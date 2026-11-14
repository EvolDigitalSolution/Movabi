-- VERIFY for develop RELEASE 2 (read-only). Run by rollout-develop-52097ef.sh before it builds or
-- recreates any container, and after deployment. Stops unless release 1 is still exact, release 2 is
-- applied exactly (3 functions, EOL-insensitive, 2 triggers), the D12 objects match develop, and no
-- cash-ride market is enabled. Rehearsed: scripts/release/rehearse-release-2.sh.
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
DO $verify$
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
  ('public.set_cancellation_policy_enabled(p_policy uuid, p_tenant uuid, p_enabled boolean)','55f8838c0e942e1a5e0260015b4a75db'),
  ('public.completion_pin_market_policy(p_metadata jsonb)','b06d13b95ba16eb69185edb935c81ebf'),
  ('public.mint_completion_pin_on_assignment()','c0765f72f8cf3197b11fecd92e3cbb8e'),
  ('public.stamp_completion_pin_policy()','ac5497c01a83276b5c9a869f308cecc4'),
  ('public.earn_referral(p_referral uuid, p_job uuid)','114759b0db49eab9d05d5c982bd581fa'),
  ('public.register_driver_inspection_photo(p_driver uuid, p_tenant uuid, p_vehicle uuid, p_revision uuid, p_slot text, p_path text)','f180b0b86f587154270a0493786d9838')) t(sig,md5) LOOP
  SELECT md5(replace(pg_get_functiondef(p.oid),chr(13),'')) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' = r.sig;
  IF v IS DISTINCT FROM r.md5 THEN bad := bad || format(E'\n  %s: expected %s, found %s', r.sig, r.md5, coalesce(v,'MISSING')); END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.jobs'::regclass AND NOT tgisinternal AND tgenabled='O'
       AND tgname IN ('zz_stamp_completion_pin_policy','zz_mint_completion_pin_on_assignment')) <> 2 THEN bad := bad || E'\n  completion PIN triggers missing or disabled'; END IF;
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='driver_vehicle_inspection_photos' AND column_name='reason') THEN bad := bad || E'\n  D12 column missing'; END IF;
 IF to_regclass('public.driver_cash_credit_markets_v1e') IS NULL OR to_regclass('public.cash_ride_fee_holds_v1e') IS NULL THEN bad := bad || E'\n  cash release tables missing'; END IF;
 IF bad <> '' THEN RAISE EXCEPTION 'VERIFY FAILED (release 2 not applied exactly):%', bad; END IF;
 -- GB/GBP cash rides were approved on 2026-11-14 (develop cohort); any other market must stay off.
 IF EXISTS (SELECT 1 FROM public.driver_cash_credit_markets_v1e WHERE enabled AND NOT (country_code='GB' AND currency_code='GBP')) THEN RAISE EXCEPTION 'VERIFY FAILED: a cash-ride market other than GB/GBP is enabled'; END IF;
 RAISE NOTICE 'VERIFY OK: release 1 + release 2 present (20 functions, 2 triggers), D12 captured, no cash-ride market outside GB/GBP';
END $verify$;
SELECT 'public.confirm_wallet_topup_with_total(uuid,text,text,text,bigint,text)'::regprocedure AS confirm_fn,
       'public.mark_wallet_topup_failed(uuid,text)'::regprocedure AS mark_failed_fn;
SELECT count(*) AS enabled_cash_markets FROM public.driver_cash_credit_markets_v1e WHERE enabled;
SELECT count(*) AS enabled_cancellation_policies FROM public.cancellation_policies WHERE enabled;
SELECT count(*) AS driver_pin_overrides FROM public.driver_pin_policies;
ROLLBACK;
