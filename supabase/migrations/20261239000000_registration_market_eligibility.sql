-- Phase 1 — Registration market eligibility authority.
--
-- Establishes a durable distinction between:
--   AUTHENTICATED          a Supabase identity/session exists
--   REGISTRATION-ELIGIBLE  Movabi's server validated a market capability
--   ONBOARDED              existing role/onboarding semantics (UNCHANGED)
--
-- Semantics
--   profiles.registration_activated_at IS NULL      -> registration PENDING
--   profiles.registration_activated_at IS NOT NULL  -> registration ACTIVATED
--
-- Only the server may set registration_activated_at. Raw Supabase auth metadata
-- is untrusted pending context and can never activate an identity.
--
-- This migration is forward-only and does not modify any historical migration.

-- ---------------------------------------------------------------------------
-- 1. Activation marker + validated registration context (idempotent adds).
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS registration_activated_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS registration_country_code text,
  ADD COLUMN IF NOT EXISTS registration_market_city text;

COMMENT ON COLUMN public.profiles.registration_activated_at IS
  'Server-authoritative registration-market activation. NULL = authenticated but registration-pending. Only the Movabi server (or this migration''s grandfathering) may set it.';
COMMENT ON COLUMN public.profiles.registration_country_code IS
  'Normalized ISO2 registration country that PASSED market capability validation.';
COMMENT ON COLUMN public.profiles.registration_market_city IS
  'Normalized registration market city that PASSED market capability validation.';

-- ---------------------------------------------------------------------------
-- 2. country_code must not silently claim a market for a pending identity.
--    The previous NOT NULL + DEFAULT 'GB' meant every new identity (including
--    Google OAuth with no country) was recorded as GB.
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles ALTER COLUMN country_code DROP DEFAULT;
ALTER TABLE public.profiles ALTER COLUMN country_code DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Grandfather EVERY profile that already exists as registration-activated.
--    Deterministic and independent of location/IP/GPS/current country.
--    Runs BEFORE any new-profile default could apply, so no existing production
--    user can be locked out by this phase.
-- ---------------------------------------------------------------------------
UPDATE public.profiles
   SET registration_activated_at = COALESCE(created_at, now())
 WHERE registration_activated_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. handle_new_user(): new identities are created registration-PENDING.
--
--    Preserves the CURRENT effective behaviour that must not regress:
--      * role stays NULL so first-time role selection still occurs later
--      * tenant resolution via the movabi-global tenant
--      * tenant_users mapping row
--      * SECURITY DEFINER execution (runs on GoTrue's own insert path)
--    Changes only what this phase requires:
--      * no hard-coded country_code (was silently 'GB' via the column default)
--      * registration metadata seeds PENDING context only; it never activates
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_full_name TEXT;
  v_registration_country TEXT;
  v_registration_city TEXT;
BEGIN
  SELECT id INTO v_tenant_id
  FROM public.tenants
  WHERE slug = 'movabi-global'
  LIMIT 1;

  v_full_name := COALESCE(new.raw_user_meta_data->>'full_name', 'User');

  -- UNTRUSTED pending context only: normalized, never authoritative.
  v_registration_country := NULLIF(upper(trim(COALESCE(new.raw_user_meta_data->>'registration_country_code', ''))), '');
  v_registration_city := NULLIF(trim(COALESCE(new.raw_user_meta_data->>'registration_market_city', '')), '');

  INSERT INTO public.profiles (
    id,
    tenant_id,
    full_name,
    role,
    onboarding_completed,
    country_code,
    registration_country_code,
    registration_market_city,
    registration_activated_at
  )
  VALUES (
    new.id,
    v_tenant_id,
    v_full_name,
    NULL,                 -- first-time role selection happens later
    false,
    NULL,                 -- never fabricate a country (no silent 'GB')
    v_registration_country,
    v_registration_city,
    NULL                  -- ALWAYS pending; metadata cannot self-activate
  );

  INSERT INTO public.tenant_users (tenant_id, user_id, role)
  VALUES (v_tenant_id, new.id, 'user');

  RETURN new;
END;
$$;

-- Trigger definition is unchanged in shape; recreated for determinism.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 5. Registration authority guard.
--    Registration eligibility is server-authoritative. An authenticated client
--    must never be able to manufacture activation by updating its own profile.
--    Mirrors the trusted-path detection of enforce_profiles_ownership_guard:
--    service_role and no-JWT (SECURITY DEFINER bootstrap) writes bypass.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_registration_authority_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT := auth.role();
BEGIN
  -- Trusted server writes (service_role) and no-JWT paths bypass.
  IF v_role IS NULL OR v_role = 'service_role' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF NEW.registration_activated_at IS DISTINCT FROM OLD.registration_activated_at
     OR NEW.registration_country_code IS DISTINCT FROM OLD.registration_country_code
     OR NEW.registration_market_city IS DISTINCT FROM OLD.registration_market_city THEN
    RAISE EXCEPTION 'Registration eligibility is server-authoritative and cannot be written directly.'
      USING ERRCODE = '42501', CONSTRAINT = 'trg_registration_authority_guard';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_registration_authority_guard ON public.profiles;
CREATE TRIGGER trg_registration_authority_guard
  BEFORE UPDATE OF registration_activated_at, registration_country_code, registration_market_city
  ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_registration_authority_guard();
