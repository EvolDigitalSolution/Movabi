-- =============================================================================
-- 20261234000000_negotiation_lease_release.sql
--
-- PRODUCTION-PROVEN DEFECT (per-driver lease expiry deadlocks the request)
--   `marketplace_negotiation_sessions.expires_at` is written by
--   create_customer_offer (config `timeoutSeconds`, default 120) and by
--   claim_marketplace_negotiation (HARD-CODED `interval '120 seconds'`, ignoring
--   the existing `claimTimeoutSeconds` config of 60). NO success transition then
--   refreshed it: driver_counter_offer and customer_counter_offer left
--   expires_at untouched.
--
--   Expiry is TERMINAL for mutations ('Negotiation has expired' in every
--   transition) AND excludes the row from discovery (fetch_hybrid_opportunities
--   requires active_driver_id IS NULL) — so once a claimed driver's lease lapsed,
--   the session was neither actionable nor claimable: the customer request was
--   deadlocked and the customer had to recreate the job.
--
--   The config already declares the product intent — `autoReleaseOnTimeout: true`
--   and `claimTimeoutSeconds: 60` — but NOTHING implemented it. There is no server
--   process for session leases (dispatch.service only reaps
--   jobs.driver_search_expires_at), so the release must be transactional and must
--   not depend on any browser remaining open.
--
-- WHAT THIS MIGRATION DOES (additive; 305/310/320/330 are NOT edited)
--   * public.negotiation_lease_expiry(job, seconds) — ONE effective-expiry rule:
--         min(now() + lease, overall marketplace deadline = jobs.expires_at)
--   * public.release_stale_negotiation_lease(session) — the automatic
--     reassignment: an EXPIRED claimed lease is released back to the market
--     (active_driver_id cleared, stale driver counter cleared, customer_offer
--     RETAINED, status 'released', attempt_count advanced) while the OVERALL
--     request is still live. Once the job is terminal, expired attempts are NOT
--     recycled.
--   * fetch_hybrid_opportunities — converges stale leases before listing, so a
--     released request becomes discoverable to the next eligible driver with no
--     browser involved. (migration-320 eligibility is preserved verbatim.)
--   * claim_marketplace_negotiation — releases a stale lease on the target
--     session first, and now uses the EXISTING `claimTimeoutSeconds` config
--     (capped by the overall deadline) instead of a hard-coded 120.
--   * driver_counter_offer / customer_counter_offer — REFRESH the lease on every
--     successful proposal, so each turn gets a full response window (capped by
--     the overall deadline). This is the fix for "counter rejected as expired".
--   * customer_decline_counter — a customer WITHDRAWAL may also release an
--     already-EXPIRED lease (mirroring customer_cancel_offer's documented expiry
--     intent), so the customer can free a stale driver without recreating the job.
--
-- DELIBERATELY UNCHANGED
--   * N12 statuses, MB001/MB002, the disabled acquisition trigger, payment/Stripe,
--     fare/commission/high-fare qualification.
--   * No new statuses, no new config keys, no migration ledger.
--
-- ACL: the two new helpers are INTERNAL (invoked only from SECURITY DEFINER
-- functions) and are revoked from PUBLIC/anon/authenticated. Replaced functions
-- keep their existing hardened ACL (CREATE OR REPLACE preserves it) and the ACL
-- is re-asserted defensively.
-- =============================================================================

-- ===========================================================================
-- 0. ONE effective-expiry rule.
--    min(now() + lease, overall marketplace deadline). jobs.expires_at IS the
--    authoritative overall deadline for a negotiation job (booking.routes sets
--    it to now() + 30 minutes when negotiation_mode_enabled). A NULL deadline
--    means "no overall cap recorded", so the lease alone applies.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.negotiation_lease_expiry(
  p_job_id UUID,
  p_seconds INTEGER
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lease INTERVAL;
  v_deadline TIMESTAMPTZ;
BEGIN
  v_lease := make_interval(secs => GREATEST(COALESCE(p_seconds, 1), 1));

  SELECT expires_at INTO v_deadline
  FROM public.jobs
  WHERE id = p_job_id;

  IF v_deadline IS NULL THEN
    RETURN now() + v_lease;
  END IF;

  RETURN LEAST(now() + v_lease, v_deadline);
END;
$$;

-- ===========================================================================
-- 1. AUTOMATIC REASSIGNMENT — release an EXPIRED per-driver lease.
--
--    Triggered transactionally from the authoritative acquisition boundaries
--    (fetch_hybrid_opportunities / claim), never from a browser.
--
--    Returns TRUE only when a stale lease was actually released, so callers can
--    treat it as a real state change.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.release_stale_negotiation_lease(
  p_session_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.marketplace_negotiation_sessions;
  v_job public.jobs;
  v_lease INTEGER;
  v_max_attempts INTEGER;
  v_driver UUID;
BEGIN
  IF p_session_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Only a CLAIMED, still-live lease can go stale.
  IF v_session.active_driver_id IS NULL THEN
    RETURN FALSE;
  END IF;
  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating') THEN
    RETURN FALSE;
  END IF;
  IF v_session.expires_at IS NULL OR v_session.expires_at > now() THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- OVERALL marketplace deadline must still be valid: the request must still be
  -- negotiating. Once the job is terminal, an expired attempt is NOT recycled.
  IF v_job.status NOT IN ('pending_fare_confirmation', 'negotiating', 'open') THEN
    RETURN FALSE;
  END IF;
  IF v_job.expires_at IS NOT NULL AND v_job.expires_at <= now() THEN
    RETURN FALSE;
  END IF;

  v_max_attempts := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'maxDriverAttempts')::INTEGER,
    5
  );
  IF v_session.attempt_count >= v_max_attempts THEN
    RETURN FALSE;
  END IF;

  v_lease := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'timeoutSeconds')::INTEGER,
    120
  );

  v_driver := v_session.active_driver_id;

  UPDATE public.marketplace_negotiation_sessions
  SET status = 'released',
      active_driver_id = NULL,             -- A loses authority
      driver_counter_offer = NULL,         -- stale A counter is NOT actionable
      claimed_at = NULL,
      attempt_count = attempt_count + 1,   -- existing release convention
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_lease),
      updated_at = now()
      -- customer_offer is INTENTIONALLY retained: the next eligible driver must
      -- answer the customer's CURRENT proposal.
  WHERE id = v_session.id;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, message, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_driver, 'driver',
    'session_released', 'Driver lease expired', v_session.round_count, now()
  );

  -- TURN RECONCILIATION (required): the event ledger still holds the expired
  -- driver's `driver_counter` as the latest FARE event, so the canonical turn
  -- would keep pointing at the driver even though driver_counter_offer is now
  -- NULL — which made the next driver's counter fail with "There is no customer
  -- offer awaiting a response". Re-assert the RETAINED customer proposal so the
  -- live fare proposal is unambiguously the customer's again (phase becomes
  -- waiting_for_driver while unclaimed, driver_turn once the next driver claims).
  IF v_session.customer_offer IS NOT NULL AND v_session.customer_offer > 0 THEN
    INSERT INTO public.marketplace_negotiation_events (
      session_id, job_id, proposed_by, proposed_by_role,
      event_type, amount, round_number, created_at
    ) VALUES (
      v_session.id, v_session.job_id, v_session.customer_id, 'customer',
      'customer_offer', v_session.customer_offer, v_session.round_count, now()
    );
  END IF;

  RETURN TRUE;
END;
$$;

-- ===========================================================================
-- 2. DISCOVERY — converge stale leases BEFORE listing so a released request is
--    discoverable with no browser involved. Everything else (identity guard,
--    safe parsing, migration-320 eligibility, expiry filter) is preserved.
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

  -- AUTOMATIC REASSIGNMENT: an expired claimed lease returns to the market.
  -- Serialised by release_stale_negotiation_lease's FOR UPDATE, so two concurrent
  -- fetchers cannot both release/relist the same attempt.
  PERFORM public.release_stale_negotiation_lease(s.id)
  FROM public.marketplace_negotiation_sessions s
  WHERE s.active_driver_id IS NOT NULL
    AND s.status IN ('open', 'driver_claimed', 'negotiating')
    AND s.expires_at IS NOT NULL
    AND s.expires_at <= now();

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
    -- EXPIRY PARITY: never surface a session past its own expiry.
    AND s.expires_at > now()
    AND NOT EXISTS (
      SELECT 1 FROM public.driver_job_declines d
      WHERE d.driver_id = p_driver_id AND d.job_id = s.job_id
    );
END;
$$;

-- ===========================================================================
-- 3. CLAIM — release a stale lease on the target session first, then honour the
--    EXISTING `claimTimeoutSeconds` config (capped by the overall deadline)
--    instead of the hard-coded 120 seconds. Identity + migration-320 eligibility
--    checks are preserved.
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
  v_claim_lease INTEGER;
BEGIN
  -- Release closure: a driver may only claim for themselves.
  IF auth.uid() IS NULL OR auth.uid() <> p_driver_id THEN
    RAISE EXCEPTION 'You can only claim a negotiation for yourself';
  END IF;

  -- ELIGIBILITY PARITY: an ineligible driver must never become the active driver.
  IF NOT public.driver_vehicle_can_accept_job(p_job_id, p_driver_id) THEN
    RAISE EXCEPTION 'You are not eligible for this service';
  END IF;

  -- AUTOMATIC REASSIGNMENT: if the previous driver's lease lapsed, release it so
  -- this claim is not rejected as "already claimed". Released under FOR UPDATE.
  PERFORM public.release_stale_negotiation_lease(s.id)
  FROM public.marketplace_negotiation_sessions s
  WHERE s.job_id = p_job_id;

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

  v_claim_lease := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'claimTimeoutSeconds')::INTEGER,
    60
  );

  UPDATE public.marketplace_negotiation_sessions
  SET active_driver_id = p_driver_id,
      status = 'negotiating',
      claimed_at = now(),
      expires_at = public.negotiation_lease_expiry(p_job_id, v_claim_lease),
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
-- 4. DRIVER COUNTER — refresh the lease for the CUSTOMER's response window
--    (capped by the overall marketplace deadline). Everything from 310/320 is
--    otherwise preserved.
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
  v_turn_lease INTEGER;
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

  IF v_session.active_driver_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the active driver can counter this negotiation';
  END IF;

  IF NOT public.driver_vehicle_can_accept_job(v_session.job_id, v_actor) THEN
    RAISE EXCEPTION 'You are not eligible for this service';
  END IF;

  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating') THEN
    RAISE EXCEPTION 'Negotiation is not open';
  END IF;

  IF v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'Negotiation has expired';
  END IF;

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

  v_turn_lease := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'timeoutSeconds')::INTEGER,
    120
  );

  UPDATE public.marketplace_negotiation_sessions
  SET driver_counter_offer = p_amount,
      status = 'negotiating',
      round_count = v_session.round_count + 1,
      -- TURN LEASE REFRESH: the customer now has a full response window.
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_turn_lease),
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
-- 5. CUSTOMER COUNTER — refresh the lease for the DRIVER's response window
--    (capped by the overall marketplace deadline).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.customer_counter_offer(
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
  v_turn_lease INTEGER;
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

  -- Only the customer who owns this negotiation may counter.
  IF v_session.customer_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the customer can counter this negotiation';
  END IF;

  IF v_session.active_driver_id IS NULL THEN
    RAISE EXCEPTION 'No driver is currently negotiating';
  END IF;

  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating') THEN
    RAISE EXCEPTION 'Negotiation is not open';
  END IF;

  IF v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'Negotiation has expired';
  END IF;

  -- Turn: the live proposal must belong to the driver.
  IF public.negotiation_live_proposal_role(v_session.id) IS DISTINCT FROM 'driver'
     OR v_session.driver_counter_offer IS NULL THEN
    RAISE EXCEPTION 'There is no driver counter-offer awaiting a response';
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  v_max_rounds := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'maxRounds')::INTEGER,
    3
  );

  IF v_session.round_count >= v_max_rounds THEN
    RAISE EXCEPTION 'Maximum negotiation rounds reached';
  END IF;

  v_turn_lease := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'timeoutSeconds')::INTEGER,
    120
  );

  UPDATE public.marketplace_negotiation_sessions
  SET customer_offer = p_amount,
      driver_counter_offer = NULL,   -- clears the answered counter: one live proposal
      status = 'negotiating',
      round_count = v_session.round_count + 1,
      -- TURN LEASE REFRESH: the driver now has a full response window. This is the
      -- fix for "customer counter rejected as expired" after reading the counter.
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_turn_lease),
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, amount, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'customer',
    'customer_offer', p_amount, v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;

-- ===========================================================================
-- 6. CUSTOMER DECLINE COUNTER ("Try Another Driver").
--    Unchanged semantics EXCEPT that a customer WITHDRAWAL may also release an
--    already-EXPIRED lease: the customer is freeing a stale driver, not
--    performing a timed counter/accept. Mirrors customer_cancel_offer's
--    documented expiry intent. Ownership and "there is a driver counter" are
--    still required.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.customer_decline_counter(
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
  v_job public.jobs;
  v_turn_lease INTEGER;
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

  IF v_session.customer_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the customer can decline this counter-offer';
  END IF;

  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating') THEN
    RAISE EXCEPTION 'Negotiation is not open';
  END IF;

  IF v_session.active_driver_id IS NULL
     OR v_session.driver_counter_offer IS NULL
     OR public.negotiation_live_proposal_role(v_session.id) IS DISTINCT FROM 'driver' THEN
    RAISE EXCEPTION 'There is no driver counter-offer to decline';
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  IF v_job.status NOT IN ('pending_fare_confirmation', 'negotiating', 'open') THEN
    RAISE EXCEPTION 'Job is not available for negotiation';
  END IF;

  v_turn_lease := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'timeoutSeconds')::INTEGER,
    120
  );

  UPDATE public.marketplace_negotiation_sessions
  SET status = 'released',
      active_driver_id = NULL,
      driver_counter_offer = NULL,
      claimed_at = NULL,
      attempt_count = attempt_count + 1,   -- existing release convention
      -- Re-arm the discovery window so the next eligible driver can claim it even
      -- when this decline happened after the previous lease had already lapsed.
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_turn_lease),
      updated_at = now()
      -- customer_offer is INTENTIONALLY retained: the request stays live and
      -- another eligible driver can claim and answer it.
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, message, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'customer',
    'customer_decline', 'Customer declined driver counter', v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;

-- ===========================================================================
-- ACL — the two new helpers are INTERNAL predicates/effects invoked only from
-- SECURITY DEFINER transitions: no role may execute them directly.
-- ===========================================================================
REVOKE ALL ON FUNCTION public.negotiation_lease_expiry(UUID, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.negotiation_lease_expiry(UUID, INTEGER) FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.release_stale_negotiation_lease(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.release_stale_negotiation_lease(UUID) FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.fetch_hybrid_opportunities(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.claim_marketplace_negotiation(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_marketplace_negotiation(UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_marketplace_negotiation(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.driver_counter_offer(UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.driver_counter_offer(UUID, NUMERIC) FROM anon;
GRANT EXECUTE ON FUNCTION public.driver_counter_offer(UUID, NUMERIC) TO authenticated;

REVOKE ALL ON FUNCTION public.customer_counter_offer(UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.customer_counter_offer(UUID, NUMERIC) FROM anon;
GRANT EXECUTE ON FUNCTION public.customer_counter_offer(UUID, NUMERIC) TO authenticated;

REVOKE ALL ON FUNCTION public.customer_decline_counter(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.customer_decline_counter(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.customer_decline_counter(UUID) TO authenticated;
