BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.record_job_settlement(uuid,uuid,numeric,numeric,numeric,numeric,numeric,text,text,text,boolean)') IS NULL
 OR to_regprocedure('public.settle_job_wallet_reservation(uuid,numeric)') IS NULL
 OR to_regclass('public.refund_operations') IS NULL THEN
   RAISE EXCEPTION 'Required settlement, wallet or refund contract missing';
 END IF;
END $$;
-- Completion and provider transfer are separate durable operations.
CREATE TABLE public.job_payout_queue (
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id),
  driver_id uuid NOT NULL,
  destination text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor > 0),
  currency text NOT NULL,
  terms jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','reconcile','paid','blocked')),
  attempt integer NOT NULL DEFAULT 0,
  token uuid,
  attempted_at timestamptz,
  lease_until timestamptz,
  retry_at timestamptz NOT NULL DEFAULT now(),
  transfer_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.job_payout_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_payout_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE ON public.job_payout_queue TO service_role;
CREATE INDEX ON public.job_payout_queue(retry_at) WHERE status IN ('pending','reconcile','processing');

CREATE FUNCTION public.complete_job_with_pending_payout(p_job_id uuid,p_driver_id uuid,p_terms jsonb,p_metadata jsonb)
RETURNS SETOF public.jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; q public.job_payout_queue%ROWTYPE; total numeric; payout numeric; fee numeric; commission numeric;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF coalesce(j.driver_id,j.accepted_driver_id) IS DISTINCT FROM p_driver_id THEN RAISE EXCEPTION 'Only the assigned driver can complete this request'; END IF;
 PERFORM 1 FROM public.errand_funding WHERE job_id=p_job_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.errand_funding WHERE job_id=p_job_id AND over_budget_status='requested') THEN RAISE EXCEPTION 'Shopping budget approval must finish before completion'; END IF;
 SELECT * INTO q FROM public.job_payout_queue WHERE job_id=p_job_id;
 IF FOUND THEN
   IF q.driver_id<>p_driver_id OR q.terms<>p_terms THEN RAISE EXCEPTION 'Payout terms changed; reconciliation required'; END IF;
   RETURN QUERY SELECT * FROM public.jobs WHERE id=p_job_id; RETURN;
 END IF;
 IF j.status NOT IN ('in_progress','en_route_to_customer','arrived_at_customer','on_trip','completed') THEN RAISE EXCEPTION 'Request is not ready for completion'; END IF;
 IF j.stripe_transfer_id IS NOT NULL OR j.settlement_status IN ('claimed','unknown','transferred','reversed') THEN RAISE EXCEPTION 'Existing transfer needs reconciliation'; END IF;

 IF coalesce(p_metadata->>'completion_pin_verified_at','')='' THEN RAISE EXCEPTION 'Verified completion evidence missing'; END IF;
 total=(p_terms->>'total')::numeric; payout=(p_terms->>'payout')::numeric;
 fee=(p_terms->>'platformFee')::numeric; commission=(p_terms->>'commission')::numeric;
 IF total IS NULL OR payout IS NULL OR fee IS NULL OR commission IS NULL OR total::text='NaN' OR payout::text='NaN' OR fee::text='NaN' OR commission::text='NaN' OR total<=0 OR payout<=0 OR fee<0 OR commission<0 OR abs(total-payout-fee-commission)>0.01 THEN RAISE EXCEPTION 'Invalid frozen payout terms'; END IF;
 IF lower(p_terms->>'currency')<>'gbp' OR (p_terms->>'amountMinor')::bigint<>round(payout*100)::bigint OR coalesce(p_terms->>'destination','') NOT LIKE 'acct_%' THEN RAISE EXCEPTION 'Invalid payout identity'; END IF;
 IF EXISTS(SELECT 1 FROM public.refund_operations WHERE job_id=p_job_id) THEN RAISE EXCEPTION 'Existing refund requires reconciliation'; END IF;
 IF (j.payment_method='wallet' OR j.payment_status='wallet_funded') AND j.payment_status<>'paid' THEN
   PERFORM public.settle_job_wallet_reservation(p_job_id,total);
 END IF;
 INSERT INTO public.job_payout_queue(job_id,driver_id,destination,amount_minor,currency,terms)
 VALUES(p_job_id,p_driver_id,p_terms->>'destination',(p_terms->>'amountMinor')::bigint,lower(p_terms->>'currency'),p_terms);
 UPDATE public.jobs SET status='completed',payment_status='paid',completed_at=coalesce(completed_at,now()),
   driver_payout=payout,platform_fee=fee,commission_fee=commission,commission_rate_used=(p_terms->>'commissionRate')::numeric,
   settlement_status='pending',stripe_transfer_status='pending',
   metadata=coalesce(j.metadata,'{}'::jsonb)||p_metadata||jsonb_build_object('driver_payout_pending',true),updated_at=now()
 WHERE id=p_job_id;
 INSERT INTO public.driver_earnings(driver_id,job_id,amount,platform_fee,gross_amount,status,currency_code,country_code)
 VALUES(p_driver_id,p_job_id,payout,fee,total,'pending',upper(p_terms->>'currency'),p_terms->>'country')
 ON CONFLICT(job_id) DO UPDATE SET amount=excluded.amount,platform_fee=excluded.platform_fee,gross_amount=excluded.gross_amount,status='pending',currency_code=excluded.currency_code,country_code=excluded.country_code
 WHERE public.driver_earnings.status<>'paid' AND public.driver_earnings.stripe_transfer_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Existing paid earnings require reconciliation'; END IF;
 RETURN QUERY SELECT * FROM public.jobs WHERE id=p_job_id;
END $$;

CREATE FUNCTION public.claim_queued_job_payout(p_job_id uuid)
RETURNS SETOF public.job_payout_queue LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF j.status<>'completed' OR j.payment_status<>'paid' THEN RETURN; END IF;
 RETURN QUERY UPDATE public.job_payout_queue SET
   status=CASE WHEN status='pending' THEN 'processing' ELSE 'reconcile' END,
   attempt=CASE WHEN status='pending' THEN attempt+1 ELSE attempt END,
   attempted_at=CASE WHEN status='pending' THEN now() ELSE attempted_at END,
   token=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now()
 WHERE job_id=p_job_id AND retry_at<=now()
 AND (status IN ('pending','reconcile') OR (status='processing' AND lease_until<now()))
 AND (lease_until IS NULL OR lease_until<now()) RETURNING *;
END $$;

CREATE FUNCTION public.finish_queued_job_payout(p_job_id uuid,p_token uuid,p_transfer_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.job_payout_queue%ROWTYPE; j public.jobs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 SELECT * INTO STRICT q FROM public.job_payout_queue WHERE job_id=p_job_id FOR UPDATE;
 IF q.status='paid' THEN RETURN q.transfer_id=p_transfer_id; END IF;
 IF q.token IS DISTINCT FROM p_token OR q.status NOT IN ('processing','reconcile') THEN RETURN false; END IF;
 IF p_transfer_id IS NULL OR p_transfer_id NOT LIKE 'tr_%' THEN RAISE EXCEPTION 'Genuine transfer ID required'; END IF;
 PERFORM public.record_job_settlement(p_job_id,q.driver_id,(q.terms->>'total')::numeric,(q.terms->>'payout')::numeric,
   (q.terms->>'platformFee')::numeric,(q.terms->>'commission')::numeric,(q.terms->>'commissionRate')::numeric,
   p_transfer_id,upper(q.currency),q.terms->>'country',true);
 UPDATE public.jobs SET metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('driver_payout_pending',false) WHERE id=p_job_id;
 UPDATE public.job_payout_queue SET status='paid',transfer_id=p_transfer_id,lease_until=NULL,last_error=NULL,updated_at=now() WHERE job_id=p_job_id;
 RETURN true;
END $$;

-- Refund and payout must not race. Existing refund RPC locks the job; this guard
-- blocks a refund operation while an unfinished payout outbox exists.
CREATE FUNCTION public.guard_refund_pending_payout() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM public.jobs WHERE id=NEW.job_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.job_payout_queue WHERE job_id=NEW.job_id AND status<>'paid') THEN
   RAISE EXCEPTION 'Pending driver payout requires reconciliation before refund';
 END IF;
 RETURN NEW;
END $$;
-- Installed only if the deployed refund ledger is present; no existing contract changes.
DO $$ BEGIN
 IF to_regclass('public.refund_operations') IS NOT NULL THEN
  EXECUTE 'CREATE TRIGGER guard_refund_pending_payout BEFORE INSERT ON public.refund_operations FOR EACH ROW EXECUTE FUNCTION public.guard_refund_pending_payout()';
 END IF;
END $$;

REVOKE ALL ON FUNCTION public.complete_job_with_pending_payout(uuid,uuid,jsonb,jsonb),public.claim_queued_job_payout(uuid),public.finish_queued_job_payout(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_job_with_pending_payout(uuid,uuid,jsonb,jsonb),public.claim_queued_job_payout(uuid),public.finish_queued_job_payout(uuid,uuid,text) TO service_role;
CREATE FUNCTION public.guard_booking_payment_margin() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE policy jsonb; charge numeric; driver_amount numeric; budget numeric; cost numeric; contribution numeric; original numeric; fee numeric; rate numeric;
BEGIN
 policy:=OLD.fare_breakdown->'paymentMargin'->'policy';
 IF policy IS NULL THEN RETURN NEW; END IF; -- Existing agreed bookings retain their original terms.
 IF NEW.agreed_fare IS DISTINCT FROM OLD.agreed_fare AND NEW.agreed_fare IS NOT NULL THEN
   original:=coalesce(OLD.total_price,OLD.price);
   IF original IS NULL OR original<=0 OR NEW.agreed_fare<=0 THEN RAISE EXCEPTION 'Invalid agreed fare'; END IF;
   charge:=NEW.agreed_fare;
   fee:=round(coalesce((OLD.fare_breakdown->>'platformFeeAmount')::numeric,OLD.platform_fee,0)*charge/original,2);
   rate:=coalesce(OLD.commission_rate_used,(OLD.fare_breakdown->>'commissionPercent')::numeric,0);
   driver_amount:=round(charge-fee-round((charge-fee)*rate/100,2),2);
 ELSIF NEW.fare_breakdown IS DISTINCT FROM OLD.fare_breakdown THEN
   IF NEW.fare_breakdown->'paymentMargin'->'policy' IS DISTINCT FROM policy THEN RAISE EXCEPTION 'Frozen payment cost policy cannot change'; END IF;
   charge:=(NEW.fare_breakdown->>'customerCharge')::numeric;
   driver_amount:=(NEW.fare_breakdown->>'driverEntitlement')::numeric;
 ELSE RETURN NEW;
 END IF;
 budget:=coalesce((NEW.fare_breakdown->>'shoppingBudget')::numeric,0);
 IF charge IS NULL OR driver_amount IS NULL OR charge::text='NaN' OR driver_amount::text='NaN' OR driver_amount<0 OR budget<0 THEN RAISE EXCEPTION 'Invalid protected fare'; END IF;
 cost:=ceil(((charge+budget)*(policy->>'paymentPercent')::numeric/100+(policy->>'paymentFixed')::numeric)*100)/100;
 contribution:=round(charge-driver_amount-cost-(policy->>'operatingAllowance')::numeric,2);
 IF contribution IS NULL OR contribution<(policy->>'minimumContribution')::numeric THEN RAISE EXCEPTION 'Agreed fare is below the protected booking minimum'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_booking_payment_margin BEFORE UPDATE OF agreed_fare,fare_breakdown ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.guard_booking_payment_margin();

CREATE FUNCTION public.guard_errand_budget_payment_margin() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; policy jsonb; charge numeric; driver_amount numeric; budget numeric; cost numeric;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=NEW.job_id;
 policy:=j.fare_breakdown->'paymentMargin'->'policy';
 IF policy IS NULL THEN RETURN NEW; END IF;
 charge:=(j.fare_breakdown->>'customerCharge')::numeric;
 driver_amount:=(j.fare_breakdown->>'driverEntitlement')::numeric;
 budget:=greatest(coalesce(NEW.item_budget,0),coalesce(NEW.amount_reserved,0)-charge);
 cost:=ceil(((charge+budget)*(policy->>'paymentPercent')::numeric/100+(policy->>'paymentFixed')::numeric)*100)/100;
 IF charge IS NULL OR driver_amount IS NULL OR round(charge-driver_amount-cost-(policy->>'operatingAllowance')::numeric,2)<(policy->>'minimumContribution')::numeric THEN
   RAISE EXCEPTION 'Additional shopping funding needs a new protected quote; agreed fare cannot change silently';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_errand_budget_payment_margin BEFORE INSERT OR UPDATE OF item_budget,amount_reserved ON public.errand_funding FOR EACH ROW EXECUTE FUNCTION public.guard_errand_budget_payment_margin();

NOTIFY pgrst,'reload schema';
COMMIT;
