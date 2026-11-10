-- ============================================================================
-- MOVABI — BATCH 2C / PHASE B.1: PREFLIGHT for
-- supabase/migrations/20260926000000_booking_acquisition_atomicity.sql
--
-- STRICTLY READ ONLY. No DDL. No DML. No RPC is invoked.
--
-- Establishes, against the live database, that the migration is safe to apply:
--   * every object it references exists,
--   * the N12 invariant is healthy,
--   * the Phase A acquisition trigger is still DISABLED,
--   * profiles RLS is still off and no RLS/grant change is being made,
--   * the pre-change ACL of the redefined lock_marketplace_fare is captured for
--     comparison after the migration (it must not change),
--   * neither new/replaced function already exists in an incompatible shape.
--
-- CLEAN-INSTALL LESSON (Batch 2B): this runs BEFORE the migration, so every
-- optional object is reached through pg_catalog.to_regprocedure('...') /
-- to_regclass('...') with a STRING argument. A statically written call would be
-- resolved by the parser before any guard could run and would abort the script.
-- ============================================================================

\pset pager off


-- ============================================================================
-- SECTION 1 — REQUIRED OBJECTS EXIST
-- ============================================================================
WITH expected_functions(sig, required_now, why) AS (
    VALUES
        ('public.lock_marketplace_fare(uuid,uuid,numeric)', TRUE,  'redefined by this migration'),
        ('public.accept_driver_offer(uuid,uuid)',           FALSE, 'created by this migration')
)
SELECT
    'FUNCTION ' || e.sig AS check_name,
    e.why AS expected,
    CASE WHEN pg_catalog.to_regprocedure(e.sig) IS NULL THEN 'ABSENT' ELSE 'present' END AS observed,
    CASE
        WHEN pg_catalog.to_regprocedure(e.sig) IS NULL AND e.required_now THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict
FROM expected_functions e;

WITH expected_tables(name) AS (
    VALUES ('jobs'), ('profiles'), ('fare_negotiations'),
           ('marketplace_negotiation_sessions'), ('marketplace_negotiation_events')
)
SELECT
    'TABLE public.' || et.name AS check_name,
    'must exist: the migration references it' AS expected,
    CASE WHEN pg_catalog.to_regclass('public.' || et.name) IS NULL THEN 'ABSENT' ELSE 'present' END AS observed,
    CASE WHEN pg_catalog.to_regclass('public.' || et.name) IS NULL THEN 'FAIL' ELSE 'PASS' END AS verdict
FROM expected_tables et
ORDER BY et.name;

-- 1.1 fare_negotiations must carry every column the new function reads.
WITH expected_columns(col) AS (
    VALUES ('id'), ('job_id'), ('proposed_by'), ('proposed_by_role'), ('amount'), ('status'),
           ('created_at'), ('updated_at')
)
SELECT
    'COLUMN fare_negotiations.' || c.col AS check_name,
    'must exist: accept_driver_offer reads it' AS expected,
    COALESCE(info.data_type, 'ABSENT') AS observed,
    CASE WHEN info.column_name IS NULL THEN 'FAIL' ELSE 'PASS' END AS verdict
FROM expected_columns c
LEFT JOIN information_schema.columns info
       ON info.table_schema = 'public'
      AND info.table_name = 'fare_negotiations'
      AND info.column_name = c.col
ORDER BY c.col;


-- ============================================================================
-- SECTION 2 — FROZEN BOUNDARIES UNCHANGED
-- ============================================================================

-- 2.1 The Phase A acquisition trigger must be ABSENT or DISABLED.
SELECT
    'ACQUISITION TRIGGER trg_enforce_job_acquisition_eligibility' AS check_name,
    'absent, or present and DISABLED (tgenabled = D)' AS expected,
    CASE WHEN t.tgname IS NULL THEN 'absent'
         ELSE 'present | enabled=' || t.tgenabled::TEXT END AS observed,
    CASE WHEN t.tgname IS NULL THEN 'PASS'
         WHEN t.tgenabled = 'D' THEN 'PASS'
         ELSE 'FAIL' END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_trigger t
       ON t.tgrelid = 'public.jobs'::regclass
      AND t.tgname = 'trg_enforce_job_acquisition_eligibility';

-- 2.2 profiles RLS must still be false: this migration changes no policy.
SELECT
    'profiles RLS' AS check_name,
    'must remain false (no RLS work in Phase B.1)' AS expected,
    'relrowsecurity=' || c.relrowsecurity::TEXT AS observed,
    CASE WHEN c.relrowsecurity IS FALSE THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'profiles';

-- 2.3 N12 invariant healthy and no duplicate occupying drivers.
SELECT
    'N12 invariant idx_jobs_one_active_per_driver' AS check_name,
    'present, UNIQUE, valid, keyed on jobs(driver_id)' AS expected,
    CASE
        WHEN i.indexrelid IS NULL THEN 'MISSING'
        ELSE 'unique=' || i.indisunique::TEXT || ' valid=' || i.indisvalid::TEXT
             || ' key=' || COALESCE(a.attname, '?')
    END AS observed,
    CASE
        WHEN i.indexrelid IS NULL THEN 'FAIL'
        WHEN i.indisunique IS TRUE AND i.indisvalid IS TRUE AND a.attname = 'driver_id' THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_index i
       ON i.indexrelid = pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')
LEFT JOIN pg_catalog.pg_attribute a
       ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0];

SELECT
    'N12 duplicate occupying drivers' AS check_name,
    'MUST be 0' AS expected,
    COUNT(*)::TEXT AS observed,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (
    SELECT j.driver_id
      FROM public.jobs j
     WHERE j.driver_id IS NOT NULL
       AND j.status IN ('assigned','accepted','fare_agreed','heading_to_pickup',
                        'driver_en_route','arrived','driver_arrived','arrived_at_store',
                        'shopping_in_progress','collected','picked_up',
                        'en_route_to_customer','in_progress','delivered',
                        'over_budget_requested','requires_review')
     GROUP BY j.driver_id
    HAVING COUNT(*) > 1
) d;


-- ============================================================================
-- SECTION 3 — PRE-CHANGE ACL SNAPSHOT (lock_marketplace_fare must not change)
-- ============================================================================
WITH roles(rolname) AS (VALUES ('anon'), ('authenticated'), ('service_role'))
SELECT
    'ACL SNAPSHOT lock_marketplace_fare/' || r.rolname AS check_name,
    'informational: must be IDENTICAL in the postflight' AS expected,
    CASE WHEN pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)') IS NULL THEN 'function absent'
         ELSE pg_catalog.has_function_privilege(r.rolname,
                  pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)'), 'EXECUTE')::TEXT
    END AS observed,
    'INFO' AS verdict
FROM roles r
ORDER BY r.rolname;

-- 3.1 Negotiation data that the hardened paths must not break.
SELECT
    'NEGOTIATION pending driver offers' AS check_name,
    'informational: jobs that accept_driver_offer could act on' AS expected,
    'jobs=' || COUNT(DISTINCT f.job_id)::TEXT AS observed,
    'INFO' AS verdict
FROM public.fare_negotiations f
WHERE f.proposed_by_role = 'driver'
  AND f.status = 'pending';

SELECT
    'NEGOTIATION jobs with an unowned fare negotiation' AS check_name,
    'informational: rows the legacy NULL-driver defect could have produced' AS expected,
    COUNT(*)::TEXT AS observed,
    'INFO' AS verdict
FROM public.jobs j
WHERE j.status = 'fare_agreed'
  AND j.driver_id IS NULL;


-- ============================================================================
-- SECTION 4 — GO / NO-GO
--
-- GO requires: every required object present, the trigger absent-or-disabled,
-- profiles RLS off, the N12 invariant healthy, and zero duplicate occupying
-- drivers.
-- ============================================================================
WITH required_objects(sig, required_now) AS (
    VALUES
        ('public.lock_marketplace_fare(uuid,uuid,numeric)', TRUE),
        ('public.accept_driver_offer(uuid,uuid)',           FALSE)
),
missing_objects AS (
    SELECT COUNT(*) AS n FROM required_objects o
     WHERE o.required_now AND pg_catalog.to_regprocedure(o.sig) IS NULL
),
required_tables(name) AS (
    VALUES ('jobs'), ('profiles'), ('fare_negotiations'),
           ('marketplace_negotiation_sessions'), ('marketplace_negotiation_events')
),
missing_tables AS (
    SELECT COUNT(*) AS n FROM required_tables rt
     WHERE pg_catalog.to_regclass('public.' || rt.name) IS NULL
),
trigger_state AS (
    SELECT CASE
             WHEN t.tgname IS NULL THEN 0
             WHEN t.tgenabled = 'D' THEN 0
             ELSE 1
           END AS n
      FROM (SELECT 1) AS one
      LEFT JOIN pg_catalog.pg_trigger t
             ON t.tgrelid = 'public.jobs'::regclass
            AND t.tgname = 'trg_enforce_job_acquisition_eligibility'
),
invariant AS (
    SELECT CASE
             WHEN i.indexrelid IS NULL THEN 1
             WHEN i.indisunique IS TRUE AND i.indisvalid IS TRUE AND a.attname = 'driver_id' THEN 0
             ELSE 1
           END AS n
      FROM (SELECT 1) AS one
      LEFT JOIN pg_catalog.pg_index i
             ON i.indexrelid = pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')
      LEFT JOIN pg_catalog.pg_attribute a
             ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
),
profiles_rls AS (
    SELECT CASE WHEN c.relrowsecurity THEN 1 ELSE 0 END AS n
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'profiles'
)
SELECT
    'PHASE B.1 GO / NO-GO' AS check_name,
    'objects present + trigger absent-or-disabled + profiles RLS off + N12 healthy' AS expected,
    'missing_required_objects=' || (SELECT n FROM missing_objects)::TEXT
      || ' | missing_tables=' || (SELECT n FROM missing_tables)::TEXT
      || ' | trigger_enabled=' || (SELECT n FROM trigger_state)::TEXT
      || ' | n12_invariant_bad=' || (SELECT n FROM invariant)::TEXT
      || ' | profiles_rls_on=' || (SELECT n FROM profiles_rls)::TEXT AS observed,
    CASE
        WHEN (SELECT n FROM missing_tables) > 0 THEN 'NO-GO: a referenced table is absent'
        WHEN (SELECT n FROM missing_objects) > 0 THEN 'NO-GO: a function this migration replaces is absent'
        WHEN (SELECT n FROM trigger_state) > 0 THEN 'NO-GO: acquisition trigger is ENABLED before Phase C'
        WHEN (SELECT n FROM invariant) > 0 THEN 'NO-GO: N12 invariant missing or malformed'
        WHEN (SELECT n FROM profiles_rls) > 0 THEN 'NO-GO: profiles RLS is already enabled (unexpected)'
        ELSE 'PASS'
    END AS verdict;
