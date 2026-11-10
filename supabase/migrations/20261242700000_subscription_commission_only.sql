BEGIN;
ALTER TABLE public.quote_market_adjustments ADD COLUMN IF NOT EXISTS protected_fare_snapshot jsonb;
-- Billing evidence and authoritative quote snapshots are backend-managed.
-- Old broad policies must not let a browser manufacture a commission waiver.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.subscriptions,public.quote_market_adjustments FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.subscriptions,public.quote_market_adjustments TO service_role;
-- Only API quotes carrying this new policy enter the assignment-time freeze.
-- No UPDATE/backfill: existing quotes, agreed jobs and completions are unchanged.
CREATE OR REPLACE FUNCTION public.freeze_subscription_driver_commission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b jsonb; policy jsonb; subscribed boolean; standard_amount numeric; standard_rate numeric;
 base numeric; fee numeric; charge numeric; commission numeric; entitlement numeric;
BEGIN
 IF NEW.driver_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.driver_id IS NOT DISTINCT FROM OLD.driver_id THEN RETURN NEW; END IF;
 b:=NEW.fare_breakdown;
 policy:=b->'driverCommissionPolicy';
 IF policy->>'version' IS DISTINCT FROM 'subscription-commission-v1' THEN RETURN NEW; END IF;
 IF b->>'policyVersion' IS DISTINCT FROM 'fare-split-v1' THEN RAISE EXCEPTION 'Frozen fare split requires reconciliation'; END IF;
 charge:=(b->>'customerCharge')::numeric;
 fee:=(b->>'platformFeeAmount')::numeric;
 base:=(b->>'driverBase')::numeric;
 standard_amount:=(policy->>'standardCommissionAmount')::numeric;
 standard_rate:=(policy->>'standardCommissionPercent')::numeric;
 IF charge IS NULL OR fee IS NULL OR base IS NULL OR standard_amount IS NULL OR standard_rate IS NULL
 OR charge::text IN ('NaN','Infinity','-Infinity') OR fee::text IN ('NaN','Infinity','-Infinity')
 OR base::text IN ('NaN','Infinity','-Infinity') OR standard_amount::text IN ('NaN','Infinity','-Infinity')
 OR standard_rate::text IN ('NaN','Infinity','-Infinity') OR charge<=0 OR fee<0 OR base<=0
 OR standard_amount<0 OR standard_amount>=base OR standard_rate<0 OR standard_rate>=100
 OR abs(charge-fee-base)>0.000001 THEN RAISE EXCEPTION 'Invalid frozen commission terms'; END IF;
 -- Backend subscription records, never a client-supplied pricing_plan label.
 SELECT EXISTS(SELECT 1 FROM subscriptions s JOIN profiles p ON p.id=NEW.driver_id
 WHERE s.user_id=p.id AND s.tenant_id IS NOT DISTINCT FROM p.tenant_id
 AND s.status='active' AND s.stripe_subscription_id IS NOT NULL
 AND (s.current_period_end IS NULL OR s.current_period_end>now())) INTO subscribed;
 commission:=CASE WHEN subscribed THEN 0 ELSE standard_amount END;
 entitlement:=base-commission;
 b:=b||jsonb_build_object('driverCommissionAmount',commission,'commissionFee',commission,
  'commissionAmount',commission,'commissionPercent',CASE WHEN subscribed THEN 0 ELSE standard_rate END,
  'driverEntitlement',entitlement,'driverNetEarnings',entitlement,'grossRevenue',fee+commission,'isPro',subscribed,
  'driverCommissionPolicy',policy||jsonb_build_object('frozen',true,'driverId',NEW.driver_id,
    'subscriptionActive',subscribed,'frozenAt',now()));
 NEW.fare_breakdown:=b;
 NEW.driver_payout:=entitlement;
 NEW.commission_fee:=commission;
 NEW.commission_rate_used:=CASE WHEN subscribed THEN 0 ELSE standard_rate END;
 NEW.pricing_plan_used:=CASE WHEN subscribed THEN 'pro' ELSE 'starter' END;
 RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION public.freeze_subscription_driver_commission() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_freeze_subscription_driver_commission ON public.jobs;
CREATE TRIGGER trg_freeze_subscription_driver_commission
 BEFORE INSERT OR UPDATE OF driver_id ON public.jobs
 FOR EACH ROW EXECUTE FUNCTION public.freeze_subscription_driver_commission();
-- Keep the existing margin policy, evaluated without depending on commission
-- for new-policy quotes. Legacy booking behaviour remains byte-for-byte unchanged.
DO $upgrade$
DECLARE definition text; original text;
BEGIN
 original:=pg_get_functiondef('public.guard_booking_payment_margin()'::regprocedure);
 IF position('THEN round(charge-fee,2)' in original)>0 AND position('THEN (NEW.fare_breakdown' in original)>0 AND position('subscription-commission-v1' in original)>0 THEN RETURN;END IF;
 definition:=replace(original,
 'driver_amount:=round(charge-fee-round((charge-fee)*rate/100,2),2);',
 'driver_amount:=CASE WHEN OLD.fare_breakdown->''driverCommissionPolicy''->>''version''=''subscription-commission-v1'' THEN round(charge-fee,2) ELSE round(charge-fee-round((charge-fee)*rate/100,2),2) END;');
 definition:=replace(definition,
 'driver_amount:=(NEW.fare_breakdown->>''driverEntitlement'')::numeric;',
 'driver_amount:=CASE WHEN NEW.fare_breakdown->''driverCommissionPolicy''->>''version''=''subscription-commission-v1'' THEN (NEW.fare_breakdown->>''driverBase'')::numeric ELSE (NEW.fare_breakdown->>''driverEntitlement'')::numeric END;');
 IF definition=original OR position('THEN round(charge-fee,2)' in definition)=0 OR position('THEN (NEW.fare_breakdown' in definition)=0 THEN
 RAISE EXCEPTION 'Payment margin guard differs; review migration before applying'; END IF;
 EXECUTE definition;
END;$upgrade$;
NOTIFY pgrst,'reload schema';
COMMIT;
