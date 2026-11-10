-- =============================================================================
-- 20261236000000_fare_agreement_payment_deadline.sql
--
-- PRODUCTION-PROVEN DEFECT (agreed fare payable forever; stale agreement lingers)
--   Both acceptance RPCs (driver_accept_customer_offer,
--   customer_accept_driver_counter) set the payment window by HARD-CODING
--   `expires_at = now() + interval '300 seconds'`. They never wrote the dedicated
--   `marketplace_negotiation_sessions.payment_deadline` column (it stayed NULL —
--   only ever set to NULL), and they ignored the existing
--   `hybrid_negotiation.paymentDeadlineAfterFareAgreement` config.
--
--   Worse, NOTHING acted on that window: payment.routes.ts skips the quote-expiry
--   check entirely when jobs.agreed_fare is set, and never consults the session,
--   while the 340 lease releaser only handles open/driver_claimed/negotiating. An
--   unpaid `fare_agreed` session therefore stayed payable indefinitely and the
--   driver stayed attached to a dead agreement.
--
-- WHAT THIS MIGRATION DOES (additive; 305/310/320/330/340/350 are NOT edited)
--   * The two acceptance RPCs now write an EXPLICIT payment_deadline from the
--     existing `paymentDeadlineAfterFareAgreement` config (default 300) and keep
--     `expires_at` equal to it, so the agreement has ONE authoritative deadline.
--   * public.expire_unpaid_fare_agreement(session) — the authoritative persisted
--     expiry transition, invoked transactionally from the authoritative
--     boundaries (discovery + claim) exactly like the 340 lease releaser, so it
--     never depends on a browser being open:
--       - while jobs.expires_at is STILL live  -> the stale agreement is released
--         and the SAME request returns to the discoverable pool with the
--         customer's proposal retained (no new job is created);
--       - once jobs.expires_at has passed      -> the request is terminalised and
--         is NOT recycled.
--     A PAID job can never be released by this path (guarded on payment_status).
--
-- DELIBERATELY UNCHANGED: N12, MB001/MB002, the disabled acquisition trigger,
--   pricing/commission, timeout configuration, and the customer/driver RPC ACLs.
-- =============================================================================

-- ===========================================================================
-- 1. AUTHORITATIVE UNPAID-AGREEMENT EXPIRY.
--    Returns TRUE only when a stale unpaid agreement was actually transitioned.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.expire_unpaid_fare_agreement(
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
  v_deadline TIMESTAMPTZ;
  v_lease INTEGER;
  v_payment TEXT;
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

  -- Only an unpaid, agreed negotiation can lapse here.
  IF v_session.status <> 'fare_agreed' THEN
    RETURN FALSE;
  END IF;

  v_deadline := COALESCE(v_session.payment_deadline, v_session.expires_at);
  IF v_deadline IS NULL OR v_deadline > now() THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- NEVER release money already taken.
  v_payment := LOWER(COALESCE(v_job.payment_status, 'pending'));
  IF v_payment IN ('authorized', 'requires_capture', 'succeeded', 'captured', 'paid', 'wallet_funded') THEN
    RETURN FALSE;
  END IF;

  -- OVERALL marketplace deadline passed -> terminalise, do NOT recycle.
  IF v_job.expires_at IS NOT NULL AND v_job.expires_at <= now() THEN
    UPDATE public.marketplace_negotiation_sessions
    SET status = 'expired',
        active_driver_id = NULL,
        driver_counter_offer = NULL,
        agreed_fare = NULL,
        payment_deadline = NULL,
        updated_at = now()
    WHERE id = v_session.id;

    UPDATE public.jobs
    SET status = 'expired',
        agreed_fare = NULL,
        driver_id = NULL,
        updated_at = now()
    WHERE id = v_session.job_id
      AND status IN ('fare_agreed', 'pending_fare_confirmation', 'negotiating', 'open');

    INSERT INTO public.marketplace_negotiation_events (
      session_id, job_id, proposed_by, proposed_by_role,
      event_type, message, round_number, created_at
    ) VALUES (
      v_session.id, v_session.job_id, v_session.customer_id, 'customer',
      'session_expired', 'Payment window closed after the request deadline', v_session.round_count, now()
    );

    RETURN TRUE;
  END IF;

  -- Request still live -> invalidate the agreement and return the SAME request to
  -- the discoverable pool with the customer's proposal retained.
  v_lease := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'timeoutSeconds')::INTEGER,
    120
  );

  UPDATE public.marketplace_negotiation_sessions
  SET status = 'released',
      active_driver_id = NULL,
      driver_counter_offer = NULL,
      agreed_fare = NULL,
      payment_deadline = NULL,
      claimed_at = NULL,
      attempt_count = attempt_count + 1,
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_lease),
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.jobs
  SET status = 'pending_fare_confirmation',
      agreed_fare = NULL,
      driver_id = NULL,
      updated_at = now()
  WHERE id = v_session.job_id
    AND status = 'fare_agreed';

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, message, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_session.customer_id, 'customer',
    'session_released', 'Payment window expired; agreement released', v_session.round_count, now()
  );

  -- Re-assert the retained customer proposal so the canonical turn is the
  -- customer's again for the next eligible driver.
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
-- 2. DISCOVERY — converge lapsed unpaid agreements as well as lapsed leases,
--    so the same request becomes searchable again with no browser involved.
--    Everything else (identity guard, safe parsing, 320 eligibility) preserved.
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
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_driver_id THEN
    RAISE EXCEPTION 'You can only fetch your own opportunities';
  END IF;

  -- Lapsed unpaid agreements release back to the market (or terminalise).
  PERFORM public.expire_unpaid_fare_agreement(s.id)
  FROM public.marketplace_negotiation_sessions s
  WHERE s.status = 'fare_agreed'
    AND COALESCE(s.payment_deadline, s.expires_at) IS NOT NULL
    AND COALESCE(s.payment_deadline, s.expires_at) <= now();

  -- Lapsed claimed leases release back to the market.
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
    AND public.driver_vehicle_can_accept_job(s.job_id, p_driver_id)
    AND s.expires_at > now()
    AND NOT EXISTS (
      SELECT 1 FROM public.driver_job_declines d
      WHERE d.driver_id = p_driver_id AND d.job_id = s.job_id
    );
END;
$$;

-- ===========================================================================
-- 3. DRIVER ACCEPT — explicit, configurable payment deadline.
--    Everything else from 310/320/340 is preserved.
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
  v_job public.jobs;
  v_pay_window INTEGER;
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

  IF v_session.active_driver_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the active driver can accept this offer';
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

  IF v_session.customer_offer IS NULL
     OR public.negotiation_live_proposal_role(v_session.id) IS DISTINCT FROM 'customer' THEN
    RAISE EXCEPTION 'There is no customer offer to accept';
  END IF;

  v_agreed := v_session.customer_offer;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  v_pay_window := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'paymentDeadlineAfterFareAgreement')::INTEGER,
    300
  );

  UPDATE public.marketplace_negotiation_sessions
  SET agreed_fare = v_agreed,
      driver_counter_offer = NULL,
      status = 'fare_agreed',
      payment_deadline = public.negotiation_lease_expiry(v_session.job_id, v_pay_window),
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_pay_window),
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
-- 4. CUSTOMER ACCEPT DRIVER COUNTER — same explicit payment deadline.
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
  v_job public.jobs;
  v_pay_window INTEGER;
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

  v_agreed := v_session.driver_counter_offer;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  v_pay_window := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'paymentDeadlineAfterFareAgreement')::INTEGER,
    300
  );

  UPDATE public.marketplace_negotiation_sessions
  SET agreed_fare = v_agreed,
      status = 'fare_agreed',
      payment_deadline = public.negotiation_lease_expiry(v_session.job_id, v_pay_window),
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_pay_window),
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
-- 5. CUSTOMER CANCELLATION BY CANONICAL PHASE.
--
--    customer_cancel_offer is the CUSTOMER WITHDRAWAL of the whole request. It
--    previously accepted only open/driver_claimed/negotiating/released, so a
--    customer on an AGREED-BUT-UNPAID fare ("Cancel Request" still on screen)
--    got a 400 'Negotiation can no longer be cancelled'.
--
--    It now also accepts the AGREED-BUT-UNPAID phase (status 'fare_agreed') and
--    terminalises the request, clearing the agreement and payment authority.
--    A request that has already been PAID can never be cancelled here.
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
  v_job public.jobs;
  v_payment TEXT;
  v_agreed_phase BOOLEAN;
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

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found';
  END IF;

  -- A PAID request must NEVER be cancelled through this path.
  v_payment := LOWER(COALESCE(v_job.payment_status, 'pending'));
  IF v_payment IN ('authorized', 'requires_capture', 'succeeded', 'captured', 'paid', 'wallet_funded') THEN
    RAISE EXCEPTION 'This booking is already paid and cannot be cancelled here';
  END IF;

  v_agreed_phase := v_session.status = 'fare_agreed';

  -- Negotiable phases PLUS the agreed-but-unpaid phase. Terminal phases still
  -- reject: an already declined/expired/paid negotiation is not cancellable.
  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating', 'released', 'fare_agreed') THEN
    RAISE EXCEPTION 'Negotiation can no longer be cancelled';
  END IF;

  UPDATE public.marketplace_negotiation_sessions
  SET status = 'customer_declined',
      active_driver_id = NULL,
      driver_counter_offer = NULL,
      agreed_fare = NULL,
      payment_deadline = NULL,
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.jobs
  SET status = 'cancelled',
      agreed_fare = NULL,
      driver_id = NULL,
      updated_at = now()
  WHERE id = v_session.job_id
    AND status IN ('pending_fare_confirmation', 'negotiating', 'open', 'fare_agreed');

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, message, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'customer',
    'customer_decline',
    CASE WHEN v_agreed_phase
         THEN 'Customer cancelled the agreed fare before payment'
         ELSE 'Customer cancelled request' END,
    v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;

-- ===========================================================================
-- 6. CUSTOMER-FACING EXPIRY / "FIND ANOTHER DRIVER" for a lapsed agreement.
--
--    After payment_deadline elapses the authoritative expiry is the transition in
--    section 1 — NOT customer_cancel_offer. This is the thin, ownership-checked
--    customer boundary that runs it for the customer's OWN session (the internal
--    helper is revoked from client roles). Idempotent.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.customer_expire_unpaid_agreement(
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
    RAISE EXCEPTION 'Only the customer can expire this agreement';
  END IF;

  -- Delegate to the single authoritative expiry transition. It is a no-op unless
  -- the agreement is unpaid AND its deadline has actually elapsed.
  IF v_session.status = 'fare_agreed' THEN
    PERFORM public.expire_unpaid_fare_agreement(p_session_id);
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id;

  RETURN v_session;
END;
$$;

-- ===========================================================================
-- 7. ATOMIC PAYMENT FINALIZATION AUTHORITY (closes the Stripe TOCTOU).
--
--    DEFECT: the real finalizers guarded ONLY on jobs.payment_status = 'pending'
--    (POST /api/payment/confirm) or payment_status='pending' AND driver_id IS NULL
--    (Stripe webhook). But expire_unpaid_fare_agreement / customer_cancel_offer
--    clear agreed_fare + driver_id while LEAVING payment_status = 'pending' — so a
--    released / expired / cancelled agreement whose Stripe authorization was
--    already in flight still matched the guard and was RESURRECTED as a paid
--    booking. (Worse: expiry clears driver_id, which SATISFIES the webhook's
--    unowned-job guard for a negotiated job.)
--
--    This RPC performs the ENTIRE check-and-write in ONE transaction, with the
--    job and its negotiation session locked in a deterministic order, and it is
--    the ONLY sanctioned way for the backend to move a job into a paid state.
--    It never holds a transaction open across the Stripe network call: Stripe
--    runs first, then this atomic boundary decides.
--
--    Returns one of:
--      'finalized'          - state advanced exactly once
--      'job_not_found'
--      'agreement_lost'     - session no longer fare_agreed (released/cancelled/expired)
--      'agreement_expired'  - payment_deadline already elapsed
--      'agreed_fare_mismatch'- server-computed fare disagrees with the session
--      'driver_mismatch'    - agreed driver no longer attached / unowned guard
--      'job_terminal'       - cancelled/expired/completed/settled
--      'already_finalized'  - payment_status is not 'pending' (idempotent no-op)
--      'intent_mismatch'    - PaymentIntent identity is not the job's intent
--
--    AMOUNT authority stays in Node (PaymentAuthorityService). This RPC instead
--    verifies the AGREEMENT identity/amount it can prove from the session, so no
--    money rule is duplicated between SQL and Node.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.finalize_job_payment(
  p_job_id UUID,
  p_payment_intent_id TEXT,
  p_payment_status TEXT,
  p_job_status TEXT,
  p_expected_service_fare NUMERIC DEFAULT NULL,
  p_require_unowned BOOLEAN DEFAULT FALSE,
  p_dispatch_started_at TIMESTAMPTZ DEFAULT NULL,
  p_driver_search_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_dispatch_attempts INTEGER DEFAULT 0,
  p_intent_amount_minor BIGINT DEFAULT NULL,
  p_currency TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.jobs;
  v_session public.marketplace_negotiation_sessions;
  v_status TEXT;
  v_deadline TIMESTAMPTZ;
  v_item_budget NUMERIC;
  v_expected_minor NUMERIC;
BEGIN
  IF p_job_id IS NULL THEN
    RETURN 'job_not_found';
  END IF;

  -- DETERMINISTIC LOCK ORDER: job, then session. Every authority in this
  -- migration takes them in this order, so no deadlock is possible.
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'job_not_found';
  END IF;

  -- IDEMPOTENCY FIRST. A repeat of an already-successful finalization must be
  -- reported as such (NOT as a lost agreement) — otherwise a legitimate retry or
  -- duplicate webhook would be misread as a conflict and would wrongly enter the
  -- Stripe compensation path for an already-paid booking. Terminal/expired/
  -- cancelled agreements still have payment_status='pending', so they fall
  -- through to the agreement checks below.
  IF LOWER(COALESCE(v_job.payment_status, '')) <> 'pending' THEN
    RETURN 'already_finalized';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE job_id = p_job_id
  ORDER BY created_at DESC NULLS LAST
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    -- NEGOTIATED: the fare agreement must STILL be authoritative. This is the
    -- check the old finalizers were missing.
    IF v_session.status IS DISTINCT FROM 'fare_agreed' THEN
      RETURN 'agreement_lost';
    END IF;

    -- The JOB must still be the live negotiated agreement — not released back to
    -- the pool, superseded, cancelled or expired.
    IF LOWER(COALESCE(v_job.status, '')) <> 'fare_agreed' THEN
      RETURN 'agreement_lost';
    END IF;

    IF v_session.agreed_fare IS NULL OR v_session.agreed_fare <= 0 THEN
      RETURN 'agreement_lost';
    END IF;

    IF v_job.agreed_fare IS NULL THEN
      RETURN 'agreement_lost';
    END IF;

    -- AUTHORITATIVE DEADLINE. Effective deadline = persisted payment_deadline,
    -- falling back to expires_at for agreements accepted BEFORE 360 started
    -- writing payment_deadline (310 set expires_at = now() + 300s). It must
    -- EXIST and must NOT have elapsed.
    v_deadline := COALESCE(v_session.payment_deadline, v_session.expires_at);
    IF v_deadline IS NULL THEN
      RETURN 'agreement_lost';
    END IF;
    IF v_deadline <= now() THEN
      RETURN 'agreement_expired';
    END IF;

    IF p_expected_service_fare IS NOT NULL
       AND ROUND(p_expected_service_fare, 2) IS DISTINCT FROM ROUND(v_session.agreed_fare, 2) THEN
      RETURN 'agreed_fare_mismatch';
    END IF;

    IF v_job.driver_id IS DISTINCT FROM v_session.active_driver_id THEN
      RETURN 'driver_mismatch';
    END IF;

    -- AUTHORITATIVE AMOUNT. For a negotiated job the customer charge is exactly
    -- agreed_fare + item budget. The item budget is READ from its persisted home
    -- (public.errand_funding is a TABLE, not a job column) using the same
    -- precedence the client uses; NO pricing/fee formula is duplicated here — this
    -- only proves the intent amount against the persisted authority, which is what
    -- stops a stale £9.06 quote from finalising a £9.00 agreement.
    IF p_intent_amount_minor IS NOT NULL THEN
      SELECT COALESCE(NULLIF(ef.amount_reserved, 0), NULLIF(ef.item_budget, 0), 0)
        INTO v_item_budget
        FROM public.errand_funding ef
       WHERE ef.job_id = p_job_id
       LIMIT 1;

      v_item_budget := COALESCE(v_item_budget, 0);
      v_expected_minor := ROUND((v_session.agreed_fare + v_item_budget) * 100);
      IF v_expected_minor IS DISTINCT FROM p_intent_amount_minor THEN
        RETURN 'amount_mismatch';
      END IF;
    END IF;
  ELSE
    -- NON-NEGOTIATED: preserve the pre-existing semantics exactly. The webhook
    -- only advances an UNPAID, UNOWNED job; /confirm may advance a locked-driver
    -- (assigned) job.
    IF p_require_unowned AND v_job.driver_id IS NOT NULL THEN
      RETURN 'driver_mismatch';
    END IF;
  END IF;

  -- CURRENCY: the money must be in the job's own currency.
  IF p_currency IS NOT NULL
     AND LOWER(p_currency) IS DISTINCT FROM LOWER(COALESCE(v_job.currency_code, 'gbp')) THEN
    RETURN 'currency_mismatch';
  END IF;

  v_status := LOWER(COALESCE(v_job.status, ''));
  IF v_status IN ('cancelled', 'canceled', 'expired', 'completed', 'settled') THEN
    RETURN 'job_terminal';
  END IF;

  IF p_payment_intent_id IS NOT NULL
     AND v_job.payment_intent_id IS NOT NULL
     AND v_job.payment_intent_id IS DISTINCT FROM p_payment_intent_id THEN
    RETURN 'intent_mismatch';
  END IF;

  UPDATE public.jobs
  SET payment_status = p_payment_status,
      status = p_job_status,
      dispatch_started_at = p_dispatch_started_at,
      driver_search_expires_at = p_driver_search_expires_at,
      dispatch_attempts = COALESCE(p_dispatch_attempts, 0),
      no_driver_reason = NULL,
      updated_at = now()
  WHERE id = p_job_id;

  RETURN 'finalized';
END;
$$;

-- ===========================================================================
-- ACL — the new expiry helper is INTERNAL to the SECURITY DEFINER transitions.
-- ===========================================================================
REVOKE ALL ON FUNCTION public.expire_unpaid_fare_agreement(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.expire_unpaid_fare_agreement(UUID) FROM anon, authenticated;
-- SERVICE authority only: the payment endpoint must be able to PERSIST the expiry
-- transition (not merely report it) with no browser / Driver Hub dependency.
-- Ordinary authenticated clients stay revoked.
GRANT EXECUTE ON FUNCTION public.expire_unpaid_fare_agreement(UUID) TO service_role;

-- BACKEND-ONLY finalization authority. Ordinary clients (anon AND authenticated)
-- must never be able to finalize arbitrary payment state — only our own server
-- (service_role) may call this.
REVOKE ALL ON FUNCTION public.finalize_job_payment(UUID, TEXT, TEXT, TEXT, NUMERIC, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, BIGINT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.finalize_job_payment(UUID, TEXT, TEXT, TEXT, NUMERIC, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, BIGINT, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_job_payment(UUID, TEXT, TEXT, TEXT, NUMERIC, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, BIGINT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.customer_cancel_offer(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.customer_cancel_offer(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.customer_cancel_offer(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.customer_expire_unpaid_agreement(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.customer_expire_unpaid_agreement(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.customer_expire_unpaid_agreement(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.fetch_hybrid_opportunities(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.driver_accept_customer_offer(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.driver_accept_customer_offer(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.driver_accept_customer_offer(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.customer_accept_driver_counter(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.customer_accept_driver_counter(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.customer_accept_driver_counter(UUID) TO authenticated;
