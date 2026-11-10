-- =============================================================================
-- Driver market-isolation trigger: SECURITY DEFINER.
-- protect_driver_operating_market_v23 calls auth.role(), but it is SECURITY
-- INVOKER, so a service_role profile write (the admin account-status endpoint)
-- failed with "permission denied for schema auth" whenever the invoker lacked
-- auth-schema USAGE. The trigger only reads OLD/NEW and raises; running it as
-- its owner is safe and matches the other auth-reading triggers.
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.protect_driver_operating_market_v23()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
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
GRANT EXECUTE ON FUNCTION public.protect_driver_operating_market_v23() TO authenticated, service_role;

COMMIT;
