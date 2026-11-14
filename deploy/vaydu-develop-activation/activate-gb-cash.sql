-- DEVELOP ONLY. Cash rides for GB/GBP with ONE test driver (5b), per the plan agreed on 2026-11-12
-- (card hold at booking = the larger of the no-show fee and the active GB cancellation cap; immediate
-- rides only; fixed fare; courier cash stays off) and the existing cash terms `fare-split-v1`.
-- Usage: psql ... -v driver_email='<GB test driver email>' < activate-gb-cash.sql
-- The API flag VAYDU_CASH_RIDE_BOOKING=true is a separate host step (README). Undo: deactivate-gb-cash.sql.
-- Consent: the test driver's cash-credit consent is recorded at the time of this run by the operator
-- for a develop TEST account (audited below); a real driver must consent in the app.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$ BEGIN IF current_database() <> 'movabi_develop' THEN RAISE EXCEPTION 'develop only'; END IF; END $guard$;
CREATE TEMP TABLE cash_driver ON COMMIT DROP AS
  SELECT u.id AS driver_id, p.tenant_id
    FROM auth.users u JOIN public.profiles p ON p.id=u.id
   WHERE lower(u.email)=lower(:'driver_email') AND p.role='driver'
     AND upper(coalesce(p.registration_country_code,p.country_code,''))='GB' AND p.tenant_id IS NOT NULL;
DO $c$ BEGIN
  IF (SELECT count(*) FROM cash_driver) <> 1 THEN RAISE EXCEPTION 'driver_email is not exactly one GB driver'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cancellation_policies c JOIN cash_driver d ON d.tenant_id=c.tenant_id WHERE c.market_code='GB' AND c.enabled) THEN
    RAISE EXCEPTION 'GB cancellation policy (P1) is not active for this tenant: the cash hold would have no cap';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.market_availability WHERE country_code='GB' AND upper(supported_currency)='GBP' AND enabled) THEN
    RAISE EXCEPTION 'GB/GBP market missing';
  END IF;
END $c$;
INSERT INTO public.driver_cash_credit_markets_v1e(country_code,currency_code,enabled,note) VALUES ('GB','GBP',true,'develop cash-ride cohort 2026-11-14')
  ON CONFLICT (country_code,currency_code) DO UPDATE SET enabled=true, updated_at=now();
INSERT INTO public.driver_cash_credit_enrolments_v1e(tenant_id,driver_id,country_code,currency_code,terms_version,consented_at,enabled)
  SELECT tenant_id, driver_id, 'GB', 'GBP', 'fare-split-v1', now(), true FROM cash_driver
  ON CONFLICT (tenant_id,driver_id,country_code,currency_code) DO UPDATE SET enabled=true;
INSERT INTO public.driver_cash_credit_config_v1e(key,enabled) VALUES ('ride_cash_credit',true)
  ON CONFLICT (key) DO UPDATE SET enabled=true;
INSERT INTO public.audit_logs(user_id,action,entity_type,entity_id,metadata)
  SELECT NULL,'admin_develop_cash_activation','driver',driver_id,
         jsonb_build_object('source','develop-activation-2026-11-14','market','GB','currency','GBP','terms','fare-split-v1','consent','recorded by operator for a develop test account')
    FROM cash_driver;
-- Only GB/GBP may show true.
SELECT country_code, upper(supported_currency) AS currency, public.driver_cash_credit_market_enabled_v1e(country_code,supported_currency) AS cash_enabled
  FROM public.market_availability ORDER BY 1;
DO $iso$ BEGIN
  IF EXISTS (SELECT 1 FROM public.market_availability WHERE country_code<>'GB' AND public.driver_cash_credit_market_enabled_v1e(country_code,supported_currency)) THEN
    RAISE EXCEPTION 'cash would be enabled outside GB';
  END IF;
END $iso$;
COMMIT;
