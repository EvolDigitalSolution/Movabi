-- Read-only pre/post checks for the driver top-up verify fix. No schema change ships.
-- Fails (ON_ERROR_STOP) if a database object the fixed API calls is missing.
\set ON_ERROR_STOP 1
SELECT 'public.confirm_wallet_topup_with_total(uuid,text,text,text,bigint,text)'::regprocedure AS confirm_fn,
       'public.mark_wallet_topup_failed(uuid,text)'::regprocedure                                AS mark_failed_fn,
       'public.record_driver_topup_provider_observation(uuid,jsonb)'::regprocedure               AS observe_fn,
       'public.record_wallet_topup_provider_reference(uuid,text)'::regprocedure                  AS bind_ref_fn,
       'public.driver_card_sandbox_enabled()'::regprocedure                                      AS sandbox_fn;
SELECT has_function_privilege('service_role','public.confirm_wallet_topup_with_total(uuid,text,text,text,bigint,text)','EXECUTE') AS sr_confirm,
       has_function_privilege('service_role','public.mark_wallet_topup_failed(uuid,text)','EXECUTE')                                AS sr_mark_failed,
       has_function_privilege('service_role','public.record_driver_topup_provider_observation(uuid,jsonb)','EXECUTE')               AS sr_observe;
-- Idempotency constraints relied on by the fix.
SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN
 ('wallet_business_events_event_key_key','wallet_topup_attempts_credit_unique','wallet_topup_attempts_attempt_key_key','payment_checkout_attempts_pkey')
 ORDER BY 1;
-- Sandbox gate state (expect driver_card_sandbox_enabled=true, enabled=false on develop).
SELECT key, value FROM public.wallet_collection_config WHERE key IN ('enabled','driver_card_sandbox_enabled') ORDER BY key;
SELECT version, provider, country_code, currency_code, fee_basis, fee_basis_points, fee_fixed_minor, fee_cap_minor, rounding, active
  FROM public.wallet_topup_fee_schedules WHERE provider='stripe' AND country_code='GB' AND currency_code='GBP' AND active;
SELECT count(*) AS enabled_stripe_gb_scopes FROM public.driver_card_topup_sandbox_scopes
 WHERE provider='stripe' AND country_code='GB' AND currency_code='GBP' AND enabled;
