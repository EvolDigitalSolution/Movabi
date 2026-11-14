-- DEVELOP ONLY. Undo activate-gb.sql: switches the GB features OFF without deleting history.
-- Kept on purpose: published policy versions (now disabled), campaign rows (now disabled), discount
-- applications and fee quotes already frozen into bookings, referral rewards already earned, audit rows.
-- Bookings made while a feature was on keep the terms frozen into them (as the features are designed).
\set ON_ERROR_STOP on
BEGIN;
DO $guard$ BEGIN IF current_database() <> 'movabi_develop' THEN RAISE EXCEPTION 'develop only'; END IF; END $guard$;
DO $d$ DECLARE r record;
BEGIN
  FOR r IN SELECT id, tenant_id FROM public.cancellation_policies WHERE market_code='GB' AND enabled LOOP
    PERFORM public.set_cancellation_policy_enabled(r.id, r.tenant_id, false);
  END LOOP;
END $d$;
UPDATE public.campaigns SET enabled=false WHERE market_code='GB' AND code IN ('FIRST5GB','REFERGB') AND enabled;
-- PIN: remove only the GB key; anything else in the setting is kept. Without it GB falls back to required.
UPDATE public.marketplace_settings SET value = value #- '{markets,GB}', updated_at = now()
 WHERE key='completion_pin_policy' AND value #> '{markets,GB}' IS NOT NULL;
INSERT INTO public.audit_logs(user_id,action,entity_type,metadata)
VALUES (NULL,'admin_develop_deactivation','market',jsonb_build_object('source','develop-activation-2026-11-14','market','GB','undone',jsonb_build_array('P1','P4','P5','P6')));
SELECT (SELECT count(*) FROM public.cancellation_policies WHERE enabled AND market_code='GB') AS gb_policies_enabled,
       (SELECT count(*) FROM public.campaigns WHERE enabled AND market_code='GB' AND code IN ('FIRST5GB','REFERGB')) AS gb_campaigns_enabled;
COMMIT;
