-- =============================================================================
-- 20261231000000_negotiation_lifecycle_authority.sql
--
-- MOVABI 2.1 — authoritative negotiation lifecycle transitions.
--
-- WHY
--   Negotiation mutations were performed by DIRECT CLIENT writes:
--     * session INSERT            (marketplace-hybrid.service.createCustomerOffer)
--     * session UPDATE            (customerCounterOffer / driverCounterOffer /
--                                  customerDecline)
--     * negotiation event INSERT  (addEvent)
--   The only guard was `marketplace_negotiation_sessions.job_id UNIQUE`, so a
--   repeat offer surfaced a raw 23505, any participant could mutate lifecycle
--   columns (status / agreed_fare / active_driver_id / round_count / fares) via
--   the broad `hybrid_sessions_owner_write` UPDATE policy, and — worst — a
--   CUSTOMER accepted a driver counter by invoking the DRIVER-authority
--   `lock_marketplace_fare` while passing `session.active_driver_id`, obtaining
--   driver authority by supplying a driver UUID.
--
--   These seven SECURITY DEFINER transitions replace all of that. Actor
--   identity is ALWAYS auth.uid(); no caller-supplied UUID is ever accepted as
--   proof of authority; amount acceptance always reads the persisted session
--   fare. NO client price parameter decides an agreed fare.
--
-- SCOPE
--   Accept Original Fare is deliberately NOT implemented here: it requires the
--   authoritative original verified fare via
--   jobs.quote_id -> quote_market_adjustments.quote_reference ->
--   returned_customer_fare, and public.quote_market_adjustments / quote_reference
--   / returned_customer_fare still have no committed executable DDL. That is a
--   separate lineage task. The customer UI must not expose the action.
--
-- SCHEMA FIDELITY
--   Uses only the tracked schema from server/marketplace-engine-migration.txt:
--     status       : open, driver_claimed, negotiating, fare_agreed,
--                    driver_declined, customer_declined, released, expired,
--                    payment_pending, paid
--     event_type   : customer_offer, driver_counter, customer_accept,
--                    driver_accept, customer_decline, driver_decline,
--                    session_claimed, session_released, session_expired,
--                    payment_completed
--   NO new status and NO new event type is introduced. Both customer cancel and
--   customer decline-counter reuse event_type='customer_decline' and are made
--   distinguishable by (1) the RPC invoked, (2) the persisted `message`, and
--   (3) the resulting authoritative session state.
--
-- TURN DERIVATION (no turn column)
--   The live fare proposal is derived from persisted state:
--     * the most recent FARE-PROPOSAL event, where a fare proposal is created by
--       EXACTLY TWO events: customer_offer and driver_counter. Accept/decline
--       events and lifecycle events (session_claimed / session_released /
--       session_expired / payment_completed) never transfer the fare turn;
--       combined with
--     * session.offer fields (customer_offer / driver_counter_offer).
--   "Live proposal belongs to the driver"  <=> latest fare event = driver_counter
--   "Live proposal belongs to the customer" <=> latest fare event = customer_offer
--   Callers require POSITIVE proof of the owner (IS [NOT] DISTINCT FROM), so a
--   NULL or missing fare-event history FAILS CLOSED.
--   This makes a second consecutive counter by the SAME party impossible.
--
-- ROUND / TIMEOUT AUTHORITY
--   Only the existing authority:
--     public.get_marketplace_setting('hybrid_negotiation', tenant_id)
--   with maxRounds (fallback 3) and timeoutSeconds (fallback 120), matching the
--   existing client/engine defaults. No second authority is introduced.
--
-- SOURCE ONLY. Applying this file is a separate, explicitly authorised step.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Shared helper: canonical live fare-proposal owner for a session.
-- SECURITY DEFINER + STABLE so the turn rule is defined in exactly ONE place
-- and cannot drift between the four transition RPCs that depend on it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.negotiation_live_proposal_role(p_session_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.proposed_by_role
  FROM public.marketplace_negotiation_events e
  WHERE e.session_id = p_session_id
    AND e.event_type IN ('customer_offer', 'driver_counter')
  ORDER BY e.created_at DESC, e.id DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.negotiation_live_proposal_role(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.negotiation_live_proposal_role(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.negotiation_live_proposal_role(UUID) TO authenticated, service_role;

-- ===========================================================================
-- 1. create_customer_offer(p_job_id, p_amount)
--    The customer opens a negotiation, or re-opens a released one, using the
--    SINGLE session row permitted by jobs.job_id UNIQUE (never a raw 23505).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.create_customer_offer(
  p_job_id UUID,
  p_amount NUMERIC
)
RETURNS public.marketplace_negotiation_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_job public.jobs;
  v_session public.marketplace_negotiation_sessions;
  v_suggested NUMERIC;
  v_timeout INTEGER;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Offer amount must be a positive value';
  END IF;

  -- Lock the job: serialises a double-click / concurrent retry for this job.
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found';
  END IF;

  IF v_job.customer_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the job customer can open a negotiation';
  END IF;

  IF v_job.negotiation_mode_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'Negotiation is not enabled for this job';
  END IF;

  IF v_job.status IS NULL OR v_job.status NOT IN ('pending_fare_confirmation', 'negotiating', 'open') THEN
    RAISE EXCEPTION 'Job is not in a negotiable state';
  END IF;

  -- Authoritative reference fare: the persisted job fields the existing
  -- createCustomerOffer flow resolves through. No quote-table dependency.
  v_suggested := COALESCE(v_job.agreed_fare, v_job.total_price);
  IF v_suggested IS NULL OR v_suggested <= 0 THEN
    RAISE EXCEPTION 'No authoritative reference fare is available for this job';
  END IF;

  v_timeout := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'timeoutSeconds')::INTEGER,
    120
  );

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE job_id = p_job_id
  FOR UPDATE;

  IF FOUND THEN
    -- One session per job (job_id UNIQUE). Never insert a second row.
    IF v_session.status IN ('open', 'driver_claimed', 'negotiating') THEN
      RAISE EXCEPTION 'An offer is already awaiting a response for this request';
    END IF;

    IF v_session.status = 'released' THEN
      -- The customer's proposal survived the driver release; re-open the SAME row.
      UPDATE public.marketplace_negotiation_sessions
      SET customer_offer = p_amount,
          driver_counter_offer = NULL,
          agreed_fare = NULL,
          active_driver_id = NULL,
          suggested_fare = v_suggested,
          status = 'open',
          round_count = 1,
          -- Clear prior-lifecycle timestamps so a reused released row cannot leak a
          -- stale claim or payment deadline into the fresh offer. attempt_count is
          -- deliberately NOT reset: it is a cumulative driver-attempt counter across
          -- the negotiation's life, not a per-offer value.
          claimed_at = NULL,
          payment_deadline = NULL,
          expires_at = now() + make_interval(secs => v_timeout),
          updated_at = now()
      WHERE id = v_session.id
      RETURNING * INTO v_session;
    ELSE
      -- customer_declined / driver_declined / expired / fare_agreed /
      -- payment_pending / paid: closed. Never resurrected silently.
      RAISE EXCEPTION 'This negotiation is already closed';
    END IF;
  ELSE
    INSERT INTO public.marketplace_negotiation_sessions (
      job_id, customer_id, active_driver_id, status,
      suggested_fare, customer_offer, driver_counter_offer, agreed_fare,
      round_count, attempt_count, expires_at
    ) VALUES (
      p_job_id, v_actor, NULL, 'open',
      v_suggested, p_amount, NULL, NULL,
      1, 0, now() + make_interval(secs => v_timeout)
    )
    RETURNING * INTO v_session;
  END IF;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, amount, round_number, created_at
  ) VALUES (
    v_session.id, p_job_id, v_actor, 'customer',
    'customer_offer', p_amount, v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;

-- ===========================================================================
-- 2. customer_counter_offer(p_session_id, p_amount)
--    Allowed only while the DRIVER's counter is the live proposal.
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

  UPDATE public.marketplace_negotiation_sessions
  SET customer_offer = p_amount,
      driver_counter_offer = NULL,   -- clears the answered counter: one live proposal
      status = 'negotiating',
      round_count = v_session.round_count + 1,
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
-- 3. driver_counter_offer(p_session_id, p_amount)
--    Allowed only while the CUSTOMER's offer is the live proposal.
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
-- 4. customer_cancel_offer(p_session_id)
--    TERMINAL withdrawal before agreement. No later driver accept/counter can
--    succeed because the status leaves the live set.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.customer_cancel_offer(
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
    RAISE EXCEPTION 'Only the customer can cancel this negotiation';
  END IF;

  -- EXPIRY INTENT: a terminal customer WITHDRAWAL is not a stale fare response.
  -- It is deliberately allowed for open/driver_claimed/negotiating/released even
  -- when expires_at has already elapsed: the customer is withdrawing the
  -- outstanding negotiation/request, not attempting a timed-out counter/accept.
  -- Therefore NO expires_at check is applied here.
  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating', 'released') THEN
    RAISE EXCEPTION 'Negotiation can no longer be cancelled';
  END IF;

  UPDATE public.marketplace_negotiation_sessions
  SET status = 'customer_declined',
      active_driver_id = NULL,      -- the previous driver cannot accept/counter
      driver_counter_offer = NULL,
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, message, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'customer',
    'customer_decline', 'Customer cancelled offer', v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;

-- ===========================================================================
-- 5. customer_decline_counter(p_session_id)
--    Rejects THIS DRIVER'S counter WITHOUT cancelling the customer's request.
--    Non-terminal: the request returns to the opportunity pool with the
--    customer's own offer retained so another eligible driver can claim it.
--
--    COMPATIBILITY (verified against the tracked fetch_hybrid_opportunities):
--      WHERE s.status IN ('open', 'released') AND s.active_driver_id IS NULL
--    so status='released' + active_driver_id IS NULL IS available, and the
--    opportunity query selects s.customer_offer — retaining it is compatible
--    with the driver card's current-proposal display.
--
--    Deliberately NO driver_job_declines row: the customer rejected a PRICE,
--    not the driver's eligibility, so the request is not driver-barred. If the
--    product later wants to bar that driver, add the decline row exactly as
--    release_marketplace_negotiation does.
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

  IF v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'Negotiation has expired';
  END IF;

  IF v_session.active_driver_id IS NULL
     OR v_session.driver_counter_offer IS NULL
     OR public.negotiation_live_proposal_role(v_session.id) IS DISTINCT FROM 'driver' THEN
    RAISE EXCEPTION 'There is no driver counter-offer to decline';
  END IF;

  UPDATE public.marketplace_negotiation_sessions
  SET status = 'released',
      active_driver_id = NULL,
      driver_counter_offer = NULL,
      attempt_count = attempt_count + 1,   -- existing release convention
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
-- 6. customer_accept_driver_counter(p_session_id)
--    Agreed fare comes ONLY from session.driver_counter_offer — never a client
--    amount. This REPLACES the authority inversion where the customer invoked
--    the driver-authority lock_marketplace_fare with session.active_driver_id.
--    Agreement semantics mirror lock_marketplace_fare (session + job, 300s
--    payment window).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.customer_accept_driver_counter(
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

  IF v_session.customer_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the customer can accept this counter-offer';
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

  IF v_session.driver_counter_offer IS NULL
     OR public.negotiation_live_proposal_role(v_session.id) IS DISTINCT FROM 'driver' THEN
    RAISE EXCEPTION 'There is no driver counter-offer to accept';
  END IF;

  -- AUTHORITATIVE: the persisted counter, not a caller-supplied amount.
  v_agreed := v_session.driver_counter_offer;

  UPDATE public.marketplace_negotiation_sessions
  SET agreed_fare = v_agreed,
      status = 'fare_agreed',
      expires_at = now() + interval '300 seconds',
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.jobs
  SET agreed_fare = v_agreed,
      status = 'fare_agreed',
      driver_id = v_session.active_driver_id,
      updated_at = now()
  WHERE id = v_session.job_id;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, amount, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'customer',
    'customer_accept', v_agreed, v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;

-- ===========================================================================
-- 7. driver_accept_customer_offer(p_session_id)
--    Agreed fare comes ONLY from session.customer_offer. The driver may only
--    accept the offer that is currently live and addressed to them.
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
-- ACL — authenticated only. Never PUBLIC, never anon.
-- ===========================================================================
REVOKE ALL ON FUNCTION public.create_customer_offer(UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_counter_offer(UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_counter_offer(UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_cancel_offer(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_decline_counter(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_accept_driver_counter(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_accept_customer_offer(UUID) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.create_customer_offer(UUID, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION public.customer_counter_offer(UUID, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION public.driver_counter_offer(UUID, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION public.customer_cancel_offer(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.customer_decline_counter(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.customer_accept_driver_counter(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.driver_accept_customer_offer(UUID) FROM anon;

GRANT EXECUTE ON FUNCTION public.create_customer_offer(UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_counter_offer(UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_counter_offer(UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_cancel_offer(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_decline_counter(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_accept_driver_counter(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_accept_customer_offer(UUID) TO authenticated;

-- ===========================================================================
-- RLS HARDENING
--   All lifecycle mutation now flows through the SECURITY DEFINER RPCs above
--   (which run as the owner and are therefore unaffected by these policies).
--   Participant SELECT is PRESERVED for Realtime and history reconstruction.
-- ===========================================================================

-- 1. Remove the broad participant UPDATE policy: it allowed any participant to
--    rewrite status / agreed_fare / active_driver_id / round_count / fares.
DROP POLICY IF EXISTS hybrid_sessions_owner_write ON public.marketplace_negotiation_sessions;

-- 2. Remove direct client session INSERT: session creation is owned by
--    create_customer_offer. `hybrid_sessions_customer_insert` is the name used
--    by the earlier Patch 1A design; it is dropped here so a partially applied
--    environment converges too.
DROP POLICY IF EXISTS hybrid_sessions_customer_insert ON public.marketplace_negotiation_sessions;

-- 3. Remove direct client event INSERT: every negotiation event is now written
--    inside an authoritative transition.
DROP POLICY IF EXISTS hybrid_events_participants_insert ON public.marketplace_negotiation_events;

-- NOTE: if production carries a session INSERT policy under a DIFFERENT name
-- from the two dropped above, it must be identified and dropped separately:
--   SELECT policyname, cmd FROM pg_policies
--   WHERE schemaname='public' AND tablename='marketplace_negotiation_sessions';
-- Participant SELECT (hybrid_sessions_owner_or_driver) and
-- (hybrid_events_participants) are deliberately NOT touched.
