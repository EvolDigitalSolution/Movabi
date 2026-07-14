-- Movabi auth-schema duplicate application table audit.
--
-- Purpose:
--   Identify accidental Movabi application tables in the auth schema and
--   classify whether each one is empty, contains data, or has dependencies.
--
-- Safety:
--   This script does not drop, rename, delete, or migrate data.
--   It does not touch Supabase realtime daily partitions.
--   Review every result before running any cleanup manually.
--   Never use DROP CASCADE for these tables.

BEGIN;

CREATE TEMP TABLE IF NOT EXISTS auth_duplicate_app_table_audit (
  table_name text PRIMARY KEY,
  auth_table_exists boolean NOT NULL DEFAULT false,
  public_table_exists boolean NOT NULL DEFAULT false,
  auth_row_count bigint,
  public_row_count bigint,
  auth_columns text,
  public_columns text,
  auth_primary_keys integer,
  public_primary_keys integer,
  auth_foreign_keys integer,
  public_foreign_keys integer,
  auth_indexes integer,
  public_indexes integer,
  auth_rls_enabled boolean,
  public_rls_enabled boolean,
  auth_newest_updated_at timestamptz,
  public_newest_updated_at timestamptz,
  auth_dependency_count integer,
  classification text,
  suggested_cleanup_sql text
) ON COMMIT DROP;

TRUNCATE auth_duplicate_app_table_audit;

DO $$
DECLARE
  v_table text;
  v_auth_reg regclass;
  v_public_reg regclass;
  v_auth_has_updated_at boolean;
  v_public_has_updated_at boolean;
  v_auth_row_count bigint;
  v_public_row_count bigint;
  v_auth_newest_updated_at timestamptz;
  v_public_newest_updated_at timestamptz;
  v_auth_dependency_count integer;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'cities',
    'dispatch_logs',
    'driver_earnings',
    'errand_funding',
    'fixed_fare_bands',
    'job_messages',
    'job_queue',
    'job_service_details',
    'jobs',
    'payout_batches',
    'pricing_config',
    'pricing_rules',
    'ratings',
    'service_types',
    'stripe_events',
    'wallet_transactions',
    'wallets'
  ]
  LOOP
    v_auth_reg := to_regclass(format('auth.%I', v_table));
    v_public_reg := to_regclass(format('public.%I', v_table));
    v_auth_has_updated_at := false;
    v_public_has_updated_at := false;
    v_auth_row_count := NULL;
    v_public_row_count := NULL;
    v_auth_newest_updated_at := NULL;
    v_public_newest_updated_at := NULL;
    v_auth_dependency_count := 0;

    IF v_auth_reg IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM auth.%I', v_table)
      INTO v_auth_row_count;

      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'auth'
          AND table_name = v_table
          AND column_name = 'updated_at'
      )
      INTO v_auth_has_updated_at;

      IF v_auth_has_updated_at THEN
        EXECUTE format('SELECT max(updated_at) FROM auth.%I', v_table)
        INTO v_auth_newest_updated_at;
      END IF;

      SELECT count(*)
      FROM pg_depend
      WHERE refobjid = v_auth_reg
        AND deptype IN ('n', 'a')
      INTO v_auth_dependency_count;
    END IF;

    IF v_public_reg IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', v_table)
      INTO v_public_row_count;

      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = v_table
          AND column_name = 'updated_at'
      )
      INTO v_public_has_updated_at;

      IF v_public_has_updated_at THEN
        EXECUTE format('SELECT max(updated_at) FROM public.%I', v_table)
        INTO v_public_newest_updated_at;
      END IF;
    END IF;

    INSERT INTO auth_duplicate_app_table_audit (
      table_name,
      auth_table_exists,
      public_table_exists,
      auth_row_count,
      public_row_count,
      auth_columns,
      public_columns,
      auth_primary_keys,
      public_primary_keys,
      auth_foreign_keys,
      public_foreign_keys,
      auth_indexes,
      public_indexes,
      auth_rls_enabled,
      public_rls_enabled,
      auth_newest_updated_at,
      public_newest_updated_at,
      auth_dependency_count,
      classification,
      suggested_cleanup_sql
    )
    SELECT
      v_table,
      v_auth_reg IS NOT NULL,
      v_public_reg IS NOT NULL,
      v_auth_row_count,
      v_public_row_count,
      (
        SELECT string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position)
        FROM information_schema.columns
        WHERE table_schema = 'auth'
          AND table_name = v_table
      ),
      (
        SELECT string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position)
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = v_table
      ),
      (
        SELECT count(*)
        FROM information_schema.table_constraints
        WHERE table_schema = 'auth'
          AND table_name = v_table
          AND constraint_type = 'PRIMARY KEY'
      ),
      (
        SELECT count(*)
        FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = v_table
          AND constraint_type = 'PRIMARY KEY'
      ),
      (
        SELECT count(*)
        FROM information_schema.table_constraints
        WHERE table_schema = 'auth'
          AND table_name = v_table
          AND constraint_type = 'FOREIGN KEY'
      ),
      (
        SELECT count(*)
        FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = v_table
          AND constraint_type = 'FOREIGN KEY'
      ),
      (
        SELECT count(*)
        FROM pg_indexes
        WHERE schemaname = 'auth'
          AND tablename = v_table
      ),
      (
        SELECT count(*)
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = v_table
      ),
      (
        SELECT c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'auth'
          AND c.relname = v_table
      ),
      (
        SELECT c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = v_table
      ),
      v_auth_newest_updated_at,
      v_public_newest_updated_at,
      v_auth_dependency_count,
      CASE
        WHEN v_auth_reg IS NULL THEN 'not_present'
        WHEN COALESCE(v_auth_row_count, 0) = 0 AND COALESCE(v_auth_dependency_count, 0) = 0
          THEN 'empty_and_safe_to_drop_after_review'
        WHEN COALESCE(v_auth_dependency_count, 0) > 0
          THEN 'has_dependencies_requiring_repair'
        WHEN COALESCE(v_auth_row_count, 0) > 0
          THEN 'contains_unique_data_requiring_merge_review'
        ELSE 'manual_review'
      END,
      CASE
        WHEN v_auth_reg IS NOT NULL
          AND COALESCE(v_auth_row_count, 0) = 0
          AND COALESCE(v_auth_dependency_count, 0) = 0
          THEN format('-- Review first, then run manually only if approved: DROP TABLE auth.%I;', v_table)
        ELSE NULL
      END;
  END LOOP;
END;
$$;

SELECT *
FROM auth_duplicate_app_table_audit
ORDER BY
  CASE classification
    WHEN 'contains_unique_data_requiring_merge_review' THEN 1
    WHEN 'has_dependencies_requiring_repair' THEN 2
    WHEN 'manual_review' THEN 3
    WHEN 'empty_and_safe_to_drop_after_review' THEN 4
    ELSE 5
  END,
  table_name;

COMMIT;

-- Additional manual verification before cleanup:
-- 1. Confirm code no longer references auth.<table_name>.
-- 2. Confirm migrations fully qualify Movabi tables with public.<table_name>.
-- 3. Confirm Supabase Auth login/signup/session refresh works.
-- 4. Apply only reviewed non-cascade DROP statements in a separate maintenance window.
