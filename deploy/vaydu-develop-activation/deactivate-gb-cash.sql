-- DEVELOP ONLY. Turn GB cash rides off (keeps enrolments, holds, ledger and history). Set
-- VAYDU_CASH_RIDE_BOOKING back to unset/false on the API as well (README).
\set ON_ERROR_STOP on
BEGIN;
DO $guard$ BEGIN IF current_database() <> 'movabi_develop' THEN RAISE EXCEPTION 'develop only'; END IF; END $guard$;
UPDATE public.driver_cash_credit_markets_v1e SET enabled=false, updated_at=now() WHERE country_code='GB' AND currency_code='GBP';
INSERT INTO public.audit_logs(user_id,action,entity_type,metadata)
  VALUES (NULL,'admin_develop_cash_deactivation','market',jsonb_build_object('source','develop-activation-2026-11-14','market','GB'));
SELECT count(*) AS enabled_cash_markets FROM public.driver_cash_credit_markets_v1e WHERE enabled;
COMMIT;
