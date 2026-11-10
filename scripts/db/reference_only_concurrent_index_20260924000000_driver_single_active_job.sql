-- ============================================================================
-- MOVABI — BATCH 2B (N12): REFERENCE ONLY — DO NOT RUN FOR THIS DEPLOYMENT
--
--                                *** NOT THE SELECTED PRODUCTION PATH ***
--
-- The Batch 2B forward migration
--     supabase/migrations/20260924000000_driver_single_active_job.sql
-- IS the authoritative deployment artifact. It creates the invariant index with
-- an ordinary transactional `CREATE UNIQUE INDEX IF NOT EXISTS`, and that is
-- the DECIDED production strategy for this release.
--
-- DECISION EVIDENCE (production preflight, 2026-09-24)
-- ============================================================================
--     jobs total rows ................ 151
--     jobs with driver_id ............ 24
--     occupying jobs ................. 0
--     duplicate occupying drivers .... 0
--     public.jobs table size ......... 232 kB  (relation total 648 kB,
--                                                indexes 360 kB)
--     PostgreSQL ..................... 15.1
--     existing single-active index ... none
--
-- At 151 rows the ordinary CREATE UNIQUE INDEX takes its ACCESS EXCLUSIVE lock
-- for a few milliseconds. CREATE INDEX CONCURRENTLY buys nothing here and costs
-- real complexity: it cannot run inside a transaction block, so it would have
-- to be applied as a separate out-of-band step disconnected from the migration
-- that defines the rest of the invariant.
--
-- THEREFORE: DO NOT RUN THIS FILE AS PART OF THE BATCH 2B DEPLOYMENT.
-- The migration alone installs the complete invariant.
--
-- WHY THIS FILE IS KEPT
-- ============================================================================
-- Documentation and future recovery only, for a hypothetical future where the
-- jobs table is large enough that a plain index build would block writes:
--
--   * big table in the future  -> build the index with the CONCURRENTLY
--                                 statement below FIRST, verify indisvalid,
--                                 then apply a migration whose
--                                 `CREATE UNIQUE INDEX IF NOT EXISTS` becomes
--                                 a no-op. The migration's SECTION 4 self-check
--                                 validates whichever object is live, so that
--                                 order is also correct.
--   * interrupted CONCURRENTLY build -> an INVALID index is left behind and an
--                                 INVALID index does NOT enforce uniqueness.
--                                 Drop it and retry:
--     DROP INDEX CONCURRENTLY IF EXISTS
--       public.idx_jobs_one_active_per_driver;
--
-- The predicate below MUST stay byte-identical to the frozen occupying-status
-- set in the migration; the static regression test asserts that.
--
-- RUN AS: the schema owner (postgres), OUTSIDE any transaction block, and ONLY
-- if a future decision explicitly selects the concurrent path. Never wrap in
-- BEGIN/COMMIT.
-- ============================================================================

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_one_active_per_driver
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
-- POST-CONDITION CHECK (read-only)
-- ============================================================================
SELECT ic.relname                              AS index_name,
       i.indisunique                           AS is_unique,
       i.indisvalid                            AS is_valid,
       i.indislive                             AS is_live,
       tn.nspname || '.' || tc.relname         AS on_table,
       pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
  JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
 WHERE ic.relname = 'idx_jobs_one_active_per_driver';
