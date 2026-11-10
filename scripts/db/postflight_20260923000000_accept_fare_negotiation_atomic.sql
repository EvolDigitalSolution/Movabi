-- ============================================================================
-- MOVABI — POSTFLIGHT for 20260923000000_accept_fare_negotiation_atomic.sql
--
-- Run AFTER applying the migration. STRICTLY READ ONLY: no DDL/DML, and it does
-- NOT invoke accept_fare_negotiation (that would mutate a real job).
--
-- AUTHORITATIVE ACL GATE
--   The verdict is derived from has_function_privilege() — EFFECTIVE privilege,
--   accounting for direct grants, role inheritance and PUBLIC-derived grants —
--   not from proacl text formatting.
--
-- ALIAS DISCIPLINE (the previous postflight shipped "column policy.signature
-- does not exist" to production):
--   Every derived table here is a single row source whose alias exposes ALL the
--   columns referenced from it. There is no second alias holding a column that
--   the SELECT list then mis-attributes. `p.signature` is produced by the same
--   subquery that selects it.
-- ============================================================================

\pset pager off

-- ============================================================================
-- SECTION 1 — EXISTENCE / SIGNATURE / RETURN TYPE
-- ============================================================================

SELECT
    'EXISTS accept_fare_negotiation' AS check_name,
    'p_job_id uuid, p_driver_id uuid -> jsonb' AS expected,
    COALESCE(pg_catalog.pg_get_function_identity_arguments(p.oid) || ' -> ' ||
             pg_catalog.pg_get_function_result(p.oid), 'MISSING') AS observed,
    CASE WHEN p.oid IS NULL THEN 'FAIL' ELSE 'PASS' END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_proc p
       ON p.proname = 'accept_fare_negotiation'
      AND p.pronamespace = 'public'::regnamespace;

SELECT
    'ARITY accept_fare_negotiation' AS check_name,
    'exactly one overload' AS expected,
    COUNT(*)::TEXT || ' overload(s): ' ||
      COALESCE(string_agg(pg_catalog.pg_get_function_identity_arguments(p.oid), ' ; '), 'none') AS observed,
    CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname = 'accept_fare_negotiation';

SELECT
    'RETURN TYPE' AS check_name,
    'jsonb' AS expected,
    COALESCE(pg_catalog.pg_get_function_result(p.oid), 'MISSING') AS observed,
    CASE WHEN p.oid IS NOT NULL AND pg_catalog.pg_get_function_result(p.oid) = 'jsonb'
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_proc p
       ON p.proname = 'accept_fare_negotiation'
      AND p.pronamespace = 'public'::regnamespace;

-- ============================================================================
-- SECTION 2 — SECURITY MODE + search_path
-- ============================================================================

SELECT
    'SECURITY MODE' AS check_name,
    'SECURITY DEFINER (needs to lock/write jobs under RLS)' AS expected,
    CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END AS observed,
    CASE WHEN p.prosecdef THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_fare_negotiation';

SELECT
    'SEARCH_PATH' AS check_name,
    'must pin public and pg_temp' AS expected,
    COALESCE(array_to_string(p.proconfig, ','), '(not set)') AS observed,
    CASE
        WHEN EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                      WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%' AND c ILIKE '%pg_temp%')
        THEN 'PASS' ELSE 'FAIL'
    END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_fare_negotiation';

-- ============================================================================
-- SECTION 3 — EFFECTIVE-PRIVILEGE MATRIX (the authoritative ACL gate)
--
-- service_role ONLY. The route derives the driver from the authenticated
-- session and is the sole caller; the browser must never reach this directly.
-- ============================================================================

SELECT
    'PRIVILEGE ' || m.rolname AS check_name,
    CASE WHEN m.can_execute THEN 'EXECUTE expected' ELSE 'EXECUTE must NOT be granted' END AS expected,
    CASE WHEN has_function_privilege(m.rolname, m.fn_oid, 'EXECUTE')
         THEN 'EXECUTE granted' ELSE 'EXECUTE NOT granted' END AS observed,
    CASE WHEN has_function_privilege(m.rolname, m.fn_oid, 'EXECUTE') = m.can_execute
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (
    -- Single row source: exposes rolname, can_execute AND signature together,
    -- so no reference can name a column this alias does not declare.
    SELECT policy.rolname,
           policy.can_execute,
           policy.signature,
           to_regprocedure(policy.signature) AS fn_oid
      FROM (VALUES
              ('anon',          false, 'public.accept_fare_negotiation(uuid,uuid)'),
              ('authenticated', false, 'public.accept_fare_negotiation(uuid,uuid)'),
              ('service_role',  true,  'public.accept_fare_negotiation(uuid,uuid)')
           ) AS policy(rolname, can_execute, signature)
) m
WHERE m.fn_oid IS NOT NULL
ORDER BY verdict DESC, m.rolname;

-- A surviving PUBLIC entry is a regression regardless of the matrix above.
SELECT
    'PUBLIC EXECUTE absent' AS check_name,
    'proacl must contain no bare =X/ entry and must not be NULL' AS expected,
    CASE
        WHEN p.proacl IS NULL THEN 'NULL proacl - default ACL still grants EXECUTE to PUBLIC'
        WHEN EXISTS (SELECT 1 FROM unnest(p.proacl) a WHERE a::TEXT LIKE '=%') THEN 'PUBLIC EXECUTE present'
        ELSE 'no PUBLIC entry'
    END AS observed,
    CASE
        WHEN p.proacl IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM unnest(p.proacl) a WHERE a::TEXT LIKE '=%')
        THEN 'PASS' ELSE 'FAIL'
    END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_fare_negotiation';

SELECT
    'ACL text' AS check_name,
    'informational: proacl as written' AS expected,
    COALESCE(array_to_string(p.proacl, ' | '), '(NULL)') AS observed,
    'INFO' AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_fare_negotiation';

-- ============================================================================
-- SECTION 4 — FUNCTION BODY CONTAINS THE REQUIRED LOCKS AND GUARDS
-- ============================================================================

SELECT
    'BODY jobs FOR UPDATE' AS check_name,
    'locks the jobs row before decision-making' AS expected,
    (pg_catalog.pg_get_functiondef(p.oid) ILIKE '%FROM public.jobs%FOR UPDATE%')::TEXT AS observed,
    CASE WHEN pg_catalog.pg_get_functiondef(p.oid) ILIKE '%FROM public.jobs%FOR UPDATE%'
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_fare_negotiation';

SELECT
    'BODY fare_negotiations FOR UPDATE' AS check_name,
    'locks the selected offer row' AS expected,
    (pg_catalog.pg_get_functiondef(p.oid) ILIKE '%FROM public.fare_negotiations%FOR UPDATE%')::TEXT AS observed,
    CASE WHEN pg_catalog.pg_get_functiondef(p.oid) ILIKE '%FROM public.fare_negotiations%FOR UPDATE%'
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_fare_negotiation';

SELECT
    'BODY requires customer offer' AS check_name,
    'proposed_by_role = customer predicate' AS expected,
    (pg_catalog.pg_get_functiondef(p.oid) ILIKE '%proposed_by_role = ''customer''%')::TEXT AS observed,
    CASE WHEN pg_catalog.pg_get_functiondef(p.oid) ILIKE '%proposed_by_role = ''customer''%'
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_fare_negotiation';

SELECT
    'BODY requires pending status' AS check_name,
    'status = pending predicate' AS expected,
    (pg_catalog.pg_get_functiondef(p.oid) ILIKE '%status = ''pending''%')::TEXT AS observed,
    CASE WHEN pg_catalog.pg_get_functiondef(p.oid) ILIKE '%status = ''pending''%'
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_fare_negotiation';

SELECT
    'BODY establishes ownership' AS check_name,
    'sets driver_id from p_driver_id' AS expected,
    (pg_catalog.pg_get_functiondef(p.oid) ILIKE '%driver_id = p_driver_id%')::TEXT AS observed,
    CASE WHEN pg_catalog.pg_get_functiondef(p.oid) ILIKE '%driver_id = p_driver_id%'
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_fare_negotiation';

SELECT
    'BODY establishes fare_agreed' AS check_name,
    'sets jobs.status = fare_agreed' AS expected,
    (pg_catalog.pg_get_functiondef(p.oid) ILIKE '%status = ''fare_agreed''%')::TEXT AS observed,
    CASE WHEN pg_catalog.pg_get_functiondef(p.oid) ILIKE '%status = ''fare_agreed''%'
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_fare_negotiation';

SELECT
    'BODY marks negotiation accepted' AS check_name,
    'sets fare_negotiations.status = accepted' AS expected,
    (pg_catalog.pg_get_functiondef(p.oid) ILIKE '%status = ''accepted''%')::TEXT AS observed,
    CASE WHEN pg_catalog.pg_get_functiondef(p.oid) ILIKE '%status = ''accepted''%'
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_fare_negotiation';

SELECT
    'BODY rejects already-owned job' AS check_name,
    'ownership guard exists' AS expected,
    (pg_catalog.pg_get_functiondef(p.oid) ILIKE '%already owned by another driver%')::TEXT AS observed,
    CASE WHEN pg_catalog.pg_get_functiondef(p.oid) ILIKE '%already owned by another driver%'
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_fare_negotiation';

-- ============================================================================
-- SECTION 5 — NO BULK REWRITE / NO DATA MIGRATION
-- ============================================================================

SELECT 'NO-BULK job rows carrying a modified updated_at in the last 15 minutes' AS check_name,
       'a data migration would spike this; the migration rewrites no rows' AS expected,
       COUNT(*)::TEXT AS observed,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'WARN' END AS verdict
FROM public.jobs
WHERE updated_at > NOW() - INTERVAL '15 minutes'
  AND status IN ('pending_fare_confirmation', 'negotiating');

-- ============================================================================
-- SECTION 6 — POST-MIGRATION GO / NO-GO
-- ============================================================================

WITH acl_policy(rolname, can_execute) AS (
    VALUES ('anon', false), ('authenticated', false), ('service_role', true)
),
acl_violations AS (
    SELECT pol.rolname
      FROM acl_policy pol
     WHERE to_regprocedure('public.accept_fare_negotiation(uuid,uuid)') IS NOT NULL
       AND has_function_privilege(
               pol.rolname,
               to_regprocedure('public.accept_fare_negotiation(uuid,uuid)'),
               'EXECUTE') <> pol.can_execute
),
public_grants AS (
    SELECT p.proname
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'accept_fare_negotiation'
       AND (p.proacl IS NULL
            OR EXISTS (SELECT 1 FROM unnest(p.proacl) a WHERE a::TEXT LIKE '=%'))
),
fn AS (
    SELECT p.oid, p.prosecdef, p.proconfig
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_fare_negotiation'
)
SELECT
    'POST-MIGRATION GO / NO-GO' AS check_name,
    'function present, jsonb, DEFINER, pinned search_path, service_role-only ACL' AS expected,
    'functions_present=' || (SELECT COUNT(*) FROM fn)::TEXT || '/1'
      || ' | rettype=' || COALESCE((SELECT pg_catalog.pg_get_function_result(f.oid) FROM fn f), 'MISSING')
      || ' | definer=' || COALESCE((SELECT f.prosecdef::TEXT FROM fn f), 'MISSING')
      || ' | acl_violations=' || COALESCE(
             (SELECT string_agg(v.rolname, ', ' ORDER BY v.rolname) FROM acl_violations v), 'none')
      || ' | public_execute_regressions=' || COALESCE(
             (SELECT string_agg(g.proname, ', ' ORDER BY g.proname) FROM public_grants g), 'none')
    AS observed,
    CASE
        WHEN (SELECT COUNT(*) FROM fn) <> 1 THEN 'NO-GO'
        WHEN COALESCE((SELECT pg_catalog.pg_get_function_result(f.oid) FROM fn f), '') <> 'jsonb' THEN 'NO-GO'
        WHEN NOT COALESCE((SELECT f.prosecdef FROM fn f), false) THEN 'NO-GO'
        WHEN NOT EXISTS (
                SELECT 1 FROM fn f
                 WHERE EXISTS (SELECT 1 FROM unnest(COALESCE(f.proconfig, '{}')) c
                                WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%' AND c ILIKE '%pg_temp%'))
            THEN 'NO-GO'
        WHEN (SELECT COUNT(*) FROM acl_violations) > 0 THEN 'NO-GO'
        WHEN (SELECT COUNT(*) FROM public_grants) > 0 THEN 'NO-GO'
        ELSE 'PASS'
    END AS verdict;
