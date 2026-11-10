-- ============================================================================
-- MOVABI — BATCH 2C / PHASE B.1: ACQUISITION ATOMICITY HARDENING
--
-- SCOPE: two live hybrid/legacy negotiation paths that could report success
-- without actually transferring ownership, or transfer it to the wrong driver.
--
--   A. public.accept_driver_offer(uuid, uuid)   NEW
--      The atomic replacement for the legacy
--      `POST /api/booking/negotiation/:id/accept` handler, which performed a bare
--      `.update({status, agreed_fare, driver_id})` with NO status predicate, NO
--      ownership predicate, NO row lock and NO transaction. It could therefore:
--        * set status = 'fare_agreed' with driver_id = NULL when a customer
--          accepted a negotiation that had no proposing driver,
--        * reassign driver_id from driver A to driver B with no check,
--        * report { success: true } whether or not anything was written.
--
--   B. public.lock_marketplace_fare(uuid, uuid, numeric)  REPLACED
--      The hybrid driver "accept fare" path. It locked the JOB with only
--      `WHERE id = p_job_id`, had no FOUND check, and had no ownership predicate:
--        * a zero-row UPDATE raised nothing and still returned the session, so
--          the driver saw "Suggested fare accepted!" with no ownership written,
--        * it could silently reassign an already-owned job (A -> B),
--        * it never verified that the caller IS the session's active driver.
--
-- THIS MIGRATION DOES NOT CHANGE ENFORCEMENT POLICY
-- ============================================================================
--   * the Phase A acquisition trigger is NOT enabled (it stays DISABLED),
--   * NO MB002 compliance check is added to either path: compliance enforcement
--     is Phase C work. MB002 therefore remains RESERVED and unreachable, and
--     MB001 keeps its existing busy/N12 meaning unchanged,
--   * no advisory rule is promoted,
--   * no RLS is enabled or altered,
--   * no table or column privilege is granted or revoked,
--   * the N12 frozen occupying-status set and idx_jobs_one_active_per_driver are
--     read-only dependencies and are neither altered nor re-created,
--   * no data is mutated by this migration.
--
-- ACL NOTE
-- ============================================================================
-- `accept_driver_offer` is a server-only helper: EXECUTE is granted to
-- service_role only, never to anon or authenticated.
-- `lock_marketplace_fare` keeps its EXISTING ACL matrix untouched: CREATE OR
-- REPLACE preserves privileges, and the authenticated client calls it directly,
-- which is why the new identity check uses `auth.uid()`.
-- ============================================================================


-- ============================================================================
-- SECTION A — public.accept_driver_offer(uuid, uuid)
--
-- The minimum trusted atomic contract for "customer accepts a driver's offer".
-- One transaction, one row lock, deterministic SQLSTATEs, and a success only
-- when ownership actually moved.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.accept_driver_offer(
    p_job_id    UUID,
    p_driver_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_job        public.jobs;
    v_offer      public.fare_negotiations;
    v_caller     UUID := auth.uid();
    v_constraint TEXT;
BEGIN
    -- Identity: a browser caller may only accept their OWN offer. service_role
    -- (the trusted server) may act on behalf of the negotiation's driver, whose
    -- id is derived server-side from the negotiation row, never from the client.
    IF v_caller IS NOT NULL AND v_caller <> p_driver_id THEN
        RAISE EXCEPTION 'You can only accept your own fare offer'
            USING ERRCODE = '42501',
                  DETAIL  = 'caller_mismatch';
    END IF;

    -- Lock the job first so concurrent acceptances serialise on one row.
    SELECT * INTO v_job
      FROM public.jobs
     WHERE id = p_job_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job not found'
            USING ERRCODE = 'P0002',
                  DETAIL  = 'job_not_found';
    END IF;

    -- The job must still be open for negotiation.
    IF v_job.status NOT IN ('pending_fare_confirmation', 'negotiating') THEN
        RAISE EXCEPTION 'This offer is no longer available'
            USING ERRCODE = '23514',
                  DETAIL  = 'job_not_negotiating';
    END IF;

    -- Ownership transition: free, or already this driver. A -> B is refused.
    IF v_job.driver_id IS NOT NULL AND v_job.driver_id <> p_driver_id THEN
        RAISE EXCEPTION 'This job is already owned by another driver'
            USING ERRCODE = '23505',
                  DETAIL  = 'job_already_owned_by_other_driver';
    END IF;

    -- The offer must exist, come from THIS driver, and still be pending.
    SELECT * INTO v_offer
      FROM public.fare_negotiations
     WHERE job_id = p_job_id
       AND proposed_by = p_driver_id
       AND proposed_by_role = 'driver'
       AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No pending driver offer found'
            USING ERRCODE = 'P0002',
                  DETAIL  = 'offer_not_found';
    END IF;

    IF v_offer.amount IS NULL OR v_offer.amount <= 0 THEN
        RAISE EXCEPTION 'Offer amount is not valid'
            USING ERRCODE = '22023',
                  DETAIL  = 'invalid_offer_amount';
    END IF;

    UPDATE public.fare_negotiations
       SET status = 'accepted',
           updated_at = now()
     WHERE id = v_offer.id;

    -- Guarded ownership write. The predicate plus the FOUND check mean this can
    -- never report success unless the row actually moved to fare_agreed.
    BEGIN
        UPDATE public.jobs
           SET status       = 'fare_agreed',
               driver_id    = p_driver_id,
               agreed_fare  = v_offer.amount,
               updated_at   = now()
         WHERE id = p_job_id
           AND status IN ('pending_fare_confirmation', 'negotiating')
           AND (driver_id IS NULL OR driver_id = p_driver_id)
        RETURNING * INTO v_job;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Ownership was not applied'
                USING ERRCODE = '23514',
                      DETAIL  = 'ownership_not_applied';
        END IF;
    EXCEPTION
        WHEN unique_violation THEN
            GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
            IF v_constraint = 'idx_jobs_one_active_per_driver' THEN
                RAISE EXCEPTION 'Driver already has an active job'
                    USING ERRCODE    = 'MB001',
                          CONSTRAINT = 'idx_jobs_one_active_per_driver',
                          DETAIL     = 'driver_single_active_job';
            END IF;
            RAISE;
    END;

    RETURN jsonb_build_object(
        'job_id',         p_job_id,
        'driver_id',      p_driver_id,
        'negotiation_id', v_offer.id,
        'agreed_fare',    v_offer.amount,
        'status',         v_job.status,
        'accepted_at',    now()
    );
END;
$$;


-- ============================================================================
-- SECTION B — public.lock_marketplace_fare(uuid, uuid, numeric)  REPLACED
--
-- Changes, all of them fail-closed:
--   1. IDENTITY  — a browser caller must be the session's active driver
--                  (`auth.uid()`); service_role bypasses. Previously any
--                  authenticated caller could name any driver.
--   2. JOB LOCK  — the job row is locked FOR UPDATE and must exist.
--   3. STATUS    — the job must still be negotiable; a terminal or already
--                  owned-by-another job is refused (no A -> B reassignment).
--   4. OWNERSHIP — driver_id must be NULL or already this driver.
--   5. FOUND     — the jobs UPDATE must actually affect a row; a zero-row update
--                  no longer returns a session as if it had succeeded.
--   6. MB001     — the N12 unique-violation mapping is preserved EXACTLY.
--
-- The ACL matrix is deliberately untouched.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.lock_marketplace_fare(
  p_job_id UUID,
  p_driver_id UUID,
  p_amount NUMERIC
)
RETURNS public.marketplace_negotiation_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session    public.marketplace_negotiation_sessions;
  v_job        public.jobs;
  v_caller     UUID := auth.uid();
  v_constraint TEXT;
BEGIN
  -- 1. IDENTITY
  IF v_caller IS NOT NULL AND v_caller <> p_driver_id THEN
    RAISE EXCEPTION 'You can only lock a fare for your own session'
      USING ERRCODE = '42501', DETAIL = 'caller_mismatch';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND OR v_session.active_driver_id IS DISTINCT FROM p_driver_id THEN
    RAISE EXCEPTION 'Session not active for this driver'
      USING ERRCODE = '42501', DETAIL = 'session_not_active';
  END IF;

  -- 2. JOB LOCK + 3. STATUS + 4. OWNERSHIP
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found'
      USING ERRCODE = 'P0002', DETAIL = 'job_not_found';
  END IF;

  IF v_job.status NOT IN ('pending_fare_confirmation', 'negotiating', 'pending', 'requested', 'searching') THEN
    RAISE EXCEPTION 'This job is no longer open for fare agreement'
      USING ERRCODE = '23514', DETAIL = 'job_not_negotiable';
  END IF;

  IF v_job.driver_id IS NOT NULL AND v_job.driver_id <> p_driver_id THEN
    RAISE EXCEPTION 'This job is already owned by another driver'
      USING ERRCODE = '23505', DETAIL = 'job_already_owned_by_other_driver';
  END IF;

  UPDATE public.marketplace_negotiation_sessions
  SET agreed_fare = p_amount,
      status = 'fare_agreed',
      expires_at = now() + interval '300 seconds',
      updated_at = now()
  WHERE job_id = p_job_id
  RETURNING * INTO v_session;

  BEGIN
    -- 5. FOUND
    UPDATE public.jobs
    SET agreed_fare = p_amount,
        status = 'fare_agreed',
        driver_id = p_driver_id,
        updated_at = now()
    WHERE id = p_job_id
      AND status IN ('pending_fare_confirmation', 'negotiating', 'pending', 'requested', 'searching')
      AND (driver_id IS NULL OR driver_id = p_driver_id)
    RETURNING * INTO v_job;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Fare was not locked for this job'
        USING ERRCODE = '23514', DETAIL = 'ownership_not_applied';
    END IF;
  EXCEPTION
    -- 6. MB001 (N12 busy) — unchanged meaning and mapping.
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

  INSERT INTO public.marketplace_negotiation_events
    (session_id, job_id, proposed_by, proposed_by_role, event_type, amount, round_number, created_at)
  VALUES
    (v_session.id, p_job_id, p_driver_id, 'driver', 'driver_accept', p_amount, v_session.round_count, now());

  RETURN v_session;
END;
$$;


-- ============================================================================
-- SECTION C — PRIVILEGES (NEW function only)
--
-- Production carries broad DEFAULT FUNCTION privileges, so REVOKE FROM PUBLIC
-- alone is not sufficient: each must-not-have role is revoked explicitly (the
-- Batch 1 / 2A / 2B discipline). The new helper is server-only.
-- `lock_marketplace_fare` ACL is NOT touched here.
-- ============================================================================
REVOKE ALL ON FUNCTION public.accept_driver_offer(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.accept_driver_offer(UUID, UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_driver_offer(UUID, UUID) TO service_role;


-- PHASE B.1 EXPLICIT NON-ACTIONS (asserted by the static tests):
--   * no ALTER TABLE public.jobs ENABLE TRIGGER
--   * no ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY
--   * no CREATE/DROP/ALTER POLICY
--   * no GRANT/REVOKE on TABLES or COLUMNS
--   * no UPDATE/INSERT/DELETE against application data
--   * no change to the N12 status set or index
