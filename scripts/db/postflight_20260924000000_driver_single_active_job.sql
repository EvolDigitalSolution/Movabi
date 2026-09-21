-- ============================================================================
-- MOVABI — BATCH 2B (N12): POSTFLIGHT for
-- supabase/migrations/20260924000000_driver_single_active_job.sql
--
-- STRICTLY READ ONLY. No DDL. No DML. It does NOT invoke any acquisition RPC
-- (that would assign a real job). Safe to run repeatedly.
--
-- ALIAS DISCIPLINE (the class of defect that cost us production reruns twice -
-- "column policy.signature does not exist" and "column m.literal does not
-- exist"): every derived table here declares every column referenced through
-- its alias, and regexp_matches - a set-returning function - is used as a FROM
-- item via CROSS JOIN LATERAL, never inside an aggregate argument.
-- pg_default_acl.defaclobjtype (internal `"char"`) is cast explicitly before
-- concatenation.
--
-- The authoritative gate is the SELF-CHECK: the frozen occupying-status set in
-- public.driver_occupying_statuses() must be IDENTICAL to the literals in the
-- LIVE partial-index predicate. That is what makes the unavoidable two-place
-- duplication safe.
-- ============================================================================

\pset pager off


-- ============================================================================
-- SECTION 1 — THE INVARIANT OBJECT
-- ============================================================================

SELECT
    'EXISTS idx_jobs_one_active_per_driver' AS check_name,
    'UNIQUE index on public.jobs(driver_id) with an occupying predicate' AS expected,
    CASE
        WHEN i.indexrelid IS NULL THEN 'MISSING'
        ELSE 'unique=' || i.indisunique::TEXT
             || ' valid=' || i.indisvalid::TEXT
             || ' live=' || i.indislive::TEXT
             || ' table=' || COALESCE(tn.nspname || '.' || tc.relname, '?')
             || ' key=' || COALESCE(a.attname, '?')
             || ' keyatts=' || COALESCE(i.indnkeyatts::TEXT, '?')
    END AS observed,
    CASE
        WHEN i.indexrelid IS NULL THEN 'FAIL'
        WHEN i.indisunique IS TRUE
             AND i.indisvalid IS TRUE
             AND tn.nspname = 'public'
             AND tc.relname = 'jobs'
             AND i.indnkeyatts = 1
             AND a.attname = 'driver_id'
            THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_index i
       ON i.indexrelid = pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')
LEFT JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
LEFT JOIN pg_catalog.pg_attribute a
       ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0];

SELECT
    'PREDICATE text' AS check_name,
    'informational: the live partial-index predicate' AS expected,
    COALESCE(
        (SELECT pg_catalog.pg_get_expr(i.indpred, i.indrelid)
           FROM pg_catalog.pg_index i
          WHERE i.indexrelid = pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')),
        'MISSING') AS observed,
    'INFO' AS verdict;

-- 1.1 The frozen set must be IDENTICAL in the helper and in the index predicate.
SELECT
    'FROZEN SET helper vs index predicate' AS check_name,
    'identical both ways: no helper-only and no predicate-only status' AS expected,
    CASE
        WHEN pg_catalog.to_regprocedure('public.driver_occupying_statuses()') IS NULL
            THEN 'helper MISSING'
        WHEN pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver') IS NULL
            THEN 'index MISSING'
        ELSE 'helper_only=' || COALESCE(
                 (SELECT string_agg(s, ',' ORDER BY s)
                    FROM (SELECT s FROM unnest(public.driver_occupying_statuses()) AS u(s)
                          EXCEPT
                          SELECT DISTINCT (m.match)[1]
                            FROM pg_catalog.pg_index i
                           CROSS JOIN LATERAL pg_catalog.regexp_matches(
                                          pg_catalog.pg_get_expr(i.indpred, i.indrelid),
                                          '''([^'']*)''', 'g') AS m(match)
                           WHERE i.indexrelid =
                                 pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')) d),
                 'none')
             || ' | predicate_only=' || COALESCE(
                 (SELECT string_agg(s, ',' ORDER BY s)
                    FROM (SELECT DISTINCT (m.match)[1] AS s
                            FROM pg_catalog.pg_index i
                           CROSS JOIN LATERAL pg_catalog.regexp_matches(
                                          pg_catalog.pg_get_expr(i.indpred, i.indrelid),
                                          '''([^'']*)''', 'g') AS m(match)
                           WHERE i.indexrelid =
                                 pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')
                          EXCEPT
                          SELECT s FROM unnest(public.driver_occupying_statuses()) AS u(s)) d),
                 'none')
    END AS observed,
    CASE
        WHEN pg_catalog.to_regprocedure('public.driver_occupying_statuses()') IS NULL THEN 'FAIL'
        WHEN pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver') IS NULL THEN 'FAIL'
        WHEN EXISTS (
                SELECT s FROM unnest(public.driver_occupying_statuses()) AS u(s)
                 EXCEPT
                SELECT DISTINCT (m.match)[1]
                  FROM pg_catalog.pg_index i
                 CROSS JOIN LATERAL pg_catalog.regexp_matches(
                                pg_catalog.pg_get_expr(i.indpred, i.indrelid),
                                '''([^'']*)''', 'g') AS m(match)
                 WHERE i.indexrelid =
                       pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')) THEN 'FAIL'
        WHEN EXISTS (
                SELECT DISTINCT (m.match)[1]
                  FROM pg_catalog.pg_index i
                 CROSS JOIN LATERAL pg_catalog.regexp_matches(
                                pg_catalog.pg_get_expr(i.indpred, i.indrelid),
                                '''([^'']*)''', 'g') AS m(match)
                 WHERE i.indexrelid =
                       pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')
                 EXCEPT
                SELECT s FROM unnest(public.driver_occupying_statuses()) AS u(s)) THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict;

-- 1.2 Explicit individual membership of the two statuses that carry the most
--     risk of silent omission, plus the terminal exclusions.
WITH predicate_literals AS (
    SELECT DISTINCT (m.match)[1] AS status
      FROM pg_catalog.pg_index i
     CROSS JOIN LATERAL pg_catalog.regexp_matches(
                    pg_catalog.pg_get_expr(i.indpred, i.indrelid),
                    '''([^'']*)''', 'g') AS m(match)
     WHERE i.indexrelid = pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')
)
SELECT
    'PREDICATE must ' || r.expectation || ' ' || r.status AS check_name,
    'frozen set membership' AS expected,
    CASE WHEN EXISTS (SELECT 1 FROM predicate_literals p WHERE p.status = r.status)
         THEN 'present' ELSE 'absent' END AS observed,
    CASE
        WHEN r.must_be_present AND EXISTS (SELECT 1 FROM predicate_literals p WHERE p.status = r.status)
            THEN 'PASS'
        WHEN NOT r.must_be_present AND NOT EXISTS (SELECT 1 FROM predicate_literals p WHERE p.status = r.status)
            THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM (VALUES
        ('include', 'fare_agreed',          TRUE),
        ('include', 'requires_review',      TRUE),
        ('include', 'assigned',             TRUE),
        ('include', 'accepted',             TRUE),
        ('EXCLUDE', 'completed',            FALSE),
        ('EXCLUDE', 'settled',              FALSE),
        ('EXCLUDE', 'cancelled',            FALSE),
        ('EXCLUDE', 'failed',               FALSE),
        ('EXCLUDE', 'expired',              FALSE),
        ('EXCLUDE', 'no_driver_found',      FALSE)
     ) AS r(expectation, status, must_be_present)
ORDER BY r.must_be_present DESC, r.status;

-- 1.3 Occupying rows that currently violate the invariant (must be 0).
SELECT
    'LIVE duplicate occupying drivers' AS check_name,
    'MUST be 0 - the index cannot exist while this is non-zero' AS expected,
    COUNT(*)::TEXT AS observed,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (
    SELECT j.driver_id
      FROM public.jobs j
     WHERE j.driver_id IS NOT NULL
       AND j.status = ANY (public.driver_occupying_statuses())
     GROUP BY j.driver_id
    HAVING COUNT(*) > 1
) d;


-- ============================================================================
-- SECTION 2 — HELPER FUNCTIONS: IDENTITY, MODE, search_path, ACL
-- ============================================================================

WITH expected(fn, sig, rettype) AS (
    VALUES
        ('driver_occupying_statuses',   'public.driver_occupying_statuses()',           'text[]'),
        ('driver_has_other_active_job', 'public.driver_has_other_active_job(uuid,uuid)', 'boolean'),
        ('driver_has_active_job',       'public.driver_has_active_job(uuid)',            'boolean')
)
SELECT
    'HELPER ' || e.fn AS check_name,
    'present, returns ' || e.rettype || ', SECURITY INVOKER, pinned search_path' AS expected,
    CASE
        WHEN p.oid IS NULL THEN 'MISSING'
        ELSE 'returns=' || pg_catalog.pg_get_function_result(p.oid)
             || ' | security=' || CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
             || ' | immutable=' || p.provolatile::TEXT
             || ' | search_path=' || COALESCE(array_to_string(p.proconfig, ','), '(not set)')
    END AS observed,
    CASE
        WHEN p.oid IS NULL THEN 'FAIL'
        WHEN pg_catalog.pg_get_function_result(p.oid) IS DISTINCT FROM e.rettype THEN 'FAIL'
        WHEN p.prosecdef IS TRUE THEN 'FAIL'
        WHEN NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                          WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%')
            THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict
FROM expected e
LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(e.sig)
ORDER BY e.fn;

-- 2.1 Helpers must be internal: no bare PUBLIC entry in proacl.
SELECT
    'HELPER proacl has no PUBLIC grant' AS check_name,
    'proacl must not contain a bare =X/ entry' AS expected,
    CASE
        WHEN p.oid IS NULL THEN 'function MISSING'
        WHEN p.proacl IS NULL THEN 'NULL proacl - default ACL still grants EXECUTE to PUBLIC'
        WHEN EXISTS (SELECT 1 FROM unnest(p.proacl) a WHERE a::TEXT LIKE '=%') THEN 'PUBLIC EXECUTE present'
        ELSE 'no PUBLIC entry'
    END AS observed,
    CASE
        WHEN p.oid IS NULL THEN 'FAIL'
        WHEN p.proacl IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM unnest(p.proacl) a WHERE a::TEXT LIKE '=%')
        THEN 'PASS' ELSE 'FAIL'
    END AS verdict
FROM (VALUES
        ('public.driver_occupying_statuses()'),
        ('public.driver_has_other_active_job(uuid,uuid)'),
        ('public.driver_has_active_job(uuid)')
     ) AS s(sig)
LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(s.sig);


-- ============================================================================
-- SECTION 3 — ACQUISITION RPCs: IDENTITY, SECURITY MODE, ACL MATRIX
-- ============================================================================

WITH expected(fn, sig, rettype, definer) AS (
    VALUES
        ('accept_searching_job',   'public.accept_searching_job(uuid,uuid)',      'boolean', TRUE),
        -- SECURITY DEFINER is now REQUIRED: the privilege defect corrected by
        -- this migration. As INVOKER it cannot execute its internal helper, and
        -- the helper ACL must stay closed rather than be widened.
        ('assign_driver_to_job',   'public.assign_driver_to_job(uuid,uuid)',      'boolean', TRUE),
        ('accept_assigned_job',    'public.accept_assigned_job(uuid,uuid)',       'boolean', TRUE),
        ('accept_fare_negotiation','public.accept_fare_negotiation(uuid,uuid)',   'jsonb',   TRUE),
        ('lock_marketplace_fare',  'public.lock_marketplace_fare(uuid,uuid,numeric)', 'marketplace_negotiation_sessions', TRUE)
)
SELECT
    'RPC ' || e.fn AS check_name,
    'returns ' || e.rettype || ' | security=' || CASE WHEN e.definer THEN 'DEFINER' ELSE 'INVOKER' END
        || ' | pinned search_path (public, pg_temp)' AS expected,
    CASE
        WHEN p.oid IS NULL THEN 'MISSING'
        ELSE 'returns=' || pg_catalog.pg_get_function_result(p.oid)
             || ' | security=' || CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
             || ' | search_path=' || COALESCE(array_to_string(p.proconfig, ','), '(not set)')
    END AS observed,
    CASE
        WHEN p.oid IS NULL THEN 'FAIL'
        WHEN pg_catalog.pg_get_function_result(p.oid) IS DISTINCT FROM e.rettype THEN 'FAIL'
        WHEN p.prosecdef IS DISTINCT FROM e.definer THEN 'FAIL'
        -- Every acquisition RPC, assign_driver_to_job included, must pin
        -- search_path: DEFINER without a pinned search_path is a privilege risk.
        WHEN NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                          WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%')
            THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict
FROM expected e
LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(e.sig)
ORDER BY e.fn;

-- 3.0 The Batch 1 vehicle helper MUST remain non-client-executable. Making
--     assign_driver_to_job SECURITY DEFINER is the fix; granting this helper to
--     client roles is NOT, and would expose job/vehicle compatibility probing.
WITH roles(rolname) AS (
    VALUES ('anon'), ('authenticated'), ('service_role')
)
SELECT
    'INTERNAL HELPER driver_vehicle_can_accept_job not client-executable' AS check_name,
    'no client role may execute the internal vehicle-compatibility helper' AS expected,
    'present=' || (pg_catalog.to_regprocedure('public.driver_vehicle_can_accept_job(uuid,uuid)') IS NOT NULL)::TEXT
      || ' | client_executable_roles=' || COALESCE(
             (SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname)
                FROM roles r
               WHERE pg_catalog.to_regprocedure('public.driver_vehicle_can_accept_job(uuid,uuid)') IS NOT NULL
                 AND pg_catalog.has_function_privilege(
                         r.rolname,
                         pg_catalog.to_regprocedure('public.driver_vehicle_can_accept_job(uuid,uuid)'),
                         'EXECUTE')),
             'none') AS observed,
    CASE
        WHEN pg_catalog.to_regprocedure('public.driver_vehicle_can_accept_job(uuid,uuid)') IS NULL THEN 'FAIL'
        WHEN EXISTS (
                SELECT 1 FROM roles r
                 WHERE pg_catalog.has_function_privilege(
                         r.rolname,
                         pg_catalog.to_regprocedure('public.driver_vehicle_can_accept_job(uuid,uuid)'),
                         'EXECUTE'))
            THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict;

-- 3.1 Effective-privilege matrix. Authoritative: has_function_privilege
--     accounts for direct grants, role inheritance and PUBLIC-derived grants.
WITH acl_policy(fn, sig, rolname, can_execute) AS (
    VALUES
        ('driver_occupying_statuses',   'public.driver_occupying_statuses()',            'anon',          FALSE),
        ('driver_occupying_statuses',   'public.driver_occupying_statuses()',            'authenticated', FALSE),
        ('driver_occupying_statuses',   'public.driver_occupying_statuses()',            'service_role',  FALSE),
        ('driver_has_other_active_job', 'public.driver_has_other_active_job(uuid,uuid)', 'anon',          FALSE),
        ('driver_has_other_active_job', 'public.driver_has_other_active_job(uuid,uuid)', 'authenticated', FALSE),
        ('driver_has_other_active_job', 'public.driver_has_other_active_job(uuid,uuid)', 'service_role',  FALSE),
        ('driver_has_active_job',       'public.driver_has_active_job(uuid)',            'anon',          FALSE),
        ('driver_has_active_job',       'public.driver_has_active_job(uuid)',            'authenticated', FALSE),
        ('driver_has_active_job',       'public.driver_has_active_job(uuid)',            'service_role',  FALSE),
        ('accept_searching_job',        'public.accept_searching_job(uuid,uuid)',        'anon',          FALSE),
        ('accept_searching_job',        'public.accept_searching_job(uuid,uuid)',        'authenticated', TRUE),
        ('accept_searching_job',        'public.accept_searching_job(uuid,uuid)',        'service_role',  TRUE),
        ('assign_driver_to_job',        'public.assign_driver_to_job(uuid,uuid)',        'anon',          FALSE),
        ('assign_driver_to_job',        'public.assign_driver_to_job(uuid,uuid)',        'authenticated', TRUE),
        ('assign_driver_to_job',        'public.assign_driver_to_job(uuid,uuid)',        'service_role',  TRUE),
        ('accept_assigned_job',         'public.accept_assigned_job(uuid,uuid)',         'anon',          FALSE),
        ('accept_assigned_job',         'public.accept_assigned_job(uuid,uuid)',         'authenticated', TRUE),
        ('accept_assigned_job',         'public.accept_assigned_job(uuid,uuid)',         'service_role',  FALSE),
        ('accept_fare_negotiation',     'public.accept_fare_negotiation(uuid,uuid)',     'anon',          FALSE),
        ('accept_fare_negotiation',     'public.accept_fare_negotiation(uuid,uuid)',     'authenticated', FALSE),
        ('accept_fare_negotiation',     'public.accept_fare_negotiation(uuid,uuid)',     'service_role',  TRUE),
        ('driver_vehicle_can_accept_job','public.driver_vehicle_can_accept_job(uuid,uuid)','anon',         FALSE),
        ('driver_vehicle_can_accept_job','public.driver_vehicle_can_accept_job(uuid,uuid)','authenticated',FALSE),
        ('driver_vehicle_can_accept_job','public.driver_vehicle_can_accept_job(uuid,uuid)','service_role', FALSE)
)
SELECT
    'ACL ' || p.fn || ' -> ' || p.rolname AS check_name,
    CASE WHEN p.can_execute THEN 'EXECUTE granted' ELSE 'EXECUTE NOT granted' END AS expected,
    CASE
        WHEN pg_catalog.to_regprocedure(p.sig) IS NULL THEN 'function MISSING'
        WHEN pg_catalog.has_function_privilege(p.rolname, pg_catalog.to_regprocedure(p.sig), 'EXECUTE')
            THEN 'EXECUTE granted'
        ELSE 'EXECUTE NOT granted'
    END AS observed,
    CASE
        WHEN pg_catalog.to_regprocedure(p.sig) IS NULL THEN 'FAIL'
        WHEN pg_catalog.has_function_privilege(p.rolname, pg_catalog.to_regprocedure(p.sig), 'EXECUTE')
             = p.can_execute THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM acl_policy p
ORDER BY p.fn, p.rolname;

-- 3.2 The helpers must have NO effective EXECUTE for any client role.
WITH helper_sigs(sig) AS (
    VALUES
        ('public.driver_occupying_statuses()'),
        ('public.driver_has_other_active_job(uuid,uuid)'),
        ('public.driver_has_active_job(uuid)')
), role_names(rolname) AS (
    VALUES ('anon'), ('authenticated'), ('service_role')
)
SELECT
    'HELPER ACL violations' AS check_name,
    'no client role may execute an N12 predicate' AS expected,
    COALESCE(
        (SELECT string_agg(h.sig || '->' || r.rolname, ', ' ORDER BY h.sig, r.rolname)
           FROM helper_sigs h
           CROSS JOIN role_names r
          WHERE pg_catalog.to_regprocedure(h.sig) IS NOT NULL
            AND pg_catalog.has_function_privilege(r.rolname, pg_catalog.to_regprocedure(h.sig), 'EXECUTE')),
        'none') AS observed,
    CASE WHEN EXISTS (
            SELECT 1 FROM helper_sigs h CROSS JOIN role_names r
             WHERE pg_catalog.to_regprocedure(h.sig) IS NOT NULL
               AND pg_catalog.has_function_privilege(r.rolname, pg_catalog.to_regprocedure(h.sig), 'EXECUTE'))
         THEN 'FAIL' ELSE 'PASS' END AS verdict;


-- ============================================================================
-- SECTION 4 — SOURCE/BODY GUARDS INSIDE THE RE-ISSUED RPCs
--
-- Verifies that each function actually contains the intended N12 handling, and
-- - deliberately - that assign_driver_to_job does NOT call the internal
-- predicate (it is SECURITY INVOKER and the predicate's EXECUTE is revoked, so
-- it must rely on the index plus the unique_violation mapping).
-- ============================================================================
WITH guard(fn, sig, needle, must_exist, why) AS (
    VALUES
        ('accept_searching_job',    'public.accept_searching_job(uuid,uuid)',
         '%driver_has_other_active_job%', TRUE,  'friendly pre-check present'),
        ('accept_searching_job',    'public.accept_searching_job(uuid,uuid)',
         '%idx_jobs_one_active_per_driver%', TRUE, 'converts the invariant violation'),
        ('accept_searching_job',    'public.accept_searching_job(uuid,uuid)',
         '%unique_violation%', TRUE, 'catches the race'),
        ('accept_searching_job',    'public.accept_searching_job(uuid,uuid)',
         '%driver_vehicle_can_accept_job%', TRUE, 'Batch 1 vehicle check preserved'),
        ('assign_driver_to_job',    'public.assign_driver_to_job(uuid,uuid)',
         '%idx_jobs_one_active_per_driver%', TRUE, 'converts the invariant violation'),
        ('assign_driver_to_job',    'public.assign_driver_to_job(uuid,uuid)',
         '%unique_violation%', TRUE, 'catches the race'),
        ('assign_driver_to_job',    'public.assign_driver_to_job(uuid,uuid)',
         '%public.driver_has_other_active_job(p_driver_id, p_job_id)%', TRUE, 'busy pre-check present, schema-qualified, target job excluded'),
        ('assign_driver_to_job',    'public.assign_driver_to_job(uuid,uuid)',
         '%public.driver_vehicle_can_accept_job(p_job_id, p_driver_id)%', TRUE, 'vehicle check preserved and schema-qualified'),
        ('assign_driver_to_job',    'public.assign_driver_to_job(uuid,uuid)',
         '%''pending'', ''requested'', ''searching''%', TRUE, 'source statuses unchanged'),
        ('assign_driver_to_job',    'public.assign_driver_to_job(uuid,uuid)',
         '%driver_id IS NULL%', TRUE, 'target job must still be unowned'),
        ('assign_driver_to_job',    'public.assign_driver_to_job(uuid,uuid)',
         '%driver_id = p_driver_id%', TRUE, 'assignment write preserved'),
        ('assign_driver_to_job',    'public.assign_driver_to_job(uuid,uuid)',
         '%accepted_driver_id%', FALSE, 'must NOT set Batch 1 acceptance markers'),
        ('assign_driver_to_job',    'public.assign_driver_to_job(uuid,uuid)',
         '%accepted_at%', FALSE, 'must NOT set Batch 1 acceptance markers'),
        ('assign_driver_to_job',    'public.assign_driver_to_job(uuid,uuid)',
         '%auth.uid()%', FALSE, 'must NOT add a caller-identity requirement (admin/service assignment semantics)'),
        ('accept_assigned_job',     'public.accept_assigned_job(uuid,uuid)',
         '%driver_has_other_active_job%', TRUE, 'pre-check present'),
        ('accept_assigned_job',     'public.accept_assigned_job(uuid,uuid)',
         '%p_job_id%', TRUE, 'target job excluded so idempotent confirmation is not rejected'),
        ('accept_assigned_job',     'public.accept_assigned_job(uuid,uuid)',
         '%status = ''assigned''%', TRUE, 'Batch 1 status guard preserved'),
        ('accept_assigned_job',     'public.accept_assigned_job(uuid,uuid)',
         '%driver_id = v_caller%', TRUE, 'Batch 1 ownership guard preserved'),
        ('accept_fare_negotiation', 'public.accept_fare_negotiation(uuid,uuid)',
         '%driver_has_other_active_job%', TRUE, 'friendly pre-check present'),
        ('accept_fare_negotiation', 'public.accept_fare_negotiation(uuid,uuid)',
         '%idx_jobs_one_active_per_driver%', TRUE, 'converts the invariant violation'),
        ('accept_fare_negotiation', 'public.accept_fare_negotiation(uuid,uuid)',
         '%FOR UPDATE%', TRUE, 'Batch 2A row locking preserved'),
        ('accept_fare_negotiation', 'public.accept_fare_negotiation(uuid,uuid)',
         '%already owned by another driver%', TRUE, 'Batch 2A 23505 ownership guard preserved'),
        ('lock_marketplace_fare',   'public.lock_marketplace_fare(uuid,uuid,numeric)',
         '%idx_jobs_one_active_per_driver%', TRUE, 'hybrid ownership writer reports the invariant violation'),
        ('lock_marketplace_fare',   'public.lock_marketplace_fare(uuid,uuid,numeric)',
         '%driver_id = p_driver_id%', TRUE, 'hybrid ownership write preserved')
)
SELECT
    'BODY ' || g.fn || ' ' || CASE WHEN g.must_exist THEN 'contains' ELSE 'must NOT contain' END
        || ' [' || g.why || ']' AS check_name,
    g.needle AS expected,
    CASE
        WHEN p.oid IS NULL THEN 'function MISSING'
        WHEN pg_catalog.pg_get_functiondef(p.oid) ILIKE g.needle THEN 'present'
        ELSE 'absent'
    END AS observed,
    CASE
        WHEN p.oid IS NULL THEN 'FAIL'
        WHEN g.must_exist AND pg_catalog.pg_get_functiondef(p.oid) ILIKE g.needle THEN 'PASS'
        WHEN NOT g.must_exist AND pg_catalog.pg_get_functiondef(p.oid) NOT ILIKE g.needle THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM guard g
LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(g.sig)
ORDER BY g.fn, g.must_exist DESC, g.needle;

-- 4.1 The frozen set must NOT be re-typed inside any RPC body: the RPCs must
--     reach it through the helper. A literal 'requires_review' inside an RPC
--     body would mean the list has been copied again.
SELECT
    'RPC bodies must not re-type the frozen status list' AS check_name,
    'no RPC body contains requires_review / over_budget_requested literals' AS expected,
    COALESCE(
        (SELECT string_agg(t.fn, ', ' ORDER BY t.fn)
           FROM (VALUES
                    ('accept_searching_job',   'public.accept_searching_job(uuid,uuid)'),
                    ('assign_driver_to_job',   'public.assign_driver_to_job(uuid,uuid)'),
                    ('accept_assigned_job',    'public.accept_assigned_job(uuid,uuid)'),
                    ('accept_fare_negotiation','public.accept_fare_negotiation(uuid,uuid)')
                ) AS t(fn, sig)
          WHERE pg_catalog.to_regprocedure(t.sig) IS NOT NULL
            AND (pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(t.sig)) ILIKE '%requires_review%'
              OR pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(t.sig)) ILIKE '%over_budget_requested%')),
        'none') AS observed,
    CASE WHEN EXISTS (
            SELECT 1 FROM (VALUES
                    ('accept_searching_job',   'public.accept_searching_job(uuid,uuid)'),
                    ('assign_driver_to_job',   'public.assign_driver_to_job(uuid,uuid)'),
                    ('accept_assigned_job',    'public.accept_assigned_job(uuid,uuid)'),
                    ('accept_fare_negotiation','public.accept_fare_negotiation(uuid,uuid)')
                ) AS t(fn, sig)
             WHERE pg_catalog.to_regprocedure(t.sig) IS NOT NULL
               AND (pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(t.sig)) ILIKE '%requires_review%'
                 OR pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(t.sig)) ILIKE '%over_budget_requested%'))
         THEN 'FAIL' ELSE 'PASS' END AS verdict;


-- ============================================================================
-- SECTION 5 — POST-MIGRATION GO / NO-GO
-- ============================================================================

WITH acl_policy(fn, sig, rolname, can_execute) AS (
    VALUES
        ('driver_occupying_statuses',   'public.driver_occupying_statuses()',            'anon',          FALSE),
        ('driver_occupying_statuses',   'public.driver_occupying_statuses()',            'authenticated', FALSE),
        ('driver_occupying_statuses',   'public.driver_occupying_statuses()',            'service_role',  FALSE),
        ('driver_has_other_active_job', 'public.driver_has_other_active_job(uuid,uuid)', 'anon',          FALSE),
        ('driver_has_other_active_job', 'public.driver_has_other_active_job(uuid,uuid)', 'authenticated', FALSE),
        ('driver_has_other_active_job', 'public.driver_has_other_active_job(uuid,uuid)', 'service_role',  FALSE),
        ('driver_has_active_job',       'public.driver_has_active_job(uuid)',            'anon',          FALSE),
        ('driver_has_active_job',       'public.driver_has_active_job(uuid)',            'authenticated', FALSE),
        ('driver_has_active_job',       'public.driver_has_active_job(uuid)',            'service_role',  FALSE),
        ('accept_searching_job',        'public.accept_searching_job(uuid,uuid)',        'anon',          FALSE),
        ('accept_searching_job',        'public.accept_searching_job(uuid,uuid)',        'authenticated', TRUE),
        ('accept_searching_job',        'public.accept_searching_job(uuid,uuid)',        'service_role',  TRUE),
        ('assign_driver_to_job',        'public.assign_driver_to_job(uuid,uuid)',        'anon',          FALSE),
        ('assign_driver_to_job',        'public.assign_driver_to_job(uuid,uuid)',        'authenticated', TRUE),
        ('assign_driver_to_job',        'public.assign_driver_to_job(uuid,uuid)',        'service_role',  TRUE),
        ('accept_assigned_job',         'public.accept_assigned_job(uuid,uuid)',         'anon',          FALSE),
        ('accept_assigned_job',         'public.accept_assigned_job(uuid,uuid)',         'authenticated', TRUE),
        ('accept_assigned_job',         'public.accept_assigned_job(uuid,uuid)',         'service_role',  FALSE),
        ('accept_fare_negotiation',     'public.accept_fare_negotiation(uuid,uuid)',     'anon',          FALSE),
        ('accept_fare_negotiation',     'public.accept_fare_negotiation(uuid,uuid)',     'authenticated', FALSE),
        ('accept_fare_negotiation',     'public.accept_fare_negotiation(uuid,uuid)',     'service_role',  TRUE),
        ('driver_vehicle_can_accept_job','public.driver_vehicle_can_accept_job(uuid,uuid)','anon',         FALSE),
        ('driver_vehicle_can_accept_job','public.driver_vehicle_can_accept_job(uuid,uuid)','authenticated',FALSE),
        ('driver_vehicle_can_accept_job','public.driver_vehicle_can_accept_job(uuid,uuid)','service_role', FALSE)
),
acl_violations AS (
    SELECT p.fn, p.rolname
      FROM acl_policy p
     WHERE pg_catalog.to_regprocedure(p.sig) IS NULL
        OR pg_catalog.has_function_privilege(p.rolname, pg_catalog.to_regprocedure(p.sig), 'EXECUTE')
           IS DISTINCT FROM p.can_execute
),
helper_grants AS (
    SELECT hs.sig, rn.rolname
      FROM (VALUES
                ('public.driver_occupying_statuses()'),
                ('public.driver_has_other_active_job(uuid,uuid)'),
                ('public.driver_has_active_job(uuid)')
           ) AS hs(sig)
     CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS rn(rolname)
     WHERE pg_catalog.to_regprocedure(hs.sig) IS NOT NULL
       AND pg_catalog.has_function_privilege(rn.rolname, pg_catalog.to_regprocedure(hs.sig), 'EXECUTE')
),
invariant AS (
    SELECT i.indisunique AS is_unique,
           i.indisvalid  AS is_valid,
           i.indnkeyatts AS key_att_count,
           a.attname     AS key_column,
           tn.nspname    AS schema_name,
           tc.relname    AS table_name,
           i.indexrelid  AS index_oid,
           i.indpred     AS predicate
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
      JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
      LEFT JOIN pg_catalog.pg_attribute a
             ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indexrelid = pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')
),
dup_drivers AS (
    SELECT COUNT(*) AS n
      FROM (
        SELECT j.driver_id
          FROM public.jobs j
         WHERE j.driver_id IS NOT NULL
           AND j.status = ANY (public.driver_occupying_statuses())
         GROUP BY j.driver_id
        HAVING COUNT(*) > 1
      ) d
),
missing_rpc AS (
    SELECT COUNT(*) AS n
      FROM (VALUES
                ('public.accept_searching_job(uuid,uuid)'),
                ('public.assign_driver_to_job(uuid,uuid)'),
                ('public.accept_assigned_job(uuid,uuid)'),
                ('public.accept_fare_negotiation(uuid,uuid)'),
                ('public.lock_marketplace_fare(uuid,uuid,numeric)')
           ) AS mr(sig)
     WHERE pg_catalog.to_regprocedure(mr.sig) IS NULL
),
vehicle_helper_grants AS (
    SELECT r.rolname
      FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(rolname)
     WHERE pg_catalog.to_regprocedure('public.driver_vehicle_can_accept_job(uuid,uuid)') IS NULL
        OR pg_catalog.has_function_privilege(
               r.rolname,
               pg_catalog.to_regprocedure('public.driver_vehicle_can_accept_job(uuid,uuid)'),
               'EXECUTE')
)
SELECT
    'POST-MIGRATION GO / NO-GO' AS check_name,
    'invariant present + unique + valid + keyed on jobs(driver_id) + frozen set identical + ACL matrix correct + internal helpers closed' AS expected,
    'invariant_present=' || (SELECT COUNT(*) FROM invariant)::TEXT
      || ' | unique=' || COALESCE((SELECT is_unique::TEXT FROM invariant), '?')
      || ' | valid=' || COALESCE((SELECT is_valid::TEXT FROM invariant), '?')
      || ' | key=' || COALESCE((SELECT key_column FROM invariant), '?')
      || ' | acl_violations=' || COALESCE(
             (SELECT string_agg(v.fn || '->' || v.rolname, ', ' ORDER BY v.fn, v.rolname) FROM acl_violations v), 'none')
      || ' | helper_grants=' || COALESCE(
             (SELECT string_agg(g.sig || '->' || g.rolname, ', ' ORDER BY g.sig, g.rolname) FROM helper_grants g), 'none')
      || ' | vehicle_helper_client_grants=' || COALESCE(
             (SELECT string_agg(vh.rolname, ', ' ORDER BY vh.rolname) FROM vehicle_helper_grants vh), 'none')
      || ' | duplicate_occupying_drivers=' || (SELECT n FROM dup_drivers)::TEXT
      || ' | missing_rpcs=' || (SELECT n FROM missing_rpc)::TEXT AS observed,
    CASE
        WHEN (SELECT COUNT(*) FROM invariant) <> 1 THEN 'NO-GO: invariant index missing'
        WHEN (SELECT is_unique FROM invariant) IS NOT TRUE THEN 'NO-GO: invariant is not UNIQUE'
        WHEN (SELECT is_valid FROM invariant) IS NOT TRUE THEN 'NO-GO: invariant index is INVALID (does not enforce)'
        WHEN (SELECT key_att_count FROM invariant) <> 1
          OR (SELECT key_column FROM invariant) IS DISTINCT FROM 'driver_id' THEN 'NO-GO: invariant key is not (driver_id)'
        WHEN (SELECT schema_name FROM invariant) IS DISTINCT FROM 'public'
          OR (SELECT table_name FROM invariant) IS DISTINCT FROM 'jobs' THEN 'NO-GO: invariant is not on public.jobs'
        WHEN (SELECT predicate FROM invariant) IS NULL THEN 'NO-GO: invariant has no partial predicate'
        WHEN EXISTS (
                SELECT s FROM unnest(public.driver_occupying_statuses()) AS u(s)
                 EXCEPT
                SELECT DISTINCT (m.match)[1]
                  FROM pg_catalog.pg_index i
                 CROSS JOIN LATERAL pg_catalog.regexp_matches(
                                pg_catalog.pg_get_expr(i.indpred, i.indrelid),
                                '''([^'']*)''', 'g') AS m(match)
                 WHERE i.indexrelid = pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')
             ) THEN 'NO-GO: helper has statuses the index predicate lacks'
        WHEN EXISTS (
                SELECT DISTINCT (m.match)[1]
                  FROM pg_catalog.pg_index i
                 CROSS JOIN LATERAL pg_catalog.regexp_matches(
                                pg_catalog.pg_get_expr(i.indpred, i.indrelid),
                                '''([^'']*)''', 'g') AS m(match)
                 WHERE i.indexrelid = pg_catalog.to_regclass('public.idx_jobs_one_active_per_driver')
                 EXCEPT
                SELECT s FROM unnest(public.driver_occupying_statuses()) AS u(s)
             ) THEN 'NO-GO: index predicate has statuses the helper lacks'
        WHEN EXISTS (SELECT 1 FROM acl_violations) THEN 'NO-GO: ACL matrix violation'
        WHEN EXISTS (SELECT 1 FROM helper_grants) THEN 'NO-GO: an N12 predicate is client-executable'
        WHEN EXISTS (SELECT 1 FROM vehicle_helper_grants)
            THEN 'NO-GO: driver_vehicle_can_accept_job is client-executable (fix via SECURITY DEFINER, not by widening helper ACLs)'
        WHEN (SELECT n FROM dup_drivers) > 0 THEN 'NO-GO: duplicate occupying jobs still present'
        WHEN (SELECT n FROM missing_rpc) > 0 THEN 'NO-GO: an acquisition RPC is missing'
        ELSE 'PASS'
    END AS verdict;
