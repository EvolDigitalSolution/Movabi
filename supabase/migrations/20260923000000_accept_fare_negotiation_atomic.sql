-- ============================================================================
-- MOVABI — BATCH 2A: atomic acceptance for the LEGACY fare_negotiations flow
--
-- PROBLEM (N35)
-- ============================================================================
-- POST /api/booking/negotiation/:jobId/driver-accept — the endpoint behind the
-- DRIVER DASHBOARD "accept customer offer" action — previously performed:
--
--     SELECT jobs
--     SELECT fare_negotiations WHERE status='pending' ORDER BY created_at DESC LIMIT 1
--     UPDATE fare_negotiations SET status='accepted'
--     UPDATE jobs SET status='fare_agreed', driver_id = <caller>
--
-- with NO transaction, NO row lock, NO status predicate on either write and NO
-- ownership predicate. Two concurrent drivers therefore both read the same
-- pending offer, both marked it accepted, both overwrote jobs.driver_id — last
-- write wins — and BOTH received { success: true }. Double-winner.
--
-- Note the two negotiation persistence models are DISJOINT and stay that way:
--   * public.marketplace_negotiation_sessions  -> the hybrid flow, written only
--     by MarketplaceHybridService.createCustomerOffer, accepted atomically by
--     public.lock_marketplace_fare (FOR UPDATE + active_driver_id guard).
--   * public.fare_negotiations                -> this legacy flow, written only
--     by POST /api/booking/negotiation.
-- No writer creates both rows for one job, which is why lock_marketplace_fare
-- cannot serve this path and a dedicated primitive is required. This migration
-- deliberately does NOT touch lock_marketplace_fare, claim_marketplace_
-- negotiation, release_marketplace_negotiation, or any Batch 1 function.
--
-- WHAT THIS FUNCTION DOES
-- ============================================================================
-- Makes legacy acceptance ONE database transaction with a deterministic lock
-- order (jobs -> fare_negotiations), and derives the driver from the caller of
-- the trusted API route. It owns ONLY ownership/status/non-ownership-amount:

--   * fare_negotiations selected row -> status='accepted'
--   * jobs -> status='fare_agreed', driver_id, negotiated_fare, agreed_fare
--
-- It deliberately does NOT recompute the derived pricing breakdown. That logic
-- lives in PricingService.applyAgreedFare (TypeScript) and is NOT duplicated in
-- PL/pgSQL; the route applies it afterwards with an ownership-guarded write.
-- See the Batch 2A report for the crash-consistency reasoning.
--
-- NO DATA MIGRATION: no UPDATE over existing rows, no backfill, no historical
-- rewrite. CREATE OR REPLACE FUNCTION + privileges only.
--
-- SECURITY: service_role only. The HTTP route derives the driver from the
-- authenticated session and passes it in; the browser must never be able to
-- call this directly. Because production carries broad DEFAULT FUNCTION
-- privileges, REVOKE FROM PUBLIC alone is NOT sufficient — every role that must
-- not execute is revoked explicitly.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.accept_fare_negotiation(
    p_job_id UUID,
    p_driver_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_job public.jobs;
    v_negotiation public.fare_negotiations;
    v_agreed_fare NUMERIC;
    v_now TIMESTAMPTZ := now();
BEGIN
    IF p_job_id IS NULL OR p_driver_id IS NULL THEN
        RAISE EXCEPTION 'p_job_id and p_driver_id are required'
            USING ERRCODE = '22023';
    END IF;

    -- ------------------------------------------------------------------
    -- 1. Lock the job first. This is the serialisation point: concurrent
    --    accepts for the same job queue here, so the loser observes the
    --    winner's committed state.
    -- ------------------------------------------------------------------
    SELECT * INTO v_job
    FROM public.jobs
    WHERE id = p_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Job not found'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_job.negotiation_mode_enabled IS NOT TRUE THEN
        RAISE EXCEPTION 'Job is not in negotiation mode'
            USING ERRCODE = '22023';
    END IF;

    -- Job must still be in a negotiation state. Both statuses are reachable:
    -- the discovery query below is the only one this function performs, and
    -- POST /api/booking/negotiation sets 'negotiating' for a customer offer
    -- and 'pending_fare_confirmation' for a driver offer.
    IF v_job.status NOT IN ('pending_fare_confirmation', 'negotiating') THEN
        RAISE EXCEPTION 'Job is no longer available for negotiation (status %)', v_job.status
            USING ERRCODE = '23514';
    END IF;

    -- ------------------------------------------------------------------
    -- 2. Ownership guard. A job already owned by a different driver is lost.
    -- ------------------------------------------------------------------
    IF v_job.driver_id IS NOT NULL AND v_job.driver_id <> p_driver_id THEN
        RAISE EXCEPTION 'Job is already owned by another driver'
            USING ERRCODE = '23505';
    END IF;

    -- ------------------------------------------------------------------
    -- 3. Deterministic selection of the newest pending CUSTOMER offer, then
    --    lock that row. Lock order is jobs -> fare_negotiations, matching the
    --    convention used by the other negotiation RPCs.
    -- ------------------------------------------------------------------
    SELECT * INTO v_negotiation
    FROM public.fare_negotiations
    WHERE job_id = p_job_id
      AND proposed_by_role = 'customer'
      AND status = 'pending'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No pending customer offer found'
            USING ERRCODE = 'P0002';
    END IF;

    -- Re-assert under the row lock. The SELECT above filtered on status, but
    -- this makes the invariant explicit and fails closed if the predicate is
    -- ever changed.
    IF v_negotiation.status <> 'pending' THEN
        RAISE EXCEPTION 'Offer is no longer pending'
            USING ERRCODE = '23514';
    END IF;

    v_agreed_fare := ROUND(COALESCE(v_negotiation.amount, 0)::NUMERIC, 2);

    IF v_agreed_fare <= 0 THEN
        RAISE EXCEPTION 'Agreed fare must be greater than zero'
            USING ERRCODE = '22023';
    END IF;

    -- ------------------------------------------------------------------
    -- 4. Writes. Both inside this transaction, so ownership and status can
    --    never diverge.
    -- ------------------------------------------------------------------
    UPDATE public.fare_negotiations
    SET status = 'accepted',
        updated_at = v_now
    WHERE id = v_negotiation.id
    RETURNING * INTO v_negotiation;

    UPDATE public.jobs
    SET status = 'fare_agreed',
        driver_id = p_driver_id,
        negotiated_fare = v_agreed_fare,
        agreed_fare = v_agreed_fare,
        updated_at = v_now
    WHERE id = p_job_id
    RETURNING * INTO v_job;

    -- Sufficient data for the route to build its existing HTTP response and to
    -- re-derive the pricing breakdown via PricingService.applyAgreedFare.
    RETURN jsonb_build_object(
        'job_id', p_job_id,
        'driver_id', p_driver_id,
        'agreed_fare', v_agreed_fare,
        'negotiation', to_jsonb(v_negotiation)
    );
END;
$$;

-- ============================================================================
-- PRIVILEGES — service_role only.
--
-- Revoked from every role explicitly, THEN granted only to service_role.
-- `REVOKE ... FROM PUBLIC` alone would leave the concrete role grants that
-- production's default ACL hands to anon / authenticated / service_role.
-- The owner keeps its own privilege; that is intentional and not revoked.
-- ============================================================================
REVOKE ALL ON FUNCTION public.accept_fare_negotiation(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_fare_negotiation(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.accept_fare_negotiation(UUID, UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.accept_fare_negotiation(UUID, UUID) FROM service_role;

GRANT EXECUTE ON FUNCTION public.accept_fare_negotiation(UUID, UUID)
TO service_role;
