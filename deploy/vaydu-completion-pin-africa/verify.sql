\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
 IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'develop only'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.marketplace_settings WHERE key='completion_pin_policy' AND tenant_id IS NULL) THEN RAISE EXCEPTION 'platform default missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.marketplace_settings WHERE key='completion_pin_policy' GROUP BY tenant_id HAVING count(*)>1) THEN RAISE EXCEPTION 'duplicate PIN settings'; END IF;
 IF EXISTS(SELECT 1 FROM public.marketplace_settings s CROSS JOIN unnest(ARRAY['NG','GH','KE','ZA','UG','TZ','RW','MW','EG','CM','CI','SN','ZM','GB']) c
  WHERE s.key='completion_pin_policy' AND s.value#>>ARRAY['markets',c] IS DISTINCT FROM CASE WHEN c='GB' THEN 'required' ELSE 'disabled' END) THEN RAISE EXCEPTION 'explicit policy does not match approval'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.jobs'::regclass AND tgname='zy_refresh_completion_pin_market_on_acceptance' AND tgenabled='O'
   AND tgfoid='public.refresh_completion_pin_market_on_acceptance()'::regprocedure) THEN RAISE EXCEPTION 'acceptance preparation trigger missing/disabled'; END IF;
 IF has_function_privilege('authenticated','public.refresh_completion_pin_market_on_acceptance()','EXECUTE') OR has_function_privilege('anon','public.refresh_completion_pin_market_on_acceptance()','EXECUTE') THEN RAISE EXCEPTION 'client helper execution privilege'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE action='admin_completion_pin_acceptance_resolver' AND metadata->>'source'='african-pin-defaults-2026-11-16') THEN RAISE EXCEPTION 'policy deployment audit missing'; END IF;
 RAISE NOTICE 'COMPLETION_PIN_VERIFY_OK: 13 explicit African defaults off; GB required; original resolver/overrides/freeze and completion/settlement retained';
END $$;
SELECT tenant_id,key,value->'markets' AS markets FROM public.marketplace_settings WHERE key='completion_pin_policy' ORDER BY tenant_id NULLS FIRST;
ROLLBACK;
