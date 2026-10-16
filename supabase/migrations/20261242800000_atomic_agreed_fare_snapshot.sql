BEGIN;
-- Alphabetically precedes margin/subscription guards; all ownership, vehicle,
-- compliance and payment checks still execute in this same transaction.
CREATE OR REPLACE FUNCTION public.sync_agreed_fare_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE b jsonb; policy jsonb; charge numeric; original numeric; fee numeric;
 base numeric; rate numeric; commission numeric; payout numeric; budget numeric;
 previous_base numeric;
BEGIN
 IF NEW.agreed_fare IS NULL THEN RETURN NEW; END IF;
 b:=OLD.fare_breakdown;
 IF b->>'policyVersion' IS DISTINCT FROM 'fare-split-v1' THEN
   RAISE EXCEPTION 'Agreed fare requires a verified financial snapshot';
 END IF;
 charge:=round(NEW.agreed_fare,2); original:=(b->>'customerCharge')::numeric;
 IF charge IS NULL OR original IS NULL OR charge::text IN ('NaN','Infinity','-Infinity')
 OR original::text IN ('NaN','Infinity','-Infinity') OR charge<=0 OR original<=0 THEN
   RAISE EXCEPTION 'Invalid agreed fare snapshot';
 END IF;
 IF NEW.agreed_fare IS NOT DISTINCT FROM OLD.agreed_fare AND charge=original THEN RETURN NEW; END IF;
 IF OLD.payment_status IN ('paid','captured','wallet_funded')
 OR OLD.status IN ('completed','settled','cancelled') OR OLD.stripe_transfer_id IS NOT NULL
 OR OLD.settlement_status IN ('claimed','unknown','transferred','reversed') THEN
   RAISE EXCEPTION 'Settled or funded fare requires explicit reconciliation';
 END IF;
 IF NEW.agreed_fare IS DISTINCT FROM OLD.agreed_fare AND OLD.payment_status='authorized' THEN
   RAISE EXCEPTION 'Existing authorization must be reconciled before re-agreement';
 END IF;
 fee:=round((b->>'platformFeeAmount')::numeric*charge/original,2);
 base:=charge-fee; rate:=(b->>'commissionPercent')::numeric;
 budget:=coalesce((b->>'shoppingBudget')::numeric,0);
 IF fee IS NULL OR rate IS NULL OR fee::text IN ('NaN','Infinity','-Infinity')
 OR rate::text IN ('NaN','Infinity','-Infinity') OR budget::text IN ('NaN','Infinity','-Infinity')
 OR fee<0 OR base<=0 OR rate<0 OR rate>=100 OR budget<0 THEN
   RAISE EXCEPTION 'Invalid frozen fee or commission basis';
 END IF;
 commission:=round(base*rate/100,2); payout:=base-commission;
 policy:=b->'driverCommissionPolicy';
 IF policy->>'version'='subscription-commission-v1' THEN
   previous_base:=(b->>'driverBase')::numeric;
   IF previous_base IS NULL OR previous_base<=0 OR previous_base::text IN ('NaN','Infinity','-Infinity') THEN
     RAISE EXCEPTION 'Invalid frozen standard commission basis';
   END IF;
   policy:=policy||jsonb_build_object('standardCommissionAmount',
     round((policy->>'standardCommissionAmount')::numeric*base/previous_base,2));
   b:=b||jsonb_build_object('driverCommissionPolicy',policy);
 END IF;
 b:=b||jsonb_build_object('customerCharge',charge,'customerServiceTotal',charge,
   'total',charge,'serviceFare',charge,'totalAuthorisation',charge+budget,
   'platformFeeAmount',fee,'platformFee',fee,'baseServiceFare',base,
   'serviceFareBeforePlatformFee',base,'driverBase',base,'driverGrossEarnings',base,
   'driverCommissionAmount',commission,'commissionFee',commission,'commissionAmount',commission,
   'driverEntitlement',payout,'driverPayout',payout,'driverNetEarnings',payout,
   'grossRevenue',fee+commission,'reconciliationValid',true);
 NEW.fare_breakdown:=b;
 NEW.price:=charge; NEW.total_price:=charge; NEW.estimated_price:=charge;
 NEW.platform_fee:=fee; NEW.driver_payout:=payout;
 NEW.commission_fee:=commission; NEW.commission_rate_used:=rate;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.sync_agreed_fare_snapshot() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS a_sync_agreed_fare_snapshot ON public.jobs;
CREATE TRIGGER a_sync_agreed_fare_snapshot BEFORE UPDATE OF agreed_fare ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.sync_agreed_fare_snapshot();
-- Finalize display aliases after subscription waiver and other BEFORE triggers.
CREATE OR REPLACE FUNCTION public.finalize_agreed_fare_aliases()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE b jsonb; charge numeric; payout numeric; fee numeric; commission numeric;
BEGIN
 b:=NEW.fare_breakdown;
 IF b->>'policyVersion' IS DISTINCT FROM 'fare-split-v1' THEN RETURN NEW; END IF;
 charge:=(b->>'customerCharge')::numeric; payout:=(b->>'driverEntitlement')::numeric;
 fee:=(b->>'platformFeeAmount')::numeric; commission:=(b->>'driverCommissionAmount')::numeric;
 IF charge IS NULL OR payout IS NULL OR fee IS NULL OR commission IS NULL
 OR charge::text IN ('NaN','Infinity','-Infinity') OR payout::text IN ('NaN','Infinity','-Infinity')
 OR fee::text IN ('NaN','Infinity','-Infinity') OR commission::text IN ('NaN','Infinity','-Infinity')
 OR charge<=0 OR payout<=0 OR fee<0 OR commission<0 OR charge<>payout+fee+commission
 OR (NEW.agreed_fare IS NOT NULL AND charge<>round(NEW.agreed_fare,2)) THEN
   RAISE EXCEPTION 'Agreed fare settlement snapshot requires reconciliation';
 END IF;
 NEW.fare_breakdown:=b||jsonb_build_object('customerServiceTotal',charge,'driverPayout',payout,
   'driverNetEarnings',payout,'commissionAmount',commission,'commissionFee',commission,
   'grossRevenue',fee+commission);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.finalize_agreed_fare_aliases() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS zz_finalize_agreed_fare_aliases ON public.jobs;
CREATE TRIGGER zz_finalize_agreed_fare_aliases BEFORE UPDATE OF agreed_fare,fare_breakdown,driver_id ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.finalize_agreed_fare_aliases();
NOTIFY pgrst,'reload schema';
COMMIT;
