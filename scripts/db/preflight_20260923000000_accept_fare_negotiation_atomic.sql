-- ============================================================================
-- MOVABI — PREFLIGHT for 20260923000000_accept_fare_negotiation_atomic.sql
--
-- Run BEFORE applying the migration. STRICTLY READ ONLY: no INSERT / UPDATE /
-- DELETE / ALTER / CREATE / DROP / GRANT / REVOKE / TRUNCATE, and no invocation
-- of any state-changing function.
--
-- Verify the migration's preconditions and surface anything that would make it
-- unsafe or ineffective. Final GO/NO-GO is the last row.
-- ============================================================================

\pset pager off

-- ============================================================================
-- SECTION 1 — OBJECT / COLUMN CONTRACTS
-- ============================================================================

WITH required_columns(obj, col, why) AS (
    VALUES
        ('jobs', 'id',                       'lock target / UPDATE target'),
        ('jobs', 'status',                   'guarded by status predicate'),
        ('jobs', 'driver_id',                'ownership guard + write'),
        ('jobs', 'negotiation_mode_enabled', 'guarded: must be true'),
        ('jobs', 'negotiated_fare',          'written on accept'),
        ('jobs', 'agreed_fare',              'written on accept'),
        ('jobs', 'updated_at',               'written on accept'),
        ('fare_negotiations', 'id',                 'row lock + UPDATE target'),
        ('fare_negotiations', 'job_id',             'selection predicate'),
        ('fare_negotiations', 'proposed_by_role',   'must equal customer'),
        ('fare_negotiations', 'status',             'must equal pending'),
        ('fare_negotiations', 'amount',             'agreed fare source'),
        ('fare_negotiations', 'created_at',         'deterministic ORDER BY'),
        ('fare_negotiations', 'updated_at',         'written on accept')
)
SELECT
    'COLUMN ' || r.obj || '.' || r.col AS check_name,
    'column exists' AS expected,
    CASE WHEN c.column_name IS NULL THEN 'MISSING' ELSE c.data_type END AS observed,
    CASE WHEN c.column_name IS NULL THEN 'FAIL' ELSE 'PASS' END AS verdict
FROM required_columns r
LEFT JOIN information_schema.columns c
       ON c.table_schema = 'public' AND c.table_name = r.obj AND c.column_name = r.col
ORDER BY verdict DESC, check_name;

-- The pricing columns the ROUTE's post-RPC PricingService.applyAgreedFare write
-- targets. The RPC does not touch these, but the route does, so a missing column
-- here means the pricing refresh fails (it is non-fatal by design, but the
-- operator should know before deploying).
--
-- These are OPTIONAL / PRICING-REFRESH columns only. They are reported as WARN
-- and can never block this migration: the RPC's own REQUIRED columns are gated
-- in SECTION 1 above, and nothing here is read or written by the RPC.
--
-- The three booking-time concepts app_confirmed_price, frontend_total_price and
-- regional_price are deliberately NOT listed: they are jobs.metadata keys, not
-- jobs columns, and PricingService.applyAgreedFare was corrected to stop
-- emitting them as top-level persistence fields.
WITH pricing_columns(col) AS (
    VALUES ('price'), ('total_price'), ('estimated_price'), ('platform_fee'),
           ('driver_payout'), ('tax_amount'), ('base_fare_used'),
           ('price_per_km_used'), ('commission_rate_used'), ('fare_breakdown')
)
SELECT
    'PRICING COLUMN jobs.' || p.col AS check_name,
    'used by PricingService.applyAgreedFare output' AS expected,
    CASE WHEN c.column_name IS NULL THEN 'MISSING (pricing refresh will fail)' ELSE c.data_type END AS observed,
    -- WARN not FAIL: pre-existing condition, not introduced by this migration.
    CASE WHEN c.column_name IS NULL THEN 'WARN' ELSE 'PASS' END AS verdict
FROM pricing_columns p
LEFT JOIN information_schema.columns c
       ON c.table_schema = 'public' AND c.table_name = 'jobs' AND c.column_name = p.col
ORDER BY verdict DESC, check_name;

-- ============================================================================
-- SECTION 2 — STATUS VOCABULARY
-- ============================================================================

SELECT
    'CONSTRAINT fare_negotiations.status' AS check_name,
    'must permit pending + accepted' AS expected,
    COALESCE(
        (SELECT string_agg(pg_catalog.pg_get_constraintdef(con.oid), ' | ' ORDER BY con.oid)
           FROM pg_constraint con
          WHERE con.conrelid = 'public.fare_negotiations'::regclass
            AND con.contype = 'c'
            AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE '%status%'),
        'NO CHECK CONSTRAINT ON status') AS observed,
    CASE
        WHEN NOT EXISTS (
            SELECT 1 FROM pg_constraint con
             WHERE con.conrelid = 'public.fare_negotiations'::regclass
               AND con.contype = 'c'
               AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE '%status%')
        THEN 'PASS'
        WHEN EXISTS (
            SELECT 1 FROM pg_constraint con
             WHERE con.conrelid = 'public.fare_negotiations'::regclass
               AND con.contype = 'c'
               AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE '%pending%'
               AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE '%accepted%')
        THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict;

SELECT
    'CONSTRAINT fare_negotiations.proposed_by_role' AS check_name,
    'must permit customer' AS expected,
    COALESCE(
        (SELECT string_agg(pg_catalog.pg_get_constraintdef(con.oid), ' | ' ORDER BY con.oid)
           FROM pg_constraint con
          WHERE con.conrelid = 'public.fare_negotiations'::regclass
            AND con.contype = 'c'
            AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE '%proposed_by_role%'),
        'NO CHECK CONSTRAINT ON proposed_by_role') AS observed,
    CASE
        WHEN NOT EXISTS (
            SELECT 1 FROM pg_constraint con
             WHERE con.conrelid = 'public.fare_negotiations'::regclass
               AND con.contype = 'c'
               AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE '%proposed_by_role%')
        THEN 'PASS'
        WHEN EXISTS (
            SELECT 1 FROM pg_constraint con
             WHERE con.conrelid = 'public.fare_negotiations'::regclass
               AND con.contype = 'c'
               AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE '%customer%')
        THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict;

-- The two job statuses the RPC accepts, and the one it writes.
--
-- regexp_matches(text, pattern, flags) is a SET-RETURNING function that exposes
-- exactly ONE output column, of type text[] - one row per match, one array
-- element per capture group. The LATERAL alias below is therefore declared as
-- m(match), and the captured literal is addressed as m.match[1]. There is no
-- column called `literal` on m; the CTE must PROJECT the capture group and name
-- it `literal`, because the outer query reads a.literal / v.literal.
WITH allowed_literals AS (
    SELECT DISTINCT m.match[1] AS literal
      FROM (SELECT pg_get_expr(con.conbin, con.conrelid) AS expr
              FROM pg_constraint con
             WHERE con.conrelid = 'public.jobs'::regclass
               AND con.contype = 'c'
               AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE '%status%') jsc
      CROSS JOIN LATERAL regexp_matches(jsc.expr, '''([^'']*)''', 'g') AS m(match)
)
SELECT
    'jobs.status permits ' || v.literal AS check_name,
    'required by accept_fare_negotiation' AS expected,
    CASE WHEN EXISTS (SELECT 1 FROM allowed_literals a WHERE a.literal = v.literal)
         THEN 'permitted' ELSE 'NOT PERMITTED' END AS observed,
    CASE WHEN EXISTS (SELECT 1 FROM allowed_literals a WHERE a.literal = v.literal)
         THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (VALUES ('pending_fare_confirmation'), ('negotiating'), ('fare_agreed')) AS v(literal)
ORDER BY verdict DESC, check_name;

-- ============================================================================
-- SECTION 3 — FUNCTION CONFLICTS / REPLACE SAFETY
-- ============================================================================

SELECT
    'EXISTING FUNCTION accept_fare_negotiation(uuid,uuid)' AS check_name,
    'must NOT already exist with a DIFFERENT return type' AS expected,
    COALESCE(
        (SELECT pg_catalog.pg_get_function_result(p.oid) || ' | owner=' || pg_get_userbyid(p.proowner)
           FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname = 'accept_fare_negotiation'
            AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_job_id uuid, p_driver_id uuid'),
        'absent (clean CREATE)') AS observed,
    CASE
        WHEN NOT EXISTS (
            SELECT 1 FROM pg_proc p
             WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'accept_fare_negotiation')
        THEN 'PASS'
        WHEN EXISTS (
            SELECT 1 FROM pg_proc p
             WHERE p.pronamespace = 'public'::regnamespace
               AND p.proname = 'accept_fare_negotiation'
               AND pg_catalog.pg_get_function_result(p.oid) = 'jsonb')
        THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict;

-- Lock-ordering: this migration assumes the other negotiation RPCs lock
-- jobs/sessions before fare rows. Report their current definitions' lock usage
-- so the operator can confirm no inversion is being introduced.
SELECT
    'LOCK ORDER reference: ' || p.proname AS check_name,
    'informational: FOR UPDATE usage in existing negotiation RPCs' AS expected,
    COALESCE(
        (SELECT array_to_string(array_agg(DISTINCT c ORDER BY c), ', ')
           FROM unnest(COALESCE(p.proconfig, '{}')) c),
        '(no proconfig)') || ' | for_update=' ||
        (pg_catalog.pg_get_functiondef(p.oid) ILIKE '%FOR UPDATE%')::TEXT AS observed,
    'INFO' AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('lock_marketplace_fare', 'claim_marketplace_negotiation', 'release_marketplace_negotiation')
ORDER BY p.proname;

-- ============================================================================
-- SECTION 4 — DATA ANOMALIES THAT WOULD MAKE ACCEPTANCE UNSAFE
-- Aggregate counts only; no row data, no PII.
-- ============================================================================

SELECT 'DATA jobs in negotiation state with no driver' AS check_name,
       'informational: candidate population for legacy accept' AS expected,
       COUNT(*)::TEXT AS observed, 'INFO' AS verdict
FROM public.jobs
WHERE status IN ('pending_fare_confirmation', 'negotiating') AND driver_id IS NULL

UNION ALL
SELECT 'DATA jobs in negotiation state ALREADY owned by a driver',
       'these will be rejected by the RPC ownership guard', COUNT(*)::TEXT, 'INFO'
FROM public.jobs
WHERE status IN ('pending_fare_confirmation', 'negotiating') AND driver_id IS NOT NULL

UNION ALL
SELECT 'DATA jobs with MULTIPLE pending customer offers',
       'RPC selects newest deterministically; others stay pending', COUNT(*)::TEXT,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'WARN' END
FROM (
    SELECT job_id FROM public.fare_negotiations
     WHERE proposed_by_role = 'customer' AND status = 'pending'
     GROUP BY job_id HAVING COUNT(*) > 1
) dup

UNION ALL
SELECT 'DATA pending customer offers with amount <= 0',
       'RPC rejects these with 22023', COUNT(*)::TEXT,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'WARN' END
FROM public.fare_negotiations
WHERE proposed_by_role = 'customer' AND status = 'pending' AND COALESCE(amount, 0) <= 0

UNION ALL
SELECT 'DATA jobs that ALSO have a marketplace negotiation session',
       'both models for one job: would mean a provenance discriminator is needed',
       COUNT(*)::TEXT,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM public.jobs j
WHERE EXISTS (SELECT 1 FROM public.marketplace_negotiation_sessions s WHERE s.job_id = j.id)
  AND EXISTS (SELECT 1 FROM public.fare_negotiations f WHERE f.job_id = j.id);

-- ============================================================================
-- SECTION 5 — SECURITY PRECONDITIONS
-- ============================================================================

SELECT
    'ROLE ' || t.rolname AS check_name,
    'role must exist for the GRANT/REVOKE to apply' AS expected,
    CASE WHEN r.oid IS NULL THEN 'MISSING' ELSE 'present' END AS observed,
    CASE WHEN r.oid IS NULL THEN 'FAIL' ELSE 'PASS' END AS verdict
FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS t(rolname)
LEFT JOIN pg_roles r ON r.rolname = t.rolname
ORDER BY verdict DESC, check_name;

-- Production carries broad DEFAULT FUNCTION privileges; report the current
-- default ACL so the explicit REVOKEs can be seen to be necessary.
SELECT
    'DEFAULT ACL for public schema' AS check_name,
    'informational: default function privileges that explicit REVOKEs must beat' AS expected,
    COALESCE(
        (SELECT string_agg(
                    pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype || ':' ||
                    COALESCE(array_to_string(d.defaclacl, ','), 'none'), ' | ')
           FROM pg_default_acl d
          JOIN pg_namespace n ON n.oid = d.defaclnamespace
         WHERE n.nspname = 'public'),
        '(no default ACL rows for public)') AS observed,
    'INFO' AS verdict;

-- ============================================================================
-- SECTION 6 — FINAL GO / NO-GO
-- ============================================================================

WITH req(obj, col) AS (
    VALUES ('jobs','id'),('jobs','status'),('jobs','driver_id'),
           ('jobs','negotiation_mode_enabled'),('jobs','negotiated_fare'),
           ('jobs','agreed_fare'),('jobs','updated_at'),
           ('fare_negotiations','id'),('fare_negotiations','job_id'),
           ('fare_negotiations','proposed_by_role'),('fare_negotiations','status'),
           ('fare_negotiations','amount'),('fare_negotiations','created_at'),
           ('fare_negotiations','updated_at')
),
missing AS (
    SELECT COUNT(*) AS n
      FROM req r
      LEFT JOIN information_schema.columns c
             ON c.table_schema='public' AND c.table_name=r.obj AND c.column_name=r.col
     WHERE c.column_name IS NULL
),
anomaly AS (
    SELECT COUNT(*) AS n
      FROM public.jobs j
     WHERE EXISTS (SELECT 1 FROM public.marketplace_negotiation_sessions s WHERE s.job_id = j.id)
       AND EXISTS (SELECT 1 FROM public.fare_negotiations f WHERE f.job_id = j.id)
),
roles_missing AS (
    SELECT COUNT(*) AS n
      FROM (VALUES ('anon'),('authenticated'),('service_role')) AS t(rolname)
      LEFT JOIN pg_roles r ON r.rolname = t.rolname
     WHERE r.oid IS NULL
)
SELECT
    'GO / NO-GO' AS check_name,
    'columns present + no dual-model jobs + required roles exist' AS expected,
    'missing_columns=' || (SELECT n FROM missing)::TEXT
      || ' | dual_model_jobs=' || (SELECT n FROM anomaly)::TEXT
      || ' | roles_missing=' || (SELECT n FROM roles_missing)::TEXT AS observed,
    CASE
        WHEN (SELECT n FROM missing) > 0 THEN 'NO-GO'
        WHEN (SELECT n FROM anomaly) > 0 THEN 'NO-GO'
        WHEN (SELECT n FROM roles_missing) > 0 THEN 'NO-GO'
        ELSE 'PASS'
    END AS verdict;
