-- =============================================================================
-- 20261232000000_negotiation_eligibility_parity.sql
--
-- PRODUCTION-PROVEN DEFECT (bike-only driver ↔ errand negotiation)
--   Ordinary acquisition enforces service/vehicle compatibility through
--   public.driver_vehicle_can_accept_job(uuid,uuid) — the canonical predicate the
--   ordinary accept RPC (public.accept_searching_job) already calls. The hybrid
--   negotiation path never called it, so a BIKE-only driver could DISCOVER and
--   CLAIM an ERRAND negotiation (this became active_driver_id on production
--   sessions 9994e5b1… / ee5e4ab9…) even though ordinary dispatch correctly does
--   not expose that errand to them.
--
--   The predicate derives the required class from the job (errand → 'car' unless
--   metadata carries an explicit vehicle class) and the driver's class from
--   public.vehicles; a bike vehicle is accepted only when the job requires 'bike'.
--
-- WHAT THIS MIGRATION DOES (additive; no existing migration is edited or reapplied)
--   Re-issues four existing functions UNCHANGED except for two added guards:
--     * eligibility parity — public.driver_vehicle_can_accept_job(...)
--     * expiry parity      — the opportunity/session must not be past expires_at
--   Applied at BOTH the discovery boundary and every driver transition that can
--   establish or retain authority, so eligibility is re-checked when the driver
--   ACTS and not merely when the opportunity list was fetched (TOCTOU).
--
-- DELIBERATELY UNCHANGED
--   * trg_enforce_job_acquisition_eligibility remains DISABLED (not enabled here).
--   * The frozen N12 occupying-status list and MB001/MB002 semantics are untouched.
--   * driver_vehicle_can_accept_job itself is NOT redefined — it is reused as-is.
--   * Session timeouts, pricing, platform fee, commission and payment are untouched.
--
-- ACL: CREATE OR REPLACE preserves the existing ACL on an existing function, so
-- the migration 310 grants/revokes remain in force. The ACL is re-asserted at the
-- end anyway, so this file is also safe if ever applied where a function is absent.
-- =============================================================================

-- ===========================================================================
-- 1. DISCOVERY — fetch_hybrid_opportunities(p_driver_id)
--    Re-issued verbatim from the hardened definition (identity guard + safe
--    distance/duration parsing) with eligibility + expiry added to the filter.
-- ===========================================================================
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
SET search_path = public
AS $$
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
    CASE
      WHEN BTRIM(j.metadata->>'distance_km') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN (BTRIM(j.metadata->>'distance_km'))::NUMERIC
      ELSE NULL
    END AS distance_km,
    CASE
      WHEN BTRIM(j.metadata->>'duration_seconds') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN LEAST(2147483647::NUMERIC, ROUND((BTRIM(j.metadata->>'duration_seconds'))::NUMERIC))::INTEGER
      ELSE NULL
    END AS eta_seconds,
    COALESCE(st.name, 'Request') AS service_name,
    COALESCE(st.slug, '') AS service_slug,
    j.pickup_address,
    j.dropoff_address
  FROM public.marketplace_negotiation_sessions s
  JOIN public.jobs j ON j.id = s.job_id
  LEFT JOIN public.service_types st ON st.id = j.service_type_id
  WHERE s.status IN ('open', 'released')
    AND s.active_driver_id IS NULL
    -- ELIGIBILITY PARITY: the same canonical predicate ordinary acquisition uses.
    AND public.driver_vehicle_can_accept_job(s.job_id, p_driver_id)
    -- EXPIRY PARITY: never surface a session past its own expiry, even before the
    -- cleanup service has transitioned it to 'expired'.
    AND s.expires_at > now()
    AND NOT EXISTS (
      SELECT 1 FROM public.driver_job_declines d
      WHERE d.driver_id = p_driver_id AND d.job_id = s.job_id
    );
END;
$$;

-- ===========================================================================
-- 2. CLAIM — claim_marketplace_negotiation(p_job_id, p_driver_id)
--    Re-issued verbatim from 20261203000000_release_authority_hardening.sql with
--    the identity guard preserved and eligibility + expiry added.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.claim_marketplace_negotiation(
  p_job_id UUID,
  p_driver_id UUID
)
RETURNS public.marketplace_negotiation_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.marketplace_negotiation_sessions;
  v_job public.jobs;
BEGIN
  -- Release closure: a driver may only claim for themselves.
  IF auth.uid() IS NULL OR auth.uid() <> p_driver_id THEN
    RAISE EXCEPTION 'You can only claim a negotiation for yourself';
  END IF;

  -- ELIGIBILITY PARITY: an ineligible driver must never become the active driver.
  -- Checked here as well as at discovery, because discovery is advisory and the
  -- driver's vehicle/eligibility may have changed since the list was fetched.
  IF NOT public.driver_vehicle_can_accept_job(p_job_id, p_driver_id) THEN
    RAISE EXCEPTION 'You are not eligible for this service';
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

  -- EXPIRY PARITY: a session past its own expiry cannot be newly claimed.
  IF v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'Negotiation has expired';
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

-- ===========================================================================
-- 3. DRIVER COUNTER — driver_counter_offer(p_session_id, p_amount)
--    Re-issued verbatim from 20261231000000 with an eligibility re-check added
--    (TOCTOU: eligibility can change after the claim).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.driver_counter_offer(
  p_session_id UUID,
  p_amount NUMERIC
)
RETURNS public.marketplace_negotiation_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_session public.marketplace_negotiation_sessions;
  v_job public.jobs;
  v_max_rounds INTEGER;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Counter amount must be a positive value';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Negotiation session not found';
  END IF;

  -- Authority: the acting driver must BE the claimed driver.
  IF v_session.active_driver_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the active driver can counter this negotiation';
  END IF;

  -- ELIGIBILITY PARITY (re-checked at act time, not only at discovery/claim).
  IF NOT public.driver_vehicle_can_accept_job(v_session.job_id, v_actor) THEN
    RAISE EXCEPTION 'You are not eligible for this service';
  END IF;

  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating') THEN
    RAISE EXCEPTION 'Negotiation is not open';
  END IF;

  IF v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'Negotiation has expired';
  END IF;

  -- Turn: the live proposal must be POSITIVELY the customer's. A NULL/missing fare
  -- event history fails closed (a NULL IS DISTINCT FROM 'customer').
  IF public.negotiation_live_proposal_role(v_session.id) IS DISTINCT FROM 'customer'
     OR v_session.customer_offer IS NULL THEN
    RAISE EXCEPTION 'There is no customer offer awaiting a response';
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  v_max_rounds := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'maxRounds')::INTEGER,
    3
  );

  IF v_session.round_count >= v_max_rounds THEN
    RAISE EXCEPTION 'Maximum negotiation rounds reached';
  END IF;

  UPDATE public.marketplace_negotiation_sessions
  SET driver_counter_offer = p_amount,
      status = 'negotiating',
      round_count = v_session.round_count + 1,
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, amount, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'driver',
    'driver_counter', p_amount, v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;

-- ===========================================================================
-- 4. DRIVER ACCEPT — driver_accept_customer_offer(p_session_id)
--    Re-issued verbatim from 20261231000000 with an eligibility re-check added.
--    Without it an ineligible driver already holding active_driver_id could lock
--    the fare (and therefore the payout) for a service they cannot perform.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.driver_accept_customer_offer(
  p_session_id UUID
)
RETURNS public.marketplace_negotiation_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_session public.marketplace_negotiation_sessions;
  v_agreed NUMERIC;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Negotiation session not found';
  END IF;

  -- Authority: the acting driver must BE the claimed driver.
  IF v_session.active_driver_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the active driver can accept this offer';
  END IF;

  -- ELIGIBILITY PARITY (re-checked at act time).
  IF NOT public.driver_vehicle_can_accept_job(v_session.job_id, v_actor) THEN
    RAISE EXCEPTION 'You are not eligible for this service';
  END IF;

  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating') THEN
    RAISE EXCEPTION 'Negotiation is not open';
  END IF;

  IF v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'Negotiation has expired';
  END IF;

  -- Turn: the live proposal must be POSITIVELY the customer's (fail closed on a
  -- NULL/missing fare event history).
  IF v_session.customer_offer IS NULL
     OR public.negotiation_live_proposal_role(v_session.id) IS DISTINCT FROM 'customer' THEN
    RAISE EXCEPTION 'There is no customer offer to accept';
  END IF;

  -- AUTHORITATIVE: the persisted customer offer, not a caller-supplied amount.
  v_agreed := v_session.customer_offer;

  UPDATE public.marketplace_negotiation_sessions
  SET agreed_fare = v_agreed,
      driver_counter_offer = NULL,
      status = 'fare_agreed',
      expires_at = now() + interval '300 seconds',
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.jobs
  SET agreed_fare = v_agreed,
      status = 'fare_agreed',
      driver_id = v_actor,
      updated_at = now()
  WHERE id = v_session.job_id;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, amount, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'driver',
    'driver_accept', v_agreed, v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;

-- ===========================================================================
-- ACL — defensive re-assertion. CREATE OR REPLACE preserves the existing ACL, so
-- this only matters if the file were ever applied where a function is absent (a
-- fresh CREATE would otherwise inherit the default PUBLIC EXECUTE).
-- ===========================================================================
REVOKE ALL ON FUNCTION public.fetch_hybrid_opportunities(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.claim_marketplace_negotiation(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_marketplace_negotiation(UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_marketplace_negotiation(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.driver_counter_offer(UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.driver_counter_offer(UUID, NUMERIC) FROM anon;
GRANT EXECUTE ON FUNCTION public.driver_counter_offer(UUID, NUMERIC) TO authenticated;

REVOKE ALL ON FUNCTION public.driver_accept_customer_offer(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.driver_accept_customer_offer(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.driver_accept_customer_offer(UUID) TO authenticated;
