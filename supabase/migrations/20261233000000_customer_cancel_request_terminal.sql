-- =============================================================================
-- 20261233000000_customer_cancel_request_terminal.sql
--
-- PRODUCTION-PROVEN DEFECT (cancelled request leaks into Pending Marketplace)
--   The Marketplace Fare "Cancel Request" button calls
--   public.customer_cancel_offer(session_id), which terminalised ONLY the
--   negotiation session (status -> 'customer_declined'). It never touched
--   public.jobs, so the job stayed in 'pending_fare_confirmation'/'negotiating'.
--
--   The Activity page classifies the Pending Marketplace bucket from the JOB
--   lifecycle state (pending_fare_confirmation/negotiating/fare_agreed), NOT from
--   the session. The result: a request the customer cancelled still rendered under
--   "Pending Marketplace" with an actionable "Fare offer received" card, and
--   reopening it re-exposed Accept Fare & Pay / Cancel Request as if live.
--
--   Meanwhile the legacy job-cancel authority (auth.cancel_job_safely) only
--   transitions 'requested','searching','assigned','accepted','heading_to_pickup'
--   and excludes the marketplace statuses, so there was NO authoritative path to
--   mark a marketplace request terminal. This is a genuine authority hole.
--
-- WHAT THIS MIGRATION DOES (additive; no existing migration is edited or reapplied)
--   Re-issues public.customer_cancel_offer UNCHANGED except that, after the session
--   is terminalised, the owning job is ALSO transitioned to 'cancelled' when it is
--   still in a negotiable state. The customer is already proven to be the session
--   owner, so this is the same actor terminalising their own outstanding request.
--
--   Result: a cancelled marketplace request is now authoritative-terminal at BOTH
--   the session and the job level, so Activity moves it from Pending Marketplace
--   into the Past ("cancelled") bucket and the Marketplace Fare page can no longer
--   treat it as an actionable live fare.
--
-- DELIBERATELY UNCHANGED
--   * Payment / Stripe / pricing / commission are untouched (the job is unpaid at
--     the negotiable stage; no capture/refund belongs here).
--   * negotiation_mode_enabled is left alone: 'cancelled' is the terminal signal.
--   * No new statuses are invented; the existing 'cancelled' taxonomy is reused.
--   * migration 310 (and 320) are not edited or reapplied.
--
-- ACL: CREATE OR REPLACE preserves the existing ACL; it is re-asserted defensively.
-- =============================================================================

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

  -- CANCELLATION AUTHORITY (added by this migration): the customer's "Cancel
  -- Request" is a terminal withdrawal of the WHOLE request, not just the session.
  -- Terminalise the owning job so the Activity bucket and the Marketplace Fare
  -- page can no longer treat it as a live actionable fare. Scoped to the
  -- negotiable statuses this RPC already permits; a fare_agreed/paid job is never
  -- reached here (the session guard above rejects those), so no payment is touched.
  UPDATE public.jobs
  SET status = 'cancelled',
      updated_at = now()
  WHERE id = v_session.job_id
    AND status IN ('pending_fare_confirmation', 'negotiating', 'open');

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, message, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'customer',
    'customer_decline', 'Customer cancelled request', v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_cancel_offer(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.customer_cancel_offer(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.customer_cancel_offer(UUID) TO authenticated;
