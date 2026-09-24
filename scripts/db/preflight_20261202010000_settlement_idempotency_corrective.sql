-- ============================================================================
-- MOVABI PHASE C2C — CORRECTIVE PREFLIGHT (schema-qualified wallet idempotency)
-- READ ONLY. Run BEFORE supabase/migrations/20261202010000_settlement_idempotency_corrective.sql
-- ============================================================================
--
-- Verifies the PRODUCTION POST-DEFECT state that the corrective migration
-- expects, so the corrective migration can only run when:
--   * public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid) still exists and
--     is STILL PRE-C2C (the intended guard did NOT reach it);
--   * the accidental auth.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)
--     overload EXISTS and carries the intended guard (proof of the defect);
--   * ACL, schema prerequisites, Phase A, and the frozen N12 set are intact.
--
-- READ ONLY by construction: BEGIN TRANSACTION READ ONLY / ROLLBACK; catalog
-- reads only. Every requirement is an executable RAISE in the DO block; a
-- condition that only appears in an informational SELECT is NOT sufficient.
-- Any violation raises so `psql -v ON_ERROR_STOP=1` exits non-zero.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;

-- 1. public target posture (PRE-C2C expected: guard absent, old anchor present).
SELECT 'corrective_preflight' AS section, 'public pay_job_from_wallet posture' AS check_name,
       'public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)' AS object,
       CASE
         WHEN to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)') IS NULL THEN 'MISSING'
         WHEN p.prosecdef THEN 'DRIFT: SECURITY DEFINER'
         WHEN array_to_string(p.proconfig, ',') LIKE '%search_path%' THEN 'DRIFT: search_path pinned'
         WHEN pg_get_functiondef(p.oid) LIKE '%v_job.payment_method = ''wallet'' OR v_job.payment_status = ''wallet_funded''%'
              THEN 'DRIFT: guard already present'
         ELSE 'EXPECTED PRE-C2C POSTURE'
       END AS verdict,
       'security_definer=' || p.prosecdef::text
       || ' search_path=' || COALESCE(array_to_string(p.proconfig, ','), '<UNPINNED>')
       || ' old_anchor=' || CASE WHEN pg_get_functiondef(p.oid) LIKE '%v_job.status IN (''cancelled'', ''completed'')%'
                                 THEN 'yes' ELSE 'NO' END AS detail
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)');

-- 2. accidental auth overload (must EXIST and carry the intended guard).
SELECT 'corrective_preflight' AS section, 'accidental auth overload' AS check_name,
       'auth.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)' AS object,
       CASE
         WHEN to_regprocedure('auth.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)') IS NULL THEN 'MISSING'
         WHEN pg_get_functiondef(p.oid) LIKE '%v_job.payment_method = ''wallet'' OR v_job.payment_status = ''wallet_funded''%'
              THEN 'PRESENT WITH GUARD'
         ELSE 'PRESENT WITHOUT GUARD'
       END AS verdict,
       'security_definer=' || p.prosecdef::text
       || ' search_path=' || COALESCE(array_to_string(p.proconfig, ','), '<UNPINNED>') AS detail
FROM pg_proc p
WHERE p.oid = to_regprocedure('auth.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)');

-- 3. public EXECUTE matrix (informational).
SELECT 'corrective_preflight' AS section, 'EXECUTE grant' AS check_name,
       n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS object,
       'EXISTS' AS verdict,
       'grantee=' || COALESCE(r.rolname, 'PUBLIC') AS detail
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
LEFT JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname = 'public'
  AND p.proname = 'pay_job_from_wallet'
  AND a.privilege_type = 'EXECUTE'
ORDER BY 3, 5;

-- 4. required columns (informational).
SELECT 'corrective_preflight' AS section, 'required column' AS check_name,
       want.tbl || '.' || want.col AS object,
       CASE WHEN c.column_name IS NULL THEN 'MISSING' ELSE 'EXISTS' END AS verdict,
       'referenced by pay_job_from_wallet' AS detail
FROM (VALUES
  ('jobs','id'), ('jobs','customer_id'), ('jobs','status'),
  ('jobs','payment_status'), ('jobs','payment_method'), ('jobs','payment_intent_id'),
  ('jobs','total_price'), ('jobs','price'), ('jobs','confirmed_at'), ('jobs','updated_at'),
  ('wallets','id'), ('wallets','user_id'), ('wallets','currency_code'),
  ('wallets','available_balance'), ('wallets','reserved_balance'), ('wallets','updated_at'),
  ('wallet_transactions','user_id'), ('wallet_transactions','job_id'),
  ('wallet_transactions','amount'), ('wallet_transactions','description'),
  ('wallet_transactions','metadata')
) AS want(tbl, col)
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col
ORDER BY want.tbl, want.col;

-- 5. Phase A trigger (informational).
SELECT 'corrective_preflight' AS section, 'phase A trigger' AS check_name,
       'trg_enforce_job_acquisition_eligibility' AS object,
       CASE WHEN tg.tgenabled = 'D' THEN 'PASS' ELSE 'FAIL' END AS verdict,
       'enabled=' || COALESCE(tg.tgenabled::text, '<absent>') AS detail
FROM (SELECT 1) AS one
LEFT JOIN pg_trigger tg
  ON tg.tgname = 'trg_enforce_job_acquisition_eligibility'
 AND tg.tgrelid = to_regclass('public.jobs')
 AND NOT tg.tgisinternal;

-- 6. N12 index (informational).
SELECT 'corrective_preflight' AS section, 'N12 index' AS check_name,
       'idx_jobs_one_active_per_driver' AS object,
       CASE WHEN i.indexrelid IS NULL OR NOT i.indisunique OR NOT i.indisvalid THEN 'FAIL' ELSE 'PASS' END AS verdict,
       CASE WHEN i.indexrelid IS NULL THEN 'missing'
            ELSE 'unique=' || i.indisunique::text || ' valid=' || i.indisvalid::text END AS detail
FROM (SELECT 1) AS one
LEFT JOIN pg_index i
  ON i.indrelid = to_regclass('public.jobs')
 AND i.indexrelid = to_regclass('public.idx_jobs_one_active_per_driver');

-- 7. HARD GATE. Every requirement below must RAISE for the preflight to fail closed.
DO $$
DECLARE
  missing_cols text := '';
  has_type_col boolean;
  v_prosecdef boolean;
  v_proconfig text;
  v_def text;
  v_helper text[];
  v_predicate text[];
  v_helper_only text[];
  v_predicate_only text[];
BEGIN
  -- A. exact public signature exists.
  IF to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'NO-GO: public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid) does not exist';
  END IF;

  -- B. exactly one public overload.
  IF (SELECT count(*) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'pay_job_from_wallet') <> 1 THEN
    RAISE EXCEPTION 'NO-GO: expected exactly one public pay_job_from_wallet overload';
  END IF;

  -- C/D/E/F. public posture: INVOKER, unpinned search_path, PRE-C2C body.
  SELECT p.prosecdef, array_to_string(p.proconfig, ','), pg_get_functiondef(p.oid)
    INTO v_prosecdef, v_proconfig, v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.oid = to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)');

  IF v_prosecdef THEN
    RAISE EXCEPTION 'NO-GO: public pay_job_from_wallet is SECURITY DEFINER (expected INVOKER)';
  END IF;
  IF COALESCE(v_proconfig, '') LIKE '%search_path%' THEN
    RAISE EXCEPTION 'NO-GO: public pay_job_from_wallet has a pinned search_path';
  END IF;
  IF v_def LIKE '%v_job.payment_method = ''wallet'' OR v_job.payment_status = ''wallet_funded''%' THEN
    RAISE EXCEPTION 'NO-GO: public pay_job_from_wallet already contains the C2C guard';
  END IF;
  IF v_def NOT LIKE '%v_job.status IN (''cancelled'', ''completed'')%' THEN
    RAISE EXCEPTION 'NO-GO: public pay_job_from_wallet missing the pre-C2C terminal-status anchor';
  END IF;

  -- G. accidental auth overload EXISTS and carries the exact guard.
  IF to_regprocedure('auth.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'NO-GO: accidental auth.pay_job_from_wallet overload not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'pay_job_from_wallet'
      AND pg_get_functiondef(p.oid) LIKE '%v_job.payment_method = ''wallet'' OR v_job.payment_status = ''wallet_funded''%'
  ) THEN
    RAISE EXCEPTION 'NO-GO: auth.pay_job_from_wallet does not contain the exact C2C guard';
  END IF;

  -- H. public ACL: service_role yes; PUBLIC/anon/authenticated no.
  IF NOT has_function_privilege('service_role', 'public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'NO-GO: service_role lacks EXECUTE on public.pay_job_from_wallet';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_roles r ON r.oid = a.grantee
    WHERE n.nspname = 'public' AND p.proname = 'pay_job_from_wallet'
      AND a.privilege_type = 'EXECUTE'
      AND (a.grantee = 0 OR COALESCE(r.rolname,'') IN ('anon','authenticated'))
  ) THEN
    RAISE EXCEPTION 'NO-GO: PUBLIC/anon/authenticated has EXECUTE on public.pay_job_from_wallet';
  END IF;

  -- I. required columns.
  SELECT string_agg(tbl || '.' || col, ', ')
    INTO missing_cols
    FROM (VALUES
      ('jobs','id'), ('jobs','customer_id'), ('jobs','status'),
      ('jobs','payment_status'), ('jobs','payment_method'), ('jobs','payment_intent_id'),
      ('jobs','total_price'), ('jobs','price'), ('jobs','confirmed_at'), ('jobs','updated_at'),
      ('wallets','id'), ('wallets','user_id'), ('wallets','currency_code'),
      ('wallets','available_balance'), ('wallets','reserved_balance'), ('wallets','updated_at'),
      ('wallet_transactions','user_id'), ('wallet_transactions','job_id'),
      ('wallet_transactions','amount'), ('wallet_transactions','description'),
      ('wallet_transactions','metadata')
    ) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col
    );
  IF missing_cols IS NOT NULL THEN
    RAISE EXCEPTION 'NO-GO: missing required column(s): %', missing_cols;
  END IF;

  -- J. wallet_transactions type column.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'wallet_transactions'
      AND column_name IN ('transaction_type', 'type')
  ) INTO has_type_col;
  IF NOT has_type_col THEN
    RAISE EXCEPTION 'NO-GO: wallet_transactions has neither transaction_type nor type';
  END IF;

  -- K. Phase A trigger EXISTS, non-internal, disabled.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    WHERE tg.tgname = 'trg_enforce_job_acquisition_eligibility'
      AND tg.tgrelid = to_regclass('public.jobs')
      AND NOT tg.tgisinternal
      AND tg.tgenabled = 'D'
  ) THEN
    RAISE EXCEPTION 'NO-GO: Phase A trigger missing or not disabled';
  END IF;

  -- L. N12 index unique and valid.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = to_regclass('public.jobs')
      AND i.indexrelid = to_regclass('public.idx_jobs_one_active_per_driver')
      AND i.indisunique AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'NO-GO: idx_jobs_one_active_per_driver missing, not unique, or not valid';
  END IF;

  -- M. N12 frozen predicate matches driver_occupying_statuses() exactly.
  v_helper := public.driver_occupying_statuses();
  SELECT array_agg(lit ORDER BY lit)
    INTO v_predicate
    FROM (
      SELECT DISTINCT (m.match)[1] AS lit
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      CROSS JOIN LATERAL pg_catalog.regexp_matches(
        pg_catalog.pg_get_expr(i.indpred, i.indrelid),
        '''([^'']*)''', 'g'
      ) AS m(match)
      WHERE ic.relname = 'idx_jobs_one_active_per_driver'
        AND i.indrelid = to_regclass('public.jobs')
    ) lits;

  IF array_length(v_helper, 1) IS DISTINCT FROM array_length(v_predicate, 1) THEN
    RAISE EXCEPTION 'NO-GO: N12 predicate status cardinality diverged from frozen set';
  END IF;
  SELECT array_agg(x ORDER BY x) INTO v_helper_only
  FROM unnest(v_helper) AS u(x)
  WHERE NOT x = ANY(v_predicate);
  SELECT array_agg(x ORDER BY x) INTO v_predicate_only
  FROM unnest(v_predicate) AS u(x)
  WHERE NOT x = ANY(v_helper);
  IF v_helper_only IS NOT NULL OR v_predicate_only IS NOT NULL THEN
    RAISE EXCEPTION 'NO-GO: N12 predicate status set diverged from frozen set';
  END IF;
END
$$;

-- 8. Sentinel (only reached when every hard gate passes).
SELECT 'corrective_preflight' AS section, 'CORRECTIVE_PREFLIGHT_COMPLETE' AS check_name, 'sentinel' AS object,
       'PASS' AS verdict,
       'public PRE-C2C posture, accidental auth overload, ACL, columns, Phase A disabled, and N12 frozen set verified. '
       || 'If this row is absent the preflight aborted.' AS detail;

ROLLBACK;
