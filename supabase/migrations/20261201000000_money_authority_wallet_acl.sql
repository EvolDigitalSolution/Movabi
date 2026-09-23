-- ============================================================================
-- MOVABI PHASE C2B — WALLET & MARKETPLACE RPC LEAST-PRIVILEGE ACL
-- ============================================================================
--
-- PURPOSE
--   Close the PUBLIC/anon EXECUTE exposure of money-crediting and negotiation
--   functions that have NO legitimate client caller. Production facts (C1
--   diagnostic) established:
--     credit_wallet_topup          : 2 overloads, PUBLIC/anon/authenticated/service_role
--     finalize_wallet_topup        : 2 overloads, PUBLIC/anon/authenticated/service_role
--     pay_job_from_wallet          : PUBLIC/anon/authenticated/service_role
--     claim/release/fetch_hybrid   : SECURITY DEFINER, PUBLIC/anon EXECUTE
--     get_marketplace_commission/setting : SECURITY DEFINER, PUBLIC/anon EXECUTE
--     settle_job_wallet_reservation: already service_role (correct)
--
-- CALLER VERIFICATION (in-repo, exhaustive)
--   credit_wallet_topup       : NO caller                       -> revoke from everyone
--   finalize_wallet_topup     : payment.routes.ts:511, webhook.routes.ts:58,
--                               reconciliation.service.ts:42   -> service_role only
--   pay_job_from_wallet       : wallet.routes.ts:119            -> service_role only
--   get_marketplace_commission: NO caller                       -> service_role only
--   get_marketplace_setting   : NO caller                       -> service_role only
--   claim/release/fetch_hybrid: marketplace-hybrid.service.ts (authenticated drivers)
--                                                              -> authenticated only (revoke PUBLIC/anon)
--
-- SAFETY
--   * Forward-only, idempotent (REVOKE/GRANT are idempotent; the DO block re-derives
--     live overloads and revokes only roles that are safe to revoke).
--   * Does NOT depend on replayed historical migrations: it revokes from functions
--     that production already contains.
--   * Does NOT change any function BODY; it only narrows EXECUTE. It does not touch
--     RLS, triggers, the N12 frozen statuses, MB001, MB002, or the Phase A trigger.
--   * settle_job_wallet_reservation and lock_marketplace_fare are already correctly
--     restricted and are deliberately left untouched.
--
-- NOTE ON UNKNOWN OVERLOADS
--   Production has a second credit_wallet_topup overload and a SECURITY DEFINER
--   finalize_wallet_topup overload with no repository source. The final DO block
--   therefore enumerates pg_proc and revokes anon/authenticated from EVERY live
--   overload of the two wallet-credit functions, so an out-of-band signature cannot
--   escape the revoke.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. credit_wallet_topup — no caller; SECURITY DEFINER; arbitrary credit hole.
--    Revoke from every role on the known signature, then let the DO block catch
--    any additional production overload.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.credit_wallet_topup(uuid, numeric, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credit_wallet_topup(uuid, numeric, text, text) FROM anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. finalize_wallet_topup — server-only (service_role). Revoke client roles.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.finalize_wallet_topup(uuid, numeric, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.finalize_wallet_topup(uuid, numeric, text) FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.finalize_wallet_topup(uuid, numeric, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.finalize_wallet_topup(uuid, numeric, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_wallet_topup(uuid, numeric, text, text) TO service_role;

-- ----------------------------------------------------------------------------
-- 3. pay_job_from_wallet — server-only (service_role). Revoke client roles.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.pay_job_from_wallet(uuid, uuid, numeric, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pay_job_from_wallet(uuid, uuid, numeric, text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pay_job_from_wallet(uuid, uuid, numeric, text, uuid) TO service_role;

-- ----------------------------------------------------------------------------
-- 4. Marketplace read helpers — no caller. Revoke client roles.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.get_marketplace_commission(text, text, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_marketplace_commission(text, text, text, uuid) FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.get_marketplace_setting(text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_marketplace_setting(text, uuid) FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5. Marketplace negotiation RPCs — authenticated drivers are the legitimate
--    callers; revoke PUBLIC and anon only. (auth.uid() body guards are C2B.1.)
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.claim_marketplace_negotiation(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_marketplace_negotiation(uuid, uuid) FROM anon;

REVOKE ALL ON FUNCTION public.release_marketplace_negotiation(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.release_marketplace_negotiation(uuid, uuid, text) FROM anon;

REVOKE ALL ON FUNCTION public.fetch_hybrid_opportunities(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(uuid) FROM anon;

-- ----------------------------------------------------------------------------
-- 5b. Marketplace negotiation RPC body guards (auth.uid() identity).
--     ACL alone is insufficient: these are SECURITY DEFINER and authenticated
--     drivers call them directly, so caller-supplied p_driver_id must be bound
--     to auth.uid(). service_role (auth.uid() IS NULL) keeps its trusted path.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_marketplace_negotiation(
  p_job_id UUID,
  p_driver_id UUID
)
RETURNS public.marketplace_negotiation_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.marketplace_negotiation_sessions;
  v_job public.jobs;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_driver_id THEN
    RAISE EXCEPTION 'A driver may only claim a session for themselves';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No negotiation session found for this job';
  END IF;

  IF v_session.status NOT IN ('open', 'released') OR v_session.active_driver_id IS NOT NULL THEN
    RAISE EXCEPTION 'Session already claimed';
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id;

  IF v_job.status NOT IN ('pending_fare_confirmation', 'negotiating', 'open') THEN
    RAISE EXCEPTION 'Job is not available for negotiation';
  END IF;

  UPDATE public.marketplace_negotiation_sessions
  SET active_driver_id = p_driver_id,
      status = 'negotiating',
      claimed_at = now(),
      expires_at = now() + interval '120 seconds',
      updated_at = now()
  WHERE job_id = p_job_id
  RETURNING * INTO v_session;

  INSERT INTO public.marketplace_negotiation_events
    (session_id, job_id, proposed_by, proposed_by_role, event_type, round_number, created_at)
  VALUES
    (v_session.id, p_job_id, p_driver_id, 'driver', 'session_claimed', v_session.round_count, now());

  RETURN v_session;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_marketplace_negotiation(
  p_job_id UUID,
  p_driver_id UUID,
  p_reason TEXT
)
RETURNS public.marketplace_negotiation_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.marketplace_negotiation_sessions;
BEGIN
  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No negotiation session found';
  END IF;

  -- An authenticated caller may only release their OWN session, and the old
  -- p_reason='system' bypass is closed. service_role (auth.uid() NULL) keeps
  -- the trusted system path.
  IF auth.uid() IS NOT NULL THEN
    IF auth.uid() <> p_driver_id OR auth.uid() <> v_session.active_driver_id THEN
      RAISE EXCEPTION 'A driver may only release their own session';
    END IF;
  END IF;

  UPDATE public.marketplace_negotiation_sessions
  SET active_driver_id = NULL,
      status = 'released',
      attempt_count = attempt_count + 1,
      driver_counter_offer = NULL,
      updated_at = now()
  WHERE job_id = p_job_id
  RETURNING * INTO v_session;

  INSERT INTO public.driver_job_declines (driver_id, job_id, reason)
  VALUES (p_driver_id, p_job_id, p_reason)
  ON CONFLICT (driver_id, job_id) DO NOTHING;

  INSERT INTO public.marketplace_negotiation_events
    (session_id, job_id, proposed_by, proposed_by_role, event_type, message, round_number, created_at)
  VALUES
    (v_session.id, p_job_id, p_driver_id, 'driver', 'session_released', p_reason, v_session.round_count, now());

  RETURN v_session;
END;
$$;

CREATE OR REPLACE FUNCTION public.fetch_hybrid_opportunities(
  p_driver_id UUID
)
RETURNS TABLE (
  session_id UUID,
  job_id UUID,
  customer_id UUID,
  suggested_fare NUMERIC,
  customer_offer NUMERIC,
  distance_km NUMERIC,
  eta_seconds INTEGER,
  service_name TEXT,
  service_slug TEXT,
  pickup_address TEXT,
  dropoff_address TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_driver_id THEN
    RAISE EXCEPTION 'A driver may only list their own opportunities';
  END IF;

  RETURN QUERY
  SELECT
    s.id AS session_id,
    s.job_id,
    s.customer_id,
    s.suggested_fare,
    s.customer_offer,
    (j.metadata->>'distance_km')::NUMERIC AS distance_km,
    (j.metadata->>'duration_seconds')::INTEGER AS eta_seconds,
    COALESCE(st.name, 'Request') AS service_name,
    COALESCE(st.slug, '') AS service_slug,
    j.pickup_address,
    j.dropoff_address
  FROM public.marketplace_negotiation_sessions s
  JOIN public.jobs j ON j.id = s.job_id
  LEFT JOIN public.service_types st ON st.id = j.service_type_id
  WHERE s.status IN ('open', 'released')
    AND s.active_driver_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.driver_job_declines d
      WHERE d.driver_id = p_driver_id AND d.job_id = s.job_id
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Catch-all for out-of-band wallet-credit overloads (e.g. the unknown second
--    credit_wallet_topup signature, and a SECURITY DEFINER finalize overload).
--    Revoke anon/authenticated from every live overload so no signature escapes.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    fn record;
BEGIN
    FOR fn IN
        SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('credit_wallet_topup', 'finalize_wallet_topup', 'pay_job_from_wallet')
    LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM anon, authenticated',
                       fn.proname, fn.args);
        EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC',
                       fn.proname, fn.args);
    END LOOP;
END
$$;

COMMIT;
