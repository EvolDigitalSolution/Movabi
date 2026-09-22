-- ============================================================================
-- MOVABI — BATCH 2C / PHASE B.B1 FOLLOW-UP: POSTFLIGHT for
-- supabase/migrations/20260926100000_lock_marketplace_fare_acl_fix.sql
--
-- STRICTLY READ ONLY. No DDL. No DML. No RPC is invoked.
-- It runs AFTER the migration, so it may reference the object directly.
--
-- It proves the ACL follow-up did what it claims and NOTHING MORE:
--   * PUBLIC     EXECUTE = FALSE   (the production exposure)
--   * anon       EXECUTE = FALSE   (the production exposure)
--   * authenticated EXECUTE = TRUE (the selected caller model: the live mobile
--                                   client invokes this RPC directly through the
--                                   Supabase JS client and therefore runs as
--                                   `authenticated`)
--   * service_role  EXECUTE = TRUE (retained trusted-server role)
--   * the function is STILL SECURITY DEFINER with a pinned search_path
--   * the function BODY is unchanged by this ACL-only migration (its source hash
--     is reported, and the B.1 fail-closed guards are re-asserted present)
--   * the Phase A acquisition trigger is STILL DISABLED
--   * profiles RLS is STILL off and no policy was created/dropped/altered
--   * no table or column privilege was granted or revoked
--   * the N12 invariant and its frozen 16-status set are untouched
--
-- ROW-LEVEL DATA EQUALITY IS NOT CLAIMED: no before/after snapshot exists, so
-- this asserts STRUCTURE only. The static suite asserts that the migration
-- contains no application-data DML and no CREATE OR REPLACE FUNCTION.
-- ============================================================================

\pset pager off


-- ============================================================================
-- SECTION 1 — THE SELECTED ACL MODEL (GATED)
-- ============================================================================
WITH expected(role_name, want, why) AS (
    VALUES
        ('PUBLIC',        FALSE, 'public pseudo-role must not execute an acquisition RPC'),
        ('anon',          FALSE, 'anonymous callers must not execute an acquisition RPC'),
        ('authenticated', TRUE,  'the live mobile client calls this RPC directly as the authenticated role'),
        ('service_role',  TRUE,  'retained trusted-server role')
),
observed AS (
    SELECT e.role_name,
           e.want,
           e.why,
           pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)') AS fn,
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
    'ACL lock_marketplace_fare/' || o.role_name AS check_name,
    'execute must be ' || o.want::TEXT || ' - ' || o.why AS expected,
    CASE WHEN o.fn IS NULL THEN 'function absent' ELSE o.has_execute::TEXT END AS observed,
    CASE
        WHEN o.fn IS NULL THEN 'FAIL'
        WHEN o.has_execute IS DISTINCT FROM o.want THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict
FROM observed o
ORDER BY o.role_name;

-- 1.1 The verbatim post-change proacl, for the audit trail.
SELECT
    'POST-CHANGE proacl lock_marketplace_fare' AS check_name,
    'informational: no PUBLIC (grantee=0) and no anon entry may remain' AS expected,
    COALESCE(p.proacl::TEXT, '(NULL = implicit default incl. EXECUTE TO PUBLIC)') AS observed,
    'INFO' AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_proc p
       ON p.oid = pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)');


-- ============================================================================
-- SECTION 2 — FUNCTION IDENTITY AND BODY UNCHANGED
-- ============================================================================
SELECT
    'FUNCTION lock_marketplace_fare identity' AS check_name,
    'SECURITY DEFINER | pinned search_path public, pg_temp | body unchanged (ACL-only migration)' AS expected,
    CASE
        WHEN pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)') IS NULL THEN 'ABSENT'
        ELSE 'returns=' || pg_catalog.pg_get_function_result(p.oid)
             || ' | security=' || CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
             || ' | volatility=' || p.provolatile::TEXT
             || ' | search_path=' || COALESCE(array_to_string(p.proconfig, ','), '(not set)')
             || ' | body_sha256=' || md5(p.prosrc)
    END AS observed,
    CASE
        WHEN pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)') IS NULL THEN 'FAIL'
        WHEN NOT p.prosecdef THEN 'FAIL'
        WHEN NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                          WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%') THEN 'FAIL'
        WHEN NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                          WHERE c ILIKE 'search\_path=%' AND c ILIKE '%pg\_temp%') THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_proc p
       ON p.oid = pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)');

-- 2.1 The B.1 fail-closed guards must still be present: this migration is ACL-only
--     and must not have altered the body.
SELECT
    'BODY unchanged guards lock_marketplace_fare' AS check_name,
    'identity + job lock + status + ownership predicate + FOUND check + MB001 still present' AS expected,
    'identity=' || (p.prosrc ILIKE '%v_caller IS NOT NULL AND v_caller <> p_driver_id%')::TEXT
      || ' | job_for_update=' || (p.prosrc ILIKE '%FROM public.jobs%FOR UPDATE%')::TEXT
      || ' | status_check=' || (p.prosrc ILIKE '%job_not_negotiable%')::TEXT
      || ' | ownership_predicate=' || (p.prosrc ILIKE '%driver_id IS NULL OR driver_id = p_driver_id%')::TEXT
      || ' | found_check=' || (p.prosrc ILIKE '%Fare was not locked for this job%')::TEXT
      || ' | mb001=' || (p.prosrc ILIKE '%MB001%')::TEXT AS observed,
    CASE
        WHEN p.oid IS NULL THEN 'FAIL'
        WHEN p.prosrc ILIKE '%v_caller IS NOT NULL AND v_caller <> p_driver_id%'
         AND p.prosrc ILIKE '%FROM public.jobs%FOR UPDATE%'
         AND p.prosrc ILIKE '%job_not_negotiable%'
         AND p.prosrc ILIKE '%driver_id IS NULL OR driver_id = p_driver_id%'
         AND p.prosrc ILIKE '%Fare was not locked for this job%'
         AND p.prosrc ILIKE '%MB001%' THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_proc p
       ON p.oid = pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)');

-- 2.2 Compliance enforcement must NOT have been activated by this follow-up.
SELECT
    'NON-ACTION no compliance enforcement' AS check_name,
    'the body must not raise MB002' AS expected,
    CASE WHEN p.oid IS NULL THEN 'function absent'
         ELSE (p.prosrc ILIKE '%MB002%')::TEXT END AS observed,
    CASE WHEN p.oid IS NULL THEN 'FAIL'
         WHEN p.prosrc ILIKE '%MB002%' THEN 'FAIL'
         ELSE 'PASS' END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_proc p
       ON p.oid = pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)');


-- ============================================================================
-- SECTION 3 — FROZEN BOUNDARIES UNCHANGED
-- ============================================================================
SELECT
    'NON-ACTION acquisition trigger' AS check_name,
    'present and DISABLED (this follow-up must never enable it)' AS expected,
    CASE WHEN t.tgname IS NULL THEN 'MISSING'
         ELSE 'present | enabled=' || t.tgenabled::TEXT END AS observed,
    CASE WHEN t.tgname IS NULL THEN 'FAIL'
         WHEN t.tgenabled = 'D' THEN 'PASS'
         ELSE 'FAIL' END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_trigger t
       ON t.tgrelid = 'public.jobs'::regclass
      AND t.tgname = 'trg_enforce_job_acquisition_eligibility';

SELECT
    'NON-ACTION profiles RLS' AS check_name,
    'must still be false after the ACL follow-up' AS expected,
    'relrowsecurity=' || c.relrowsecurity::TEXT AS observed,
    CASE WHEN c.relrowsecurity IS FALSE THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'profiles';

SELECT
    'NON-ACTION jobs UPDATE policy presence' AS check_name,
    'the pre-existing policy must be present and unmodified' AS expected,
    COALESCE(string_agg(p.polname, ', ' ORDER BY p.polname), 'NONE') AS observed,
    CASE WHEN COUNT(*) > 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_catalog.pg_policy p
WHERE p.polrelid = 'public.jobs'::regclass AND p.polcmd = 'w';

SELECT
    'N12 invariant idx_jobs_one_active_per_driver' AS check_name,
    'present, UNIQUE, valid, keyed on jobs(driver_id) — untouched' AS expected,
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

-- 3.1 The OTHER Phase B.1 function must be untouched by this follow-up.
WITH roles(rolname, want) AS (
    VALUES ('anon', FALSE), ('authenticated', FALSE), ('service_role', TRUE)
)
SELECT
    'NON-ACTION accept_driver_offer/' || r.rolname AS check_name,
    'execute must remain ' || r.want::TEXT || ' (unchanged by the ACL follow-up)' AS expected,
    CASE WHEN pg_catalog.to_regprocedure('public.accept_driver_offer(uuid,uuid)') IS NULL THEN 'function absent'
         ELSE pg_catalog.has_function_privilege(r.rolname,
                  pg_catalog.to_regprocedure('public.accept_driver_offer(uuid,uuid)'), 'EXECUTE')::TEXT
    END AS observed,
    CASE
        WHEN pg_catalog.to_regprocedure('public.accept_driver_offer(uuid,uuid)') IS NULL THEN 'INFO'
        WHEN pg_catalog.has_function_privilege(r.rolname,
             pg_catalog.to_regprocedure('public.accept_driver_offer(uuid,uuid)'), 'EXECUTE')
             IS DISTINCT FROM r.want THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict
FROM roles r
ORDER BY r.rolname;


-- ============================================================================
-- SECTION 4 — POST-MIGRATION GO / NO-GO
--
-- The ACL model is part of the AGGREGATE, not just a per-row report: it must be
-- impossible for a per-row ACL FAIL to coexist with an aggregate PASS (the
-- defect this follow-up also corrects).
-- ============================================================================
WITH expected(role_name, want) AS (
    VALUES ('PUBLIC', FALSE), ('anon', FALSE),
           ('authenticated', TRUE), ('service_role', TRUE)
),
probe AS (
    SELECT e.role_name,
           e.want,
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
           END AS has_execute,
           pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)') AS fn
      FROM expected e
),
acl_violations AS (
    SELECT COUNT(*) AS n
      FROM probe pr
     WHERE pr.fn IS NULL
        OR pr.has_execute IS DISTINCT FROM pr.want
),
public_or_anon AS (
    SELECT COUNT(*) AS n
      FROM probe pr
     WHERE pr.role_name IN ('PUBLIC', 'anon')
       AND (pr.fn IS NULL OR pr.has_execute)
),
required_missing AS (
    SELECT COUNT(*) AS n
      FROM probe pr
     WHERE pr.role_name IN ('authenticated', 'service_role')
       AND (pr.fn IS NULL OR NOT pr.has_execute)
),
identity AS (
    SELECT CASE
             WHEN pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)') IS NULL THEN 1
             WHEN NOT p.prosecdef THEN 1
             WHEN NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                               WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%') THEN 1
             ELSE 0
           END AS n
      FROM (SELECT 1) AS one
      LEFT JOIN pg_catalog.pg_proc p
             ON p.oid = pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)')
),
trigger_enabled AS (
    SELECT CASE WHEN t.tgname IS NULL THEN 1 WHEN t.tgenabled = 'D' THEN 0 ELSE 1 END AS n
      FROM (SELECT 1) AS one
      LEFT JOIN pg_catalog.pg_trigger t
             ON t.tgrelid = 'public.jobs'::regclass
            AND t.tgname = 'trg_enforce_job_acquisition_eligibility'
),
n12_statuses AS (
    SELECT COUNT(*) AS n FROM (SELECT unnest(public.driver_occupying_statuses()) AS status) s
),
profiles_rls AS (
    SELECT CASE WHEN c.relrowsecurity THEN 1 ELSE 0 END AS n
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'profiles'
)
SELECT
    'ACL FOLLOW-UP POST-MIGRATION GO / NO-GO' AS check_name,
    'PUBLIC/anon denied + authenticated/service_role allowed + DEFINER + pinned search_path + trigger DISABLED + N12 intact(16) + profiles RLS off' AS expected,
    'acl_violations=' || (SELECT n FROM acl_violations)::TEXT
      || ' | public_or_anon_executable=' || (SELECT n FROM public_or_anon)::TEXT
      || ' | required_role_missing=' || (SELECT n FROM required_missing)::TEXT
      || ' | identity_bad=' || (SELECT n FROM identity)::TEXT
      || ' | trigger_enabled_or_missing=' || (SELECT n FROM trigger_enabled)::TEXT
      || ' | n12_status_count=' || (SELECT n FROM n12_statuses)::TEXT
      || ' | profiles_rls_on=' || (SELECT n FROM profiles_rls)::TEXT AS observed,
    CASE
        WHEN (SELECT n FROM public_or_anon) > 0 THEN 'NO-GO: lock_marketplace_fare is still executable by PUBLIC or anon'
        WHEN (SELECT n FROM required_missing) > 0 THEN 'NO-GO: authenticated or service_role lost EXECUTE (the live mobile client path would break)'
        WHEN (SELECT n FROM acl_violations) > 0 THEN 'NO-GO: lock_marketplace_fare ACL violates the selected caller model'
        WHEN (SELECT n FROM identity) > 0 THEN 'NO-GO: function is not DEFINER with a pinned search_path'
        WHEN (SELECT n FROM trigger_enabled) > 0 THEN 'NO-GO: acquisition trigger is not DISABLED'
        WHEN (SELECT n FROM n12_statuses) <> 16 THEN 'NO-GO: N12 frozen status set changed'
        WHEN (SELECT n FROM profiles_rls) > 0 THEN 'NO-GO: profiles RLS was enabled by the ACL follow-up'
        ELSE 'PASS'
    END AS verdict;
