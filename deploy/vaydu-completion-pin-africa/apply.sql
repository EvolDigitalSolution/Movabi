\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='10s';
DO $$ BEGIN
 IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'develop only'; END IF;
 IF to_regprocedure('public.completion_pin_market_policy(jsonb)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.jobs'::regclass AND tgname='zz_stamp_completion_pin_policy' AND tgenabled='O')
 THEN RAISE EXCEPTION 'existing completion PIN resolver/stamp trigger required'; END IF;
 IF EXISTS(SELECT 1 FROM public.marketplace_settings WHERE key='completion_pin_policy' GROUP BY tenant_id HAVING count(*)>1)
 THEN RAISE EXCEPTION 'duplicate tenant/platform PIN settings; inspect before changing'; END IF;
 IF EXISTS(SELECT 1 FROM public.marketplace_settings WHERE key='completion_pin_policy' AND
  (jsonb_typeof(value) IS DISTINCT FROM 'object' OR (value ? 'markets' AND jsonb_typeof(value->'markets') IS DISTINCT FROM 'object')))
 THEN RAISE EXCEPTION 'malformed PIN setting; no policy guessed'; END IF;
END $$;
LOCK TABLE public.marketplace_settings,public.jobs,public.driver_pin_policies,public.job_completion_secrets IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE pin_settings_before ON COMMIT DROP AS SELECT id,to_jsonb(s) row FROM public.marketplace_settings s;
CREATE TEMP TABLE pin_jobs_before ON COMMIT DROP AS SELECT id,metadata,driver_id,status FROM public.jobs;
CREATE TEMP TABLE pin_overrides_before ON COMMIT DROP AS SELECT to_jsonb(p) row FROM public.driver_pin_policies p;
CREATE TEMP TABLE pin_secrets_before ON COMMIT DROP AS SELECT to_jsonb(p) row FROM public.job_completion_secrets p;
CREATE TEMP TABLE pin_functions_before ON COMMIT DROP AS
 SELECT p.oid,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prokind='f' AND p.proname<>'refresh_completion_pin_market_on_acceptance';
\ir acceptance-market.sql
CREATE TEMP TABLE pin_approved(country text PRIMARY KEY,policy text NOT NULL) ON COMMIT DROP;
INSERT INTO pin_approved SELECT c,'disabled' FROM unnest(ARRAY['NG','GH','KE','ZA','UG','TZ','RW','MW','EG','CM','CI','SN','ZM']) c;
INSERT INTO pin_approved VALUES('GB','required');
-- All current tenant rows retain their own ID and all unrelated market/default fields.
-- A platform row supplies the same defaults for tenants without their own setting.
INSERT INTO public.marketplace_settings(key,value)
 SELECT 'completion_pin_policy','{}'::jsonb WHERE NOT EXISTS(SELECT 1 FROM public.marketplace_settings WHERE key='completion_pin_policy' AND tenant_id IS NULL);
UPDATE public.marketplace_settings s SET value=jsonb_set(s.value,'{markets}',
 coalesce(s.value->'markets','{}'::jsonb)||(SELECT jsonb_object_agg(country,policy) FROM pin_approved),true)
 WHERE s.key='completion_pin_policy' AND s.value IS DISTINCT FROM jsonb_set(s.value,'{markets}',
 coalesce(s.value->'markets','{}'::jsonb)||(SELECT jsonb_object_agg(country,policy) FROM pin_approved),true);
INSERT INTO public.audit_logs(user_id,action,entity_type,entity_id,metadata)
 SELECT NULL,'admin_completion_pin_market_defaults','marketplace_setting',s.id,
 jsonb_build_object('source','african-pin-defaults-2026-11-16','approval','user instruction: African markets off by default, GB required; driver overrides preserved',
 'operator',session_user,'transaction',txid_current(),'before',b.row,'after',to_jsonb(s),
 'scope',(SELECT jsonb_object_agg(country,policy) FROM pin_approved),'effective_from','first unfrozen driver assignment; existing frozen jobs unchanged')
 FROM public.marketplace_settings s LEFT JOIN pin_settings_before b USING(id)
 WHERE s.key='completion_pin_policy' AND b.row IS DISTINCT FROM to_jsonb(s);
INSERT INTO public.audit_logs(user_id,action,entity_type,metadata)
 SELECT NULL,'admin_completion_pin_acceptance_resolver','database_function',jsonb_build_object(
 'source','african-pin-defaults-2026-11-16','operator',session_user,'transaction',txid_current(),
 'definition',pg_get_functiondef('public.refresh_completion_pin_market_on_acceptance()'::regprocedure),
 'reason','resolve current explicit market policy before existing override/freeze trigger')
 WHERE NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE action='admin_completion_pin_acceptance_resolver' AND metadata->>'source'='african-pin-defaults-2026-11-16');
DO $$ BEGIN
 IF EXISTS((SELECT * FROM pin_jobs_before EXCEPT SELECT id,metadata,driver_id,status FROM public.jobs)
 UNION ALL (SELECT id,metadata,driver_id,status FROM public.jobs EXCEPT SELECT * FROM pin_jobs_before)) THEN RAISE EXCEPTION 'existing jobs changed'; END IF;
 IF EXISTS((SELECT row FROM pin_overrides_before EXCEPT SELECT to_jsonb(p) FROM public.driver_pin_policies p)
 UNION ALL(SELECT to_jsonb(p) FROM public.driver_pin_policies p EXCEPT SELECT row FROM pin_overrides_before)) THEN RAISE EXCEPTION 'driver overrides changed'; END IF;
 IF EXISTS((SELECT row FROM pin_secrets_before EXCEPT SELECT to_jsonb(p) FROM public.job_completion_secrets p)
 UNION ALL(SELECT to_jsonb(p) FROM public.job_completion_secrets p EXCEPT SELECT row FROM pin_secrets_before)) THEN RAISE EXCEPTION 'existing PIN secrets changed'; END IF;
 IF EXISTS(SELECT 1 FROM pin_functions_before b WHERE pg_get_functiondef(b.oid) IS DISTINCT FROM b.definition) THEN RAISE EXCEPTION 'existing function changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.marketplace_settings s CROSS JOIN pin_approved a WHERE s.key='completion_pin_policy' AND s.value#>>ARRAY['markets',a.country] IS DISTINCT FROM a.policy) THEN RAISE EXCEPTION 'approved country entry missing'; END IF;
 IF EXISTS(SELECT 1 FROM pin_settings_before b LEFT JOIN public.marketplace_settings s USING(id) WHERE s.id IS NULL
 OR CASE WHEN s.key='completion_pin_policy' THEN
   (to_jsonb(s)-ARRAY['value','updated_at']) IS DISTINCT FROM (b.row-ARRAY['value','updated_at'])
   OR (s.value-'markets') IS DISTINCT FROM ((b.row->'value')-'markets')
   OR ((s.value->'markets')-(SELECT array_agg(country) FROM pin_approved)) IS DISTINCT FROM
      (coalesce(b.row#>'{value,markets}','{}'::jsonb)-(SELECT array_agg(country) FROM pin_approved))
 ELSE to_jsonb(s) IS DISTINCT FROM b.row END) THEN RAISE EXCEPTION 'unrelated setting or market changed'; END IF;
 RAISE NOTICE 'COMPLETION_PIN_POLICY_APPLIED: explicit African defaults off; GB required; jobs, driver overrides, secrets and existing functions unchanged';
END $$;
COMMIT;
