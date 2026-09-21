-- ============================================================================
-- MOVABI — PRE-DEPLOYMENT PREFLIGHT (READ ONLY)
--
-- Run BEFORE applying:
--   supabase/migrations/20260921000000_accept_rpc_lifecycle_reconcile.sql
--
-- PURPOSE
--   Prove that every table, column, function, constraint, grant and RLS state the
--   migration depends on actually exists on the HOSTED database, and surface
--   problematic live data, WITHOUT changing anything.
--
-- SAFETY
--   This script is strictly READ ONLY. It performs no INSERT / UPDATE / DELETE /
--   ALTER / CREATE / DROP / GRANT / REVOKE / TRUNCATE and calls no function that
--   moves money. Every statement is a SELECT against catalogs or aggregates.
--
--   Data checks are AGGREGATE/COUNT ONLY and deliberately avoid selecting customer
--   names, emails, phone numbers, addresses, wallet identifiers or any other
--   personal data.
--
-- READING THE OUTPUT
--   Every check emits a row with:
--     check_name  - what was inspected
--     expected    - what the migration needs
--     observed    - what the database actually has
--     verdict     - 'PASS' | 'FAIL' | 'WARN' | 'INFO'  (only FAIL is fatal)
--
--   ARCHITECTURE NOTE ON VERDICTS
--     PASS  - expectation met.
--     WARN  - not fatal, but read the note; may need operator judgement.
--     INFO  - purely informational, never a gate.
--     FAIL  - expectation NOT met. Any FAIL means do not apply the migration.
--
--     The migration under test is written against the VERIFIED production schema
--     and writes wallet_transactions.transaction_type directly (production has no
--     `type` column). Several checks below assert that exact shape rather than
--     probing for variants. Do not "fix" a WARN or INFO by editing the migration.
--
--   CARDINALITY SAFETY
--     Every scalar subquery in this script is deliberately aggregation- or
--     EXISTS-based. A bare `(SELECT ...)` filtered only by object NAME is unsafe
--     on this database because PostgreSQL function identity includes the argument
--     list, so same-name overloads legitimately produce multiple rows and would
--     raise "more than one row returned by a subquery used as an expression".
--     Where a specific function is meant, the query keys on its exact
--     ::regprocedure signature.
--
-- FINAL STEP
--   The last query returns a single PASS/FAIL summary line. If it is not 'PASS',
--   DO NOT apply the migration.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — TABLE / COLUMN CONTRACTS
-- ============================================================================

WITH required_columns(table_name, column_name, why) AS (
    VALUES
        -- jobs: touched by all three accept RPCs and by settlement
        ('jobs', 'id',                  'accept_searching_job / assign_driver_to_job / accept_assigned_job UPDATE target'),
        ('jobs', 'status',              'all three accept RPCs set this'),
        ('jobs', 'driver_id',           'accept RPCs read + write; accept_assigned_job ownership gate'),
        ('jobs', 'accepted_driver_id',  'accept RPCs write; idempotency guard'),
        ('jobs', 'accepted_at',         'accept RPCs write server timestamp'),
        ('jobs', 'updated_at',          'all three accept RPCs write this'),
        ('jobs', 'service_type_id',     'settle_job_wallet_reservation service lookup'),
        ('jobs', 'metadata',            'settle_job_wallet_reservation metadata->>service_slug fallback'),
        ('jobs', 'customer_id',         'settle_job_wallet_reservation wallets lookup'),
        ('jobs', 'currency_code',       'settle_job_wallet_reservation ledger metadata'),
        -- wallets: settlement mutation target
        ('wallets', 'id',                   'used as wallet_transactions.wallet_id when that column exists'),
        ('wallets', 'user_id',              'settle_job_wallet_reservation lookup + UPDATE'),
        ('wallets', 'available_balance',    'settle_job_wallet_reservation UPDATE'),
        ('wallets', 'reserved_balance',     'settle_job_wallet_reservation UPDATE + amount derivation'),
        ('wallets', 'updated_at',           'settle_job_wallet_reservation UPDATE'),
        -- wallet_transactions: settlement/release ledger inserts
        ('wallet_transactions', 'user_id',     'settlement + release INSERT'),
        ('wallet_transactions', 'job_id',      'settlement + release INSERT'),
        ('wallet_transactions', 'amount',      'settlement + release INSERT'),
        ('wallet_transactions', 'description', 'settlement + release INSERT'),
        ('wallet_transactions', 'metadata',    'settlement + release INSERT'),
        -- errand_funding: settlement marker
        ('errand_funding', 'job_id',          'settle_job_wallet_reservation lock + marker UPDATE'),
        ('errand_funding', 'status',          'already_settled early return + marker write'),
        ('errand_funding', 'amount_reserved', 'settlement amount derivation'),
        ('errand_funding', 'metadata',        'settlement metadata merge'),
        ('errand_funding', 'updated_at',      'settle_job_wallet_reservation UPDATE'),
        -- errand_details: errand amount cap
        ('errand_details', 'job_id',          'settle_job_wallet_reservation lookup'),
        ('errand_details', 'actual_spending', 'errand settlement cap'),
        -- service_types: slug lookup
        ('service_types', 'id',   'join target from jobs.service_type_id'),
        ('service_types', 'slug', 'settle_job_wallet_reservation service resolution')
)
SELECT
    'COLUMN ' || r.table_name || '.' || r.column_name AS check_name,
    'column exists'                                    AS expected,
    CASE WHEN c.column_name IS NULL THEN 'MISSING' ELSE c.data_type END AS observed,
    CASE WHEN c.column_name IS NULL THEN 'FAIL' ELSE 'PASS' END AS verdict
FROM required_columns r
LEFT JOIN information_schema.columns c
       ON c.table_schema = 'public'
      AND c.table_name   = r.table_name
      AND c.column_name  = r.column_name
ORDER BY verdict DESC, check_name;


-- ============================================================================
-- SECTION 2 — TABLE PRESENCE (explicit, so a missing table is unmistakable)
-- ============================================================================

SELECT
    'TABLE ' || t.name AS check_name,
    'table exists in public' AS expected,
    CASE WHEN c.relname IS NULL THEN 'MISSING' ELSE 'present' END AS observed,
    CASE WHEN c.relname IS NULL THEN 'FAIL' ELSE 'PASS' END AS verdict
FROM (VALUES
        ('jobs'), ('wallets'), ('wallet_transactions'),
        ('errand_funding'), ('errand_details'), ('service_types'),
        ('driver_earnings')
     ) AS t(name)
LEFT JOIN pg_class c
       ON c.relname = t.name
      AND c.relnamespace = 'public'::regnamespace
      AND c.relkind = 'r'
ORDER BY verdict DESC, check_name;


-- ============================================================================
-- SECTION 3 — LEDGER COLUMNS
--
-- The migration now writes transaction_type DIRECTLY (production has no `type`
-- column). It no longer probes information_schema at runtime, so this section
-- asserts the exact production shape the migration was written against.
-- ============================================================================

SELECT
    'LEDGER COLUMN wallet_transactions.' || v.col AS check_name,
    v.expectation AS expected,
    CASE WHEN c.column_name IS NULL THEN 'absent' ELSE c.data_type || ' / ' || c.is_nullable END AS observed,
    CASE
        WHEN v.must_exist AND c.column_name IS NULL THEN 'FAIL'
        ELSE 'PASS'
    END AS verdict
FROM (VALUES
        ('transaction_type',          'REQUIRED: migration inserts this literal column name', true),
        ('type',                      'not used by the migration (production has no such column)', false),
        ('wallet_id',                 'REQUIRED: migration inserts it', true),
        ('user_id',                   'REQUIRED:', true),
        ('job_id',                    'REQUIRED:', true),
        ('amount',                    'REQUIRED:', true),
        ('description',               'written by the migration', false),
        ('metadata',                  'written by the migration', false),
        ('balance_before_available',  'written by the migration (nullable expected)', false),
        ('balance_after_available',   'written by the migration (nullable expected)', false),
        ('balance_before_reserved',   'written by the migration (nullable expected)', false),
        ('balance_after_reserved',    'written by the migration (nullable expected)', false),
        ('stripe_payment_intent_id',  'informational', false),
        ('payment_intent_id',         'informational', false)
     ) AS v(col, expectation, must_exist)
LEFT JOIN information_schema.columns c
       ON c.table_schema = 'public'
      AND c.table_name   = 'wallet_transactions'
      AND c.column_name  = v.col
ORDER BY verdict DESC, check_name;

-- Which type vocabulary is installed, and does it permit 'settlement' / 'release'?
-- Cardinality-safe: string_agg over EVERY matching CHECK constraint. A bare
-- scalar subquery here would throw if wallet_transactions carried more than one
-- CHECK mentioning 'settlement'.
SELECT
    'LEDGER CHECK permits settlement+release' AS check_name,
    'at least one CHECK constraint on wallet_transactions mentions both settlement and release' AS expected,
    COALESCE(
        (SELECT string_agg(pg_catalog.pg_get_constraintdef(con.oid), ' | ' ORDER BY con.oid)
           FROM pg_constraint con
          WHERE con.conrelid = 'public.wallet_transactions'::regclass
            AND con.contype = 'c'
            AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE '%settlement%'),
        'NO CHECK CONSTRAINT MENTIONING settlement') AS observed,
    CASE
        WHEN EXISTS (
            SELECT 1 FROM pg_constraint con
             WHERE con.conrelid = 'public.wallet_transactions'::regclass
               AND con.contype = 'c'
               AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE '%settlement%'
               AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE '%release%'
        ) THEN 'PASS'
        WHEN EXISTS (
            SELECT 1 FROM pg_constraint con
             WHERE con.conrelid = 'public.wallet_transactions'::regclass
               AND con.contype = 'c'
               AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE '%settlement%'
        ) THEN 'WARN'
        -- No CHECK at all is safe: both literals are accepted.
        ELSE 'PASS'
    END AS verdict;


-- ============================================================================
-- SECTION 4 — FUNCTION CONTRACTS (prerequisites + what will be replaced)
-- ============================================================================

SELECT
    -- The VALUES list mixes real public function names with one non-function
    -- entry ('auth_uid', which is auth.uid() and lives in schema auth). That
    -- entry used to produce a row with a NULL label because the label was built
    -- from the missing function name. Label robustly from the VALUES column.
    'FUNCTION ' || COALESCE(f.fname, '(unnamed)') AS check_name,
    'exists with expected argument types' AS expected,
    CASE
        WHEN p.oid IS NULL AND COALESCE(f.fname, '') = 'auth_uid' THEN
            'not a public function; checked separately in the security section'
        WHEN p.oid IS NULL THEN 'MISSING'
        ELSE pg_catalog.pg_get_function_identity_arguments(p.oid)
    END AS observed,
    CASE
        -- auth_uid is informational only: it is auth.uid(), not public.auth_uid.
        WHEN COALESCE(f.fname, '') = 'auth_uid' THEN 'INFO'
        WHEN p.oid IS NULL AND f.required THEN 'FAIL'
        WHEN p.oid IS NULL THEN 'WARN'
        ELSE 'PASS'
    END AS verdict,
    f.note
FROM (VALUES
        -- The migration CREATES this helper, so it must NOT pre-exist as a
        -- prerequisite. Its requirements are asserted in their own section below.
        ('driver_vehicle_can_accept_job', false, 'CREATED by this migration; absence pre-migration is expected.'),
        ('accept_searching_job',          true,  'Existing production RPC. Will be DROPped and recreated as BOOLEAN.'),
        ('assign_driver_to_job',          true,  'Existing production RPC. Will be CREATE OR REPLACE-d.'),
        ('accept_assigned_job',           false, 'Created by this migration. Absent now is expected.'),
        ('settle_job_wallet_reservation', false, 'Created by this migration. Absent now is expected.'),
        ('reserve_errand_funds',          false, 'Lock-order reference only (wallets before errand_funding).'),
        ('release_job_wallet_reservation',false, 'Lock-order reference only (jobs then wallets).'),
        ('settle_errand_funds',           false, 'Superseded errand settlement; informational.'),
        ('pay_job_from_wallet',           false, 'Lock-order / wallet RPC; informational.'),
        ('auth_uid',                      false, 'Informational: this is auth.uid(), NOT a public function. Checked in the security section.')
     ) AS f(fname, required, note)
LEFT JOIN pg_proc p
       ON p.proname = f.fname
      AND p.pronamespace = 'public'::regnamespace
-- Explicitly report auth.uid() existence under a non-NULL label, so the
-- informational intent survives without a blank check_name row.
UNION ALL
SELECT
    'FUNCTION auth.uid() (Supabase helper)' AS check_name,
    'exists in schema auth' AS expected,
    CASE WHEN EXISTS (
            SELECT 1 FROM pg_proc pr
            JOIN pg_namespace n ON n.oid = pr.pronamespace
            WHERE n.nspname = 'auth' AND pr.proname = 'uid'
         ) THEN 'present' ELSE 'MISSING' END AS observed,
    CASE WHEN EXISTS (
            SELECT 1 FROM pg_proc pr
            JOIN pg_namespace n ON n.oid = pr.pronamespace
            WHERE n.nspname = 'auth' AND pr.proname = 'uid'
         ) THEN 'INFO' ELSE 'FAIL' END AS verdict,
    'Required by SECURITY DEFINER RPCs that call auth.uid().' AS note
ORDER BY verdict DESC, check_name;

-- Exact current signatures of the two functions being replaced, so the
-- postflight can prove the argument list did not change.
SELECT
    'CURRENT SIG ' || p.proname AS check_name,
    'will be CREATE OR REPLACE-d with identical argument list' AS expected,
    pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid) AS observed,
    'INFO' AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('accept_searching_job', 'assign_driver_to_job')
ORDER BY p.proname;

-- ============================================================================
-- SECTION 4b — DROP SAFETY for accept_searching_job
--
-- The migration performs, with NO CASCADE:
--     DROP FUNCTION IF EXISTS public.accept_searching_job(uuid, uuid);
-- because production's version RETURNS public.jobs and the new one must return
-- BOOLEAN (CREATE OR REPLACE cannot change a return type). A non-CASCADE drop
-- FAILS if anything depends on the function, so this section proves it is safe
-- BEFORE the migration is applied. Anything unexpected here is a NO-GO.
-- ============================================================================

-- 4b.1 Exactly one (uuid,uuid) overload, and its current return type.
SELECT
    'DROP-SAFETY accept_searching_job overload count' AS check_name,
    'exactly 1 overload of (uuid, uuid), else NO-GO (DROP would be ambiguous)' AS expected,
    COUNT(*)::TEXT || ' overload(s): ' ||
      COALESCE(string_agg(pg_get_function_identity_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid), ' ; '), 'none')
    AS observed,
    CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname = 'accept_searching_job';

-- 4b.2 Current return type must be the recognised pre-migration state.
SELECT
    'DROP-SAFETY accept_searching_job return type' AS check_name,
    'public.jobs (recognised pre-migration state) or boolean (already migrated)' AS expected,
    COALESCE(pg_get_function_result(p.oid), 'MISSING') AS observed,
    CASE
        WHEN p.oid IS NULL THEN 'FAIL'
        WHEN pg_get_function_result(p.oid) IN ('public.jobs', 'jobs', 'boolean') THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN pg_proc p
       ON p.proname = 'accept_searching_job'
      AND p.pronamespace = 'public'::regnamespace;

-- 4b.3 Dependency check: a non-CASCADE DROP fails if ANY object depends on it.
--
-- Authoritative form, matching the canonical production diagnostic exactly:
--   pg_depend WHERE refclassid='pg_proc' AND refobjid='public.accept_searching_job(uuid,uuid)'::regprocedure
--
-- NOTE ON A FIXED BUG: this check previously reported "1 dependent object(s)"
-- even when the canonical query above returned zero rows. The cause was
-- COUNT(*) over LEFT JOINs: with no dependencies the LEFT JOINs still emit ONE
-- row per matching pg_proc row (with NULLs), so COUNT(*) was 1. The count must
-- come from a column of the *dependency* row, never from COUNT(*).
WITH target AS (
    SELECT 'public.accept_searching_job(uuid,uuid)'::regprocedure::oid AS fn_oid
),
dependents AS (
    SELECT COALESCE(
               pg_describe_object(d.classid, d.objid, d.objsubid),
               'object oid ' || d.objid::TEXT
           ) AS dependent_description
      FROM pg_depend d
      JOIN target t ON d.refclassid = 'pg_proc'::regclass
                   AND d.refobjid   = t.fn_oid
)
SELECT
    'DROP-SAFETY accept_searching_job dependents' AS check_name,
    'ZERO dependent objects (COUNT over pg_depend refobjid=regprocedure)' AS expected,
    COUNT(dep.dependent_description)::TEXT || ' dependent object(s)' ||
      CASE
          WHEN COUNT(dep.dependent_description) = 0 THEN ''
          ELSE ' : ' || (SELECT string_agg(DISTINCT dependent_description, ', ') FROM dependents)
      END
    AS observed,
    CASE WHEN COUNT(dep.dependent_description) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (SELECT 1) AS one
LEFT JOIN dependents dep ON TRUE
GROUP BY one;

-- 4b.4 The helper prerequisites the migration's new function bodies need.
-- Its body reads public.jobs, public.service_types and public.vehicles.
SELECT
    'HELPER PREREQ ' || r.t || '.' || r.c AS check_name,
    'column required by driver_vehicle_can_accept_job' AS expected,
    CASE WHEN ic.column_name IS NULL THEN 'MISSING' ELSE ic.data_type END AS observed,
    CASE WHEN ic.column_name IS NULL THEN 'FAIL' ELSE 'PASS' END AS verdict
FROM (VALUES
        ('jobs', 'id'),
        ('jobs', 'service_type_id'),
        ('jobs', 'metadata'),
        ('service_types', 'id'),
        ('service_types', 'slug'),
        ('vehicles', 'id'),
        ('vehicles', 'user_id'),
        ('vehicles', 'type'),
        ('vehicles', 'capacity')
     ) AS r(t, c)
LEFT JOIN information_schema.columns ic
       ON ic.table_schema = 'public' AND ic.table_name = r.t AND ic.column_name = r.c
ORDER BY verdict DESC, check_name;

-- 4b.5 vehicles.service_class MUST NOT be required: production has no such
-- physical column, and the helper reads it through to_jsonb(row)->>'service_class'.
-- This row documents that expectation rather than failing on it.
SELECT
    'HELPER service_class physical column' AS check_name,
    'expected ABSENT; helper reads it via to_jsonb(row) so absence is safe' AS expected,
    CASE WHEN ic.column_name IS NULL THEN 'absent (expected)' ELSE 'present (' || ic.data_type || ')' END AS observed,
    'INFO' AS verdict
FROM (SELECT 1) AS one
LEFT JOIN information_schema.columns ic
       ON ic.table_schema = 'public' AND ic.table_name = 'vehicles' AND ic.column_name = 'service_class';

-- 4b.6 The migration now writes transaction_type directly (no `type` column on
-- production), so a `type` column must not be required.
SELECT
    'LEDGER type column expectation' AS check_name,
    'production uses transaction_type; `type` is not written by the migration' AS expected,
    'transaction_type=' || CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='wallet_transactions' AND column_name='transaction_type')
      THEN 'present' ELSE 'MISSING' END
    || ' | type=' || CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='wallet_transactions' AND column_name='type')
      THEN 'present' ELSE 'absent' END
    AS observed,
    CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='wallet_transactions' AND column_name='transaction_type')
      THEN 'PASS' ELSE 'FAIL' END AS verdict;

-- 4b.7 Audit columns the migration now populates must exist.
SELECT
    'LEDGER AUDIT COLUMN ' || c.col AS check_name,
    'populated by settle_job_wallet_reservation; must be nullable' AS expected,
    CASE WHEN ic.column_name IS NULL THEN 'MISSING'
         ELSE ic.data_type || ' / ' || ic.is_nullable END AS observed,
    CASE WHEN ic.column_name IS NULL THEN 'FAIL' ELSE 'PASS' END AS verdict
FROM (VALUES
        ('balance_before_available'), ('balance_after_available'),
        ('balance_before_reserved'),  ('balance_after_reserved'),
        ('wallet_id'), ('user_id'), ('amount')
     ) AS c(col)
LEFT JOIN information_schema.columns ic
       ON ic.table_schema = 'public' AND ic.table_name = 'wallet_transactions' AND ic.column_name = c.col
ORDER BY verdict DESC, check_name;

-- Does anything ELSE in the database call these functions (triggers, views, other
-- functions)? A caller could break if semantics changed.
-- Cardinality-safe: grouped by function, and rows with no caller are filtered out
-- by d.oid IS NOT NULL, so 'none found' is an honest report. Informational only.
SELECT
    'CALLERS OF ' || COALESCE(p.proname, '(none)') AS check_name,
    'identify dependent routines before replacing' AS expected,
    COALESCE(string_agg(DISTINCT d.proname, ', '), 'none found') AS observed,
    'INFO' AS verdict
FROM pg_proc p
LEFT JOIN pg_depend dep
       ON dep.refobjid = p.oid
      AND dep.refclassid = 'pg_proc'::regclass
LEFT JOIN pg_proc d
       ON d.oid = dep.objid
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('accept_searching_job', 'assign_driver_to_job', 'driver_vehicle_can_accept_job')
  AND d.oid IS NOT NULL
GROUP BY p.proname;


-- ============================================================================
-- SECTION 5 — jobs.status CHECK CONSTRAINT
-- ============================================================================

SELECT
    'jobs.status CHECK constraint' AS check_name,
    'must permit every status the lifecycle writes' AS expected,
    COALESCE(
        (SELECT string_agg(pg_catalog.pg_get_constraintdef(con.oid), ' | ' ORDER BY con.oid)
           FROM pg_constraint con
          WHERE con.conrelid = 'public.jobs'::regclass
            AND con.contype = 'c'
            AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE '%status%'),
        'NO CHECK CONSTRAINT FOUND ON status'
    ) AS observed,
    'INFO' AS verdict;

-- Per-status membership test: is each required literal permitted?
WITH required_status(s) AS (
    VALUES ('pending'), ('requested'), ('searching'), ('broadcasting'), ('waiting'),
           ('assigned'), ('accepted'), ('arrived'), ('heading_to_pickup'),
           ('arrived_at_store'), ('shopping_in_progress'), ('collected'),
           ('en_route_to_customer'), ('delivered'), ('in_progress'),
           ('completed'), ('settled'), ('cancelled'), ('no_driver_found')
),
constraint_def AS (
    SELECT pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
     WHERE con.conrelid = 'public.jobs'::regclass
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%status%'
     LIMIT 1
)
SELECT
    'STATUS PERMITTED ' || r.s AS check_name,
    'jobs_status_check permits literal' AS expected,
    CASE
        WHEN (SELECT def FROM constraint_def) IS NULL THEN 'no constraint to test (unconstrained TEXT is permissive)'
        WHEN (SELECT def FROM constraint_def) ILIKE '%''' || r.s || '''%' THEN 'permitted'
        ELSE 'NOT PERMITTED'
    END AS observed,
    CASE
        -- No CHECK constraint at all means every literal is accepted.
        WHEN (SELECT def FROM constraint_def) IS NULL THEN 'PASS'
        WHEN (SELECT def FROM constraint_def) ILIKE '%''' || r.s || '''%' THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict
FROM required_status r
ORDER BY verdict DESC, check_name;


-- ============================================================================
-- SECTION 6 — UNIQUENESS / FK / NOT NULL CONTRACTS
-- ============================================================================

-- driver_earnings UNIQUE(job_id): required by completeJob's upsert and by the
-- app-layer "already fully completed" readiness check.
SELECT
    'driver_earnings UNIQUE(job_id)' AS check_name,
    'unique constraint or unique index on (job_id)' AS expected,
    COALESCE(
        (SELECT string_agg(DISTINCT pg_get_constraintdef(con.oid), ' | ')
           FROM pg_constraint con
          WHERE con.conrelid = 'public.driver_earnings'::regclass
            AND con.contype IN ('u', 'p')
            AND pg_get_constraintdef(con.oid) ILIKE '%job_id%'),
        COALESCE(
            (SELECT string_agg(DISTINCT indexdef, ' | ')
               FROM pg_indexes
              WHERE schemaname = 'public'
                AND tablename = 'driver_earnings'
                AND indexdef ILIKE 'CREATE UNIQUE%'
                AND indexdef ILIKE '%job_id%'),
            'NONE FOUND')
    ) AS observed,
    CASE
        WHEN EXISTS (
            SELECT 1 FROM pg_constraint con
             WHERE con.conrelid = 'public.driver_earnings'::regclass
               AND con.contype IN ('u', 'p')
               AND pg_get_constraintdef(con.oid) ILIKE '%job_id%'
        ) OR EXISTS (
            SELECT 1 FROM pg_indexes
             WHERE schemaname = 'public'
               AND tablename = 'driver_earnings'
               AND indexdef ILIKE 'CREATE UNIQUE%'
               AND indexdef ILIKE '%job_id%'
        ) THEN 'PASS' ELSE 'FAIL'
    END AS verdict;

-- errand_funding.job_id UNIQUE: the settlement marker row must be unique per job.
SELECT
    'errand_funding.job_id uniqueness' AS check_name,
    'unique constraint/index on (job_id)' AS expected,
    COALESCE(
        (SELECT string_agg(DISTINCT pg_get_constraintdef(con.oid), ' | ')
           FROM pg_constraint con
          WHERE con.conrelid = 'public.errand_funding'::regclass
            AND con.contype IN ('u', 'p')
            AND pg_get_constraintdef(con.oid) ILIKE '%job_id%'),
        'NONE FOUND'
    ) AS observed,
    CASE
        WHEN EXISTS (
            SELECT 1 FROM pg_constraint con
             WHERE con.conrelid = 'public.errand_funding'::regclass
               AND con.contype IN ('u', 'p')
               AND pg_get_constraintdef(con.oid) ILIKE '%job_id%'
        ) THEN 'PASS' ELSE 'WARN'
    END AS verdict;

-- errand_funding.status CHECK: must permit 'settled' (the marker the migration writes).
SELECT
    'errand_funding.status permits settled' AS check_name,
    'settled must be an allowed status literal' AS expected,
    COALESCE(
        (SELECT string_agg(pg_catalog.pg_get_constraintdef(con.oid), ' | ' ORDER BY con.oid)
           FROM pg_constraint con
          WHERE con.conrelid = 'public.errand_funding'::regclass
            AND con.contype = 'c'
            AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE '%status%'),
        'NO CHECK CONSTRAINT ON status') AS observed,
    CASE
        WHEN NOT EXISTS (
            SELECT 1 FROM pg_constraint con
             WHERE con.conrelid = 'public.errand_funding'::regclass
               AND con.contype = 'c'
               AND pg_get_constraintdef(con.oid) ILIKE '%status%'
        ) THEN 'PASS'
        WHEN EXISTS (
            SELECT 1 FROM pg_constraint con
             WHERE con.conrelid = 'public.errand_funding'::regclass
               AND con.contype = 'c'
               AND pg_get_constraintdef(con.oid) ILIKE '%status%'
               AND pg_get_constraintdef(con.oid) ILIKE '%settled%'
        ) THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict;

-- NOT NULL columns the migration writes into, plus their defaults.
SELECT
    'NOT NULL ' || table_name || '.' || column_name AS check_name,
    'column is nullable (migration always supplies a value)' AS expected,
    CASE WHEN is_nullable = 'NO' THEN 'NOT NULL' ELSE 'nullable' END AS observed,
    'INFO' AS verdict
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'wallet_transactions' AND column_name IN
          ('user_id','job_id','amount','type','transaction_type','wallet_id','description','metadata'))
    OR (table_name = 'wallets' AND column_name IN
          ('user_id','available_balance','reserved_balance','updated_at'))
    OR (table_name = 'errand_funding' AND column_name IN
          ('job_id','status','amount_reserved','metadata','updated_at')))
ORDER BY check_name;

-- wallet_transactions indexes/constraints (does anything already enforce
-- one settlement per job? If not, idempotency rests on the migration's marker).
SELECT
    'INDEX ' || indexname AS check_name,
    'informational: uniqueness relevant to settlement idempotency' AS expected,
    indexdef AS observed,
    CASE
        WHEN indexdef ILIKE 'CREATE UNIQUE%' AND indexdef ILIKE '%job_id%' THEN 'NOTE'
        ELSE 'INFO'
    END AS verdict
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'wallet_transactions'
ORDER BY indexname;


-- ============================================================================
-- SECTION 7 — SECURITY: owner, DEFINER/INVOKER, search_path, ACLs
-- ============================================================================

SELECT
    'SECURITY ' || p.proname AS check_name,
    'CURRENT state before migration' AS expected,
    'prosecdef=' || p.prosecdef::TEXT
      || ' | owner=' || pg_get_userbyid(p.proowner)
      || ' | search_path=' || COALESCE(array_to_string(p.proconfig, ','), '(not set)')
      || ' | acl=' || COALESCE(array_to_string(p.proacl, ' | '), '(default: owner only)')
    AS observed,
    'INFO' AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('accept_searching_job', 'assign_driver_to_job',
                    'driver_vehicle_can_accept_job', 'reserve_errand_funds',
                    'release_job_wallet_reservation', 'settle_errand_funds',
                    'pay_job_from_wallet')
ORDER BY p.proname;

-- Anonymous (PUBLIC) EXECUTE on the migration's own functions would be a
-- security regression; the migration revokes it.
SELECT
    'PUBLIC EXECUTE revocable on ' || p.proname AS check_name,
    'migration will REVOKE ALL FROM PUBLIC' AS expected,
    CASE
        WHEN p.proacl IS NULL THEN 'ACL is default (PUBLIC has EXECUTE by default) - migration revoke is required'
        WHEN EXISTS (SELECT 1 FROM unnest(p.proacl) a WHERE a::TEXT LIKE '=%') THEN 'ACL explicitly grants PUBLIC - check'
        ELSE 'no PUBLIC grant'
    END AS observed,
    'INFO' AS verdict
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('accept_searching_job', 'assign_driver_to_job');

-- Does the roles the migration GRANTs to actually exist?
SELECT
    'ROLE ' || r.rolname AS check_name,
    'role must exist for GRANT EXECUTE to succeed' AS expected,
    CASE WHEN r.oid IS NULL THEN 'MISSING' ELSE 'present' END AS observed,
    CASE WHEN r.oid IS NULL THEN 'FAIL' ELSE 'PASS' END AS verdict
FROM (VALUES ('authenticated'), ('service_role'), ('anon')) AS t(rolname)
LEFT JOIN pg_roles r ON r.rolname = t.rolname
ORDER BY verdict DESC, check_name;

-- RLS state for the tables the migration touches (SECURITY DEFINER bypasses RLS,
-- but the client-side paths that call these RPCs do not).
SELECT
    'RLS ' || c.relname AS check_name,
    'informational: RLS enabled + policy count' AS expected,
    'rls_enabled=' || c.relrowsecurity::TEXT
      || ' | force_rls=' || c.relforcerowsecurity::TEXT
      || ' | policies=' || (SELECT COUNT(*) FROM pg_policies pol
                             WHERE pol.schemaname = 'public' AND pol.tablename = c.relname)::TEXT
    AS observed,
    'INFO' AS verdict
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('jobs', 'wallets', 'wallet_transactions', 'errand_funding', 'driver_earnings', 'errand_details')
ORDER BY c.relname;

-- Confirm auth.uid() exists and how it resolves (the accept RPCs depend on it).
SELECT
    'auth.uid() availability' AS check_name,
    'accept_searching_job / accept_assigned_job call auth.uid()' AS expected,
    CASE
        WHEN EXISTS (
            SELECT 1 FROM pg_proc pr
            JOIN pg_namespace n ON n.oid = pr.pronamespace
            WHERE n.nspname = 'auth' AND pr.proname = 'uid'
        ) THEN 'auth.uid() present'
        ELSE 'auth.uid() NOT FOUND - SECURITY DEFINER RPCs will fail at runtime'
    END AS observed,
    CASE
        WHEN EXISTS (
            SELECT 1 FROM pg_proc pr
            JOIN pg_namespace n ON n.oid = pr.pronamespace
            WHERE n.nspname = 'auth' AND pr.proname = 'uid'
        ) THEN 'PASS'
        ELSE 'FAIL'
    END AS verdict;


-- ============================================================================
-- SECTION 8 — DATA PREFLIGHT (aggregate counts ONLY, no personal data)
-- ============================================================================

SELECT 'DATA assigned jobs with NULL driver_id' AS check_name,
       'should be 0; these rows cannot progress' AS expected,
       COUNT(*)::TEXT AS observed,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'WARN' END AS verdict
FROM public.jobs WHERE status = 'assigned' AND driver_id IS NULL

UNION ALL
SELECT 'DATA accepted jobs with NULL driver_id',
       'should be 0; ownership guards cannot resolve a driver', COUNT(*)::TEXT,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM public.jobs WHERE status = 'accepted' AND driver_id IS NULL

UNION ALL
SELECT 'DATA accepted jobs with NULL accepted_driver_id',
       'legacy rows predating accepted_driver_id; not converted by this migration', COUNT(*)::TEXT,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'WARN' END
FROM public.jobs WHERE status = 'accepted' AND accepted_driver_id IS NULL

UNION ALL
SELECT 'DATA accepted jobs where driver_id <> accepted_driver_id',
       'conflicting owners; needs operator review (not auto-fixed)', COUNT(*)::TEXT,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'WARN' END
FROM public.jobs
WHERE status = 'accepted'
  AND driver_id IS NOT NULL
  AND accepted_driver_id IS NOT NULL
  AND driver_id <> accepted_driver_id

UNION ALL
SELECT 'DATA completed jobs missing driver_earnings',
       'these are the Batch 1B resume cases; completeJob can now recover them', COUNT(*)::TEXT,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'WARN' END
FROM public.jobs j
WHERE j.status = 'completed'
  AND NOT EXISTS (SELECT 1 FROM public.driver_earnings e WHERE e.job_id = j.id)

UNION ALL
SELECT 'DATA assigned jobs total (informational)',
       'these stay assigned; the driver must confirm via accept_assigned_job', COUNT(*)::TEXT,
       'INFO'
FROM public.jobs WHERE status = 'assigned'

UNION ALL
SELECT 'DATA settled errand_funding rows (informational)',
       'already-settled markers; settle RPC will return already_settled', COUNT(*)::TEXT,
       'INFO'
FROM public.errand_funding WHERE LOWER(COALESCE(status, '')) = 'settled'

UNION ALL
SELECT 'DATA unsettled wallet-funded jobs',
       'wallet reservation still held; first settle will mutate balances', COUNT(*)::TEXT,
       'INFO'
FROM public.jobs
WHERE COALESCE(payment_status, '') = 'wallet_funded'
  AND status NOT IN ('completed', 'settled', 'cancelled')

UNION ALL
SELECT 'DATA duplicate settlement ledger rows per job',
       'if >0 the migration still behaves correctly (marker guards), but review', COUNT(*)::TEXT,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'WARN' END
FROM (
    SELECT job_id
    FROM public.wallet_transactions
    WHERE job_id IS NOT NULL
      AND (
        -- support whichever column variant is installed without erroring
        (to_jsonb(wallet_transactions) ->> 'type') = 'settlement'
        OR (to_jsonb(wallet_transactions) ->> 'transaction_type') = 'settlement'
      )
    GROUP BY job_id
    HAVING COUNT(*) > 1
) dup

UNION ALL
SELECT 'DATA duplicate driver_earnings rows per job',
       'should be 0 because UNIQUE(job_id) is expected', COUNT(*)::TEXT,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM (
    SELECT job_id FROM public.driver_earnings GROUP BY job_id HAVING COUNT(*) > 1
) dup2

UNION ALL
SELECT 'DATA jobs with NULL service_type_id AND no metadata.service_slug',
       'errand detection falls back; settlement still safe, slug resolves empty', COUNT(*)::TEXT,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'WARN' END
FROM public.jobs
WHERE service_type_id IS NULL
  AND COALESCE(metadata ->> 'service_slug', '') = ''

UNION ALL
SELECT 'DATA wallets with reserved_balance < 0',
       'negative reservation would distort settlement arithmetic', COUNT(*)::TEXT,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM public.wallets WHERE COALESCE(reserved_balance, 0) < 0

UNION ALL
SELECT 'DATA wallets with available_balance < 0',
       'negative available balance', COUNT(*)::TEXT,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM public.wallets WHERE COALESCE(available_balance, 0) < 0;


-- ============================================================================
-- SECTION 9 — FINAL GO / NO-GO SUMMARY
-- ============================================================================

WITH checks AS (
    -- prerequisite columns
    SELECT COUNT(*) AS failures FROM (
        SELECT 1
        FROM (VALUES
            ('jobs','id'),('jobs','status'),('jobs','driver_id'),('jobs','accepted_driver_id'),
            ('jobs','accepted_at'),('jobs','updated_at'),('jobs','service_type_id'),
            ('jobs','metadata'),('jobs','customer_id'),('jobs','currency_code'),
            ('wallets','user_id'),('wallets','available_balance'),('wallets','reserved_balance'),
            ('wallets','id'),('wallets','updated_at'),
            ('wallet_transactions','user_id'),('wallet_transactions','job_id'),
            ('wallet_transactions','amount'),('wallet_transactions','description'),
            ('wallet_transactions','metadata'),
            ('errand_funding','job_id'),('errand_funding','status'),
            ('errand_funding','amount_reserved'),('errand_funding','metadata'),
            ('errand_funding','updated_at'),
            ('errand_details','job_id'),('errand_details','actual_spending'),
            ('service_types','id'),('service_types','slug'),
            ('driver_earnings','job_id')
        ) AS r(t, c)
        LEFT JOIN information_schema.columns ic
               ON ic.table_schema = 'public' AND ic.table_name = r.t AND ic.column_name = r.c
        WHERE ic.column_name IS NULL
    ) missing_columns
)
SELECT
    'GO / NO-GO' AS check_name,
    'prereq columns + helper prereqs + DROP-safety + auth.uid() + roles' AS expected,
    'missing_columns=' || (SELECT failures FROM checks)::TEXT
      || ' | helper_prereqs_missing='
      || (SELECT COUNT(*) FROM (VALUES
            ('jobs','id'),('jobs','service_type_id'),('jobs','metadata'),
            ('service_types','id'),('service_types','slug'),
            ('vehicles','id'),('vehicles','user_id'),('vehicles','type'),('vehicles','capacity')
          ) AS hr(t,c)
          LEFT JOIN information_schema.columns hic
                 ON hic.table_schema='public' AND hic.table_name=hr.t AND hic.column_name=hr.c
          WHERE hic.column_name IS NULL)::TEXT
      || ' | accept_searching_job_overloads='
      || (SELECT COUNT(*)::TEXT FROM pg_proc p
           WHERE p.pronamespace='public'::regnamespace AND p.proname='accept_searching_job')
      || ' | accept_searching_job_rettype='
      -- Actual return type of the EXACT signature the migration drops.
      -- This previously used a scalar subquery filtered only by name; any second
      -- overload of accept_searching_job made it multi-row and threw
      -- "more than one row returned by a subquery used as an expression".
      -- array_to_string is an aggregate, so it always yields exactly one row.
      || (SELECT COALESCE(array_to_string(array_agg(DISTINCT pg_catalog.pg_get_function_result(p.oid) ORDER BY pg_catalog.pg_get_function_result(p.oid)), ' | '), 'MISSING')
            FROM (SELECT 'public.accept_searching_job(uuid,uuid)'::regprocedure::oid AS oid) t
            LEFT JOIN pg_proc p ON p.oid = t.oid)
      || ' | accept_searching_job_dependents='
      -- Authoritative: keyed on the exact signature, matching section 4b.3.
      || (SELECT COUNT(*)::TEXT
            FROM pg_depend d
           WHERE d.refclassid = 'pg_proc'::regclass
             AND d.refobjid = to_regprocedure('public.accept_searching_job(uuid,uuid)'))
      || ' | transaction_type='
      || CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_schema='public' AND table_name='wallet_transactions'
                              AND column_name='transaction_type')
              THEN 'present' ELSE 'MISSING' END
      || ' | ledger_audit_cols_missing='
      || (SELECT COUNT(*)::TEXT FROM (VALUES
            ('balance_before_available'),('balance_after_available'),
            ('balance_before_reserved'),('balance_after_reserved')
          ) AS ac(c)
          LEFT JOIN information_schema.columns aic
                 ON aic.table_schema='public' AND aic.table_name='wallet_transactions' AND aic.column_name=ac.c
          WHERE aic.column_name IS NULL)
      || ' | auth.uid()='
      || CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                            WHERE n.nspname='auth' AND p.proname='uid')
              THEN 'present' ELSE 'MISSING' END
      || ' | roles_missing='
      || (SELECT COUNT(*) FROM (VALUES ('authenticated'),('service_role'))
            AS rr(rn) LEFT JOIN pg_roles r ON r.rolname = rr.rn WHERE r.oid IS NULL)::TEXT
    AS observed,
    CASE
        WHEN (SELECT failures FROM checks) > 0 THEN 'NO-GO'
        -- helper prerequisites (the migration creates the helper, so it must NOT
        -- need to pre-exist, but its inputs must be present)
        WHEN (SELECT COUNT(*) FROM (VALUES
                ('jobs','id'),('jobs','service_type_id'),('jobs','metadata'),
                ('service_types','id'),('service_types','slug'),
                ('vehicles','id'),('vehicles','user_id'),('vehicles','type'),('vehicles','capacity')
              ) AS hr(t,c)
              LEFT JOIN information_schema.columns hic
                     ON hic.table_schema='public' AND hic.table_name=hr.t AND hic.column_name=hr.c
              WHERE hic.column_name IS NULL) > 0 THEN 'NO-GO'
        -- DROP safety for accept_searching_job
        WHEN (SELECT COUNT(*) FROM pg_proc p
               WHERE p.pronamespace='public'::regnamespace AND p.proname='accept_searching_job') <> 1 THEN 'NO-GO'
        -- Cardinality-safe: filtered to the exact signature the migration drops.
        WHEN (SELECT COALESCE(array_to_string(array_agg(DISTINCT pg_catalog.pg_get_function_result(p.oid)), ' | '), '')
                FROM (SELECT 'public.accept_searching_job(uuid,uuid)'::regprocedure::oid AS oid) t
                LEFT JOIN pg_proc p ON p.oid = t.oid)
             NOT IN ('public.jobs', 'jobs', 'boolean') THEN 'NO-GO'
        WHEN (SELECT COUNT(*)
                FROM pg_depend d
               WHERE d.refclassid = 'pg_proc'::regclass
                 AND d.refobjid = to_regprocedure('public.accept_searching_job(uuid,uuid)')
             ) > 0 THEN 'NO-GO'
        -- ledger shape the migration was written against
        WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_schema='public' AND table_name='wallet_transactions'
                            AND column_name='transaction_type') THEN 'NO-GO'
        WHEN (SELECT COUNT(*) FROM (VALUES
                ('balance_before_available'),('balance_after_available'),
                ('balance_before_reserved'),('balance_after_reserved')
              ) AS ac(c)
              LEFT JOIN information_schema.columns aic
                     ON aic.table_schema='public' AND aic.table_name='wallet_transactions' AND aic.column_name=ac.c
              WHERE aic.column_name IS NULL) > 0 THEN 'NO-GO'
        WHEN NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                          WHERE n.nspname='auth' AND p.proname='uid') THEN 'NO-GO'
        WHEN (SELECT COUNT(*) FROM (VALUES ('authenticated'),('service_role'))
                AS rr(rn) LEFT JOIN pg_roles r ON r.rolname = rr.rn WHERE r.oid IS NULL) > 0 THEN 'NO-GO'
        ELSE 'PASS'
    END AS verdict;