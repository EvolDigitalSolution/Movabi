-- ============================================================================
-- MOVABI — POST-MIGRATION VERIFICATION (READ ONLY)
--
-- Run AFTER applying:
--   supabase/migrations/20260921000000_accept_rpc_lifecycle_reconcile.sql
-- and BEFORE restarting the API or accepting driver traffic.
--
-- PURPOSE
--   Prove the migration landed exactly as reviewed, that grants/security are as
--   intended, and that NO existing job row was bulk-converted from 'assigned' to
--   'accepted'.
--
-- SAFETY
--   Strictly READ ONLY: no INSERT / UPDATE / DELETE / ALTER / CREATE / DROP /
--   GRANT / REVOKE / TRUNCATE.
--
--   It deliberately DOES NOT invoke any money-moving RPC
--   (settle_job_wallet_reservation) against real customer jobs, and does not call
--   accept_searching_job / accept_assigned_job (which mutate jobs).
--
--   Data checks are aggregate/count only and expose no personal data.
--
-- READING THE OUTPUT
--   verdict = 'PASS' | 'FAIL' | 'WARN' | 'INFO'. A 'FAIL' means the migration did
--   not land as reviewed — capture this output and diagnose before serving traffic.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — ALL FOUR FUNCTIONS EXIST WITH EXACT SIGNATURES
-- ============================================================================

SELECT
    'EXISTS ' || f.fname AS check_name,
    f.expected_signature AS expected,
    COALESCE(pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid), 'MISSING') AS observed,
    CASE WHEN p.oid IS NULL THEN 'FAIL' ELSE 'PASS' END AS verdict
FROM (VALUES
        ('driver_vehicle_can_accept_job', 'p_job_id uuid, p_driver_id uuid -> boolean'),
        ('accept_searching_job',          'p_job_id uuid, p_driver_id uuid -> boolean'),
        ('assign_driver_to_job',          'p_job_id uuid, p_driver_id uuid -> boolean'),
        ('accept_assigned_job',           'p_job_id uuid, p_driver_id uuid -> boolean'),
        ('settle_job_wallet_reservation', 'p_job_id uuid, p_amount numeric -> jsonb')
     ) AS f(fname, expected_signature)
LEFT JOIN pg_proc p
       ON p.proname = f.fname
      AND p.pronamespace = 'public'::regnamespace
ORDER BY verdict DESC, check_name;

-- Return types are the critical assertion: accept_searching_job was
-- public.jobs in production and MUST now be boolean, otherwise the client's
-- `accepted !== true` check rejects every successful accept.
SELECT
    'RETURN TYPE ' || f.fname AS check_name,
    f.expected_return AS expected,
    COALESCE(pg_get_function_result(p.oid), 'MISSING') AS observed,
    CASE
        WHEN p.oid IS NULL THEN 'FAIL'
        WHEN pg_get_function_result(p.oid) = f.expected_return THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM (VALUES
        ('driver_vehicle_can_accept_job', 'boolean'),
        ('accept_searching_job',          'boolean'),
        ('assign_driver_to_job',          'boolean'),
        ('accept_assigned_job',           'boolean'),
        ('settle_job_wallet_reservation', 'jsonb')
     ) AS f(fname, expected_return)
LEFT JOIN pg_proc p
       ON p.proname = f.fname
      AND p.pronamespace = 'public'::regnamespace
ORDER BY verdict DESC, check_name;

-- Wrong-arity variants would shadow or confuse PostgREST resolution.
SELECT
    'ARITY ' || p.proname AS check_name,
    'exactly one overload with the reviewed argument list' AS expected,
    COUNT(*)::TEXT || ' overload(s): ' ||
      string_agg(pg_get_function_identity_arguments(p.oid), ' ; ') AS observed,
    CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('driver_vehicle_can_accept_job', 'accept_searching_job',
                    'assign_driver_to_job', 'accept_assigned_job',
                    'settle_job_wallet_reservation')
GROUP BY p.proname
ORDER BY check_name;


-- ============================================================================
-- SECTION 2 — SECURITY DEFINER / INVOKER + PINNED search_path
-- ============================================================================

SELECT
    'SECURITY MODE ' || p.proname AS check_name,
    CASE
        WHEN p.proname IN ('accept_searching_job', 'accept_assigned_job', 'settle_job_wallet_reservation')
         THEN 'SECURITY DEFINER (required: bypasses RLS to write jobs / wallets)'
        WHEN p.proname = 'driver_vehicle_can_accept_job'
         THEN 'SECURITY INVOKER (required: read-only predicate, no elevated rights)'
        ELSE 'SECURITY INVOKER (required: admin/dispatch path keeps caller rights)'
    END AS expected,
    CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END AS observed,
    CASE
        WHEN p.proname IN ('accept_searching_job', 'accept_assigned_job', 'settle_job_wallet_reservation')
             AND p.prosecdef THEN 'PASS'
        WHEN p.proname IN ('assign_driver_to_job', 'driver_vehicle_can_accept_job')
             AND NOT p.prosecdef THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('driver_vehicle_can_accept_job', 'accept_searching_job',
                    'assign_driver_to_job', 'accept_assigned_job',
                    'settle_job_wallet_reservation')
ORDER BY p.proname;

SELECT
    'SEARCH_PATH ' || p.proname AS check_name,
    'accept_searching_job / accept_assigned_job / settle_job_wallet_reservation / helper must pin public, pg_temp' AS expected,
    COALESCE(array_to_string(p.proconfig, ','), '(not set)') AS observed,
    CASE
        WHEN p.proname IN ('accept_searching_job', 'accept_assigned_job',
                           'settle_job_wallet_reservation', 'driver_vehicle_can_accept_job')
             AND EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
                          WHERE c ILIKE 'search\_path=%' AND c ILIKE '%public%')
             THEN 'PASS'
        WHEN p.proname = 'assign_driver_to_job' THEN 'PASS' -- invoker rights, caller search_path
        ELSE 'FAIL'
    END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('driver_vehicle_can_accept_job', 'accept_searching_job',
                    'assign_driver_to_job', 'accept_assigned_job',
                    'settle_job_wallet_reservation')
ORDER BY p.proname;


-- ============================================================================
-- SECTION 3 — OWNER + ACL / GRANTS
-- ============================================================================

SELECT
    'OWNER ' || p.proname AS check_name,
    'owner is the migration role (informational)' AS expected,
    pg_get_userbyid(p.proowner) AS observed,
    'INFO' AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('driver_vehicle_can_accept_job', 'accept_searching_job',
                    'assign_driver_to_job', 'accept_assigned_job',
                    'settle_job_wallet_reservation')
ORDER BY p.proname;

-- Raw ACL. This is a FORMATTING-LEVEL diagnostic only: it shows what is written
-- in proacl. It deliberately does NOT decide the verdict, because effective
-- privileges also depend on role inheritance and default ACLs that proacl text
-- cannot express. The authoritative test is the effective-privilege matrix below.
--
-- PUBLIC detection: in proacl text a grant to the PUBLIC pseudo-role is rendered
-- with an empty grantee before the "=" (e.g. "=X/owner"). A NULL proacl means the
-- function still carries the built-in default ACL, where PUBLIC holds EXECUTE.
SELECT
    'ACL ' || p.proname AS check_name,
    'informational: proacl text; the effective-privilege matrix below is authoritative' AS expected,
    COALESCE(array_to_string(p.proacl, ' | '),
             '(NULL: default ACL - PUBLIC has EXECUTE)') AS observed,
    'INFO' AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('driver_vehicle_can_accept_job', 'accept_searching_job',
                    'assign_driver_to_job', 'accept_assigned_job',
                    'settle_job_wallet_reservation')
ORDER BY p.proname;

-- Any surviving PUBLIC EXECUTE is a hard security regression.
SELECT
    'PUBLIC EXECUTE absent on ' || p.proname AS check_name,
    'no PUBLIC grant (proacl must not contain a bare =X/ entry)' AS expected,
    CASE
        WHEN p.proacl IS NULL THEN 'NULL proacl - default ACL still grants EXECUTE to PUBLIC'
        WHEN EXISTS (SELECT 1 FROM unnest(p.proacl) a WHERE a::TEXT LIKE '=%') THEN 'PUBLIC EXECUTE present'
        ELSE 'no PUBLIC entry'
    END AS observed,
    CASE
        WHEN p.proacl IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM unnest(p.proacl) a WHERE a::TEXT LIKE '=%')
        THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('driver_vehicle_can_accept_job', 'accept_searching_job',
                    'assign_driver_to_job', 'accept_assigned_job',
                    'settle_job_wallet_reservation')
ORDER BY p.proname;

-- ============================================================================
-- EFFECTIVE-PRIVILEGE MATRIX — the authoritative ACL gate.
--
-- This is the COMPLETE 5 functions x 4 roles matrix, so a policy cell cannot be
-- silently omitted (the previous version listed only 13 hand-picked cells and
-- omitted, for example, every service_role/helper and anon/assign cell).
--
-- has_function_privilege(role, fnoid, 'EXECUTE') is authoritative: it reports the
-- EFFECTIVE privilege for that role, accounting for direct grants, role
-- inheritance and PUBLIC-derived grants. The verdict is therefore derived from it
-- rather than from parsing proacl text.
--
-- EXECUTE policy:
--   driver_vehicle_can_accept_job : nobody (internal; invoked from SECURITY DEFINER callers)
--   accept_searching_job          : authenticated + service_role
--   assign_driver_to_job          : authenticated + service_role
--   accept_assigned_job           : authenticated only
--   settle_job_wallet_reservation : service_role only (moves money)
-- ============================================================================
SELECT
    'PRIVILEGE ' || m.fname || ' -> ' || m.rolname AS check_name,
    CASE WHEN m.can_execute THEN 'EXECUTE expected' ELSE 'EXECUTE must NOT be granted' END AS expected,
    CASE WHEN has_function_privilege(m.rolname, m.fn_oid, 'EXECUTE')
         THEN 'EXECUTE granted' ELSE 'EXECUTE NOT granted' END AS observed,
    CASE
        WHEN has_function_privilege(m.rolname, m.fn_oid, 'EXECUTE') = m.can_execute
        THEN 'PASS' ELSE 'FAIL'
    END AS verdict
FROM (
    SELECT policy.fname, policy.rolname, policy.can_execute,
           CASE WHEN policy.rolname = 'PUBLIC'
                THEN NULL
                ELSE to_regprocedure(policy.signature) END AS fn_oid
    FROM (VALUES
            -- driver_vehicle_can_accept_job: internal predicate, no role access
            ('driver_vehicle_can_accept_job', 'anon',          false),
            ('driver_vehicle_can_accept_job', 'authenticated', false),
            ('driver_vehicle_can_accept_job', 'service_role',  false),

            -- accept_searching_job: driver self-accept from browser + server
            ('accept_searching_job',          'anon',          false),
            ('accept_searching_job',          'authenticated', true),
            ('accept_searching_job',          'service_role',  true),

            -- assign_driver_to_job: admin/dispatch assignment
            ('assign_driver_to_job',          'anon',          false),
            ('assign_driver_to_job',          'authenticated', true),
            ('assign_driver_to_job',          'service_role',  true),

            -- accept_assigned_job: assigned-driver confirmation only
            ('accept_assigned_job',           'anon',          false),
            ('accept_assigned_job',           'authenticated', true),
            ('accept_assigned_job',           'service_role',  false),

            -- settle_job_wallet_reservation: server-side only, moves money
            ('settle_job_wallet_reservation', 'anon',          false),
            ('settle_job_wallet_reservation', 'authenticated', false),
            ('settle_job_wallet_reservation', 'service_role',  true)
         ) AS policy(fname, rolname, can_execute)
    JOIN (VALUES
            ('driver_vehicle_can_accept_job', 'public.driver_vehicle_can_accept_job(uuid,uuid)'),
            ('accept_searching_job',          'public.accept_searching_job(uuid,uuid)'),
            ('assign_driver_to_job',          'public.assign_driver_to_job(uuid,uuid)'),
            ('accept_assigned_job',           'public.accept_assigned_job(uuid,uuid)'),
            ('settle_job_wallet_reservation', 'public.settle_job_wallet_reservation(uuid,numeric)')
         ) AS sig(fname, signature) ON sig.fname = policy.fname
) m
WHERE m.fn_oid IS NOT NULL
ORDER BY verdict DESC, m.fname, m.rolname;


-- ============================================================================
-- SECTION 4 — DEFINITIONS CONTAIN THE REVIEWED BEHAVIOUR
-- ============================================================================

SELECT
    'DEF accept_searching_job' AS check_name,
    'atomic claim: driver_id IS NULL + accepted_driver_id IS NULL + status gate' AS expected,
    'driver_id IS NULL=' || (pg_get_functiondef(p.oid) ILIKE '%driver_id IS NULL%')::TEXT
      || ' accepted_driver_id IS NULL=' || (pg_get_functiondef(p.oid) ILIKE '%accepted_driver_id IS NULL%')::TEXT
      || ' broadcasting=' || (pg_get_functiondef(p.oid) ILIKE '%broadcasting%')::TEXT
      || ' waiting=' || (pg_get_functiondef(p.oid) ILIKE '%waiting%')::TEXT
      || ' auth_uid_guard=' || (pg_get_functiondef(p.oid) ILIKE '%auth.uid()%')::TEXT
    AS observed,
    CASE
        WHEN pg_get_functiondef(p.oid) ILIKE '%driver_id IS NULL%'
         AND pg_get_functiondef(p.oid) ILIKE '%accepted_driver_id IS NULL%'
         AND pg_get_functiondef(p.oid) ILIKE '%broadcasting%'
         AND pg_get_functiondef(p.oid) ILIKE '%waiting%'
         AND pg_get_functiondef(p.oid) ILIKE '%auth.uid()%'
        THEN 'PASS' ELSE 'FAIL'
    END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_searching_job';

SELECT
    'DEF assign_driver_to_job' AS check_name,
    'MUST still write assigned and MUST NOT write accepted_driver_id' AS expected,
    'writes assigned=' || (pg_get_functiondef(p.oid) ILIKE '%''assigned''%')::TEXT
      || ' touches accepted_driver_id=' || (pg_get_functiondef(p.oid) ILIKE '%accepted_driver_id%')::TEXT
      || ' touches accepted_at=' || (pg_get_functiondef(p.oid) ILIKE '%accepted_at%')::TEXT
    AS observed,
    CASE
        WHEN pg_get_functiondef(p.oid) ILIKE '%''assigned''%'
         AND pg_get_functiondef(p.oid) NOT ILIKE '%accepted_driver_id%'
         AND pg_get_functiondef(p.oid) NOT ILIKE '%accepted_at%'
        THEN 'PASS' ELSE 'FAIL'
    END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'assign_driver_to_job';

SELECT
    'DEF accept_assigned_job' AS check_name,
    'only the stored driver may confirm: status=assigned + driver_id=auth.uid() + accepted_driver_id IS NULL' AS expected,
    'status assigned=' || (pg_get_functiondef(p.oid) ILIKE '%''assigned''%')::TEXT
      || ' driver_is_caller=' || (pg_get_functiondef(p.oid) ILIKE '%driver_id = v_caller%')::TEXT
      || ' accepted_driver_id IS NULL=' || (pg_get_functiondef(p.oid) ILIKE '%accepted_driver_id IS NULL%')::TEXT
      || ' sets accepted=' || (pg_get_functiondef(p.oid) ILIKE '%''accepted''%')::TEXT
    AS observed,
    CASE
        WHEN pg_get_functiondef(p.oid) ILIKE '%''assigned''%'
         AND pg_get_functiondef(p.oid) ILIKE '%driver_id = v_caller%'
         AND pg_get_functiondef(p.oid) ILIKE '%accepted_driver_id IS NULL%'
         AND pg_get_functiondef(p.oid) ILIKE '%''accepted''%'
        THEN 'PASS' ELSE 'FAIL'
    END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_assigned_job';

SELECT
    'DEF settle_job_wallet_reservation' AS check_name,
    'locks jobs+wallets+errand_funding FOR UPDATE; already_settled early return; marker write' AS expected,
    'FOR UPDATE=' || (pg_get_functiondef(p.oid) ILIKE '%FOR UPDATE%')::TEXT
      || ' already_settled=' || (pg_get_functiondef(p.oid) ILIKE '%already_settled%')::TEXT
      || ' errand_funding marker=' || (pg_get_functiondef(p.oid) ILIKE '%errand_funding%')::TEXT
      || ' wallets update=' || (pg_get_functiondef(p.oid) ILIKE '%UPDATE public.wallets%')::TEXT
      || ' wallet_transactions insert=' || (pg_get_functiondef(p.oid) ILIKE '%wallet_transactions%')::TEXT
    AS observed,
    CASE
        WHEN pg_get_functiondef(p.oid) ILIKE '%FOR UPDATE%'
         AND pg_get_functiondef(p.oid) ILIKE '%already_settled%'
         AND pg_get_functiondef(p.oid) ILIKE '%errand_funding%'
         AND pg_get_functiondef(p.oid) ILIKE '%wallet_transactions%'
        THEN 'PASS' ELSE 'FAIL'
    END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'settle_job_wallet_reservation';

-- The helper must be present BEFORE any accept call, schema-qualified, and must
-- fail closed (missing job / missing vehicle -> FALSE).
SELECT
    'DEF driver_vehicle_can_accept_job' AS check_name,
    'schema-qualified reads; NULL-safe; missing job/vehicle -> FALSE; no service_class column use' AS expected,
    'reads public.jobs=' || (pg_get_functiondef(p.oid) ILIKE '%public.jobs%')::TEXT
      || ' reads public.service_types=' || (pg_get_functiondef(p.oid) ILIKE '%public.service_types%')::TEXT
      || ' reads public.vehicles=' || (pg_get_functiondef(p.oid) ILIKE '%public.vehicles%')::TEXT
      || ' jsonb service_class=' || (pg_get_functiondef(p.oid) ILIKE '%service_class%')::TEXT
      || ' returns_false=' || (pg_get_functiondef(p.oid) ILIKE '%RETURN FALSE%')::TEXT
      || ' not_definer=' || (NOT p.prosecdef)::TEXT
    AS observed,
    CASE
        WHEN pg_get_functiondef(p.oid) ILIKE '%public.jobs%'
         AND pg_get_functiondef(p.oid) ILIKE '%public.service_types%'
         AND pg_get_functiondef(p.oid) ILIKE '%public.vehicles%'
         AND pg_get_functiondef(p.oid) ILIKE '%RETURN FALSE%'
         AND NOT p.prosecdef
        THEN 'PASS' ELSE 'FAIL'
    END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'driver_vehicle_can_accept_job';

-- The settlement body must populate the four audit columns on both ledger events
-- and must no longer use runtime column probing / dynamic SQL.
SELECT
    'DEF settle ledger audit columns' AS check_name,
    'balance_before/after_available/reserved populated; no EXECUTE format probing' AS expected,
    'balance_before_available=' || (pg_get_functiondef(p.oid) ILIKE '%balance_before_available%')::TEXT
      || ' balance_after_available=' || (pg_get_functiondef(p.oid) ILIKE '%balance_after_available%')::TEXT
      || ' balance_before_reserved=' || (pg_get_functiondef(p.oid) ILIKE '%balance_before_reserved%')::TEXT
      || ' balance_after_reserved=' || (pg_get_functiondef(p.oid) ILIKE '%balance_after_reserved%')::TEXT
      || ' transaction_type=' || (pg_get_functiondef(p.oid) ILIKE '%transaction_type%')::TEXT
      || ' dynamic_sql_probing=' || (pg_get_functiondef(p.oid) ILIKE '%EXECUTE format%')::TEXT
    AS observed,
    CASE
        WHEN pg_get_functiondef(p.oid) ILIKE '%balance_before_available%'
         AND pg_get_functiondef(p.oid) ILIKE '%balance_after_available%'
         AND pg_get_functiondef(p.oid) ILIKE '%balance_before_reserved%'
         AND pg_get_functiondef(p.oid) ILIKE '%balance_after_reserved%'
         AND pg_get_functiondef(p.oid) ILIKE '%transaction_type%'
         AND pg_get_functiondef(p.oid) NOT ILIKE '%EXECUTE format%'
         -- release row must NOT reuse the settlement snapshot for available
         AND pg_get_functiondef(p.oid) ILIKE '%v_available_after_settlement%'
        THEN 'PASS' ELSE 'FAIL'
    END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'settle_job_wallet_reservation';


-- ============================================================================
-- SECTION 5 — NO BULK DATA CONVERSION (the migration must not have rewritten rows)
-- ============================================================================

-- The forbidden legacy rewrite would have converted assigned -> accepted and
-- back-filled accepted_at. Any 'assigned' row carrying an accepted_at is the
-- signature of that rewrite, or of a pre-existing inconsistent row.
SELECT
    'NO-BULK assigned rows WITH accepted_at' AS check_name,
    'must be 0: the migration performs no data migration' AS expected,
    COUNT(*)::TEXT AS observed,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM public.jobs
WHERE status = 'assigned' AND accepted_at IS NOT NULL;

SELECT
    'NO-BULK assigned rows WITH accepted_driver_id' AS check_name,
    'must be 0: assign_driver_to_job never sets accepted_driver_id' AS expected,
    COUNT(*)::TEXT AS observed,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'WARN' END AS verdict
FROM public.jobs
WHERE status = 'assigned' AND accepted_driver_id IS NOT NULL;

-- updated_at should not have been mass-touched by a data migration. If a very
-- large share of assigned rows changed in the last minutes, investigate.
SELECT
    'NO-BULK assigned rows updated in last 15 minutes' AS check_name,
    'a bulk rewrite would show a spike here' AS expected,
    COUNT(*)::TEXT AS observed,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'WARN' END AS verdict
FROM public.jobs
WHERE status = 'assigned' AND updated_at > NOW() - INTERVAL '15 minutes';

-- Current population snapshot, for comparison against the preflight numbers.
SELECT 'SNAPSHOT jobs by status' AS check_name, status AS expected, COUNT(*)::TEXT AS observed, 'INFO' AS verdict
FROM public.jobs
GROUP BY status
ORDER BY status;


-- ============================================================================
-- SECTION 6 — POST-MIGRATION GO / NO-GO
-- ============================================================================

WITH acl_policy(fname, signature, rolname, can_execute) AS (
    VALUES
        -- driver_vehicle_can_accept_job: internal predicate, no role access
        ('driver_vehicle_can_accept_job', 'public.driver_vehicle_can_accept_job(uuid,uuid)', 'anon',          false),
        ('driver_vehicle_can_accept_job', 'public.driver_vehicle_can_accept_job(uuid,uuid)', 'authenticated', false),
        ('driver_vehicle_can_accept_job', 'public.driver_vehicle_can_accept_job(uuid,uuid)', 'service_role',  false),
        -- accept_searching_job: driver self-accept (browser) + server
        ('accept_searching_job',          'public.accept_searching_job(uuid,uuid)',          'anon',          false),
        ('accept_searching_job',          'public.accept_searching_job(uuid,uuid)',          'authenticated', true),
        ('accept_searching_job',          'public.accept_searching_job(uuid,uuid)',          'service_role',  true),
        -- assign_driver_to_job: admin/dispatch assignment
        ('assign_driver_to_job',          'public.assign_driver_to_job(uuid,uuid)',          'anon',          false),
        ('assign_driver_to_job',          'public.assign_driver_to_job(uuid,uuid)',          'authenticated', true),
        ('assign_driver_to_job',          'public.assign_driver_to_job(uuid,uuid)',          'service_role',  true),
        -- accept_assigned_job: assigned-driver confirmation only
        ('accept_assigned_job',           'public.accept_assigned_job(uuid,uuid)',           'anon',          false),
        ('accept_assigned_job',           'public.accept_assigned_job(uuid,uuid)',           'authenticated', true),
        ('accept_assigned_job',           'public.accept_assigned_job(uuid,uuid)',           'service_role',  false),
        -- settle_job_wallet_reservation: service_role only (moves money)
        ('settle_job_wallet_reservation', 'public.settle_job_wallet_reservation(uuid,numeric)', 'anon',          false),
        ('settle_job_wallet_reservation', 'public.settle_job_wallet_reservation(uuid,numeric)', 'authenticated', false),
        ('settle_job_wallet_reservation', 'public.settle_job_wallet_reservation(uuid,numeric)', 'service_role',  true)
),
acl_violations AS (
    -- Effective-privilege violations across the WHOLE matrix. Derived from
    -- has_function_privilege so role inheritance and default ACLs are accounted
    -- for, and complete so no policy cell can be forgotten the way the previous
    -- hand-written helper/settlement checks could.
    SELECT pol.fname, pol.rolname, pol.can_execute
      FROM acl_policy pol
     WHERE to_regprocedure(pol.signature) IS NOT NULL
       AND has_function_privilege(pol.rolname, to_regprocedure(pol.signature), 'EXECUTE') <> pol.can_execute
),
public_grants AS (
    -- A surviving PUBLIC entry in proacl is a regression regardless of the matrix.
    SELECT p.proname AS fname
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('driver_vehicle_can_accept_job', 'accept_searching_job',
                         'assign_driver_to_job', 'accept_assigned_job',
                         'settle_job_wallet_reservation')
       AND (p.proacl IS NULL
            OR EXISTS (SELECT 1 FROM unnest(p.proacl) a WHERE a::TEXT LIKE '=%'))
),
functions_present AS (
    SELECT COUNT(*) AS n
      FROM (VALUES
            ('driver_vehicle_can_accept_job'),('accept_searching_job'),
            ('assign_driver_to_job'),('accept_assigned_job'),
            ('settle_job_wallet_reservation')
           ) AS f(n)
     WHERE EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.pronamespace='public'::regnamespace AND p.proname = f.n)
)
SELECT
    'POST-MIGRATION GO / NO-GO' AS check_name,
    'all five functions present with correct return types, ACL matrix satisfied, no bulk rewrite' AS expected,
    'functions_present=' || (SELECT n FROM functions_present)::TEXT || '/5'
      || ' | accept_searching_job_rettype='
      || COALESCE((SELECT pg_get_function_result(p.oid) FROM pg_proc p
                    WHERE p.pronamespace='public'::regnamespace AND p.proname='accept_searching_job'), 'MISSING')
      || ' | helper_rettype='
      || COALESCE((SELECT pg_get_function_result(p.oid) FROM pg_proc p
                    WHERE p.pronamespace='public'::regnamespace AND p.proname='driver_vehicle_can_accept_job'), 'MISSING')
      || ' | acl_policy_violations='
      || (SELECT COUNT(*) FROM acl_violations)::TEXT
      || ' | acl_violations='
      || COALESCE((SELECT string_agg(v.fname || '->' || v.rolname, ', ' ORDER BY v.fname, v.rolname)
                     FROM acl_violations v), 'none')
      || ' | public_execute_regressions='
      || COALESCE((SELECT string_agg(g.fname, ', ' ORDER BY g.fname) FROM public_grants g), 'none')
      || ' | assigned_with_accepted_at='
      || (SELECT COUNT(*)::TEXT FROM public.jobs WHERE status='assigned' AND accepted_at IS NOT NULL)
    AS observed,
    CASE
        WHEN (SELECT n FROM functions_present) <> 5 THEN 'NO-GO'
        -- return types: the client contract depends on these
        WHEN COALESCE((SELECT pg_get_function_result(p.oid) FROM pg_proc p
                        WHERE p.pronamespace='public'::regnamespace AND p.proname='accept_searching_job'), '') <> 'boolean'
            THEN 'NO-GO'
        WHEN COALESCE((SELECT pg_get_function_result(p.oid) FROM pg_proc p
                        WHERE p.pronamespace='public'::regnamespace AND p.proname='driver_vehicle_can_accept_job'), '') <> 'boolean'
            THEN 'NO-GO'
        -- AUTHORITATIVE ACL GATE: any effective-privilege deviation, or any
        -- surviving PUBLIC grant, forces NO-GO.
        WHEN (SELECT COUNT(*) FROM acl_violations) > 0 THEN 'NO-GO'
        WHEN (SELECT COUNT(*) FROM public_grants) > 0 THEN 'NO-GO'
        WHEN (SELECT COUNT(*) FROM public.jobs WHERE status='assigned' AND accepted_at IS NOT NULL) > 0
            THEN 'NO-GO'
        ELSE 'PASS'
    END AS verdict;
