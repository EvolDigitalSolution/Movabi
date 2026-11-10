BEGIN;
-- These are sandbox ledgers, never operational booking/payment/payout columns.
DO $$ BEGIN
 IF to_regclass('public.jobs') IS NULL OR to_regclass('public.service_types') IS NULL
 OR to_regclass('public.driver_earnings') IS NULL OR to_regclass('public.job_payout_queue') IS NULL
 OR to_regclass('public.job_payment_bindings') IS NULL THEN
   RAISE EXCEPTION 'Kora pilot requires the existing booking, earnings, payout-queue and binding schema';
 END IF;
END $$;
CREATE TABLE public.kora_sandbox_booking_enrolments (
 job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE RESTRICT,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 active boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.kora_sandbox_booking_payments (
 job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE RESTRICT,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 reference text NOT NULL UNIQUE CHECK(reference ~ '^vaydu-book-[a-f0-9]{32}$'),
 merchant_account_ref text NOT NULL CHECK(length(merchant_account_ref)>0),
 currency text NOT NULL CHECK(currency='NGN'),
 amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 10000 AND 9007199254740991),
 booking_snapshot jsonb NOT NULL CHECK(jsonb_typeof(booking_snapshot)='object'),
 state text NOT NULL DEFAULT 'started' CHECK(state IN ('started','submitted','unknown','verified','requires_refund','refunded')),
 checkout_url text,
 refund_reference text UNIQUE CHECK(refund_reference ~ '^vaydu-refund-[a-f0-9]{32}$'),
 refund_state text NOT NULL DEFAULT 'none' CHECK(refund_state IN ('none','started','processing','unknown','success','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((refund_state='none' AND refund_reference IS NULL) OR (refund_state<>'none' AND refund_reference IS NOT NULL))
);
ALTER TABLE public.kora_sandbox_booking_enrolments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kora_sandbox_booking_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kora_sandbox_booking_enrolments,public.kora_sandbox_booking_payments FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.kora_sandbox_booking_enrolments,public.kora_sandbox_booking_payments TO service_role;
-- Enrolment writes require a database operator; the API cannot enrol arbitrary jobs.
CREATE FUNCTION public.kora_sandbox_booking_snapshot(p_job uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_object_agg(k,coalesce(to_jsonb(j)->k,'null'::jsonb))
 FROM public.jobs j CROSS JOIN unnest(ARRAY['id','customer_id','status','country_code','currency_code',
 'service_type_id','payment_method','payment_status','payment_intent_id','driver_id','agreed_fare',
 'price','estimated_price','total_price','quote_id','fare_breakdown']) AS fields(k)
 WHERE j.id=p_job
$$;
CREATE FUNCTION public.reserve_kora_sandbox_booking(p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs; e public.kora_sandbox_booking_enrolments; b public.kora_sandbox_booking_payments;
 job uuid:=(p_row->>'job_id')::uuid; owner_id uuid:=(p_row->>'user_id')::uuid; amount bigint:=(p_row->>'amount_minor')::bigint;
BEGIN
 SELECT * INTO j FROM public.jobs WHERE id=job FOR UPDATE;
 IF NOT FOUND OR j.customer_id IS DISTINCT FROM owner_id THEN RAISE EXCEPTION 'Booking owner mismatch'; END IF;
 SELECT * INTO e FROM public.kora_sandbox_booking_enrolments WHERE job_id=job FOR SHARE;
 IF NOT FOUND OR NOT e.active OR e.user_id IS DISTINCT FROM owner_id THEN RAISE EXCEPTION 'Sandbox booking not enrolled'; END IF;
 IF j.status IS DISTINCT FROM 'completed' OR to_jsonb(j)->>'country_code' IS DISTINCT FROM 'NG'
 OR to_jsonb(j)->>'currency_code' IS DISTINCT FROM 'NGN'
 OR coalesce(to_jsonb(j)->>'payment_intent_id','')<>'' OR to_jsonb(j)->>'payment_method'='wallet'
 OR coalesce(j.payment_status,'') NOT IN ('pending','unpaid')
 OR NOT EXISTS(SELECT 1 FROM public.service_types WHERE id=j.service_type_id AND slug='ride')
 OR EXISTS(SELECT 1 FROM public.driver_earnings WHERE job_id=job)
 OR EXISTS(SELECT 1 FROM public.job_payout_queue WHERE job_id=job)
 OR EXISTS(SELECT 1 FROM public.job_payment_bindings WHERE job_id=job) THEN
   RAISE EXCEPTION 'Completed unpaid isolated ride required';
 END IF;
 IF public.kora_sandbox_booking_snapshot(job) IS DISTINCT FROM p_row->'booking_snapshot'
 OR p_row->>'currency' IS DISTINCT FROM 'NGN'
 OR to_jsonb(j)->'fare_breakdown'->>'policyVersion' IS DISTINCT FROM 'fare-split-v1'
 OR amount<10000 OR amount>9007199254740991
 OR (to_jsonb(j)->'fare_breakdown'->>'customerCharge')::numeric*100 IS DISTINCT FROM amount::numeric THEN
   RAISE EXCEPTION 'Frozen booking terms differ';
 END IF;
 SELECT * INTO b FROM public.kora_sandbox_booking_payments WHERE job_id=job FOR UPDATE;
 IF FOUND THEN
   IF b.user_id IS DISTINCT FROM owner_id OR b.reference IS DISTINCT FROM p_row->>'reference'
   OR b.merchant_account_ref IS DISTINCT FROM p_row->>'merchant_account_ref'
   OR b.amount_minor IS DISTINCT FROM amount OR b.booking_snapshot IS DISTINCT FROM p_row->'booking_snapshot' THEN
     RAISE EXCEPTION 'Original sandbox payment binding required';
   END IF;
   RETURN jsonb_build_object('created',false,'payment',to_jsonb(b));
 END IF;
 INSERT INTO public.kora_sandbox_booking_payments(job_id,user_id,reference,merchant_account_ref,currency,amount_minor,booking_snapshot)
 VALUES(job,owner_id,p_row->>'reference',p_row->>'merchant_account_ref','NGN',amount,p_row->'booking_snapshot') RETURNING * INTO b;
 RETURN jsonb_build_object('created',true,'payment',to_jsonb(b));
END $$;
CREATE FUNCTION public.finish_kora_sandbox_booking_checkout(p_job uuid,p_user uuid,p_account text,p_state text,p_url text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b public.kora_sandbox_booking_payments;
BEGIN
 SELECT * INTO b FROM public.kora_sandbox_booking_payments WHERE job_id=p_job FOR UPDATE;
 IF NOT FOUND OR b.user_id IS DISTINCT FROM p_user OR b.merchant_account_ref IS DISTINCT FROM p_account
 OR p_state NOT IN ('submitted','unknown') OR p_state IS NULL THEN RAISE EXCEPTION 'Original checkout binding required'; END IF;
 IF b.state IN ('started','submitted','unknown') AND b.refund_state='none' THEN
   IF p_state='submitted' AND (p_url IS NULL OR p_url !~ '^https://(test-checkout[.]korapay[.]com|checkout[.]korapay[.]com)/') THEN
     RAISE EXCEPTION 'Trusted checkout URL required';
   END IF;
   UPDATE public.kora_sandbox_booking_payments SET state=p_state,checkout_url=p_url WHERE job_id=p_job RETURNING * INTO b;
 END IF;
 RETURN to_jsonb(b);
END $$;
CREATE FUNCTION public.confirm_kora_sandbox_booking(p_job uuid,p_user uuid,p_account text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs; b public.kora_sandbox_booking_payments; valid boolean;
BEGIN
 SELECT * INTO j FROM public.jobs WHERE id=p_job FOR UPDATE;
 SELECT * INTO b FROM public.kora_sandbox_booking_payments WHERE job_id=p_job FOR UPDATE;
 IF NOT FOUND OR b.user_id IS DISTINCT FROM p_user OR b.merchant_account_ref IS DISTINCT FROM p_account THEN
   RAISE EXCEPTION 'Original booking payment binding required'; END IF;
 IF b.refund_state<>'none' THEN RETURN to_jsonb(b); END IF;
 valid:=j.customer_id IS NOT DISTINCT FROM p_user AND j.status='completed'
 AND public.kora_sandbox_booking_snapshot(p_job) IS NOT DISTINCT FROM b.booking_snapshot
 AND EXISTS(SELECT 1 FROM public.kora_sandbox_booking_enrolments WHERE job_id=p_job AND user_id=p_user AND active)
 AND NOT EXISTS(SELECT 1 FROM public.driver_earnings WHERE job_id=p_job)
 AND NOT EXISTS(SELECT 1 FROM public.job_payout_queue WHERE job_id=p_job)
 AND NOT EXISTS(SELECT 1 FROM public.job_payment_bindings WHERE job_id=p_job);
 UPDATE public.kora_sandbox_booking_payments SET state=CASE WHEN coalesce(valid,false) THEN 'verified' ELSE 'requires_refund' END
 WHERE job_id=p_job RETURNING * INTO b;
 RETURN to_jsonb(b);
END $$;
CREATE FUNCTION public.claim_kora_sandbox_booking_refund(p_job uuid,p_user uuid,p_account text,p_reference text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b public.kora_sandbox_booking_payments;
BEGIN
 SELECT * INTO b FROM public.kora_sandbox_booking_payments WHERE job_id=p_job FOR UPDATE;
 IF NOT FOUND OR b.user_id IS DISTINCT FROM p_user OR b.merchant_account_ref IS DISTINCT FROM p_account
 OR b.state NOT IN ('verified','requires_refund','refunded') OR p_reference IS NULL
 OR p_reference !~ '^vaydu-refund-[a-f0-9]{32}$' THEN RAISE EXCEPTION 'Verified full refund binding required'; END IF;
 IF b.refund_reference IS NOT NULL THEN
   IF b.refund_reference IS DISTINCT FROM p_reference THEN RAISE EXCEPTION 'Original refund reference required'; END IF;
   RETURN jsonb_build_object('claimed',false,'payment',to_jsonb(b));
 END IF;
 UPDATE public.kora_sandbox_booking_payments SET state='requires_refund',refund_reference=p_reference,refund_state='started'
 WHERE job_id=p_job RETURNING * INTO b;
 RETURN jsonb_build_object('claimed',true,'payment',to_jsonb(b));
END $$;
CREATE FUNCTION public.finish_kora_sandbox_booking_refund(p_job uuid,p_user uuid,p_account text,p_state text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b public.kora_sandbox_booking_payments;
BEGIN
 SELECT * INTO b FROM public.kora_sandbox_booking_payments WHERE job_id=p_job FOR UPDATE;
 IF NOT FOUND OR b.user_id IS DISTINCT FROM p_user OR b.merchant_account_ref IS DISTINCT FROM p_account
 OR b.refund_reference IS NULL OR p_state IS NULL OR p_state NOT IN ('processing','unknown','success','failed') THEN
   RAISE EXCEPTION 'Original refund binding required'; END IF;
 IF b.refund_state IN ('success','failed') THEN RETURN to_jsonb(b); END IF;
 UPDATE public.kora_sandbox_booking_payments SET refund_state=p_state,
 state=CASE WHEN p_state='success' THEN 'refunded' ELSE 'requires_refund' END WHERE job_id=p_job RETURNING * INTO b;
 RETURN to_jsonb(b);
END $$;
REVOKE ALL ON FUNCTION public.kora_sandbox_booking_snapshot(uuid),public.reserve_kora_sandbox_booking(jsonb),
 public.finish_kora_sandbox_booking_checkout(uuid,uuid,text,text,text),public.confirm_kora_sandbox_booking(uuid,uuid,text),
 public.claim_kora_sandbox_booking_refund(uuid,uuid,text,text),public.finish_kora_sandbox_booking_refund(uuid,uuid,text,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_kora_sandbox_booking(jsonb),public.finish_kora_sandbox_booking_checkout(uuid,uuid,text,text,text),
 public.confirm_kora_sandbox_booking(uuid,uuid,text),public.claim_kora_sandbox_booking_refund(uuid,uuid,text,text),
 public.finish_kora_sandbox_booking_refund(uuid,uuid,text,text) TO service_role;
COMMIT;
