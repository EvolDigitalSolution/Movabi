-- PREREQ for develop RELEASE 2 (read-only). Passes only on develop's current state: release 1 applied
-- exactly (its 15 functions, EOL-insensitive) and release 2 not yet applied.
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
DO $prereq$
DECLARE r record; v text; bad text := '';
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.activate_cash_ride_v1e(p_job_id uuid, p_customer_id uuid, p_provider text, p_provider_payment_reference text, p_amount_minor bigint, p_currency text)','e952464be26cc3015f7eaf36f9011ebb'),
  ('public.cancel_job_with_actor(p_job_id uuid, p_reason text, p_actor uuid, p_actor_role text)','bc3f58a30d4316839cea1b588a53e658'),
  ('public.cancellation_fee_quote(p_job uuid, p_actor_role text, p_at timestamp with time zone)','48da223980b7db17dde0338a9b206fd1'),
  ('public.cash_acquisition_allowed_v1e(j jobs)','fc266818c98444af5a0a5b0f63ae209c'),
  ('public.cash_ride_acquirable_v1e(j jobs)','bf7aa20870111baec4cf5ebec8d82382'),
  ('public.cash_service_enabled_v1e(p_slug text, p_country text, p_currency text)','80fc92a5a4f2b9455c2f7b867d26a694'),
  ('public.complete_cash_ride_v1e(p_job_id uuid, p_driver_id uuid, p_metadata jsonb)','63e561c99df02e3369e8d1a46f85ef85'),
  ('public.driver_cash_credit_market_enabled_v1e(p_country text, p_currency text)','bc2b4c3823dcc0951ac8000511398335'),
  ('public.driver_cash_credit_status_v1f(p_driver_id uuid)','037bd5c0d7cf018a938858fa4cf4e6e9'),
  ('public.driver_offer_metrics_v2(p_driver uuid, p_since timestamp with time zone)','5c9b929a72435445667b8903720cd05d'),
  ('public.enforce_job_payment_eligibility()','d9342df9352e86be3303a05046e10c5a'),
  ('public.enforce_ride_cash_credit_v1e()','68671f11fbdf775931c8fbaee6990260'),
  ('public.record_negotiated_assignment(p_job uuid, p_driver uuid)','0e7343d787a2663069a471c0e4e0974b'),
  ('public.reserve_cash_job_credit_v1e(p_job_id uuid, p_driver_id uuid)','35a8106d29d8f070716a93c2f3fa4874'),
  ('public.set_cancellation_policy_enabled(p_policy uuid, p_tenant uuid, p_enabled boolean)','55f8838c0e942e1a5e0260015b4a75db')) t(sig,md5) LOOP
  SELECT md5(replace(pg_get_functiondef(p.oid),chr(13),'')) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' = r.sig;
  IF v IS DISTINCT FROM r.md5 THEN bad := bad || format(E'\n  release 1 %s: expected %s, found %s', r.sig, r.md5, coalesce(v,'MISSING')); END IF;
 END LOOP;
 -- earn_referral must be develop's live body (it is replaced by 20261270200000 and restored by release-down).
 SELECT md5(replace(pg_get_functiondef('public.earn_referral(uuid,uuid)'::regprocedure),chr(13),'')) INTO v;
 IF v IS DISTINCT FROM '98e50e3328d7a29ba7f9f5c1a19751c4' THEN bad := bad || format(E'
  earn_referral is not develop''s live body (found %s)', v); END IF;
 IF to_regprocedure('public.stamp_completion_pin_policy()') IS NOT NULL OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('zz_stamp_completion_pin_policy','zz_mint_completion_pin_on_assignment')) THEN
   bad := bad || E'\n  release 2 objects already present';
 END IF;
 IF to_regprocedure('public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text,integer,text)') IS NULL THEN bad := bad || E'\n  8-argument register_driver_inspection_photo missing'; END IF;
 IF bad <> '' THEN RAISE EXCEPTION 'PREREQ FAILED:%', bad; END IF;
 RAISE NOTICE 'PREREQ OK: release 1 exact, release 2 not applied';
END $prereq$;
ROLLBACK;
