-- ============================================================================
-- MOVABI — PHASE C1 READ-ONLY SCHEMA LINEAGE DIAGNOSTIC
-- ============================================================================
--
-- PURPOSE
--   Establish, WITHOUT MUTATING ANYTHING, whether production actually contains
--   every object that the repository can no longer represent as lineage:
--     * the three untracked migrations
--         20260707000000_marketplace_engine.sql              (F3953FC8...)
--         20260708173000_marketplace_distance_duration_columns.sql (F0FCF6D0...)
--         20260708180000_shop_pricing_config_columns.sql     (A9B40EC9...)
--     * the six settlement columns C0 could not trace
--     * the two money-crediting wallet functions with no ACL lineage
--     * migration-state recording (does supabase_migrations exist at all?)
--
-- SAFETY CONTRACT — THIS SCRIPT IS READ-ONLY BY CONSTRUCTION
--   * It is wrapped in BEGIN TRANSACTION READ ONLY / ROLLBACK, so any accidental
--     write anywhere in the session fails with 25006 instead of persisting.
--   * Every statement is a SELECT. There is no INSERT/UPDATE/DELETE, no
--     CREATE/ALTER/DROP, no GRANT/REVOKE, no VACUUM, no ANALYZE, no SET.
--   * It never CALLS an application function. Application functions are only
--     introspected through pg_proc; invoking one (even a "read" helper) could
--     have side effects in a SECURITY DEFINER body, so none is invoked.
--   * It touches only: pg_catalog, information_schema, pg_proc, pg_class,
--     pg_attribute, pg_constraint, pg_index/pg_indexes, pg_trigger, pg_policy,
--     pg_roles, aclexplode(), acldefault(), to_regclass().
--
-- HOW TO READ THE OUTPUT
--   Every row is (section, check_name, object, verdict, detail) where verdict is
--   EXISTS / MISSING / PRESENT / ABSENT / UNKNOWN. Run section by section; a
--   NO-GO for C1 is any MISSING verdict in SECTION 2, 6, 7 or 9 while the
--   corresponding repository file is expected to have been applied.
--
-- THIS FILE IS NOT APPLIED BY ANY TOOLING. It is not in supabase/migrations,
--   it has no version prefix, and nothing in package.json or CI invokes it.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;

-- ----------------------------------------------------------------------------
-- SECTION 0 — environment
-- ----------------------------------------------------------------------------
SELECT '0. env' AS section, 'server_version' AS check_name, NULL::text AS object,
       'PRESENT' AS verdict, current_setting('server_version') AS detail
UNION ALL SELECT '0. env', 'database', NULL, 'PRESENT', current_database()
UNION ALL SELECT '0. env', 'current_user', NULL, 'PRESENT', current_user
UNION ALL SELECT '0. env', 'search_path', NULL, 'PRESENT', current_setting('search_path');

-- ----------------------------------------------------------------------------
-- SECTION 1 — migration state recording
--   Determines whether ANY tool records applied migrations. If
--   supabase_migrations.schema_migrations is ABSENT, migration state is not
--   recorded in-database and `supabase db push` cannot be used to reason about
--   what has been applied - which is exactly why replay is a live risk.
-- ----------------------------------------------------------------------------
SELECT '1. migration state' AS section, 'schema supabase_migrations' AS check_name,
       NULL::text AS object,
       CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'supabase_migrations')
            THEN 'PRESENT' ELSE 'ABSENT' END AS verdict,
       'CLI migration-state schema' AS detail
UNION ALL
SELECT '1. migration state', 'table schema_migrations', 'supabase_migrations.schema_migrations',
       CASE WHEN to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
            THEN 'PRESENT' ELSE 'ABSENT' END,
       'authoritative applied-migration ledger for supabase CLI';

-- Applied versions, if the ledger exists. (Returns no rows when it does not.)
SELECT '1. migration state' AS section, 'applied version' AS check_name,
       version::text AS object, 'PRESENT' AS verdict, COALESCE(name, '') AS detail
FROM supabase_migrations.schema_migrations
ORDER BY version;

-- ----------------------------------------------------------------------------
-- SECTION 2 — objects expected from 20260707000000_marketplace_engine.sql
-- ----------------------------------------------------------------------------
SELECT '2. marketplace engine' AS section, kind AS check_name, obj AS object,
       CASE WHEN to_regclass(obj) IS NOT NULL THEN 'EXISTS' ELSE 'MISSING' END AS verdict,
       obj AS detail
FROM (VALUES
  ('table',  'public.marketplace_settings'),
  ('table',  'public.marketplace_commission_overrides'),
  ('table',  'public.fare_negotiations'),
  ('table',  'public.driver_bids'),
  ('table',  'public.driver_job_declines'),
  ('table',  'public.marketplace_negotiation_sessions'),
  ('table',  'public.marketplace_negotiation_events')
) AS t(kind, obj)
ORDER BY obj;

-- Functions created by that file (existence + identity + ACL posture).
SELECT '2. marketplace engine' AS section, 'function' AS check_name,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object,
       'EXISTS' AS verdict,
       'security_definer=' || p.prosecdef::text
       || ' volatility=' || p.provolatile::text
       || ' search_path=' || COALESCE(array_to_string(p.proconfig, ','), '<UNPINNED>') AS detail
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN (
    'get_marketplace_commission','get_marketplace_setting',
    'claim_marketplace_negotiation','release_marketplace_negotiation',
    'lock_marketplace_fare','fetch_hybrid_opportunities'
  )
ORDER BY p.proname;

-- Indexes created by that file.
SELECT '2. marketplace engine' AS section, 'index' AS check_name, i.indexname AS object,
       'EXISTS' AS verdict, i.tablename AS detail
FROM pg_indexes i
WHERE i.schemaname = 'public'
  AND i.indexname IN (
    'idx_commission_overrides_lookup','idx_fare_negotiations_job',
    'idx_driver_bids_job','idx_driver_bids_driver',
    'idx_driver_job_declines_job','idx_driver_job_declines_driver',
    'idx_marketplace_negotiation_sessions_job','idx_marketplace_negotiation_sessions_driver',
    'idx_marketplace_negotiation_events_session'
  )
ORDER BY i.indexname;

-- Policies created by that file.
SELECT '2. marketplace engine' AS section, 'policy' AS check_name,
       pol.polname || ' ON ' || c.relname AS object, 'EXISTS' AS verdict,
       'cmd=' || pol.polcmd::text AS detail
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
WHERE c.relnamespace = 'public'::regnamespace
  AND pol.polname IN (
    'marketplace_settings_admin_read','marketplace_settings_admin_write',
    'commission_overrides_admin','fare_negotiations_participants_read',
    'driver_bids_participants_read','driver_job_declines_driver_all',
    'hybrid_sessions_owner_or_driver','hybrid_sessions_owner_write',
    'hybrid_events_participants'
  )
ORDER BY pol.polname;

-- Triggers created by that file. NOTE: these six are NOT guarded by
-- DROP TRIGGER IF EXISTS in the source, so re-running that migration would fail
-- with 42710 where they already exist. Their presence here is therefore direct
-- evidence that replaying the file is unsafe.
SELECT '2. marketplace engine' AS section, 'trigger' AS check_name,
       tg.tgname || ' ON ' || c.relname AS object, 'EXISTS' AS verdict,
       'enabled=' || tg.tgenabled::text AS detail
FROM pg_trigger tg
JOIN pg_class c ON c.oid = tg.tgrelid
WHERE NOT tg.tgisinternal
  AND tg.tgname IN (
    'trg_marketplace_negotiation_sessions_updated_at',
    'trg_marketplace_negotiation_events_updated_at',
    'trg_marketplace_settings_updated_at',
    'trg_commission_overrides_updated_at',
    'trg_fare_negotiations_updated_at',
    'trg_driver_bids_updated_at'
  )
ORDER BY tg.tgname;

-- ----------------------------------------------------------------------------
-- SECTION 3 — jobs columns added by the untracked migrations
--   These have NO tracked definition anywhere in the repository, yet committed
--   server code and committed migrations both read them.
-- ----------------------------------------------------------------------------
SELECT '3. jobs columns' AS section,
       'untracked-migration column' AS check_name,
       a.attname AS object,
       CASE WHEN a.attname IS NOT NULL THEN 'EXISTS' ELSE 'MISSING' END AS verdict,
       format_type(a.atttypid, a.atttypmod) || ' nullable=' || (NOT a.attnotnull)::text
       || ' default=' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '<none>')
       || ' -- source: 20260707000000_marketplace_engine.sql + 20260708173000' AS detail
FROM (VALUES
  ('fare_breakdown'),('dynamic_pricing_multiplier'),('negotiated_fare'),
  ('negotiation_deadline'),('bid_deadline'),('marketplace_flags'),
  ('bid_mode_enabled'),('negotiation_mode_enabled'),('agreed_fare'),
  ('driver_tier_at_assignment'),('city_zone'),('demand_score'),('supply_score'),
  ('distance_km'),('estimated_distance_km'),('distance_meters'),
  ('duration_seconds'),('estimated_duration')
) AS want(col)
LEFT JOIN pg_attribute a
  ON a.attrelid = 'public.jobs'::regclass AND a.attname = want.col AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
ORDER BY want.col;

-- ----------------------------------------------------------------------------
-- SECTION 4 — untraced settlement columns (C0 open question)
--   Written by committed server code; defined by no repository source.
-- ----------------------------------------------------------------------------
SELECT '4. settlement columns' AS section, 'jobs column' AS check_name,
       a.attname AS object,
       CASE WHEN a.attname IS NOT NULL THEN 'EXISTS' ELSE 'MISSING' END AS verdict,
       format_type(a.atttypid, a.atttypmod) || ' nullable=' || (NOT a.attnotnull)::text
       || ' default=' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '<none>') AS detail
FROM (VALUES
  ('stripe_transfer_id'),('stripe_transfer_status'),('transferred_at'),
  ('completed_at'),('refund_id'),('cancellation_fee'),
  ('payment_intent_id')
) AS want(col)
LEFT JOIN pg_attribute a
  ON a.attrelid = 'public.jobs'::regclass AND a.attname = want.col AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
ORDER BY want.col;

-- ----------------------------------------------------------------------------
-- SECTION 5 — pricing_config columns from 20260708180000 (no tracked lineage)
-- ----------------------------------------------------------------------------
SELECT '5. pricing_config columns' AS section, 'column' AS check_name,
       a.attname AS object,
       CASE WHEN a.attname IS NOT NULL THEN 'EXISTS' ELSE 'MISSING' END AS verdict,
       format_type(a.atttypid, a.atttypmod) || ' nullable=' || (NOT a.attnotnull)::text
       || ' default=' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '<none>') AS detail
FROM (VALUES
  ('free_included_items'),('extra_item_fee'),('large_shopping_surcharge'),
  ('large_shopping_threshold'),('peak_multiplier'),('weather_multiplier')
) AS want(col)
LEFT JOIN pg_attribute a
  ON a.attrelid = 'public.pricing_config'::regclass AND a.attname = want.col AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
ORDER BY want.col;

-- ----------------------------------------------------------------------------
-- SECTION 6 — jobs_status_check definition
--   Defined differently by the untracked migration (30 statuses) and by tracked
--   01_jobs_status_constraint.sql / the reconcile dump. Print the LIVE text.
-- ----------------------------------------------------------------------------
SELECT '6. jobs status constraint' AS section, 'check constraint' AS check_name,
       con.conname AS object, 'EXISTS' AS verdict, pg_get_constraintdef(con.oid) AS detail
FROM pg_constraint con
WHERE con.conrelid = 'public.jobs'::regclass
  AND con.contype = 'c'
  AND con.conname = 'jobs_status_check';

-- ----------------------------------------------------------------------------
-- SECTION 7 — settlement tables used by completeJob / create-intent / webhook
-- ----------------------------------------------------------------------------
SELECT '7. settlement tables' AS section, 'table' AS check_name, obj AS object,
       CASE WHEN to_regclass(obj) IS NOT NULL THEN 'EXISTS' ELSE 'MISSING' END AS verdict,
       'required by committed server code' AS detail
FROM (VALUES
  ('public.wallets'),('public.wallet_transactions'),('public.driver_earnings'),
  ('public.errand_funding'),('public.stripe_events'),('public.job_queue'),
  ('public.audit_logs'),('public.jobs'),('public.pricing_config'),
  ('public.market_pricing_strategies'),('public.market_availability'),
  ('public.quote_market_adjustments'),('public.payments')
) AS t(obj)
ORDER BY obj;

-- driver_earnings: the completion short-circuit depends on UNIQUE(job_id).
SELECT '7. settlement tables' AS section, 'unique constraint' AS check_name,
       con.conname AS object, 'EXISTS' AS verdict, pg_get_constraintdef(con.oid) AS detail
FROM pg_constraint con
WHERE con.conrelid = to_regclass('public.driver_earnings')
  AND con.contype = 'u';

-- ----------------------------------------------------------------------------
-- SECTION 8 — money-crediting wallet functions: EXECUTE matrix incl. PUBLIC
--   C0 found these two have no GRANT/REVOKE anywhere in the repository.
--   PostgreSQL grants EXECUTE to PUBLIC by default, so if proacl is NULL the
--   effective grantee set is PUBLIC - i.e. anon/authenticated can call them
--   through PostgREST unless a role-level REVOKE exists somewhere out of band.
--   has_function_privilege() cannot test PUBLIC, hence aclexplode + grantee = 0.
-- ----------------------------------------------------------------------------
SELECT '8. wallet ACLs' AS section,
       'EXECUTE grant' AS check_name,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object,
       'EXISTS' AS verdict,
       'grantee=' || COALESCE(r.rolname, 'PUBLIC') AS detail
FROM pg_proc p
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
LEFT JOIN pg_roles r ON r.oid = a.grantee
WHERE p.pronamespace = 'public'::regnamespace
  AND a.privilege_type = 'EXECUTE'
  AND p.proname IN ('increment_wallet_balance','credit_wallet_topup','finalize_wallet_topup','pay_job_from_wallet')
ORDER BY p.proname, 5;

-- Explicit proacl text (NULL means "never touched" -> implicit PUBLIC EXECUTE).
SELECT '8. wallet ACLs' AS section, 'proacl raw' AS check_name,
       p.proname AS object, 'PRESENT' AS verdict,
       COALESCE(p.proacl::text, '<NULL: implicit EXECUTE to PUBLIC>') AS detail
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('increment_wallet_balance','credit_wallet_topup','finalize_wallet_topup','pay_job_from_wallet','settle_job_wallet_reservation')
ORDER BY p.proname;

-- ----------------------------------------------------------------------------
-- SECTION 9 — Phase A compliance trigger state (must remain DISABLED)
-- ----------------------------------------------------------------------------
SELECT '9. phase A trigger' AS section, 'trigger state' AS check_name,
       tg.tgname AS object, 'PRESENT' AS verdict,
       'enabled=' || tg.tgenabled::text
       || ' (D = disabled, O = origin, A = always) -- MUST be D' AS detail
FROM pg_trigger tg
WHERE tg.tgname = 'trg_enforce_job_acquisition_eligibility';

-- ----------------------------------------------------------------------------
-- SECTION 10 — verdict roll-up
-- ----------------------------------------------------------------------------
SELECT '10. verdict' AS section, 'jobs columns missing' AS check_name, NULL::text AS object,
       CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'NO-GO' END AS verdict,
       COUNT(*)::text || ' of 18 untracked-migration jobs columns missing from production' AS detail
FROM (VALUES
  ('fare_breakdown'),('dynamic_pricing_multiplier'),('negotiated_fare'),
  ('negotiation_deadline'),('bid_deadline'),('marketplace_flags'),
  ('bid_mode_enabled'),('negotiation_mode_enabled'),('agreed_fare'),
  ('driver_tier_at_assignment'),('city_zone'),('demand_score'),('supply_score'),
  ('distance_km'),('estimated_distance_km'),('distance_meters'),
  ('duration_seconds'),('estimated_duration')
) AS want(col)
LEFT JOIN pg_attribute a
  ON a.attrelid = 'public.jobs'::regclass AND a.attname = want.col AND a.attnum > 0 AND NOT a.attisdropped
WHERE a.attname IS NULL;

ROLLBACK;

-- ============================================================================
-- END OF READ-ONLY DIAGNOSTIC — nothing above persists. BEGIN READ ONLY +
-- ROLLBACK means a write would have raised 25006 rather than committing.
-- ============================================================================
