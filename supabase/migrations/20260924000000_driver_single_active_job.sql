-- ============================================================================
-- MOVABI — BATCH 2B: N12 single-active-job invariant
--
-- PROBLEM (N12)
-- ============================================================================
-- No path in the system prevented one driver from owning two simultaneously
-- active jobs. Every acquisition path guarded only the TARGET job row
-- (`driver_id IS NULL` on that job) and never asked whether the DRIVER already
-- owned another job. There was no partial unique index, no exclusion
-- constraint, no trigger, no advisory lock, and no driver-row lock, so:
--
--   T1 accept(J1, D)   -> UPDATE jobs WHERE id = J1
--   T2 accept(J2, D)   -> UPDATE jobs WHERE id = J2
--
-- lock DIFFERENT rows and both commit. Locking the target job cannot serialise
-- this: the contended resource is the DRIVER, not the job.
--
-- CANONICAL DEFINITION OF OCCUPATION (frozen)
-- ============================================================================
-- A job occupies its driver iff
--     jobs.driver_id IS NOT NULL
--     AND jobs.status IN (<frozen occupying set, see below>)
--
-- The frozen occupying set is EXACTLY these 16 statuses, derived from every
-- writer that sets jobs.driver_id and cross-checked against the driver app's
-- own active-status lists:
--
--   assigned, accepted, fare_agreed, heading_to_pickup, driver_en_route,
--   arrived, driver_arrived, arrived_at_store, shopping_in_progress, collected,
--   picked_up, en_route_to_customer, in_progress, delivered,
--   over_budget_requested, requires_review
--
-- Deliberately EXCLUDED (terminal / non-occupying history):
--   completed, settled, cancelled, failed, expired, no_driver_found
--
-- `fare_agreed` is INCLUDED because three separate paths write driver_id
-- together with that status (accept_fare_negotiation, lock_marketplace_fare and
-- the legacy POST /api/booking/negotiation/:id/accept route).
-- `requires_review` is INCLUDED because the driver-unable-after-spend path
-- retains driver_id when it moves the job there.
--
-- profiles.is_available is NOT touched by this migration and remains a
-- presence/willingness flag only. No is_busy column is introduced. Availability
-- flags are never toggled by job acquisition or completion.
--
-- THE AUTHORITATIVE MECHANISM
-- ============================================================================
-- A partial UNIQUE index on jobs(driver_id) restricted to the frozen occupying
-- statuses. It is enforced by the storage engine for EVERY writer - all
-- acquisition RPCs, the legacy direct PostgREST update, hybrid negotiation, and
-- any future path - and it is keyed on the DRIVER, so two concurrent
-- transactions writing two DIFFERENT jobs for the same driver contend on the
-- same index tuple and the second fails with unique_violation (23505).
--
-- The RPC pre-checks below are SECONDARY, deterministic-UX only. They are NOT
-- the concurrency guarantee and must never be described or tested as such.
--
-- WHY THE STATUS LIST APPEARS IN TWO PLACES (and how the duplication is
-- guarded)
-- ============================================================================
-- A partial-index predicate must be stable for the life of the index. A
-- predicate that calls a user function (even one marked IMMUTABLE) would be
-- re-evaluated against the function's CURRENT body on every write, so a later
-- CREATE OR REPLACE of that function would silently change which rows are
-- indexed while leaving the already-indexed rows behind - corrupting the
-- invariant with no error. The index predicate is therefore a LITERAL list and
-- does not depend on any function.
--
-- The literal list therefore appears exactly twice in this file: once in
-- public.driver_occupying_statuses() (the single runtime source of truth used
-- by every RPC pre-check) and once in the index predicate. The two are proved
-- identical by THREE independent guards:
--   1. the migration-time check below (raises and rolls the migration back),
--   2. scripts/db/postflight_20260924000000_driver_single_active_job.sql
--      (set-compares the helper output against the LIVE index predicate),
--   3. src/testing/batch2b-driver-single-active-job.spec.ts (static set compare).
--
-- Operationally: run the preflight FIRST. If duplicate occupying jobs exist,
-- that is an operator-review NO-GO and NOTHING here may be applied.
--
-- INDEX DEPLOYMENT — DECIDED: ordinary transactional CREATE UNIQUE INDEX
-- ============================================================================
-- Production preflight evidence (2026-09-24):
--     jobs total rows ................ 151
--     jobs with driver_id ............ 24
--     occupying jobs ................. 0
--     duplicate occupying drivers .... 0
--     public.jobs table size ......... 232 kB (relation total 648 kB)
--     PostgreSQL ..................... 15.1
--     existing single-active index ... none
--
-- With 151 rows and a 232 kB heap, the ordinary transactional
-- CREATE UNIQUE INDEX below is the SELECTED production path. It is the
-- authoritative deployment artifact and it is transaction-safe, so it applies
-- and rolls back with the rest of this migration.
--
-- CREATE INDEX CONCURRENTLY is explicitly NOT used for this deployment. A
-- reference copy is retained at
-- scripts/db/reference_only_concurrent_index_20260924000000_driver_single_active_job.sql
-- purely as documentation / future recovery for a much larger table. That file
-- is NOT part of this deployment and MUST NOT be run for it.
--
-- `IF NOT EXISTS` remains so the statement is idempotent if the index somehow
-- already exists; the SECTION 4 guard then validates the REAL live object.
--
-- NO DATA MIGRATION: this migration never rewrites, reassigns, deletes or
-- repairs existing job rows. Duplicate active ownership is NOT resolved
-- automatically.
--
-- NEVER edits 20260921000000 or 20260923000000. Those files are applied and
-- frozen; the functions below are re-issued here with CREATE OR REPLACE.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — CANONICAL OCCUPYING-STATUS HELPER
--
-- Pure, argument-free, side-effect-free literal array. This is the single
-- runtime source of the frozen set: every RPC pre-check reaches the set through
-- driver_has_other_active_job() -> driver_occupying_statuses(), so no endpoint
-- ever re-types the list.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.driver_occupying_statuses()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT ARRAY[
        'assigned',
        'accepted',
        'fare_agreed',
        'heading_to_pickup',
        'driver_en_route',
        'arrived',
        'driver_arrived',
        'arrived_at_store',
        'shopping_in_progress',
        'collected',
        'picked_up',
        'en_route_to_customer',
        'in_progress',
        'delivered',
        'over_budget_requested',
        'requires_review'
    ]::TEXT[];
$$;


-- ============================================================================
-- SECTION 2 — ACTIVE-JOB PREDICATES
--
-- driver_has_other_active_job(p_driver_id, p_exclude_job_id) is the predicate
-- the RPCs use. The exclude argument is ESSENTIAL: an operation that targets
-- job J must not be rejected merely because J itself is one of the driver's
-- occupying jobs. This is exactly the case for accept_assigned_job, whose job
-- already carries driver_id = caller BEFORE confirmation.
--
-- NULL handling: a NULL driver id yields FALSE (never a false "busy"), and a
-- NULL exclude id excludes nothing (IS DISTINCT FROM NULL is TRUE for every
-- non-null job id).
--
-- SECURITY INVOKER, mirrored from Batch 1's driver_vehicle_can_accept_job: this
-- is an internal predicate called only from SECURITY DEFINER functions, so it
-- needs no elevated rights and must not be client-callable. EXECUTE is revoked
-- from every role below; the SECURITY DEFINER callers run as the owner and can
-- still reach it.
--
-- This is why SECTION 5.2 makes assign_driver_to_job SECURITY DEFINER: an
-- INVOKER function cannot execute this predicate, and widening the predicate's
-- ACL to accommodate it would expose driver busy-state probing to clients.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.driver_has_other_active_job(
    p_driver_id UUID,
    p_exclude_job_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    SELECT p_driver_id IS NOT NULL
       AND EXISTS (
           SELECT 1
             FROM public.jobs j
            WHERE j.driver_id = p_driver_id
              AND j.status = ANY (public.driver_occupying_statuses())
              AND j.id IS DISTINCT FROM p_exclude_job_id
       );
$$;

CREATE OR REPLACE FUNCTION public.driver_has_active_job(
    p_driver_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    SELECT public.driver_has_other_active_job(p_driver_id, NULL);
$$;


-- ============================================================================
-- SECTION 3 — THE INVARIANT
--
-- Partial UNIQUE index. One occupying job per driver. Terminal statuses are
-- outside the predicate, so a driver accumulates unlimited completed/cancelled
-- history, and a driver becomes free again STRUCTURALLY the moment their job
-- leaves the occupying set - no release write, no availability toggle, and no
-- possibility of a permanently-busy driver.
--
-- IF NOT EXISTS makes this idempotent so an operator pre-created CONCURRENTLY
-- index is respected.
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_per_driver
    ON public.jobs (driver_id)
 WHERE driver_id IS NOT NULL
   AND status IN (
        'assigned',
        'accepted',
        'fare_agreed',
        'heading_to_pickup',
        'driver_en_route',
        'arrived',
        'driver_arrived',
        'arrived_at_store',
        'shopping_in_progress',
        'collected',
        'picked_up',
        'en_route_to_customer',
        'in_progress',
        'delivered',
        'over_budget_requested',
        'requires_review'
   );


-- ============================================================================
-- SECTION 4 — MIGRATION-TIME SELF-CHECK OF THE LIVE INVARIANT OBJECT
--
-- Fails the migration (and therefore rolls it back) unless the index that now
-- exists under this name is genuinely the intended invariant AND its literal
-- predicate status set is identical to the helper's frozen set. This is what
-- makes the two-place duplication safe: a divergence cannot be applied.
-- ============================================================================
DO $$
DECLARE
    v_is_unique      BOOLEAN;
    v_table          TEXT;
    v_key_column     TEXT;
    v_key_count      INTEGER;
    v_helper         TEXT[];
    v_predicate      TEXT[];
    v_helper_only    TEXT[];
    v_predicate_only TEXT[];
BEGIN
    SELECT i.indisunique,
           tn.nspname || '.' || tc.relname,
           a.attname,
           i.indnkeyatts
      INTO v_is_unique, v_table, v_key_column, v_key_count
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
      JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
      LEFT JOIN pg_catalog.pg_attribute a
             ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE ic.relname = 'idx_jobs_one_active_per_driver'
       AND tn.nspname = 'public';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'N12: idx_jobs_one_active_per_driver was not created';
    END IF;

    IF v_is_unique IS NOT TRUE THEN
        RAISE EXCEPTION 'N12: idx_jobs_one_active_per_driver exists but is NOT UNIQUE';
    END IF;

    IF v_table IS DISTINCT FROM 'public.jobs' THEN
        RAISE EXCEPTION 'N12: idx_jobs_one_active_per_driver is on % , expected public.jobs', v_table;
    END IF;

    IF v_key_count IS DISTINCT FROM 1 OR v_key_column IS DISTINCT FROM 'driver_id' THEN
        RAISE EXCEPTION 'N12: idx_jobs_one_active_per_driver key must be exactly (driver_id), found % column(s) starting with %',
            v_key_count, COALESCE(v_key_column, 'NULL');
    END IF;

    -- The helper's frozen set.
    v_helper := public.driver_occupying_statuses();

    -- The LIVE index predicate's quoted literals. regexp_matches is a
    -- set-returning function, so it is used as a FROM item via CROSS JOIN
    -- LATERAL (PostgreSQL 15 rejects an SRF inside an aggregate argument).
    SELECT array_agg(DISTINCT lit ORDER BY lit)
      INTO v_predicate
      FROM (
          SELECT (m.match)[1] AS lit
            FROM pg_catalog.pg_index i
            JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
           CROSS JOIN LATERAL pg_catalog.regexp_matches(
                          pg_catalog.pg_get_expr(i.indpred, i.indrelid),
                          '''([^'']*)''', 'g') AS m(match)
           WHERE ic.relname = 'idx_jobs_one_active_per_driver'
      ) lits;

    IF v_predicate IS NULL THEN
        RAISE EXCEPTION 'N12: idx_jobs_one_active_per_driver has no readable predicate';
    END IF;

    SELECT array_agg(s ORDER BY s) INTO v_helper_only
      FROM (SELECT s FROM unnest(v_helper) AS u(s)
            EXCEPT
            SELECT s FROM unnest(v_predicate) AS u(s)) d;

    SELECT array_agg(s ORDER BY s) INTO v_predicate_only
      FROM (SELECT s FROM unnest(v_predicate) AS u(s)
            EXCEPT
            SELECT s FROM unnest(v_helper) AS u(s)) d;

    IF v_helper_only IS NOT NULL OR v_predicate_only IS NOT NULL THEN
        RAISE EXCEPTION 'N12: frozen status set diverged. helper-only=%, predicate-only=%',
            COALESCE(v_helper_only::TEXT, 'none'),
            COALESCE(v_predicate_only::TEXT, 'none');
    END IF;

    RAISE NOTICE 'N12: invariant verified - unique(driver_id) over % occupying statuses',
        array_length(v_helper, 1);
END $$;


-- ============================================================================
-- SECTION 5 — ACQUISITION RPCs
--
-- Each ownership-writing RPC is re-issued to (a) fail fast with a
-- deterministic driver-busy error when the driver already owns ANOTHER
-- occupying job, and (b) convert a genuine unique_violation on THIS index into
-- the same deterministic error. Both paths use the same SQLSTATE (MB001) and
-- the same CONSTRAINT name, so callers never have to guess, and an unrelated
-- unique violation is re-raised untouched.
--
-- SQLSTATE MB001 is application-defined. It is deliberately NOT 23505, because
-- accept_fare_negotiation already uses 23505 for "job is already owned by
-- another driver" and mapping that to "you are busy" would be wrong.
--
-- Every existing guard, lock, status predicate, vehicle check, auth rule and
-- return contract from Batch 1 / Batch 2A is preserved verbatim.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 5.1 accept_searching_job - DRIVER SELF-ACCEPT (Batch 1 semantics preserved)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_searching_job(
    p_job_id UUID,
    p_driver_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller UUID := auth.uid();
    v_updated BOOLEAN;
    v_constraint TEXT;
BEGIN
    IF p_job_id IS NULL OR p_driver_id IS NULL THEN
        RAISE EXCEPTION 'p_job_id and p_driver_id are required';
    END IF;

    -- Browser/authenticated callers may only claim work for themselves.
    -- service_role calls have no auth.uid() and remain available to trusted server code.
    IF v_caller IS NOT NULL AND v_caller <> p_driver_id THEN
        RAISE EXCEPTION 'A driver may only accept a request for themselves';
    END IF;

    IF NOT public.driver_vehicle_can_accept_job(p_job_id, p_driver_id) THEN
        RAISE EXCEPTION 'Driver vehicle is not compatible with this request';
    END IF;

    -- N12 (secondary, deterministic UX only). The target job is excluded, so a
    -- repeat call on a job this driver already owns behaves exactly as before:
    -- the UPDATE predicate below matches no row and the function returns FALSE.
    IF public.driver_has_other_active_job(p_driver_id, p_job_id) THEN
        RAISE EXCEPTION 'Driver already has an active job'
            USING ERRCODE = 'MB001',
                  CONSTRAINT = 'idx_jobs_one_active_per_driver',
                  DETAIL = 'driver_single_active_job';
    END IF;

    BEGIN
        UPDATE public.jobs
        SET driver_id = p_driver_id,
            accepted_driver_id = p_driver_id,
            status = 'accepted',
            accepted_at = NOW(),
            updated_at = NOW()
        WHERE id = p_job_id
          -- Exactly the statuses the driver UI advertises as available
          -- (driver.service.ts availableRequestStatuses + the realtime filter +
          --  dispatch.service.ts, which writes 'broadcasting' and 'waiting').
          AND status IN ('pending', 'requested', 'searching', 'broadcasting', 'waiting')
          AND driver_id IS NULL
          AND accepted_driver_id IS NULL;

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
-- 5.2 assign_driver_to_job - ADMIN/DISPATCH ASSIGNMENT
--
-- PRIVILEGE DEFECT CORRECTED HERE (confirmed in production):
--   Batch 1 left this function SECURITY INVOKER while the helper it must call,
--   public.driver_vehicle_can_accept_job(uuid,uuid), has EXECUTE revoked from
--   anon, authenticated AND service_role (only the owner retains it). Inside an
--   INVOKER function the privilege check runs as the CALLING role, so every
--   real caller - the admin browser path (authenticated) and
--   POST /api/booking/accept (service_role) - would fail with
--   42501 permission denied for function driver_vehicle_can_accept_job.
--
--   Production evidence: assign_driver_to_job(uuid,uuid) is SECURITY INVOKER
--   with authenticated=true, service_role=true; driver_vehicle_can_accept_job
--   is SECURITY INVOKER with authenticated=false, service_role=false.
--
-- FIX: SECURITY DEFINER + pinned search_path. The purpose is NARROWLY to let
-- this controlled RPC execute its internal helper without exposing that helper
-- to client roles. The helper ACLs are NOT widened (SECTION 6); they stay
-- closed to PUBLIC/anon/authenticated/service_role.
--
-- This is NOT a privilege escalation: the external EXECUTE matrix is unchanged
-- (anon=false, authenticated=true, service_role=true) and no new caller gains
-- access. The function performs exactly the same single UPDATE it always did.
--
-- SECURITY INVOKER -> DEFINER means the body must not depend on the caller's
-- search_path or on RLS for safety, so every relation and function reference is
-- schema-qualified and search_path is pinned. There is no dynamic SQL and no
-- caller-controlled identifier: p_job_id / p_driver_id are used only as VALUES
-- in a parameterised statement.
--
-- Deliberately NO auth.uid() = p_driver_id requirement: this RPC exists to
-- serve the admin/service assignment semantics, where the acting operator is not
-- the assigned driver.
--
-- All Batch 1 assignment semantics preserved: arguments and RETURNS BOOLEAN
-- unchanged; vehicle compatibility still mandatory; source statuses still
-- exactly ('pending','requested','searching'); target job must still have
-- driver_id IS NULL; still sets driver_id / status='assigned' / updated_at;
-- still returns FOUND semantics; accepted_driver_id / accepted_at untouched.
--
-- The busy pre-check is UX/error determinism ONLY. The partial UNIQUE index
-- idx_jobs_one_active_per_driver remains the concurrency authority.
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
-- 5.3 accept_assigned_job - DRIVER CONFIRMS AN ADMIN ASSIGNMENT
--
-- Batch 1 semantics preserved. The target job ALREADY carries
-- driver_id = v_caller, so the pre-check MUST exclude it - otherwise a
-- legitimate idempotent confirmation would report the driver as busy with their
-- own job. driver_has_other_active_job(v_caller, p_job_id) does exactly that.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_assigned_job(
    p_job_id UUID,
    p_driver_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller UUID := auth.uid();
    v_updated BOOLEAN;
    v_constraint TEXT;
BEGIN
    IF p_job_id IS NULL THEN
        RAISE EXCEPTION 'p_job_id is required';
    END IF;

    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required to confirm an assignment';
    END IF;

    IF p_driver_id IS NOT NULL AND p_driver_id <> v_caller THEN
        RAISE EXCEPTION 'A driver may only confirm a request assigned to themselves';
    END IF;

    -- N12: defensive. Ownership was created earlier by assign_driver_to_job, so
    -- this cannot itself create a second ownership; the check rejects only the
    -- case where the driver holds ANOTHER occupying job besides this target.
    IF public.driver_has_other_active_job(v_caller, p_job_id) THEN
        RAISE EXCEPTION 'Driver already has an active job'
            USING ERRCODE = 'MB001',
                  CONSTRAINT = 'idx_jobs_one_active_per_driver',
                  DETAIL = 'driver_single_active_job';
    END IF;

    -- Atomic: only the driver already stored on the job may confirm it, only from
    -- 'assigned', and only while accepted_driver_id is still unset. A repeat call
    -- matches no row and returns FALSE without raising.
    BEGIN
        UPDATE public.jobs
        SET status = 'accepted',
            accepted_driver_id = v_caller,
            accepted_at = NOW(),
            updated_at = NOW()
        WHERE id = p_job_id
          AND status = 'assigned'
          AND driver_id = v_caller
          AND accepted_driver_id IS NULL;

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
-- 5.4 accept_fare_negotiation - LEGACY NEGOTIATION ACCEPT (Batch 2A preserved)
--
-- Every Batch 2A guard, ERRCODE, lock, ORDER BY and the JSONB return contract
-- are preserved verbatim. Only the N12 pre-check and the unique_violation
-- mapping around the jobs write are added. The existing 23505 for "already
-- owned by another driver" is untouched and remains distinguishable from the
-- new MB001 driver-busy conflict.
-- ----------------------------------------------------------------------------
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
    v_constraint TEXT;
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
    -- 2b. N12 (secondary, deterministic UX only). Fails fast BEFORE locking a
    --     fare_negotiations row. The target job is excluded so this can never
    --     reject the driver's own job. The unique index remains the guarantee.
    -- ------------------------------------------------------------------
    IF public.driver_has_other_active_job(p_driver_id, p_job_id) THEN
        RAISE EXCEPTION 'Driver already has an active job'
            USING ERRCODE = 'MB001',
                  CONSTRAINT = 'idx_jobs_one_active_per_driver',
                  DETAIL = 'driver_single_active_job';
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

    BEGIN
        UPDATE public.jobs
        SET status = 'fare_agreed',
            driver_id = p_driver_id,
            negotiated_fare = v_agreed_fare,
            agreed_fare = v_agreed_fare,
            updated_at = v_now
        WHERE id = p_job_id
        RETURNING * INTO v_job;
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


-- ----------------------------------------------------------------------------
-- 5.5 lock_marketplace_fare - HYBRID NEGOTIATION ACCEPT
--
-- Hybrid ALSO writes jobs.driver_id (unconditionally, with status
-- 'fare_agreed'), so it is an ownership writer and the unique index applies to
-- it automatically. The client already propagates the error
-- (marketplace-hybrid.service.ts lockFare: `if (error) throw error`, and every
-- caller either rethrows or shows a danger toast), so no false success is
-- possible. The ONLY change here is wrapping the jobs write so the invariant
-- violation is reported deterministically and identifies the constraint.
--
-- Body otherwise reproduced from the documented baseline
-- (supabase_incremental_schema_reconcile.sql lines 3512-3556), which differs
-- from the 20260707000000 forward copy only by carrying
-- `SET search_path = public`. Every table reference in this body is already
-- schema-qualified, so search_path cannot change name resolution - the pin is
-- behaviour-neutral and matches Batch 1's hardening convention.
--
-- ACL is deliberately NOT touched: CREATE OR REPLACE preserves the existing
-- privileges, and this migration has no mandate to change hybrid's ACL matrix.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lock_marketplace_fare(
  p_job_id UUID,
  p_driver_id UUID,
  p_amount NUMERIC
)
RETURNS public.marketplace_negotiation_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.marketplace_negotiation_sessions;
  v_constraint TEXT;
BEGIN
  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND OR v_session.active_driver_id IS DISTINCT FROM p_driver_id THEN
    RAISE EXCEPTION 'Session not active for this driver';
  END IF;

  UPDATE public.marketplace_negotiation_sessions
  SET agreed_fare = p_amount,
      status = 'fare_agreed',
      expires_at = now() + interval '300 seconds',
      updated_at = now()
  WHERE job_id = p_job_id
  RETURNING * INTO v_session;

  BEGIN
    UPDATE public.jobs
    SET agreed_fare = p_amount,
        status = 'fare_agreed',
        driver_id = p_driver_id,
        updated_at = now()
    WHERE id = p_job_id;
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

  INSERT INTO public.marketplace_negotiation_events
    (session_id, job_id, proposed_by, proposed_by_role, event_type, amount, round_number, created_at)
  VALUES
    (v_session.id, p_job_id, p_driver_id, 'driver', 'driver_accept', p_amount, v_session.round_count, now());

  RETURN v_session;
END;
$$;


-- ============================================================================
-- SECTION 6 — PRIVILEGES
--
-- Production carries broad DEFAULT FUNCTION privileges, so REVOKE FROM PUBLIC
-- alone is NOT sufficient: a concrete role's own grant survives it, and
-- CREATE OR REPLACE preserves ACLs while DROP+CREATE re-derives them. Every
-- must-not-have role is therefore revoked explicitly.
--
-- The N12 predicates are INTERNAL: they are reachable only from the SECURITY
-- DEFINER acquisition functions, which run as the owner. No role is granted
-- EXECUTE, so an authenticated client cannot probe another driver's busy state.
-- ============================================================================
REVOKE ALL ON FUNCTION public.driver_occupying_statuses() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_has_other_active_job(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_has_active_job(UUID) FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.driver_occupying_statuses()
FROM anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.driver_has_other_active_job(UUID, UUID)
FROM anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.driver_has_active_job(UUID)
FROM anon, authenticated, service_role;

-- accept_searching_job / assign_driver_to_job: external matrix preserved
-- (browser + server, never anonymous). assign_driver_to_job becomes SECURITY
-- DEFINER in 5.2, but its EFFECTIVE EXTERNAL EXECUTE matrix is deliberately
-- UNCHANGED, so no new caller gains access.
REVOKE ALL ON FUNCTION public.accept_searching_job(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_driver_to_job(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.accept_searching_job(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.assign_driver_to_job(UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.accept_searching_job(UUID, UUID)
TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assign_driver_to_job(UUID, UUID)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_driver_to_job(UUID, UUID)
TO service_role;

-- The Batch 1 vehicle-compatibility helper MUST remain internal. This migration
-- does NOT grant it to anon/authenticated/service_role: making the RPC SECURITY
-- DEFINER is the correct fix for the privilege defect, granting the helper to
-- client roles is not. Declared here as an explicit, idempotent re-assertion so
-- the intent is machine-checkable and cannot be "fixed" by widening it.
REVOKE ALL ON FUNCTION public.driver_vehicle_can_accept_job(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.driver_vehicle_can_accept_job(UUID, UUID)
FROM anon, authenticated, service_role;

-- accept_assigned_job: Batch 1 matrix preserved (authenticated only).
REVOKE ALL ON FUNCTION public.accept_assigned_job(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.accept_assigned_job(UUID, UUID)
FROM anon, service_role;
GRANT EXECUTE ON FUNCTION public.accept_assigned_job(UUID, UUID)
TO authenticated;

-- accept_fare_negotiation: Batch 2A matrix preserved (service_role only).
REVOKE ALL ON FUNCTION public.accept_fare_negotiation(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_fare_negotiation(UUID, UUID)
FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_fare_negotiation(UUID, UUID)
TO service_role;

-- lock_marketplace_fare: ACL intentionally untouched (see SECTION 5.5).

-- No data migration is performed here.
-- Rows that currently violate the invariant are NOT repaired, reassigned or
-- deleted. The preflight must have reported zero duplicate occupying drivers
-- before this migration is applied.
