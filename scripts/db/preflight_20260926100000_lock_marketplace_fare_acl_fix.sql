-- ============================================================================
-- MOVABI — BATCH 2C / PHASE B.B1 FOLLOW-UP: PREFLIGHT for
-- supabase/migrations/20260926100000_lock_marketplace_fare_acl_fix.sql
--
-- STRICTLY READ ONLY. No DDL. No DML. No RPC is invoked.
--
-- Establishes, against the live database, the exact pre-change state that the
-- ACL follow-up corrects:
--   * the function exists with the exact expected signature,
--   * the CURRENT effective EXECUTE privilege for PUBLIC / anon / authenticated /
--     service_role (the exposure this migration removes),
--   * the CURRENT proacl verbatim, so the change is auditable before and after,
--   * the function is SECURITY DEFINER with a pinned search_path (so retaining
--     `authenticated` EXECUTE is safe),
--   * the Phase A acquisition trigger is still DISABLED,
--   * profiles RLS is still false,
--   * the N12 invariant is intact and the frozen status set is exactly 16.
--
-- CLEAN-INSTALL LESSON (Batch 2B): this runs BEFORE the migration, so every
-- optional object is reached through pg_catalog.to_regprocedure('...') with a
-- STRING argument. A statically written call would be resolved by the parser
-- before any guard could run and would abort the script.
-- ============================================================================

\pset pager off


-- ============================================================================
-- SECTION 1 — FUNCTION IDENTITY
-- ============================================================================
SELECT
    'FUNCTION public.lock_marketplace_fare(uuid,uuid,numeric)' AS check_name,
    'present with the exact signature, SECURITY DEFINER, pinned search_path' AS expected,
    CASE
        WHEN pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)') IS NULL THEN 'ABSENT'
        ELSE 'returns=' || pg_catalog.pg_get_function_result(p.oid)
             || ' | security=' || CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
             || ' | volatility=' || p.provolatile::TEXT
             || ' | search_path=' || COALESCE(array_to_string(p.proconfig, ','), '(not set)')
    END AS observed,
    CASE
        WHEN pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)') IS NULL THEN 'FAIL'
        WHEN NOT p.prosecdef THEN 'FAIL'
        WHEN NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                          WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%') THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_proc p
       ON p.oid = pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)');


-- ============================================================================
-- SECTION 2 — CURRENT ACL (the exposure being corrected)
--
-- PUBLIC is tested through aclexplode(grantee = 0): PUBLIC is a pseudo-role, so
-- has_function_privilege cannot probe it, and an ABSENT proacl still means
-- PostgreSQL's implicit EXECUTE TO PUBLIC. This preflight EXPECTS the permissive
-- state and reports it as informational — the migration is what changes it.
-- ============================================================================
WITH expected(role_name) AS (
    VALUES ('PUBLIC'), ('anon'), ('authenticated'), ('service_role')
),
probe AS (
    SELECT e.role_name,
           CASE
               WHEN e.role_name = 'PUBLIC' THEN (
                   SELECT COUNT(*) > 0
                     FROM pg_catalog.pg_proc p
                     CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                    WHERE p.oid = pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)')
                      AND a.grantee = 0
                      AND a.privilege_type = 'EXECUTE')
               ELSE pg_catalog.has_function_privilege(
                        e.role_name,
                        pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)'),
                        'EXECUTE')
           END AS has_execute
      FROM expected e
)
SELECT
    'CURRENT ACL lock_marketplace_fare/' || pr.role_name AS check_name,
    'informational: pre-change state that the follow-up migration corrects' AS expected,
    CASE WHEN pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)') IS NULL
              THEN 'function absent' ELSE pr.has_execute::TEXT END AS observed,
    'INFO' AS verdict
FROM probe pr
ORDER BY pr.role_name;

-- 2.1 The verbatim proacl, so the operator can diff it before/after.
SELECT
    'CURRENT proacl lock_marketplace_fare' AS check_name,
    'informational: raw ACL entries (grantee= is PUBLIC)' AS expected,
    COALESCE(p.proacl::TEXT, '(NULL = implicit default incl. EXECUTE TO PUBLIC)') AS observed,
    'INFO' AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_proc p
       ON p.oid = pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)');

-- 2.2 Security impact: an ANONYMOUS caller passes the B.1 identity guard because
--     auth.uid() is NULL, which is why PUBLIC/anon EXECUTE is load-bearing.
SELECT
    'EXPOSURE impact anonymous caller' AS check_name,
    'informational: with PUBLIC/anon EXECUTE an anonymous caller reaches the ownership checks' AS expected,
    'public_execute=' || COALESCE((
        SELECT (COUNT(*) > 0)::TEXT
          FROM pg_catalog.pg_proc p
          CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
         WHERE p.oid = pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)')
           AND a.grantee = 0
           AND a.privilege_type = 'EXECUTE'), 'n/a')
      || ' | anon_execute=' || CASE
             WHEN pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)') IS NULL THEN 'n/a'
             ELSE pg_catalog.has_function_privilege('anon',
                  pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)'), 'EXECUTE')::TEXT
         END AS observed,
    'INFO' AS verdict;


-- ============================================================================
-- SECTION 3 — FROZEN BOUNDARIES UNCHANGED
-- ============================================================================
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

SELECT
    'profiles RLS' AS check_name,
    'must remain false (this migration changes no policy)' AS expected,
    'relrowsecurity=' || c.relrowsecurity::TEXT AS observed,
    CASE WHEN c.relrowsecurity IS FALSE THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'profiles';

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
    'N12 frozen occupying statuses' AS check_name,
    'exactly 16 approved statuses' AS expected,
    'count=' || COUNT(*)::TEXT AS observed,
    CASE WHEN COUNT(*) = 16 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (SELECT unnest(public.driver_occupying_statuses()) AS status) s;

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
-- SECTION 4 — GO / NO-GO
--
-- GO requires: the function present with the exact signature, SECURITY DEFINER,
-- a pinned search_path, the trigger absent-or-disabled, profiles RLS off, the
-- N12 invariant healthy, and the frozen status set exactly 16. The permissive
-- ACL itself is NOT a NO-GO condition here: that is the state this migration
-- corrects, and it is reported above for the record.
-- ============================================================================
WITH function_state AS (
    SELECT pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)') AS oid
),
missing AS (
    SELECT CASE WHEN oid IS NULL THEN 1 ELSE 0 END AS n FROM function_state
),
unpinned_or_invoker AS (
    SELECT CASE
             WHEN f.oid IS NULL THEN 1
             WHEN NOT p.prosecdef THEN 1
             WHEN NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                               WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%') THEN 1
             ELSE 0
           END AS n
      FROM function_state f
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = f.oid
),
trigger_state AS (
    SELECT CASE WHEN t.tgname IS NULL THEN 0 WHEN t.tgenabled = 'D' THEN 0 ELSE 1 END AS n
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
n12_statuses AS (
    SELECT COUNT(*) AS n FROM (SELECT unnest(public.driver_occupying_statuses()) AS status) s
),
dup_drivers AS (
    SELECT COUNT(*) AS n
      FROM (
        SELECT j.driver_id
          FROM public.jobs j
         WHERE j.driver_id IS NOT NULL
           AND j.status = ANY (ARRAY['assigned','accepted','fare_agreed','heading_to_pickup',
                                     'driver_en_route','arrived','driver_arrived','arrived_at_store',
                                     'shopping_in_progress','collected','picked_up',
                                     'en_route_to_customer','in_progress','delivered',
                                     'over_budget_requested','requires_review'])
         GROUP BY j.driver_id
        HAVING COUNT(*) > 1
      ) d
),
profiles_rls AS (
    SELECT CASE WHEN c.relrowsecurity THEN 1 ELSE 0 END AS n
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'profiles'
)
SELECT
    'ACL FOLLOW-UP GO / NO-GO' AS check_name,
    'function present + DEFINER + pinned search_path + trigger absent-or-disabled + profiles RLS off + N12 healthy + 16 statuses' AS expected,
    'function_missing=' || (SELECT n FROM missing)::TEXT
      || ' | definer_or_searchpath_bad=' || (SELECT n FROM unpinned_or_invoker)::TEXT
      || ' | trigger_enabled=' || (SELECT n FROM trigger_state)::TEXT
      || ' | n12_invariant_bad=' || (SELECT n FROM invariant)::TEXT
      || ' | n12_status_count=' || (SELECT n FROM n12_statuses)::TEXT
      || ' | n12_duplicate_drivers=' || (SELECT n FROM dup_drivers)::TEXT
      || ' | profiles_rls_on=' || (SELECT n FROM profiles_rls)::TEXT AS observed,
    CASE
        WHEN (SELECT n FROM missing) > 0 THEN 'NO-GO: lock_marketplace_fare is absent'
        WHEN (SELECT n FROM unpinned_or_invoker) > 0 THEN 'NO-GO: function is not DEFINER with a pinned search_path'
        WHEN (SELECT n FROM trigger_state) > 0 THEN 'NO-GO: acquisition trigger is ENABLED before Phase C'
        WHEN (SELECT n FROM invariant) > 0 THEN 'NO-GO: N12 invariant missing or malformed'
        WHEN (SELECT n FROM n12_statuses) <> 16 THEN 'NO-GO: N12 frozen status set changed'
        WHEN (SELECT n FROM dup_drivers) > 0 THEN 'NO-GO: duplicate occupying drivers (operator review)'
        WHEN (SELECT n FROM profiles_rls) > 0 THEN 'NO-GO: profiles RLS was enabled (unexpected)'
        ELSE 'PASS'
    END AS verdict;
