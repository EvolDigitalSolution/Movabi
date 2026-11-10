BEGIN;
SELECT pg_advisory_xact_lock(20261024,900);
DO $preflight$
BEGIN
 IF to_regclass('public.jobs') IS NULL OR to_regclass('public.profiles') IS NULL THEN
  RAISE EXCEPTION 'Driver market prerequisites missing';
 END IF;
END $preflight$;
CREATE OR REPLACE FUNCTION public.driver_job_market_matches_v23(p jsonb,j jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $function$
 SELECT COALESCE(
  upper(btrim(COALESCE(NULLIF(p->>'registration_country_code',''),p->>'country_code',''))) ~ '^[A-Z]{2}$'
  AND upper(btrim(COALESCE(NULLIF(p->>'registration_country_code',''),p->>'country_code',''))) =
      upper(btrim(COALESCE(NULLIF(j->>'country_code',''),j->'metadata'->>'country_code','')))
  AND NULLIF(p->>'tenant_id','') IS NOT NULL AND p->>'tenant_id'=j->>'tenant_id'
  AND (NULLIF(j->'metadata'->>'country_code','') IS NULL OR
       upper(btrim(j->'metadata'->>'country_code'))=upper(btrim(j->>'country_code'))),false)
$function$;
REVOKE ALL ON FUNCTION public.driver_job_market_matches_v23(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_job_market_matches_v23(jsonb,jsonb) TO authenticated,service_role;
CREATE OR REPLACE FUNCTION public.enforce_driver_job_market_v23()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $function$
DECLARE j jsonb; p jsonb; driver_text text; field_name text;
BEGIN
 IF TG_TABLE_NAME='jobs' THEN
  IF TG_OP='UPDATE' AND NEW.status IN ('cancelled','canceled','expired','failed','requires_review') AND NEW.driver_id IS NOT DISTINCT FROM OLD.driver_id AND NEW.accepted_driver_id IS NOT DISTINCT FROM OLD.accepted_driver_id THEN RETURN NEW; END IF;
  j:=to_jsonb(NEW);
 ELSE
  SELECT to_jsonb(job) INTO j FROM public.jobs job WHERE job.id=(to_jsonb(NEW)->>'job_id')::uuid FOR UPDATE;
  IF j IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='DRIVER_MARKET_JOB_MISSING'; END IF;
 END IF;
 FOREACH field_name IN ARRAY TG_ARGV LOOP
  driver_text:=NULLIF(to_jsonb(NEW)->>field_name,'');
  IF driver_text IS NULL THEN CONTINUE; END IF;
  SELECT to_jsonb(profile) INTO p FROM public.profiles profile WHERE profile.id=driver_text::uuid;
  IF p IS NULL OR p->>'role' IS DISTINCT FROM 'driver' OR NOT public.driver_job_market_matches_v23(p,j) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='DRIVER_MARKET_MISMATCH';
  END IF;
 END LOOP;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.enforce_driver_job_market_v23() FROM PUBLIC;
DROP TRIGGER IF EXISTS enforce_driver_market_jobs_v23 ON public.jobs;
CREATE TRIGGER enforce_driver_market_jobs_v23 BEFORE INSERT OR UPDATE OF driver_id,accepted_driver_id,country_code,tenant_id,status,metadata
 ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.enforce_driver_job_market_v23('driver_id','accepted_driver_id');
DO $triggers$
BEGIN
 IF to_regclass('public.marketplace_negotiation_sessions') IS NOT NULL THEN
  EXECUTE 'DROP TRIGGER IF EXISTS enforce_driver_market_negotiation_v23 ON public.marketplace_negotiation_sessions';
  EXECUTE 'CREATE TRIGGER enforce_driver_market_negotiation_v23 BEFORE INSERT OR UPDATE OF active_driver_id,job_id ON public.marketplace_negotiation_sessions FOR EACH ROW EXECUTE FUNCTION public.enforce_driver_job_market_v23(''active_driver_id'')';
 END IF;
 IF to_regclass('public.driver_offers') IS NOT NULL THEN
  EXECUTE 'DROP TRIGGER IF EXISTS enforce_driver_market_offers_v23 ON public.driver_offers';
  EXECUTE 'CREATE TRIGGER enforce_driver_market_offers_v23 BEFORE INSERT OR UPDATE OF driver_id,job_id ON public.driver_offers FOR EACH ROW EXECUTE FUNCTION public.enforce_driver_job_market_v23(''driver_id'')';
 END IF;
END $triggers$;
-- Security-definer predicates avoid policy recursion through profile policies.
CREATE OR REPLACE FUNCTION public.driver_can_read_job_market_v23(j jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $function$
DECLARE p jsonb;
BEGIN
 SELECT to_jsonb(profile) INTO p FROM public.profiles profile WHERE profile.id=auth.uid();
 IF p->>'role' IS DISTINCT FROM 'driver' THEN RETURN true; END IF;
 IF (j->>'driver_id'=auth.uid()::text OR j->>'accepted_driver_id'=auth.uid()::text) AND j->>'status' IN ('completed','settled','cancelled','canceled','expired','failed') THEN RETURN true; END IF;
 RETURN j->>'customer_id'=auth.uid()::text OR public.driver_job_market_matches_v23(p,j);
END $function$;
CREATE OR REPLACE FUNCTION public.driver_can_read_earnings_v23(driver uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $function$
 SELECT driver=auth.uid() OR EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.role IN ('admin','super_admin'))
$function$;
REVOKE ALL ON FUNCTION public.driver_can_read_job_market_v23(jsonb),public.driver_can_read_earnings_v23(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_can_read_job_market_v23(jsonb),public.driver_can_read_earnings_v23(uuid) TO authenticated,service_role;
DO $rls$
BEGIN
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.jobs'::regclass)
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.driver_earnings'::regclass) THEN
  RAISE EXCEPTION 'Existing jobs and earnings RLS required; inspect policies before rollout';
 END IF;
END $rls$;
DROP POLICY IF EXISTS driver_market_jobs_read_v23 ON public.jobs;
CREATE POLICY driver_market_jobs_read_v23 ON public.jobs AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.driver_can_read_job_market_v23(to_jsonb(jobs)));
DROP POLICY IF EXISTS driver_earnings_owner_read_v23 ON public.driver_earnings;
CREATE POLICY driver_earnings_owner_read_v23 ON public.driver_earnings AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.driver_can_read_earnings_v23(driver_id));
DROP POLICY IF EXISTS driver_jobs_anonymous_read_v23 ON public.jobs;
CREATE POLICY driver_jobs_anonymous_read_v23 ON public.jobs AS RESTRICTIVE FOR SELECT TO anon USING (false);
DROP POLICY IF EXISTS driver_earnings_anonymous_read_v23 ON public.driver_earnings;
CREATE POLICY driver_earnings_anonymous_read_v23 ON public.driver_earnings AS RESTRICTIVE FOR SELECT TO anon USING (false);
-- Do not let authenticated drivers move markets by editing profile mirrors.
CREATE OR REPLACE FUNCTION public.protect_driver_operating_market_v23()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
BEGIN
 IF auth.role() IN ('anon','authenticated') AND (
   (OLD.role='driver' AND (
     OLD.registration_country_code IS DISTINCT FROM NEW.registration_country_code OR OLD.country_code IS DISTINCT FROM NEW.country_code
     OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.role IS DISTINCT FROM NEW.role))
   OR (NEW.role IN ('admin','super_admin') AND OLD.role IS DISTINCT FROM NEW.role)
   OR OLD.registration_activated_at IS DISTINCT FROM NEW.registration_activated_at
   OR to_jsonb(OLD)->>'stripe_account_id' IS DISTINCT FROM to_jsonb(NEW)->>'stripe_account_id'
   OR to_jsonb(OLD)->>'stripe_connect_account_id' IS DISTINCT FROM to_jsonb(NEW)->>'stripe_connect_account_id'
   OR to_jsonb(OLD)->>'stripe_connected_account_id' IS DISTINCT FROM to_jsonb(NEW)->>'stripe_connected_account_id'
   OR to_jsonb(OLD)->>'stripe_connect_id' IS DISTINCT FROM to_jsonb(NEW)->>'stripe_connect_id'
   OR to_jsonb(OLD)->>'stripe_connect_status' IS DISTINCT FROM to_jsonb(NEW)->>'stripe_connect_status'
   OR to_jsonb(OLD)->>'charges_enabled' IS DISTINCT FROM to_jsonb(NEW)->>'charges_enabled'
   OR to_jsonb(OLD)->>'payouts_enabled' IS DISTINCT FROM to_jsonb(NEW)->>'payouts_enabled') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='DRIVER_MARKET_CHANGE_REQUIRES_REVIEW';
 END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.protect_driver_operating_market_v23() FROM PUBLIC;
DROP TRIGGER IF EXISTS protect_driver_operating_market_v23 ON public.profiles;
CREATE TRIGGER protect_driver_operating_market_v23 BEFORE UPDATE
 ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.protect_driver_operating_market_v23();
NOTIFY pgrst,'reload schema';
COMMIT;
