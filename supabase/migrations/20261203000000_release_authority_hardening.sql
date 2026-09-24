-- ============================================================================
-- MOVABI 2.1 FINAL RELEASE CLOSURE — AUTHORITY HARDENING (forward-only)
-- ============================================================================
-- Closes the direct-client and unprivileged acquisition authority gaps proven
-- by the Phase C release audit:
--
--   1. jobs RLS UPDATE policy was row-level only (no column restriction), so a
--      client (customer/driver/any-user-on-pending) could write payment_status,
--      status, driver_id, agreed_fare, price, commission, payout, payment_intent_id
--      and stripe_* directly, bypassing every server/RPC authority.
--   2. assign_driver_to_job had no admin/privileged authority check and was
--      EXECUTE-granted to authenticated.
--   3. claim/release/fetch_hybrid_opportunities had no identity check and were
--      left at the permissive default ACL (PUBLIC + anon + authenticated).
--
-- All changes are schema-qualified, idempotent (REVOKE IF NOT EXISTS semantics
-- via REVOKE / CREATE OR REPLACE), and preserve service_role + table-owner
-- authority. Phase A is NOT enabled here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Close direct-client money/acquisition writes on public.jobs.
--    The client may only write lifecycle + geography columns; every money and
--    ownership column is server/RPC-authoritative only.
-- ----------------------------------------------------------------------------
REVOKE UPDATE ON public.jobs FROM anon, authenticated;

GRANT UPDATE (
  status,
  pickup_lat,
  pickup_lng,
  dropoff_lat,
  dropoff_lng,
  negotiation_mode_enabled,
  updated_at,
  expiry_reason,
  expired_at,
  is_draft
) ON public.jobs TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. assign_driver_to_job: require privileged (service_role or tenant admin)
--    authority. The server self-accept path calls this via service_role
--    (auth.uid() is NULL); the admin client calls it with an authenticated JWT
--    and must be a tenant admin.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_driver_to_job(
    p_job_id UUID,
    p_driver_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_updated BOOLEAN;
    v_constraint TEXT;
BEGIN
    -- Release closure: a non-service_role caller must be a tenant admin.
    IF auth.uid() IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM public.profiles
        WHERE id = auth.uid() AND role = 'admin'
    ) THEN
        RAISE EXCEPTION 'Only an administrator can assign a driver to a job';
    END IF;

    IF NOT public.driver_vehicle_can_accept_job(p_job_id, p_driver_id) THEN
        RAISE EXCEPTION 'Driver vehicle is not compatible with this request';
    END IF;

    -- N12 (secondary, deterministic UX only). The target job is excluded, so an
    -- idempotent re-assignment of a job this driver already owns behaves as
    -- before. The unique index still decides the race.
    IF public.driver_has_other_active_job(p_driver_id, p_job_id) THEN
        RAISE EXCEPTION 'Driver already has an active job'
            USING ERRCODE = 'MB001',
                  CONSTRAINT = 'idx_jobs_one_active_per_driver',
                  DETAIL = 'driver_single_active_job';
    END IF;

    BEGIN
        UPDATE public.jobs
        SET driver_id = p_driver_id,
            status = 'assigned',
            updated_at = NOW()
        WHERE id = p_job_id
          AND status IN ('pending', 'requested', 'searching')
          AND driver_id IS NULL;

        v_updated := FOUND;
    EXCEPTION
        WHEN unique_violation THEN
            GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
            IF v_constraint = 'idx_jobs_one_active_per_driver' THEN
                RAISE EXCEPTION 'Driver already has an active job'
                    USING ERRCODE = 'MB001',
                          CONSTRAINT = 'idx_jobs_one_active_per_driver',
                          DETAIL = 'driver_single_active_job';
            END IF;
            RAISE;
    END;

    RETURN v_updated;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. claim_marketplace_negotiation: bind driver identity to auth.uid().
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_marketplace_negotiation(
  p_job_id UUID,
  p_driver_id UUID
)
RETURNS public.marketplace_negotiation_sessions AS $$
DECLARE
  v_session public.marketplace_negotiation_sessions;
  v_job public.jobs;
BEGIN
  -- Release closure: a driver may only claim for themselves.
  IF auth.uid() IS NULL OR auth.uid() <> p_driver_id THEN
    RAISE EXCEPTION 'You can only claim a negotiation for yourself';
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ----------------------------------------------------------------------------
-- 4. release_marketplace_negotiation: bind identity; close the p_reason='system'
--    bypass for non-service_role callers.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_marketplace_negotiation(
  p_job_id UUID,
  p_driver_id UUID,
  p_reason TEXT
)
RETURNS public.marketplace_negotiation_sessions AS $$
DECLARE
  v_session public.marketplace_negotiation_sessions;
BEGIN
  -- Release closure: a non-service_role caller must act for themselves and may
  -- not spoof a system release.
  IF auth.uid() IS NOT NULL THEN
    IF auth.uid() <> p_driver_id THEN
      RAISE EXCEPTION 'You can only release your own negotiation session';
    END IF;
    IF p_reason = 'system' THEN
      RAISE EXCEPTION 'System release requires service role';
    END IF;
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No negotiation session found';
  END IF;

  IF v_session.active_driver_id IS DISTINCT FROM p_driver_id AND p_reason <> 'system' THEN
    RAISE EXCEPTION 'Only active driver or system can release session';
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ----------------------------------------------------------------------------
-- 5. fetch_hybrid_opportunities: bind driver identity to auth.uid().
-- ----------------------------------------------------------------------------
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
) AS $$
BEGIN
  -- Release closure: a driver may only fetch their own opportunities.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_driver_id THEN
    RAISE EXCEPTION 'You can only fetch your own opportunities';
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ----------------------------------------------------------------------------
-- 6. ACL for the three marketplace RPCs: authenticated + service_role only,
--    never PUBLIC/anon.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.claim_marketplace_negotiation(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_marketplace_negotiation(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fetch_hybrid_opportunities(uuid) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.claim_marketplace_negotiation(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.release_marketplace_negotiation(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(uuid) FROM anon;

GRANT EXECUTE ON FUNCTION public.claim_marketplace_negotiation(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_marketplace_negotiation(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(uuid) TO authenticated, service_role;
