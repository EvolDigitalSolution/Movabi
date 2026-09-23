-- ============================================================================
-- MOVABI — PHASE C1 READ-ONLY SCHEMA LINEAGE DIAGNOSTIC  (rev 2, absence-safe)
-- ============================================================================
--
-- PURPOSE
--   Establish, WITHOUT MUTATING ANYTHING, whether production actually contains
--   every object that the repository can no longer represent as lineage:
--     * the three recovered migrations
--         20260707000000_marketplace_engine.sql                    (F3953FC8...)
--         20260708173000_marketplace_distance_duration_columns.sql (F0FCF6D0...)
--         20260708180000_shop_pricing_config_columns.sql           (A9B40EC9...)
--     * the six settlement columns with no tracked definition
--     * the two money-crediting wallet functions with no ACL lineage
--     * migration-state recording
--
-- WHY THIS IS rev 2 — THE rev 1 DEFECT
--   rev 1 ended SECTION 1 with an unconditional
--       SELECT ... FROM supabase_migrations.schema_migrations ORDER BY version;
--   PostgreSQL resolves every relation named in a statement at PARSE/PLAN time,
--   before any predicate runs, so in the target environment - where
--   supabase_migrations is ABSENT - that statement raised
--       ERROR: relation "supabase_migrations.schema_migrations" does not exist
--   The READ ONLY transaction was aborted, which poisons every subsequent
--   statement (25P02), so SECTIONS 2-10 NEVER RAN. A CASE or WHERE guard CANNOT
--   fix that class of bug: only catalog introspection can.
--   rev 1 had the same defect in five more places via the ::regclass CAST
--   (`'public.jobs'::regclass` x3, `'public.pricing_config'::regclass`,
--   `WHERE con.conrelid = 'public.jobs'::regclass`) and via
--   `'public'::regnamespace` x2. ::regclass/::regnamespace RAISE 42P01 when the
--   object is missing; to_regclass()/to_regnamespace() RETURN NULL. That
--   difference is the whole safety property of this script.
--
-- ABSENCE-SAFETY CONTRACT (rev 2)
--   * No statement in this file names a possibly-absent object outside a
--     to_regclass()/to_regnamespace() argument. Absence is therefore never a
--     PostgreSQL error; it is a reported verdict.
--   * Every expected object is enumerated ONE ROW PER OBJECT, driven by a VALUES
--     list or `FROM (SELECT 1) AS one`, LEFT JOINed to pg_catalog, so a missing
--     object produces a row reading ABSENT rather than an empty result set that
--     could be mistaken for "nothing to check".
--   * Section 1 works in all three states: schema absent / schema present but
--     table absent / both present. The ledger is only ever PROBED, never
--     SELECTed from. When the ledger is absent the script reports
--     MIGRATION_LEDGER=ABSENT and skips row enumeration entirely.
--   * This file is enforced by src/testing/batch2c-diagnostic-readonly.spec.ts,
--     which structurally forbids the rev 1 defects (no FROM/JOIN of the ledger,
--     no ::regclass, no ::regnamespace, no write DDL/DML) and requires the
--     read-only envelope and the completion sentinel.
--
-- READ-ONLY CONTRACT — read-only by construction, not by convention
--   * BEGIN TRANSACTION READ ONLY ... ROLLBACK: any accidental write fails with
--     25006 instead of persisting.
--   * SELECT only. No INSERT/UPDATE/DELETE, no CREATE/ALTER/DROP, no
--     GRANT/REVOKE, no VACUUM/ANALYZE/SET, no temporary tables, no functions,
--     no DO blocks. It does NOT create the missing migration schema or table.
--   * No application function is ever CALLED. Application functions are
--     introspected through pg_proc only, because invoking even a "read" helper
--     could have side effects inside a SECURITY DEFINER body.
--   * Touches only: pg_catalog, information_schema, pg_proc, pg_class,
--     pg_attribute, pg_constraint, pg_indexes, pg_trigger, pg_policy, pg_roles,
--     aclexplode(), acldefault(), to_regclass(), to_regnamespace().
--
-- WRAPPER REQUIREMENT — READ THIS BEFORE TRUSTING THE OUTPUT
--   rev 1 was run as `psql ... | tee ...` with no pipefail/PIPESTATUS check, so
--   tee exited 0 and the wrapper reported DIAGNOSTIC_EXIT=0 even though psql had
--   failed and the transaction had aborted. Do not repeat that:
--     1. Run with `set -o pipefail` (bash) or check ${PIPESTATUS[0]} (bash) /
--        $LASTEXITCODE of psql (PowerShell) - never tee's status.
--     2. Independently require the SECTION 11 sentinel row DIAGNOSTIC_COMPLETE /
--        verdict COMPLETED. If that row is absent, the script aborted and NO
--        conclusion may be drawn from ANY section.
--     3. Optionally run psql with `\set ON_ERROR_ROLLBACK on` so a single
--        unexpected error cannot poison the rest of the transaction.
--
-- HOW TO READ THE OUTPUT
--   Rows are (section, check_name, object, verdict, detail) with verdicts
--   EXISTS / ABSENT / OK / NO-GO / UNKNOWN. A NO-GO for C1 is any ABSENT in
--   SECTION 2, 3, 5 or 8 while the corresponding repository file is expected to
--   have been applied.
--
-- THIS FILE IS NOT APPLIED BY ANY TOOLING. It has no version prefix, it is not in
-- supabase/migrations, and nothing in package.json or CI invokes it.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;

-- ----------------------------------------------------------------------------
-- SECTION 0 - environment (no application object referenced)
-- ----------------------------------------------------------------------------
SELECT '0. env' AS section, 'server_version' AS check_name, NULL::text AS object,
       'PRESENT' AS verdict, current_setting('server_version') AS detail
UNION ALL SELECT '0. env', 'database', NULL, 'PRESENT', current_database()
UNION ALL SELECT '0. env', 'current_user', NULL, 'PRESENT', current_user
UNION ALL SELECT '0. env', 'transaction_read_only', NULL, 'PRESENT', current_setting('transaction_read_only');

-- ----------------------------------------------------------------------------
-- SECTION 1 - migration-state recording (ABSENCE-SAFE)
--
-- The ledger is only ever PROBED through to_regclass(). It is never named in a
-- FROM/JOIN clause, so an absent ledger cannot abort this transaction.
-- ----------------------------------------------------------------------------
SELECT '1. migration ledger' AS section,
       'MIGRATION_LEDGER=' || CASE
           WHEN to_regclass('supabase_migrations.schema_migrations') IS NULL THEN 'ABSENT'
           ELSE 'PRESENT' END AS check_name,
       'schema_migrations' AS object,
       CASE WHEN to_regclass('supabase_migrations.schema_migrations') IS NULL THEN 'ABSENT' ELSE 'EXISTS' END AS verdict,
       CASE WHEN to_regclass('supabase_migrations.schema_migrations') IS NULL
            THEN 'No migration ledger found. Applied migrations are NOT recorded in-database, so '
                 || '`supabase db push` cannot reason about what is applied and MUST NOT be used here. '
                 || 'Adopt by recording versions, never by replaying DDL.'
            ELSE 'Ledger present in schema supabase_migrations; row enumeration is safe (see SECTION 1B).' END AS detail;

-- Ledger SHAPE from catalogs only - always emits exactly one row, present or not.
SELECT '1. migration ledger' AS section, 'ledger shape (catalog only)' AS check_name,
       'schema_migrations' AS object,
       CASE WHEN c.oid IS NULL THEN 'ABSENT' ELSE 'EXISTS' END AS verdict,
       CASE WHEN c.oid IS NULL
            THEN 'ledger absent in schema supabase_migrations: no rows to enumerate (rev 1 aborted here); '
                 || 'run the commented ledger query in this file MANUALLY only if MIGRATION_LEDGER=PRESENT'
            ELSE 'relkind=' || c.relkind::text
                 || ' estimated_rows=' || COALESCE(c.reltuples::bigint, 0)::text
                 || ' (reltuples is an estimate; -1 or 0 means never analyzed) '
                 || 'columns=[' || COALESCE((
                        SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
                        FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '')
                 || ']' END AS detail
FROM (SELECT 1) AS one
LEFT JOIN pg_class c ON c.oid = to_regclass('supabase_migrations.schema_migrations');

-- Ledger COLUMNS from catalogs only - one row per column, empty when absent.
SELECT '1. migration ledger' AS section, 'ledger column' AS check_name,
       a.attname AS object, 'EXISTS' AS verdict,
       format_type(a.atttypid, a.atttypmod) || ' nullable=' || (NOT a.attnotnull)::text AS detail
FROM pg_attribute a
WHERE a.attrelid = to_regclass('supabase_migrations.schema_migrations')
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum;

-- OPTIONAL, MANUAL: run this ONLY when SECTION 1 reports MIGRATION_LEDGER=PRESENT.
-- It is deliberately NOT executable here, because naming the ledger in a FROM
-- clause is exactly what aborted rev 1:
--   SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version;

-- ----------------------------------------------------------------------------
-- SECTION 2 - objects expected from 20260707000000_marketplace_engine.sql
-- ----------------------------------------------------------------------------
SELECT '2. marketplace engine' AS section, kind AS check_name, obj AS object,
       CASE WHEN to_regclass(obj) IS NULL THEN 'ABSENT' ELSE 'EXISTS' END AS verdict,
       CASE WHEN to_regclass(obj) IS NULL
            THEN 'table missing: the recovered migration has NOT been applied here'
            ELSE 'table present' END AS detail
FROM (VALUES
  ('table', 'public.marketplace_settings'),
  ('table', 'public.marketplace_commission_overrides'),
  ('table', 'public.fare_negotiations'),
  ('table', 'public.driver_bids'),
  ('table', 'public.driver_job_declines'),
  ('table', 'public.marketplace_negotiation_sessions'),
  ('table', 'public.marketplace_negotiation_events')
) AS t(kind, obj)
ORDER BY obj;

-- Functions: one row per expected function, LEFT JOINed from a VALUES list.
SELECT '2. marketplace engine' AS section, 'function' AS check_name, want.fn AS object,
       CASE WHEN p.oid IS NULL THEN 'ABSENT' ELSE 'EXISTS' END AS verdict,
       CASE WHEN p.oid IS NULL THEN 'function not installed in schema public'
            ELSE 'security_definer=' || p.prosecdef::text
                 || ' volatility=' || p.provolatile::text
                 || ' search_path=' || COALESCE(array_to_string(p.proconfig, ','), '<UNPINNED>')
                 || ' proacl=' || COALESCE(p.proacl::text, '<NULL: implicit EXECUTE to PUBLIC>') END AS detail
FROM (VALUES
  ('get_marketplace_commission'), ('get_marketplace_setting'),
  ('claim_marketplace_negotiation'), ('release_marketplace_negotiation'),
  ('lock_marketplace_fare'), ('fetch_hybrid_opportunities')
) AS want(fn)
LEFT JOIN pg_proc p ON p.pronamespace = to_regnamespace('public') AND p.proname = want.fn
ORDER BY want.fn;

-- Indexes: one row per expected index.
SELECT '2. marketplace engine' AS section, 'index' AS check_name, want.ix AS object,
       CASE WHEN i.indexname IS NULL THEN 'ABSENT' ELSE 'EXISTS' END AS verdict,
       COALESCE(i.tablename, 'index not found in schema public') AS detail
FROM (VALUES
  ('idx_commission_overrides_lookup'), ('idx_fare_negotiations_job'),
  ('idx_driver_bids_job'), ('idx_driver_bids_driver'),
  ('idx_driver_job_declines_job'), ('idx_driver_job_declines_driver'),
  ('idx_marketplace_negotiation_sessions_job'), ('idx_marketplace_negotiation_sessions_driver'),
  ('idx_marketplace_negotiation_events_session')
) AS want(ix)
LEFT JOIN pg_indexes i ON i.schemaname = 'public' AND i.indexname = want.ix
ORDER BY want.ix;

-- Policies: one row per expected policy.
SELECT '2. marketplace engine' AS section, 'policy' AS check_name, want.pn AS object,
       CASE WHEN pol.oid IS NULL THEN 'ABSENT' ELSE 'EXISTS' END AS verdict,
       CASE WHEN pol.oid IS NULL THEN 'policy not found'
            ELSE 'on ' || COALESCE(c.relname, '<unknown relation>') || ' cmd=' || pol.polcmd::text END AS detail
FROM (VALUES
  ('marketplace_settings_admin_read'), ('marketplace_settings_admin_write'),
  ('commission_overrides_admin'), ('fare_negotiations_participants_read'),
  ('driver_bids_participants_read'), ('driver_job_declines_driver_all'),
  ('hybrid_sessions_owner_or_driver'), ('hybrid_sessions_owner_write'),
  ('hybrid_events_participants')
) AS want(pn)
LEFT JOIN pg_policy pol ON pol.polname = want.pn
LEFT JOIN pg_class c ON c.oid = pol.polrelid
ORDER BY want.pn;

-- Triggers: one row per expected trigger.
-- NOTE these six are NOT guarded by DROP TRIGGER IF EXISTS in the recovered
-- migration, so replaying that file where they already exist fails with 42710.
-- Their presence here is direct evidence that replay would be unsafe.
SELECT '2. marketplace engine' AS section, 'trigger' AS check_name, want.tn AS object,
       CASE WHEN tg.oid IS NULL THEN 'ABSENT' ELSE 'EXISTS' END AS verdict,
       CASE WHEN tg.oid IS NULL THEN 'trigger not found'
            ELSE 'on ' || COALESCE(c.relname, '<unknown relation>') || ' enabled=' || tg.tgenabled::text END AS detail
FROM (VALUES
  ('trg_marketplace_negotiation_sessions_updated_at'),
  ('trg_marketplace_negotiation_events_updated_at'),
  ('trg_marketplace_settings_updated_at'),
  ('trg_commission_overrides_updated_at'),
  ('trg_fare_negotiations_updated_at'),
  ('trg_driver_bids_updated_at')
) AS want(tn)
LEFT JOIN pg_trigger tg ON tg.tgname = want.tn AND NOT tg.tgisinternal
LEFT JOIN pg_class c ON c.oid = tg.tgrelid
ORDER BY want.tn;

-- ----------------------------------------------------------------------------
-- SECTION 3 - jobs columns added by the recovered migrations
--   to_regclass('public.jobs') returns NULL when jobs is absent, so every row
--   still emits and reports ABSENT instead of raising 42P01 (the rev 1 defect).
-- ----------------------------------------------------------------------------
SELECT '3. jobs columns' AS section, 'column required by recovered migration' AS check_name,
       want.col AS object,
       CASE WHEN a.attname IS NULL THEN 'ABSENT' ELSE 'EXISTS' END AS verdict,
       CASE WHEN to_regclass('public.jobs') IS NULL THEN 'relation public.jobs does not exist'
            WHEN a.attname IS NULL THEN 'column missing: recovered migration not applied'
            ELSE format_type(a.atttypid, a.atttypmod) || ' nullable=' || (NOT a.attnotnull)::text
                 || ' default=' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '<none>') END AS detail
FROM (VALUES
  ('fare_breakdown'),('dynamic_pricing_multiplier'),('negotiated_fare'),
  ('negotiation_deadline'),('bid_deadline'),('marketplace_flags'),
  ('bid_mode_enabled'),('negotiation_mode_enabled'),('agreed_fare'),
  ('driver_tier_at_assignment'),('city_zone'),('demand_score'),('supply_score'),
  ('distance_km'),('estimated_distance_km'),('distance_meters'),
  ('duration_seconds'),('estimated_duration')
) AS want(col)
LEFT JOIN pg_attribute a
  ON a.attrelid = to_regclass('public.jobs') AND a.attname = want.col
 AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
ORDER BY want.col;

-- ----------------------------------------------------------------------------
-- SECTION 4 - settlement columns written by committed code, no tracked definition
-- ----------------------------------------------------------------------------
SELECT '4. settlement columns' AS section, 'jobs column' AS check_name,
       want.col AS object,
       CASE WHEN a.attname IS NULL THEN 'ABSENT' ELSE 'EXISTS' END AS verdict,
       CASE WHEN to_regclass('public.jobs') IS NULL THEN 'relation public.jobs does not exist'
            WHEN a.attname IS NULL THEN 'column missing: no repository source defines it'
            ELSE format_type(a.atttypid, a.atttypmod) || ' nullable=' || (NOT a.attnotnull)::text
                 || ' default=' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '<none>') END AS detail
FROM (VALUES
  ('stripe_transfer_id'),('stripe_transfer_status'),('transferred_at'),
  ('completed_at'),('refund_id'),('cancellation_fee'),('payment_intent_id')
) AS want(col)
LEFT JOIN pg_attribute a
  ON a.attrelid = to_regclass('public.jobs') AND a.attname = want.col
 AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
ORDER BY want.col;

-- ----------------------------------------------------------------------------
-- SECTION 5 - pricing_config columns from 20260708180000 (no tracked lineage)
-- ----------------------------------------------------------------------------
SELECT '5. pricing_config columns' AS section, 'column' AS check_name,
       want.col AS object,
       CASE WHEN a.attname IS NULL THEN 'ABSENT' ELSE 'EXISTS' END AS verdict,
       CASE WHEN to_regclass('public.pricing_config') IS NULL THEN 'relation public.pricing_config does not exist'
            WHEN a.attname IS NULL THEN 'column missing: recovered migration not applied'
            ELSE format_type(a.atttypid, a.atttypmod) || ' nullable=' || (NOT a.attnotnull)::text
                 || ' default=' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '<none>') END AS detail
FROM (VALUES
  ('free_included_items'),('extra_item_fee'),('large_shopping_surcharge'),
  ('large_shopping_threshold'),('peak_multiplier'),('weather_multiplier')
) AS want(col)
LEFT JOIN pg_attribute a
  ON a.attrelid = to_regclass('public.pricing_config') AND a.attname = want.col
 AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
ORDER BY want.col;

-- ----------------------------------------------------------------------------
-- SECTION 6 - jobs_status_check definition (always emits exactly one row)
-- ----------------------------------------------------------------------------
SELECT '6. jobs status constraint' AS section, 'check constraint' AS check_name,
       'jobs_status_check' AS object,
       CASE WHEN con.oid IS NULL THEN 'ABSENT' ELSE 'EXISTS' END AS verdict,
       CASE WHEN to_regclass('public.jobs') IS NULL THEN 'relation public.jobs does not exist'
            WHEN con.oid IS NULL THEN 'no jobs_status_check constraint on public.jobs'
            ELSE pg_get_constraintdef(con.oid) END AS detail
FROM (SELECT 1) AS one
LEFT JOIN pg_constraint con
  ON con.conrelid = to_regclass('public.jobs')
 AND con.contype = 'c' AND con.conname = 'jobs_status_check';

-- ----------------------------------------------------------------------------
-- SECTION 7 - settlement tables used by completeJob / create-intent / webhook
-- ----------------------------------------------------------------------------
SELECT '7. settlement tables' AS section, 'table' AS check_name, want.obj AS object,
       CASE WHEN to_regclass(want.obj) IS NULL THEN 'ABSENT' ELSE 'EXISTS' END AS verdict,
       'required by committed server code' AS detail
FROM (VALUES
  ('public.wallets'),('public.wallet_transactions'),('public.driver_earnings'),
  ('public.errand_funding'),('public.stripe_events'),('public.job_queue'),
  ('public.audit_logs'),('public.jobs'),('public.pricing_config'),
  ('public.market_pricing_strategies'),('public.market_availability'),
  ('public.quote_market_adjustments'),('public.payments')
) AS want(obj)
ORDER BY want.obj;

-- driver_earnings: the completion short-circuit depends on UNIQUE(job_id).
SELECT '7. settlement tables' AS section, 'unique constraint' AS check_name,
       COALESCE(con.conname, 'driver_earnings job_id unique constraint') AS object,
       CASE WHEN con.oid IS NULL THEN 'ABSENT' ELSE 'EXISTS' END AS verdict,
       CASE WHEN to_regclass('public.driver_earnings') IS NULL THEN 'relation public.driver_earnings does not exist'
            WHEN con.oid IS NULL THEN 'no unique constraint on public.driver_earnings'
            ELSE pg_get_constraintdef(con.oid) END AS detail
FROM (SELECT 1) AS one
LEFT JOIN pg_constraint con
  ON con.conrelid = to_regclass('public.driver_earnings') AND con.contype = 'u';

-- ----------------------------------------------------------------------------
-- SECTION 8 - money-crediting wallet functions: EXECUTE matrix incl. PUBLIC
--   C0 found these have no GRANT/REVOKE anywhere in the repository. PostgreSQL
--   grants EXECUTE to PUBLIC by default, so when proacl IS NULL the effective
--   grantee set is PUBLIC - anon/authenticated could call them through PostgREST.
--   has_function_privilege() cannot test PUBLIC, hence aclexplode + grantee = 0.
-- ----------------------------------------------------------------------------
SELECT '8. wallet ACLs' AS section, 'function posture' AS check_name, want.fn AS object,
       CASE WHEN p.oid IS NULL THEN 'ABSENT' ELSE 'EXISTS' END AS verdict,
       CASE WHEN p.oid IS NULL THEN 'function not installed in schema public'
            ELSE 'security_definer=' || p.prosecdef::text
                 || ' search_path=' || COALESCE(array_to_string(p.proconfig, ','), '<UNPINNED>')
                 || ' proacl=' || COALESCE(p.proacl::text, '<NULL: implicit EXECUTE to PUBLIC>') END AS detail
FROM (VALUES
  ('increment_wallet_balance'),('credit_wallet_topup'),('finalize_wallet_topup'),
  ('pay_job_from_wallet'),('settle_job_wallet_reservation')
) AS want(fn)
LEFT JOIN pg_proc p ON p.pronamespace = to_regnamespace('public') AND p.proname = want.fn
ORDER BY want.fn;

-- Explicit EXECUTE grantees for whichever of those functions actually exists.
SELECT '8. wallet ACLs' AS section, 'EXECUTE grant' AS check_name,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object,
       'EXISTS' AS verdict,
       'grantee=' || COALESCE(r.rolname, 'PUBLIC') AS detail
FROM pg_proc p
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
LEFT JOIN pg_roles r ON r.oid = a.grantee
WHERE p.pronamespace = to_regnamespace('public')
  AND a.privilege_type = 'EXECUTE'
  AND p.proname IN ('increment_wallet_balance','credit_wallet_topup','finalize_wallet_topup','pay_job_from_wallet','settle_job_wallet_reservation')
ORDER BY p.proname, 5;

-- ----------------------------------------------------------------------------
-- SECTION 9 - Phase A compliance trigger state (must remain DISABLED = 'D')
-- ----------------------------------------------------------------------------
SELECT '9. phase A trigger' AS section, 'trigger state' AS check_name,
       'trg_enforce_job_acquisition_eligibility' AS object,
       CASE WHEN tg.oid IS NULL THEN 'ABSENT' ELSE 'EXISTS' END AS verdict,
       CASE WHEN to_regclass('public.jobs') IS NULL THEN 'relation public.jobs does not exist'
            WHEN tg.oid IS NULL THEN 'trigger not present on public.jobs'
            ELSE 'enabled=' || tg.tgenabled::text || ' (D = disabled, O = origin, A = always). MUST be D.'
       END AS detail
FROM (SELECT 1) AS one
LEFT JOIN pg_trigger tg
  ON tg.tgname = 'trg_enforce_job_acquisition_eligibility'
 AND tg.tgrelid = to_regclass('public.jobs')
 AND NOT tg.tgisinternal;

-- ----------------------------------------------------------------------------
-- SECTION 10 - verdict roll-up
-- ----------------------------------------------------------------------------
SELECT '10. verdict' AS section, 'jobs columns absent' AS check_name, NULL::text AS object,
       CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'NO-GO' END AS verdict,
       COUNT(*)::text || ' of 18 recovered-migration jobs columns are ABSENT' AS detail
FROM (VALUES
  ('fare_breakdown'),('dynamic_pricing_multiplier'),('negotiated_fare'),
  ('negotiation_deadline'),('bid_deadline'),('marketplace_flags'),
  ('bid_mode_enabled'),('negotiation_mode_enabled'),('agreed_fare'),
  ('driver_tier_at_assignment'),('city_zone'),('demand_score'),('supply_score'),
  ('distance_km'),('estimated_distance_km'),('distance_meters'),
  ('duration_seconds'),('estimated_duration')
) AS want(col)
LEFT JOIN pg_attribute a
  ON a.attrelid = to_regclass('public.jobs') AND a.attname = want.col
 AND a.attnum > 0 AND NOT a.attisdropped
WHERE a.attname IS NULL
UNION ALL
SELECT '10. verdict', 'settlement columns absent', NULL,
       CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'NO-GO' END,
       COUNT(*)::text || ' of 7 expected jobs settlement columns are ABSENT'
FROM (VALUES
  ('stripe_transfer_id'),('stripe_transfer_status'),('transferred_at'),
  ('completed_at'),('refund_id'),('cancellation_fee'),('payment_intent_id')
) AS want(col)
LEFT JOIN pg_attribute a
  ON a.attrelid = to_regclass('public.jobs') AND a.attname = want.col
 AND a.attnum > 0 AND NOT a.attisdropped
WHERE a.attname IS NULL
UNION ALL
SELECT '10. verdict', 'marketplace engine tables absent', NULL,
       CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'NO-GO' END,
       COUNT(*)::text || ' of 7 marketplace_engine tables are ABSENT'
FROM (VALUES
  ('public.marketplace_settings'),('public.marketplace_commission_overrides'),
  ('public.fare_negotiations'),('public.driver_bids'),('public.driver_job_declines'),
  ('public.marketplace_negotiation_sessions'),('public.marketplace_negotiation_events')
) AS want(obj)
WHERE to_regclass(want.obj) IS NULL;

-- ----------------------------------------------------------------------------
-- SECTION 11 - completion sentinel
--   A wrapper MUST require this row. Its absence means the script aborted and no
--   section's output may be trusted (the rev 1 failure mode).
-- ----------------------------------------------------------------------------
SELECT '11. completion' AS section, 'DIAGNOSTIC_COMPLETE' AS check_name, 'sentinel' AS object,
       'COMPLETED' AS verdict,
       'Every section above ran without aborting the READ ONLY transaction. If this row is '
       || 'missing from the output, the script stopped early and the run is INVALID.' AS detail;

ROLLBACK;

-- ============================================================================
-- END OF READ-ONLY DIAGNOSTIC - nothing above persists. BEGIN TRANSACTION READ
-- ONLY + ROLLBACK means a write would have raised 25006 rather than committing.
-- ============================================================================
