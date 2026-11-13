-- Area 3 (2026-11-13): per-driver completion PIN control, market-isolated.
--
-- When a driver is assigned to a job (driver_id set or changed), the policy in force is frozen onto
-- the job's metadata so the customer app, the driver app and the server completion check all
-- read the same value:
--   completion_pin_effective   'required' | 'optional' | 'disabled'
--   completion_pin_source      'driver' (the driver's override) | 'market' (the booking market's policy)
--   completion_pin_driver_id   the driver it was resolved for (a reassignment re-resolves)
--   completion_pin_required    effective <> 'disabled' (the flag both apps already read)
-- Precedence: the driver's override in driver_pin_policies FOR THE JOB'S TENANT, then the booking
-- market's policy (metadata.completion_pin_market_policy, written by the API from the tenant's
-- setting for the booking's own country), then required. An override in another tenant never applies.
--
-- When the effective policy is not 'disabled' and the job has no completion secret yet (a market
-- that disables the PIN, with a driver whose override requires it), a 4-digit PIN is minted from
-- gen_random_uuid() randomness into the customer-only job_completion_secrets table.
--
-- Changes nothing for jobs that already have a driver; existing policies and secrets are kept.
-- Rollback: 20261270100000_completion_pin_effective.down.sql.

CREATE OR REPLACE FUNCTION public.completion_pin_market_policy(p_metadata jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT CASE
    WHEN p_metadata->>'completion_pin_market_policy' IN ('required','optional','disabled') THEN p_metadata->>'completion_pin_market_policy'
    WHEN p_metadata ? 'completion_pin_market_policy' THEN 'required'   -- unreadable value: fail closed
    WHEN p_metadata->>'completion_pin_required' = 'false' THEN 'disabled'
    ELSE 'required' END $$;
REVOKE ALL ON FUNCTION public.completion_pin_market_policy(jsonb) FROM PUBLIC;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON FUNCTION public.completion_pin_market_policy(jsonb) FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON FUNCTION public.completion_pin_market_policy(jsonb) FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public.completion_pin_market_policy(jsonb) TO service_role; END IF;
END $g$;

CREATE OR REPLACE FUNCTION public.stamp_completion_pin_policy() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE v_override text; v_effective text;
BEGIN
  IF NEW.driver_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.driver_id IS NOT DISTINCT FROM OLD.driver_id THEN RETURN NEW; END IF;
  SELECT p.policy INTO v_override FROM public.driver_pin_policies p
   WHERE p.driver_id = NEW.driver_id AND p.tenant_id = NEW.tenant_id;
  v_effective := coalesce(v_override, public.completion_pin_market_policy(coalesce(NEW.metadata, '{}'::jsonb)));
  NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object(
    'completion_pin_effective', v_effective,
    'completion_pin_source', CASE WHEN v_override IS NULL THEN 'market' ELSE 'driver' END,
    'completion_pin_driver_id', NEW.driver_id,
    'completion_pin_required', v_effective <> 'disabled');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.stamp_completion_pin_policy() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.mint_completion_pin_on_assignment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE v_pin text;
BEGIN
  IF NEW.driver_id IS NULL OR coalesce(NEW.metadata->>'completion_pin_effective', 'disabled') = 'disabled' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.driver_id IS NOT DISTINCT FROM OLD.driver_id THEN RETURN NULL; END IF;
  -- 1000..9999 from 32 random bits of a v4 UUID (cryptographically random in PostgreSQL 13+).
  v_pin := (1000 + (('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 9000))::text;
  INSERT INTO public.job_completion_secrets(job_id, completion_pin) VALUES (NEW.id, v_pin)
  ON CONFLICT (job_id) DO NOTHING;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.mint_completion_pin_on_assignment() FROM PUBLIC;

-- Supabase grants EXECUTE on new functions to anon/authenticated by default privileges, so revoking
-- from PUBLIC is not enough: the trigger functions are executable by no client role.
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.stamp_completion_pin_policy() FROM anon;
    REVOKE ALL ON FUNCTION public.mint_completion_pin_on_assignment() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON FUNCTION public.stamp_completion_pin_policy() FROM authenticated;
    REVOKE ALL ON FUNCTION public.mint_completion_pin_on_assignment() FROM authenticated;
  END IF;
END $g$;

-- zz_: runs after the other BEFORE triggers on jobs, so their checks see the row as submitted.
DROP TRIGGER IF EXISTS zz_stamp_completion_pin_policy ON public.jobs;
CREATE TRIGGER zz_stamp_completion_pin_policy BEFORE INSERT OR UPDATE OF driver_id ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.stamp_completion_pin_policy();
DROP TRIGGER IF EXISTS zz_mint_completion_pin_on_assignment ON public.jobs;
CREATE TRIGGER zz_mint_completion_pin_on_assignment AFTER INSERT OR UPDATE OF driver_id ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.mint_completion_pin_on_assignment();

-- Compatibility checks (fail the transaction rather than leave a half state).
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.job_completion_secrets'::regclass AND contype IN ('p','u')
                 AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.job_completion_secrets'::regclass AND attname='job_id')]::int2[]) THEN
    RAISE EXCEPTION 'job_completion_secrets.job_id must be unique for ON CONFLICT (job_id)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.driver_pin_policies'::regclass AND contype='p') THEN
    RAISE EXCEPTION 'driver_pin_policies must have its (driver_id, tenant_id) primary key';
  END IF;
END $c$;
