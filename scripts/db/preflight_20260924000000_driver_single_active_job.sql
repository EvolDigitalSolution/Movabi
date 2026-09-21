-- ============================================================================
-- MOVABI — BATCH 2B (N12): PREFLIGHT for
-- supabase/migrations/20260924000000_driver_single_active_job.sql
--
-- STRICTLY READ ONLY. No DDL. No DML. No mutation RPC is invoked. It is safe
-- to run repeatedly against production.
--
-- PURPOSE
-- ============================================================================
-- Decide, from PRODUCTION EVIDENCE, whether the single-active-job invariant can
-- be installed, and which index-build variant to use. Nothing in this file
-- resolves duplicates: a non-zero duplicate count is an OPERATOR-REVIEW NO-GO.
--
-- The frozen occupying set is restated here ONLY because the helper
-- public.driver_occupying_statuses() does not exist before the migration runs.
-- This script therefore cannot use the helper, so SECTION 7 set-compares its
-- own restatement against the helper's output whenever the helper DOES exist,
-- making the restatement self-verifying rather than an unguarded copy.
--
-- SQL HYGIENE (defects that cost us Batch 2A reruns):
--   * every derived-table alias declares every column referenced through it;
--   * regexp_matches is a set-returning function, so it is used as a FROM item
--     via CROSS JOIN LATERAL, never inside an aggregate argument;
--   * pg_default_acl.defaclobjtype is the internal `"char"` type and is cast
--     explicitly before any concatenation (text || "char" is ambiguous).
-- ============================================================================

\pset pager off


-- ============================================================================
-- SECTION 1 — SERVER CONTEXT AND TABLE SIZE (drives the index-build decision)
-- ============================================================================

SELECT
    'PG_VERSION' AS check_name,
    'informational: server version' AS expected,
    pg_catalog.current_setting('server_version') || ' (' || pg_catalog.version() || ')' AS observed,
    'INFO' AS verdict;

SELECT
    'JOBS total row count' AS check_name,
    'informational: drives plain vs CONCURRENTLY index build' AS expected,
    COUNT(*)::TEXT AS observed,
    'INFO' AS verdict
FROM public.jobs;

SELECT
    'JOBS rows with non-null driver_id' AS check_name,
    'informational: population the invariant constrains' AS expected,
    COUNT(*)::TEXT AS observed,
    'INFO' AS verdict
FROM public.jobs j
WHERE j.driver_id IS NOT NULL;

-- 1.1 Relation size. This is the evidence that selects the ORDINARY
--     transactional CREATE UNIQUE INDEX over CREATE INDEX CONCURRENTLY.
SELECT
    'JOBS relation size' AS check_name,
    'informational: drives plain vs CONCURRENTLY (Batch 2B selected PLAIN)' AS expected,
    'total=' || pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(c.oid))
      || ' | table=' || pg_catalog.pg_size_pretty(pg_catalog.pg_relation_size(c.oid))
      || ' | indexes=' || pg_catalog.pg_size_pretty(pg_catalog.pg_indexes_size(c.oid)) AS observed,
    'INFO' AS verdict
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'jobs';


-- ============================================================================
-- SECTION 2 — ACTIVE-JOB DATA ANOMALIES (the GO/NO-GO evidence)
-- ============================================================================

-- 2.1 Occupying-job row count.
WITH occupying(status) AS (
    VALUES ('assigned'),('accepted'),('fare_agreed'),('heading_to_pickup'),
           ('driver_en_route'),('arrived'),('driver_arrived'),('arrived_at_store'),
           ('shopping_in_progress'),('collected'),('picked_up'),
           ('en_route_to_customer'),('in_progress'),('delivered'),
           ('over_budget_requested'),('requires_review')
)
SELECT
    'OCCUPYING job row count' AS check_name,
    'informational: rows the partial predicate matches' AS expected,
    COUNT(*)::TEXT AS observed,
    'INFO' AS verdict
FROM public.jobs j
JOIN occupying o ON o.status = j.status;

-- 2.2 Drivers with MORE THAN ONE occupying job. THE critical GO/NO-GO number.
WITH occupying(status) AS (
    VALUES ('assigned'),('accepted'),('fare_agreed'),('heading_to_pickup'),
           ('driver_en_route'),('arrived'),('driver_arrived'),('arrived_at_store'),
           ('shopping_in_progress'),('collected'),('picked_up'),
           ('en_route_to_customer'),('in_progress'),('delivered'),
           ('over_budget_requested'),('requires_review')
), per_driver AS (
    SELECT j.driver_id, COUNT(*) AS occupying_jobs
      FROM public.jobs j
      JOIN occupying o ON o.status = j.status
     WHERE j.driver_id IS NOT NULL
     GROUP BY j.driver_id
)
SELECT
    'DRIVERS with > 1 occupying job' AS check_name,
    'MUST be 0 - any other value is an operator-review NO-GO' AS expected,
    COUNT(*)::TEXT AS observed,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM per_driver d
WHERE d.occupying_jobs > 1;

-- 2.3 Exact job IDs / statuses / timestamps for every duplicate driver.
WITH occupying(status) AS (
    VALUES ('assigned'),('accepted'),('fare_agreed'),('heading_to_pickup'),
           ('driver_en_route'),('arrived'),('driver_arrived'),('arrived_at_store'),
           ('shopping_in_progress'),('collected'),('picked_up'),
           ('en_route_to_customer'),('in_progress'),('delivered'),
           ('over_budget_requested'),('requires_review')
), dup AS (
    SELECT j.driver_id
      FROM public.jobs j
      JOIN occupying o ON o.status = j.status
     WHERE j.driver_id IS NOT NULL
     GROUP BY j.driver_id
    HAVING COUNT(*) > 1
)
SELECT
    'DUPDRIVER ' || j.driver_id::TEXT AS check_name,
    'operator must decide which job keeps the driver' AS expected,
    'jobs=' || COUNT(*)::TEXT
      || ' | ids=' || string_agg(j.id::TEXT, ',' ORDER BY j.created_at)
      || ' | statuses=' || string_agg(j.status, ',' ORDER BY j.created_at)
      || ' | created_at=' || string_agg(j.created_at::TEXT, ',' ORDER BY j.created_at) AS observed,
    'FAIL' AS verdict
FROM public.jobs j
JOIN occupying o ON o.status = j.status
JOIN dup d ON d.driver_id = j.driver_id
GROUP BY j.driver_id;

-- 2.4 Status-pair frequency: which combinations must be resolved.
WITH occupying(status) AS (
    VALUES ('assigned'),('accepted'),('fare_agreed'),('heading_to_pickup'),
           ('driver_en_route'),('arrived'),('driver_arrived'),('arrived_at_store'),
           ('shopping_in_progress'),('collected'),('picked_up'),
           ('en_route_to_customer'),('in_progress'),('delivered'),
           ('over_budget_requested'),('requires_review')
)
SELECT
    'DUPSTATUS pair ' || a.status || ' + ' || b.status AS check_name,
    'informational: duplicate status combinations' AS expected,
    COUNT(*)::TEXT || ' driver(s)' AS observed,
    'INFO' AS verdict
FROM public.jobs a
JOIN occupying oa ON oa.status = a.status
JOIN public.jobs b ON b.driver_id = a.driver_id AND b.id > a.id
JOIN occupying ob ON ob.status = b.status
WHERE a.driver_id IS NOT NULL
GROUP BY a.status, b.status
ORDER BY COUNT(*) DESC, a.status, b.status;

-- 2.5 Occupying rows with NULL driver_id. Not blocked by the predicate, but a
--     lifecycle anomaly the operator should see.
WITH occupying(status) AS (
    VALUES ('assigned'),('accepted'),('fare_agreed'),('heading_to_pickup'),
           ('driver_en_route'),('arrived'),('driver_arrived'),('arrived_at_store'),
           ('shopping_in_progress'),('collected'),('picked_up'),
           ('en_route_to_customer'),('in_progress'),('delivered'),
           ('over_budget_requested'),('requires_review')
)
SELECT
    'OCCUPYING rows with driver_id NULL - status ' || o.status AS check_name,
    'informational: excluded by the predicate, should normally be 0' AS expected,
    COUNT(*)::TEXT AS observed,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'WARN' END AS verdict
FROM public.jobs j
JOIN occupying o ON o.status = j.status
WHERE j.driver_id IS NULL
GROUP BY o.status
ORDER BY o.status;

-- 2.6 Counts by occupying status (full population shape).
WITH occupying(status) AS (
    VALUES ('assigned'),('accepted'),('fare_agreed'),('heading_to_pickup'),
           ('driver_en_route'),('arrived'),('driver_arrived'),('arrived_at_store'),
           ('shopping_in_progress'),('collected'),('picked_up'),
           ('en_route_to_customer'),('in_progress'),('delivered'),
           ('over_budget_requested'),('requires_review')
)
SELECT
    'STATUS ' || o.status AS check_name,
    'informational: occupying rows in this status' AS expected,
    COUNT(j.id)::TEXT || ' occupying | '
      || COUNT(j.id) FILTER (WHERE j.driver_id IS NULL)::TEXT || ' with NULL driver' AS observed,
    'INFO' AS verdict
FROM occupying o
LEFT JOIN public.jobs j ON j.status = o.status
GROUP BY o.status
ORDER BY COUNT(j.id) DESC, o.status;


-- ============================================================================
-- SECTION 3 — DO THE AVAILABILITY FLAGS DISAGREE WITH OCCUPATION?
-- (Reports only. profiles.is_available is NOT repurposed as is_busy and is
--  never toggled by this batch.)
-- ============================================================================

WITH occupying(status) AS (
    VALUES ('assigned'),('accepted'),('fare_agreed'),('heading_to_pickup'),
           ('driver_en_route'),('arrived'),('driver_arrived'),('arrived_at_store'),
           ('shopping_in_progress'),('collected'),('picked_up'),
           ('en_route_to_customer'),('in_progress'),('delivered'),
           ('over_budget_requested'),('requires_review')
), busy AS (
    SELECT DISTINCT j.driver_id
      FROM public.jobs j
      JOIN occupying o ON o.status = j.status
     WHERE j.driver_id IS NOT NULL
)
SELECT
    'BUSY drivers with profiles.is_available = true' AS check_name,
    'informational: is_available is a presence flag, not a busy flag' AS expected,
    COUNT(*) FILTER (WHERE p.is_available IS TRUE)::TEXT || ' of ' || COUNT(*)::TEXT AS observed,
    'INFO' AS verdict
FROM busy b
JOIN public.profiles p ON p.id = b.driver_id;

WITH occupying(status) AS (
    VALUES ('assigned'),('accepted'),('fare_agreed'),('heading_to_pickup'),
           ('driver_en_route'),('arrived'),('driver_arrived'),('arrived_at_store'),
           ('shopping_in_progress'),('collected'),('picked_up'),
           ('en_route_to_customer'),('in_progress'),('delivered'),
           ('over_budget_requested'),('requires_review')
), busy AS (
    SELECT DISTINCT j.driver_id
      FROM public.jobs j
      JOIN occupying o ON o.status = j.status
     WHERE j.driver_id IS NOT NULL
)
SELECT
    'BUSY drivers with profiles.is_online = true' AS check_name,
    'informational: dispatch presence gate that will still match busy drivers' AS expected,
    COUNT(*) FILTER (WHERE p.is_online IS TRUE)::TEXT || ' of ' || COUNT(*)::TEXT AS observed,
    'INFO' AS verdict
FROM busy b
JOIN public.profiles p ON p.id = b.driver_id;

-- Busy drivers that no longer exist as profiles (orphan ownership).
WITH occupying(status) AS (
    VALUES ('assigned'),('accepted'),('fare_agreed'),('heading_to_pickup'),
           ('driver_en_route'),('arrived'),('driver_arrived'),('arrived_at_store'),
           ('shopping_in_progress'),('collected'),('picked_up'),
           ('en_route_to_customer'),('in_progress'),('delivered'),
           ('over_budget_requested'),('requires_review')
)
SELECT
    'ORPHAN occupying driver_id with no profiles row' AS check_name,
    'informational: ownership pointing at a missing driver' AS expected,
    COUNT(DISTINCT j.driver_id)::TEXT AS observed,
    'INFO' AS verdict
FROM public.jobs j
JOIN occupying o ON o.status = j.status
WHERE j.driver_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = j.driver_id);


-- ============================================================================
-- SECTION 4 — EXISTING INDEX INVENTORY ON public.jobs
-- ============================================================================

SELECT
    'INDEX ' || ic.relname AS check_name,
    CASE WHEN i.indisunique THEN 'UNIQUE' ELSE 'non-unique' END AS expected,
    pg_catalog.pg_get_indexdef(i.indexrelid) AS observed,
    CASE
        WHEN ic.relname = 'idx_jobs_one_active_per_driver' AND i.indisunique IS NOT TRUE
            THEN 'FAIL'
        WHEN ic.relname = 'idx_jobs_one_active_per_driver' AND i.indisvalid IS NOT TRUE
            THEN 'FAIL'
        ELSE 'INFO'
    END AS verdict
FROM pg_catalog.pg_index i
JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
WHERE i.indrelid = 'public.jobs'::regclass
  AND pg_catalog.pg_get_indexdef(i.indexrelid) ILIKE '%driver_id%'
ORDER BY ic.relname;

-- 4.1 Does the invariant object already exist, and is it the intended one?
SELECT
    'INVARIANT idx_jobs_one_active_per_driver state' AS check_name,
    'absent, or present as UNIQUE + valid on public.jobs(driver_id)' AS expected,
    CASE
        WHEN i.indexrelid IS NULL THEN 'absent (clean install)'
        ELSE 'unique=' || i.indisunique::TEXT
             || ' valid=' || i.indisvalid::TEXT
             || ' live=' || i.indislive::TEXT
             || ' table=' || tn.nspname || '.' || tc.relname
             || ' predicate=' || COALESCE(pg_catalog.pg_get_expr(i.indpred, i.indrelid), 'NONE')
    END AS observed,
    CASE
        WHEN i.indexrelid IS NULL THEN 'PASS'
        WHEN i.indisunique IS TRUE AND i.indisvalid IS TRUE
             AND tn.nspname = 'public' AND tc.relname = 'jobs'
            THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_index i
       ON i.indexrelid = pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')
LEFT JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace;

-- 4.2 Any OTHER unique index that already constrains jobs(driver_id)? A second
--     overlapping unique object would make the semantics ambiguous.
SELECT
    'CONFLICTING unique index on jobs(driver_id)' AS check_name,
    'none other than the intended invariant' AS expected,
    COALESCE(string_agg(ic.relname, ', ' ORDER BY ic.relname), 'none') AS observed,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_catalog.pg_index i
JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
WHERE i.indrelid = 'public.jobs'::regclass
  AND i.indisunique IS TRUE
  AND pg_catalog.pg_get_indexdef(i.indexrelid) ILIKE '%driver_id%'
  AND ic.relname <> 'idx_jobs_one_active_per_driver';


-- ============================================================================
-- SECTION 5 — OBJECT EXISTENCE: HELPERS AND ACQUISITION RPCs
-- ============================================================================

WITH expected(fn, sig, why) AS (
    VALUES
        ('driver_occupying_statuses',    'public.driver_occupying_statuses()',            'NEW in 20260924000000'),
        ('driver_has_other_active_job',  'public.driver_has_other_active_job(uuid,uuid)', 'NEW in 20260924000000'),
        ('driver_has_active_job',        'public.driver_has_active_job(uuid)',            'NEW in 20260924000000'),
        ('accept_searching_job',         'public.accept_searching_job(uuid,uuid)',        're-issued by 20260924000000'),
        ('assign_driver_to_job',         'public.assign_driver_to_job(uuid,uuid)',        're-issued by 20260924000000'),
        ('accept_assigned_job',          'public.accept_assigned_job(uuid,uuid)',         're-issued by 20260924000000'),
        ('accept_fare_negotiation',      'public.accept_fare_negotiation(uuid,uuid)',     're-issued by 20260924000000'),
        ('lock_marketplace_fare',        'public.lock_marketplace_fare(uuid,uuid,numeric)','REQUIRED: hybrid ownership writer'),
        ('driver_vehicle_can_accept_job','public.driver_vehicle_can_accept_job(uuid,uuid)','REQUIRED: internal Batch 1 helper called by assign_driver_to_job')
)
SELECT
    'FUNCTION ' || e.fn AS check_name,
    e.why AS expected,
    CASE
        WHEN pg_catalog.to_regprocedure(e.sig) IS NULL THEN 'absent'
        ELSE 'present | returns=' || pg_catalog.pg_get_function_result(p.oid)
             || ' | identity=' || pg_catalog.pg_get_function_identity_arguments(p.oid)
             || ' | security=' || CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
             || ' | search_path=' || COALESCE(array_to_string(p.proconfig, ','), '(not set)')
    END AS observed,
    -- EXISTENCE ONLY. Security mode is reported, never gated: the migration
    -- CHANGES assign_driver_to_job from INVOKER to DEFINER, so requiring the
    -- post-migration mode here would make the preflight fail on today's correct
    -- live state.
    CASE
        WHEN pg_catalog.to_regprocedure(e.sig) IS NULL
             AND e.fn IN ('lock_marketplace_fare', 'driver_vehicle_can_accept_job') THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict
FROM expected e
LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(e.sig)
ORDER BY e.fn;

-- 5.0 EXPECTED TRANSITION for the privilege defect this batch corrects.
--     Reports live state as INFO plus the required post-migration state, so the
--     operator can see the change this migration makes. Never a gate: before the
--     migration INVOKER is the CURRENT (defective) state; after it, DEFINER is
--     required and the postflight enforces that.
SELECT
    'TRANSITION assign_driver_to_job security mode' AS check_name,
    'must be DEFINER with pinned search_path AFTER this migration' AS expected,
    'live=' || CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
      || ' | search_path=' || COALESCE(array_to_string(p.proconfig, ','), '(not set)')
      || ' | calls_internal_vehicle_helper=' ||
         (pg_catalog.pg_get_functiondef(p.oid) ILIKE '%driver_vehicle_can_accept_job%')::TEXT
      || ' | vehicle_helper_client_executable=' ||
         COALESCE((
             SELECT bool_or(pg_catalog.has_function_privilege(r.rolname, v.oid, 'EXECUTE'))::TEXT
               FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(rolname)
               CROSS JOIN pg_catalog.pg_proc v
              WHERE v.oid = pg_catalog.to_regprocedure('public.driver_vehicle_can_accept_job(uuid,uuid)')
         ), 'helper absent') AS observed,
    'INFO' AS verdict
FROM pg_catalog.pg_proc p
WHERE p.oid = pg_catalog.to_regprocedure('public.assign_driver_to_job(uuid,uuid)');

-- 5.0b assign_driver_to_job is INVOKER today and calls a helper that its
--      effective callers cannot execute. Reported as a KNOWN DEFECT that this
--      migration corrects (via SECURITY DEFINER), NOT by widening helper ACLs.
SELECT
    'KNOWN DEFECT assign_driver_to_job cannot execute its own helper' AS check_name,
    'corrected by 20260924000000 (INVOKER -> DEFINER); helper ACL must stay closed' AS expected,
    'invoker=' || (NOT p.prosecdef)::TEXT
      || ' | authenticated_can_execute_helper=' ||
         COALESCE(pg_catalog.has_function_privilege(
             'authenticated',
             pg_catalog.to_regprocedure('public.driver_vehicle_can_accept_job(uuid,uuid)'),
             'EXECUTE')::TEXT, 'helper absent')
      || ' | service_role_can_execute_helper=' ||
         COALESCE(pg_catalog.has_function_privilege(
             'service_role',
             pg_catalog.to_regprocedure('public.driver_vehicle_can_accept_job(uuid,uuid)'),
             'EXECUTE')::TEXT, 'helper absent') AS observed,
    'INFO' AS verdict
FROM pg_catalog.pg_proc p
WHERE p.oid = pg_catalog.to_regprocedure('public.assign_driver_to_job(uuid,uuid)');

-- 5.1 Live definitions of the hybrid writer, so the operator can confirm the
--     definition this batch reproduces (reconcile baseline vs 20260707000000
--     forward copy differ by the search_path pin).
SELECT
    'lock_marketplace_fare live search_path' AS check_name,
    'informational: reconcile baseline carries SET search_path = public' AS expected,
    COALESCE(array_to_string(p.proconfig, ','), '(not set)') AS observed,
    'INFO' AS verdict
FROM pg_catalog.pg_proc p
WHERE p.oid = pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)');


-- ============================================================================
-- SECTION 6 — ROLES AND ACL CONTEXT
-- ============================================================================

SELECT
    'ROLE ' || t.rolname AS check_name,
    'role must exist for the REVOKE/GRANT matrix to apply' AS expected,
    CASE WHEN r.oid IS NULL THEN 'MISSING' ELSE 'present' END AS observed,
    CASE WHEN r.oid IS NULL THEN 'FAIL' ELSE 'PASS' END AS verdict
FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS t(rolname)
LEFT JOIN pg_catalog.pg_roles r ON r.rolname = t.rolname
ORDER BY verdict DESC, check_name;

-- Default ACL for the public schema. defaclobjtype is the internal `"char"`
-- type and is cast explicitly before concatenation.
SELECT
    'DEFAULT ACL for public schema' AS check_name,
    'informational: default function privileges the explicit REVOKEs must beat' AS expected,
    COALESCE(
        (SELECT string_agg(
                    pg_catalog.pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::TEXT || ':' ||
                    COALESCE(array_to_string(d.defaclacl, ','), 'none'), ' | ')
           FROM pg_catalog.pg_default_acl d
           JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
          WHERE n.nspname = 'public'),
        '(no default ACL rows for public)') AS observed,
    'INFO' AS verdict;

-- Effective EXECUTE matrix for the objects this batch installs or re-issues.
-- has_function_privilege is authoritative (it accounts for role inheritance and
-- PUBLIC-derived grants). NULL fn_oid yields NULL, which is reported as absent.
WITH policy(fn, sig, rolname, can_execute) AS (
    VALUES
        ('driver_occupying_statuses',   'public.driver_occupying_statuses()',             'anon',          false),
        ('driver_occupying_statuses',   'public.driver_occupying_statuses()',             'authenticated', false),
        ('driver_occupying_statuses',   'public.driver_occupying_statuses()',             'service_role',  false),
        ('driver_has_other_active_job', 'public.driver_has_other_active_job(uuid,uuid)',  'anon',          false),
        ('driver_has_other_active_job', 'public.driver_has_other_active_job(uuid,uuid)',  'authenticated', false),
        ('driver_has_other_active_job', 'public.driver_has_other_active_job(uuid,uuid)',  'service_role',  false),
        ('driver_has_active_job',       'public.driver_has_active_job(uuid)',             'anon',          false),
        ('driver_has_active_job',       'public.driver_has_active_job(uuid)',             'authenticated', false),
        ('driver_has_active_job',       'public.driver_has_active_job(uuid)',             'service_role',  false),
        ('accept_searching_job',        'public.accept_searching_job(uuid,uuid)',         'anon',          false),
        ('accept_searching_job',        'public.accept_searching_job(uuid,uuid)',         'authenticated', true),
        ('accept_searching_job',        'public.accept_searching_job(uuid,uuid)',         'service_role',  true),
        ('assign_driver_to_job',        'public.assign_driver_to_job(uuid,uuid)',         'anon',          false),
        ('assign_driver_to_job',        'public.assign_driver_to_job(uuid,uuid)',         'authenticated', true),
        ('assign_driver_to_job',        'public.assign_driver_to_job(uuid,uuid)',         'service_role',  true),
        ('accept_assigned_job',         'public.accept_assigned_job(uuid,uuid)',          'anon',          false),
        ('accept_assigned_job',         'public.accept_assigned_job(uuid,uuid)',          'authenticated', true),
        ('accept_assigned_job',         'public.accept_assigned_job(uuid,uuid)',          'service_role',  false),
        ('accept_fare_negotiation',     'public.accept_fare_negotiation(uuid,uuid)',      'anon',          false),
        ('accept_fare_negotiation',     'public.accept_fare_negotiation(uuid,uuid)',      'authenticated', false),
        ('accept_fare_negotiation',     'public.accept_fare_negotiation(uuid,uuid)',      'service_role',  true),
        ('driver_vehicle_can_accept_job','public.driver_vehicle_can_accept_job(uuid,uuid)','anon',         false),
        ('driver_vehicle_can_accept_job','public.driver_vehicle_can_accept_job(uuid,uuid)','authenticated',false),
        ('driver_vehicle_can_accept_job','public.driver_vehicle_can_accept_job(uuid,uuid)','service_role', false)
)
SELECT
    'ACL ' || p.fn || ' -> ' || p.rolname AS check_name,
    CASE WHEN p.can_execute THEN 'EXECUTE granted' ELSE 'EXECUTE NOT granted' END AS expected,
    CASE
        WHEN pg_catalog.to_regprocedure(p.sig) IS NULL THEN 'function absent'
        WHEN pg_catalog.has_function_privilege(p.rolname, pg_catalog.to_regprocedure(p.sig), 'EXECUTE')
            THEN 'EXECUTE granted'
        ELSE 'EXECUTE NOT granted'
    END AS observed,
    'INFO' AS verdict,
    p.can_execute AS target_can_execute
FROM policy p
ORDER BY p.fn, p.rolname;


-- ============================================================================
-- SECTION 7 — FROZEN-SET SELF-CHECK OF THIS SCRIPT'S RESTATEMENT
-- Only meaningful once public.driver_occupying_statuses() exists.
-- ============================================================================

WITH occupying(status) AS (
    VALUES ('assigned'),('accepted'),('fare_agreed'),('heading_to_pickup'),
           ('driver_en_route'),('arrived'),('driver_arrived'),('arrived_at_store'),
           ('shopping_in_progress'),('collected'),('picked_up'),
           ('en_route_to_customer'),('in_progress'),('delivered'),
           ('over_budget_requested'),('requires_review')
)
SELECT
    'FROZEN SET preflight-restatement vs helper' AS check_name,
    'identical sets (or helper absent, which is expected before the migration)' AS expected,
    CASE
        WHEN pg_catalog.to_regprocedure('public.driver_occupying_statuses()') IS NULL
            THEN 'helper absent - restatement not yet verifiable'
        ELSE 'script_only=' || COALESCE(
                 (SELECT string_agg(s, ',' ORDER BY s)
                    FROM (SELECT s FROM occupying
                          EXCEPT
                          SELECT s FROM unnest(public.driver_occupying_statuses()) AS u(s)) d),
                 'none')
             || ' | helper_only=' || COALESCE(
                 (SELECT string_agg(s, ',' ORDER BY s)
                    FROM (SELECT s FROM unnest(public.driver_occupying_statuses()) AS u(s)
                          EXCEPT
                          SELECT s FROM occupying) d),
                 'none')
    END AS observed,
    CASE
        WHEN pg_catalog.to_regprocedure('public.driver_occupying_statuses()') IS NULL THEN 'INFO'
        WHEN EXISTS (SELECT s FROM occupying
                     EXCEPT
                     SELECT s FROM unnest(public.driver_occupying_statuses()) AS u(s)) THEN 'FAIL'
        WHEN EXISTS (SELECT s FROM unnest(public.driver_occupying_statuses()) AS u(s)
                     EXCEPT
                     SELECT s FROM occupying) THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict;


-- ============================================================================
-- SECTION 8 — FINAL GO / NO-GO
--
-- GO requires ALL of:
--   * drivers with > 1 occupying job            = 0
--   * required roles present                    = yes
--   * conflicting unique object on driver_id    = none
--   * existing invariant object (if present)     is UNIQUE + valid on jobs(driver_id)
--   * lock_marketplace_fare present              (hybrid ownership writer)
-- ============================================================================

WITH occupying(status) AS (
    VALUES ('assigned'),('accepted'),('fare_agreed'),('heading_to_pickup'),
           ('driver_en_route'),('arrived'),('driver_arrived'),('arrived_at_store'),
           ('shopping_in_progress'),('collected'),('picked_up'),
           ('en_route_to_customer'),('in_progress'),('delivered'),
           ('over_budget_requested'),('requires_review')
),
duplicate_drivers AS (
    SELECT COUNT(*) AS n
      FROM (
        SELECT j.driver_id
          FROM public.jobs j
          JOIN occupying o ON o.status = j.status
         WHERE j.driver_id IS NOT NULL
         GROUP BY j.driver_id
        HAVING COUNT(*) > 1
      ) d
),
missing_roles AS (
    SELECT COUNT(*) AS n
      FROM (VALUES ('anon'),('authenticated'),('service_role')) AS t(rolname)
      LEFT JOIN pg_catalog.pg_roles r ON r.rolname = t.rolname
     WHERE r.oid IS NULL
),
conflicting_index AS (
    SELECT COUNT(*) AS n
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
     WHERE i.indrelid = 'public.jobs'::regclass
       AND i.indisunique IS TRUE
       AND pg_catalog.pg_get_indexdef(i.indexrelid) ILIKE '%driver_id%'
       AND ic.relname <> 'idx_jobs_one_active_per_driver'
),
existing_invariant AS (
    SELECT COUNT(*) FILTER (
               WHERE i.indisunique IS NOT TRUE
                  OR i.indisvalid IS NOT TRUE
                  OR tn.nspname IS DISTINCT FROM 'public'
                  OR tc.relname IS DISTINCT FROM 'jobs'
           ) AS n
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
      JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
     WHERE i.indexrelid = pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')
),
hybrid_writer AS (
    SELECT CASE
               WHEN pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)') IS NULL
               THEN 1 ELSE 0 END AS n
)
SELECT
    'GO / NO-GO' AS check_name,
    'no duplicate occupying drivers + roles present + no conflicting object + hybrid writer present' AS expected,
    'duplicate_drivers=' || (SELECT n FROM duplicate_drivers)::TEXT
      || ' | roles_missing=' || (SELECT n FROM missing_roles)::TEXT
      || ' | conflicting_unique_indexes=' || (SELECT n FROM conflicting_index)::TEXT
      || ' | malformed_existing_invariant=' || (SELECT n FROM existing_invariant)::TEXT
      || ' | missing_hybrid_writer=' || (SELECT n FROM hybrid_writer)::TEXT AS observed,
    CASE
        WHEN (SELECT n FROM duplicate_drivers) > 0 THEN 'NO-GO: resolve duplicate occupying jobs (operator review)'
        WHEN (SELECT n FROM missing_roles) > 0 THEN 'NO-GO: required roles missing'
        WHEN (SELECT n FROM conflicting_index) > 0 THEN 'NO-GO: conflicting unique index on jobs(driver_id)'
        WHEN (SELECT n FROM existing_invariant) > 0 THEN 'NO-GO: existing idx_jobs_one_active_per_driver is not the intended invariant'
        WHEN (SELECT n FROM hybrid_writer) > 0 THEN 'NO-GO: lock_marketplace_fare missing'
        ELSE 'PASS'
    END AS verdict;
