-- ============================================================================
-- Movabi 2.1 — Profiles authorization hardening
-- Additive + idempotent. Applied MANUALLY / out-of-band (no migration ledger).
--
--   1. REVOKE anonymous write authority on public.profiles (anon SELECT retained).
--   2. BEFORE UPDATE trigger protecting verified-driver identity columns
--      (full_name, date_of_birth, country_code) from direct non-service_role
--      writes.
--   3. Authenticated ownership guard (INSERT/UPDATE/DELETE must target the
--      caller's own row), with service_role / no-JWT bypass.
--
-- Does NOT: enable RLS, or touch Phase-A / N12 / MB001 / MB002.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Anonymous write revocation.
--    Profile bootstrap for new signups runs through public.handle_new_user()
--    which is SECURITY DEFINER (owner-privileged), so it is unaffected.
--    No unauthenticated flow legitimately INSERTs/UPDATEs/DELETEs/TRUNCATEs
--    public.profiles. anon SELECT is intentionally retained.
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.profiles FROM anon;

-- ---------------------------------------------------------------------------
-- 2. Verified-driver identity guard.
--    Trusted-role detection uses auth.role() (the verified production helper).
--    The verified-driver predicate mirrors DriverIdentityEditabilityService:
--
--        const status = String(profile.driver_review_status
--                              || profile.verification_status || '').toLowerCase();
--        const verified = profile.is_verified === true || status === 'approved';
--
--    No-op updates pass (IS DISTINCT FROM). Protected fields must be one of
--    full_name / date_of_birth / country_code.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_verified_driver_identity_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role     TEXT := auth.role();
    v_verified BOOLEAN;
BEGIN
    -- Trusted server writes (service_role) and any no-JWT path bypass.
    IF v_role IS NULL OR v_role = 'service_role' THEN
        RETURN NEW;
    END IF;

    -- Non-driver rows (customers, etc.) are unaffected.
    IF OLD.role IS DISTINCT FROM 'driver' THEN
        RETURN NEW;
    END IF;

    -- Exact verified-driver predicate (see header comment).
    v_verified := (OLD.is_verified = true)
        OR (lower(COALESCE(NULLIF(OLD.driver_review_status, ''),
                           NULLIF(OLD.verification_status, ''), '')) = 'approved');

    IF NOT v_verified THEN
        RETURN NEW;
    END IF;

    IF NEW.full_name IS DISTINCT FROM OLD.full_name THEN
        RAISE EXCEPTION 'A verified driver cannot change their legal name directly.'
            USING ERRCODE = '42501', CONSTRAINT = 'trg_verified_driver_identity_guard';
    END IF;
    IF NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth THEN
        RAISE EXCEPTION 'A verified driver cannot change their date of birth directly.'
            USING ERRCODE = '42501', CONSTRAINT = 'trg_verified_driver_identity_guard';
    END IF;
    IF NEW.country_code IS DISTINCT FROM OLD.country_code THEN
        RAISE EXCEPTION 'A verified driver cannot change their country directly.'
            USING ERRCODE = '42501', CONSTRAINT = 'trg_verified_driver_identity_guard';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_verified_driver_identity_guard ON public.profiles;
CREATE TRIGGER trg_verified_driver_identity_guard
    BEFORE UPDATE OF full_name, date_of_birth, country_code
    ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_verified_driver_identity_guard();

-- ---------------------------------------------------------------------------
-- 3. Authenticated ownership guard.
--    A direct authenticated client write must target the caller's own profile.
--    Trusted paths (service_role) and no-JWT paths (e.g. the SECURITY DEFINER
--    signup bootstrap public.handle_new_user(), which runs on GoTrue's own
--    connection where auth.role() IS NULL) bypass. Fail closed if an
--    authenticated caller has no resolvable auth.uid().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_profiles_ownership_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role TEXT := auth.role();
    v_uid  UUID := auth.uid();
BEGIN
    -- Trusted server writes (service_role) and no-JWT paths bypass.
    IF v_role IS NULL OR v_role = 'service_role' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Only authenticated clients are subject to ownership enforcement.
    IF v_role <> 'authenticated' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Fail closed: an authenticated caller must have a resolvable identity.
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Authenticated profile write requires a caller identity.'
            USING ERRCODE = '42501', CONSTRAINT = 'trg_profiles_ownership_guard';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.id IS DISTINCT FROM v_uid THEN
            RAISE EXCEPTION 'Authenticated users can only insert their own profile.'
                USING ERRCODE = '42501', CONSTRAINT = 'trg_profiles_ownership_guard';
        END IF;
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.id IS DISTINCT FROM v_uid THEN
            RAISE EXCEPTION 'Authenticated users can only update their own profile.'
                USING ERRCODE = '42501', CONSTRAINT = 'trg_profiles_ownership_guard';
        END IF;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        IF OLD.id IS DISTINCT FROM v_uid THEN
            RAISE EXCEPTION 'Authenticated users can only delete their own profile.'
                USING ERRCODE = '42501', CONSTRAINT = 'trg_profiles_ownership_guard';
        END IF;
        RETURN OLD;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_ownership_guard_insert ON public.profiles;
CREATE TRIGGER trg_profiles_ownership_guard_insert
    BEFORE INSERT ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_profiles_ownership_guard();

DROP TRIGGER IF EXISTS trg_profiles_ownership_guard_update ON public.profiles;
CREATE TRIGGER trg_profiles_ownership_guard_update
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_profiles_ownership_guard();

DROP TRIGGER IF EXISTS trg_profiles_ownership_guard_delete ON public.profiles;
CREATE TRIGGER trg_profiles_ownership_guard_delete
    BEFORE DELETE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_profiles_ownership_guard();
