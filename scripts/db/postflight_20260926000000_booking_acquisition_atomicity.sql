-- ============================================================================
-- MOVABI — BATCH 2C / PHASE B.1: POSTFLIGHT for
-- supabase/migrations/20260926000000_booking_acquisition_atomicity.sql
--
-- STRICTLY READ ONLY. No DDL. No DML. It invokes NO ownership/acquisition RPC.
-- It runs AFTER the migration, so it may reference the objects directly.
--
-- It proves the migration did what it claims and NOTHING MORE:
--   * both functions exist with a pinned search_path and the intended mode,
--   * accept_driver_offer is service_role-only,
--   * lock_marketplace_fare keeps its PRE-EXISTING ACL (authenticated still
--     executable, anon still not),
--   * the Phase A acquisition trigger is STILL DISABLED,
--   * profiles RLS is STILL off and no policy was created, dropped or altered,
--   * the N12 invariant and its frozen status set are untouched,
--   * no table or column privilege was granted or revoked.
--
-- ROW-LEVEL DATA EQUALITY IS NOT CLAIMED: this script has no before/after
-- snapshot, so it asserts STRUCTURE only. The static suite asserts that the
-- migration contains no application-data DML.
-- ============================================================================

\pset pager off


-- ============================================================================
-- SECTION 1 — THE TWO FUNCTIONS
-- ============================================================================
WITH expected(name, sig, rettype, definer, volatility) AS (
    VALUES
        ('accept_driver_offer',   'public.accept_driver_offer(uuid,uuid)',           'jsonb',  TRUE, 'v'),
        ('lock_marketplace_fare', 'public.lock_marketplace_fare(uuid,uuid,numeric)', 'record', TRUE, 'v')
)
SELECT
    'OBJECT ' || e.name AS check_name,
    'present | returns ' || e.rettype || ' | DEFINER | pinned search_path' AS expected,
    CASE
        WHEN p.oid IS NULL THEN 'MISSING'
        ELSE 'returns=' || pg_catalog.pg_get_function_result(p.oid)
             || ' | security=' || CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
             || ' | volatility=' || p.provolatile::TEXT
             || ' | search_path=' || COALESCE(array_to_string(p.proconfig, ','), '(not set)')
    END AS observed,
    CASE
        WHEN p.oid IS NULL THEN 'FAIL'
        WHEN p.prosecdef IS DISTINCT FROM e.definer THEN 'FAIL'
        WHEN p.provolatile::TEXT IS DISTINCT FROM e.volatility THEN 'FAIL'
        WHEN NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                          WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%') THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict
FROM expected e
LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(e.sig)
ORDER BY e.name;

-- 1.1 accept_driver_offer must be server-only: service_role only.
WITH roles(rolname, expected_execute) AS (
    VALUES ('anon', FALSE), ('authenticated', FALSE), ('service_role', TRUE)
)
SELECT
    'ACL accept_driver_offer/' || r.rolname AS check_name,
    'execute=' || r.expected_execute::TEXT AS expected,
    CASE WHEN pg_catalog.to_regprocedure('public.accept_driver_offer(uuid,uuid)') IS NULL THEN 'function absent'
         ELSE pg_catalog.has_function_privilege(r.rolname,
                  pg_catalog.to_regprocedure('public.accept_driver_offer(uuid,uuid)'), 'EXECUTE')::TEXT
    END AS observed,
    CASE
        WHEN pg_catalog.to_regprocedure('public.accept_driver_offer(uuid,uuid)') IS NULL THEN 'FAIL'
        WHEN pg_catalog.has_function_privilege(r.rolname,
             pg_catalog.to_regprocedure('public.accept_driver_offer(uuid,uuid)'), 'EXECUTE')
             IS DISTINCT FROM r.expected_execute THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict
FROM roles r
ORDER BY r.rolname;

-- 1.2 lock_marketplace_fare ACL — THE SELECTED CALLER MODEL (GATED).
--
-- Caller audit (Batch 2C Phase B/B.1 ACL follow-up): the ONLY legitimate runtime
-- caller is the mobile driver client invoking this RPC directly through the
-- Supabase JS client (src/app/core/services/marketplace/marketplace-hybrid.service.ts
-- -> `this.rpc('lock_marketplace_fare', ...)`), which presents the user's JWT and
-- therefore executes as `authenticated`. There is NO server/API (service_role)
-- caller in the repository.
--
--   PUBLIC        = FALSE   a pseudo-role; no anonymous execution of an
--                           ACQUISITION RPC
--   anon          = FALSE   no anonymous execution of an acquisition RPC
--   authenticated = TRUE    the live mobile client path calls it directly, and
--                           the function derives and validates auth.uid(),
--                           the session's active_driver_id and the job's
--                           ownership/status before it writes
--   service_role  = TRUE    retained trusted-server role
--
-- PUBLIC is tested through aclexplode(grantee = 0): PUBLIC is a pseudo-role, so
-- has_function_privilege cannot probe it, and an ABSENT proacl still means
-- PostgreSQL's implicit EXECUTE TO PUBLIC.
WITH expected(role_name, want, why) AS (
    VALUES
        ('PUBLIC',        FALSE, 'public pseudo-role must not execute an acquisition RPC'),
        ('anon',          FALSE, 'anonymous callers must not execute an acquisition RPC'),
        ('authenticated', TRUE,  'the live mobile client calls this RPC directly'),
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

-- 1.3 The hardened bodies must carry the fail-closed guards.
SELECT
    'BODY guards accept_driver_offer' AS check_name,
    'identity + job lock + ownership predicate + FOUND check + MB001' AS expected,
    'identity=' || (p.prosrc ILIKE '%v_caller IS NOT NULL AND v_caller <> p_driver_id%')::TEXT
      || ' | job_for_update=' || (p.prosrc ILIKE '%FROM public.jobs%FOR UPDATE%')::TEXT
      || ' | ownership_predicate=' || (p.prosrc ILIKE '%driver_id IS NULL OR driver_id = p_driver_id%')::TEXT
      || ' | found_check=' || (p.prosrc ILIKE '%Ownership was not applied%')::TEXT
      || ' | mb001=' || (p.prosrc ILIKE '%MB001%')::TEXT AS observed,
    CASE
        WHEN p.oid IS NULL THEN 'FAIL'
        WHEN p.prosrc ILIKE '%v_caller IS NOT NULL AND v_caller <> p_driver_id%'
         AND p.prosrc ILIKE '%FROM public.jobs%FOR UPDATE%'
         AND p.prosrc ILIKE '%driver_id IS NULL OR driver_id = p_driver_id%'
         AND p.prosrc ILIKE '%Ownership was not applied%'
         AND p.prosrc ILIKE '%MB001%' THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_proc p
       ON p.oid = pg_catalog.to_regprocedure('public.accept_driver_offer(uuid,uuid)');

SELECT
    'BODY guards lock_marketplace_fare' AS check_name,
    'identity + job lock + status + ownership predicate + FOUND check + MB001' AS expected,
    'identity=' || (p.prosrc ILIKE '%v_caller IS NOT NULL AND v_caller <> p_driver_id%')::TEXT
      || ' | job_for_update=' || (p.prosrc ILIKE '%FROM public.jobs%FOR UPDATE%')::TEXT
      || ' | status_check=' || (p.prosrc ILIKE '%job_not_negotiable%')::TEXT
      || ' | ownership_predicate=' || (p.prosrc ILIKE '%driver_id IS NULL OR driver_id = p_driver_id%')::TEXT
      || ' | found_check=' || (p.prosrc ILIKE '%Fare was not locked for this job%')::TEXT
      || ' | mb001=' || (p.prosrc ILIKE '%MB001%')::TEXT AS observed,
    CASE
        WHEN p.oid IS NULL THEN 'FAIL'
        WHEN p.prosrc ILIKE '%job_not_negotiable%'
         AND p.prosrc ILIKE '%Fare was not locked for this job%'
         AND p.prosrc ILIKE '%MB001%' THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_proc p
       ON p.oid = pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)');

-- 1.4 Neither function may raise MB002: compliance enforcement is Phase C.
SELECT
    'NON-ACTION no compliance enforcement in Phase B.1' AS check_name,
    'neither body may raise MB002' AS expected,
    COALESCE(string_agg(DISTINCT p.proname, ', '), 'none') AS observed,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (VALUES
        ('public.accept_driver_offer(uuid,uuid)'),
        ('public.lock_marketplace_fare(uuid,uuid,numeric)')
     ) AS o(sig)
JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(o.sig)
WHERE p.prosrc ILIKE '%MB002%';


-- ============================================================================
-- SECTION 2 — FROZEN BOUNDARIES UNCHANGED
-- ============================================================================
SELECT
    'NON-ACTION acquisition trigger' AS check_name,
    'present and DISABLED (Phase B.1 must never enable it)' AS expected,
    CASE WHEN t.tgname IS NULL THEN 'MISSING'
         ELSE 'present | enabled=' || t.tgenabled::TEXT END AS observed,
    CASE
        WHEN t.tgname IS NULL THEN 'FAIL'
        WHEN t.tgenabled = 'D' THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_catalog.pg_trigger t
       ON t.tgrelid = 'public.jobs'::regclass
      AND t.tgname = 'trg_enforce_job_acquisition_eligibility';

SELECT
    'NON-ACTION profiles RLS' AS check_name,
    'must still be false after Phase B.1' AS expected,
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

WITH expected(name, sig, rettype) AS (
    VALUES
        ('driver_occupying_statuses',   'public.driver_occupying_statuses()',            'text[]'),
        ('driver_has_other_active_job', 'public.driver_has_other_active_job(uuid,uuid)', 'boolean'),
        ('driver_has_active_job',       'public.driver_has_active_job(uuid)',            'boolean')
)
SELECT
    'N12 helper ' || e.name AS check_name,
    'present, returns ' || e.rettype AS expected,
    CASE WHEN p.oid IS NULL THEN 'MISSING'
         ELSE 'returns=' || pg_catalog.pg_get_function_result(p.oid) END AS observed,
    CASE
        WHEN p.oid IS NULL THEN 'FAIL'
        WHEN pg_catalog.pg_get_function_result(p.oid) IS DISTINCT FROM e.rettype THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict
FROM expected e
LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(e.sig)
ORDER BY e.name;

SELECT
    'N12 frozen occupying statuses' AS check_name,
    'exactly 16 approved statuses' AS expected,
    'count=' || COUNT(*)::TEXT AS observed,
    CASE WHEN COUNT(*) = 16 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (SELECT unnest(public.driver_occupying_statuses()) AS status) s;

-- 2.1 The Phase A compliance objects must be untouched by this migration.
SELECT
    'NON-ACTION Phase A compliance objects' AS check_name,
    'all seven still present' AS expected,
    COUNT(*)::TEXT || ' of 7 present' AS observed,
    CASE WHEN COUNT(*) = 7 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (VALUES
        ('public.canonical_driver_service(text)'),
        ('public.job_canonical_service(uuid)'),
        ('public.safe_iso_date(text)'),
        ('public.driver_compliance_rules()'),
        ('public.driver_compliance_rule_passes(text,text,timestamptz)'),
        ('public.driver_service_eligibility(uuid,text,timestamptz)'),
        ('public.enforce_job_acquisition_eligibility()')
     ) AS o(sig)
WHERE pg_catalog.to_regprocedure(o.sig) IS NOT NULL;


-- ============================================================================
-- SECTION 3 — POST-MIGRATION GO / NO-GO
-- ============================================================================
WITH objects(sig, expected_execute_service) AS (
    VALUES
        ('public.accept_driver_offer(uuid,uuid)',           TRUE),
        ('public.lock_marketplace_fare(uuid,uuid,numeric)', TRUE)
),
missing AS (
    SELECT COUNT(*) AS n FROM objects o WHERE pg_catalog.to_regprocedure(o.sig) IS NULL
),
unpinned AS (
    SELECT COUNT(*) AS n
      FROM objects o
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(o.sig)
     WHERE p.oid IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                        WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%')
),
client_executable AS (
    SELECT COUNT(*) AS n
      FROM objects o
     CROSS JOIN (VALUES ('anon'), ('authenticated')) AS ro(rolname)
     WHERE o.sig = 'public.accept_driver_offer(uuid,uuid)'
       AND pg_catalog.to_regprocedure(o.sig) IS NOT NULL
       AND pg_catalog.has_function_privilege(ro.rolname, pg_catalog.to_regprocedure(o.sig), 'EXECUTE')
),
-- ---------------------------------------------------------------------------
-- lock_marketplace_fare ACL enforcement in the AGGREGATE.
--
-- The per-row ACL checks above are only a gate if the FINAL verdict depends on
-- them. This block exists precisely because it did not: production emitted
-- `ACL PRESERVED lock_marketplace_fare/anon = FAIL` while this aggregate still
-- returned PASS, so an anonymous caller could execute an acquisition RPC and
-- nothing failed. Each condition is counted separately so the operator can see
-- WHICH half of the selected model is violated.
-- ---------------------------------------------------------------------------
lock_fare_public AS (
    SELECT COUNT(*) AS n
      FROM pg_catalog.pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)')
       AND a.grantee = 0
       AND a.privilege_type = 'EXECUTE'
),
lock_fare_anon AS (
    SELECT COUNT(*) AS n
      FROM (VALUES ('anon')) AS ro(rolname)
     WHERE pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)') IS NOT NULL
       AND pg_catalog.has_function_privilege(ro.rolname,
             pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)'), 'EXECUTE')
),
lock_fare_required_missing AS (
    SELECT COUNT(*) AS n
      FROM (VALUES ('authenticated'), ('service_role')) AS ro(rolname)
     WHERE pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)') IS NULL
        OR NOT pg_catalog.has_function_privilege(ro.rolname,
                 pg_catalog.to_regprocedure('public.lock_marketplace_fare(uuid,uuid,numeric)'), 'EXECUTE')
),
lock_fare_acl_violations AS (
    SELECT (SELECT n FROM lock_fare_public)
         + (SELECT n FROM lock_fare_anon)
         + (SELECT n FROM lock_fare_required_missing) AS n
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
    'PHASE B.1 POST-MIGRATION GO / NO-GO' AS check_name,
    'both functions present + pinned + accept_driver_offer server-only + lock_marketplace_fare ACL = selected model (PUBLIC/anon denied, authenticated/service_role allowed) + trigger DISABLED + N12 intact + profiles RLS still off' AS expected,
    'missing_objects=' || (SELECT n FROM missing)::TEXT
      || ' | unpinned=' || (SELECT n FROM unpinned)::TEXT
      || ' | accept_driver_offer_client_executable=' || (SELECT n FROM client_executable)::TEXT
      || ' | lock_fare_public_executable=' || (SELECT n FROM lock_fare_public)::TEXT
      || ' | lock_fare_anon_executable=' || (SELECT n FROM lock_fare_anon)::TEXT
      || ' | lock_fare_required_role_missing=' || (SELECT n FROM lock_fare_required_missing)::TEXT
      || ' | trigger_enabled_or_missing=' || (SELECT n FROM trigger_enabled)::TEXT
      || ' | n12_status_count=' || (SELECT n FROM n12_statuses)::TEXT
      || ' | profiles_rls_on=' || (SELECT n FROM profiles_rls)::TEXT AS observed,
    CASE
        WHEN (SELECT n FROM missing) > 0 THEN 'NO-GO: a Phase B.1 function is missing'
        WHEN (SELECT n FROM lock_fare_acl_violations) > 0 THEN 'NO-GO: lock_marketplace_fare ACL violates the selected caller model (PUBLIC/anon must NOT execute; authenticated/service_role MUST)'
        WHEN (SELECT n FROM unpinned) > 0 THEN 'NO-GO: a Phase B.1 function is not pinned to search_path'
        WHEN (SELECT n FROM client_executable) > 0 THEN 'NO-GO: accept_driver_offer is client-executable'
        WHEN (SELECT n FROM trigger_enabled) > 0 THEN 'NO-GO: acquisition trigger is not DISABLED'
        WHEN (SELECT n FROM n12_statuses) <> 16 THEN 'NO-GO: N12 frozen status set changed'
        WHEN (SELECT n FROM profiles_rls) > 0 THEN 'NO-GO: profiles RLS was enabled in Phase B.1'
        ELSE 'PASS'
    END AS verdict;
