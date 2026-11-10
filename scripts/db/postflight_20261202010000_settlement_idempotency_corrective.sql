-- ============================================================================
-- MOVABI PHASE C2C — CORRECTIVE POSTFLIGHT (schema-qualified wallet idempotency)
-- READ ONLY. Run AFTER supabase/migrations/20261202010000_settlement_idempotency_corrective.sql
-- ============================================================================
--
-- Verifies the corrected production state:
--   * public.pay_job_from_wallet now carries the intended C2C guard, and the
--     guard is PROVEN structurally (guard string present, 'already_paid' return
--     present, and the guard occurs BEFORE wallet INSERT / wallet UPDATE /
--     jobs UPDATE);
--   * the accidental auth.pay_job_from_wallet overload is GONE;
--   * ACL, Phase A, N12 (unique+valid and exact frozen 16-status predicate),
--     and required columns remain intact.
--
-- READ ONLY by construction: BEGIN TRANSACTION READ ONLY / ROLLBACK; catalog
-- reads only. Every requirement is an executable RAISE in the DO block. The
-- sentinel is CORRECTIVE_POSTFLIGHT_COMPLETE | PASS and is only reached when
-- every gate passes. This file also fixes two production postflight defects:
--   BUG 1: a loose pg_get_functiondef LIKE match that did not structurally
--          prove the guard (now replaced by strpos-based presence + ordering);
--   BUG 2: an N12 predicate query that raised "column \"s\" does not exist"
--          (now replaced by explicit array_agg over unnest with aliases).
-- ============================================================================

BEGIN TRANSACTION READ ONLY;

-- 1. public target posture (informational).
SELECT 'corrective_postflight' AS section, 'public pay_job_from_wallet posture' AS check_name,
       'public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)' AS object,
       CASE WHEN p.prosecdef THEN 'FAIL' ELSE 'PASS' END AS verdict,
       'security_definer=' || p.prosecdef::text
       || ' search_path=' || COALESCE(array_to_string(p.proconfig, ','), '<UNPINNED>') AS detail
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)');

-- 2. accidental auth overload absence (informational).
SELECT 'corrective_postflight' AS section, 'accidental auth overload absent' AS check_name,
       'auth.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)' AS object,
       CASE WHEN to_regprocedure('auth.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)') IS NULL
            THEN 'PASS' ELSE 'FAIL' END AS verdict,
       'the accidentally created auth overload must be gone' AS detail;

-- 3. public EXECUTE matrix (informational).
SELECT 'corrective_postflight' AS section, 'EXECUTE grant' AS check_name,
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

-- 4. Phase A trigger (informational).
SELECT 'corrective_postflight' AS section, 'phase A trigger' AS check_name,
       'trg_enforce_job_acquisition_eligibility' AS object,
       CASE WHEN tg.tgenabled = 'D' THEN 'PASS' ELSE 'FAIL' END AS verdict,
       'enabled=' || COALESCE(tg.tgenabled::text, '<absent>') AS detail
FROM (SELECT 1) AS one
LEFT JOIN pg_trigger tg
  ON tg.tgname = 'trg_enforce_job_acquisition_eligibility'
 AND tg.tgrelid = to_regclass('public.jobs')
 AND NOT tg.tgisinternal;

-- 5. N12 index (informational).
SELECT 'corrective_postflight' AS section, 'N12 index' AS check_name,
       'idx_jobs_one_active_per_driver' AS object,
       CASE WHEN i.indexrelid IS NULL OR NOT i.indisunique OR NOT i.indisvalid THEN 'FAIL' ELSE 'PASS' END AS verdict,
       CASE WHEN i.indexrelid IS NULL THEN 'missing'
            ELSE 'unique=' || i.indisunique::text || ' valid=' || i.indisvalid::text END AS detail
FROM (SELECT 1) AS one
LEFT JOIN pg_index i
  ON i.indrelid = to_regclass('public.jobs')
 AND i.indexrelid = to_regclass('public.idx_jobs_one_active_per_driver');

-- 6. HARD GATE.
DO $$
DECLARE
  v_prosecdef boolean;
  v_proconfig text;
  v_def text;
  v_guard_pos integer;
  v_paid_pos integer;
  v_wallet_insert_pos integer;
  v_wallet_update_pos integer;
  v_jobs_update_pos integer;
  v_helper text[];
  v_predicate text[];
  v_helper_only text[];
  v_predicate_only text[];
BEGIN
  -- A. exact public signature exists.
  IF to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'NO-GO: public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid) missing';
  END IF;

  -- B. exactly one public overload.
  IF (SELECT count(*) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'pay_job_from_wallet') <> 1 THEN
    RAISE EXCEPTION 'NO-GO: expected exactly one public pay_job_from_wallet overload';
  END IF;

  -- C/D. public INVOKER + unpinned search_path.
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

  -- E. exact C2C guard structurally present in the PUBLIC function, with the
  --    'already_paid' return, ordered BEFORE wallet INSERT / wallet UPDATE /
  --    jobs UPDATE. strpos proves presence AND ordering (BUG 1 fix).
  v_guard_pos := strpos(v_def, 'IF v_job.payment_method = ''wallet'' OR v_job.payment_status = ''wallet_funded'' THEN');
  v_paid_pos := strpos(v_def, '''status'', ''already_paid''');
  v_wallet_insert_pos := strpos(v_def, 'INSERT INTO wallets');
  v_wallet_update_pos := strpos(v_def, 'UPDATE wallets');
  v_jobs_update_pos := strpos(v_def, 'UPDATE jobs');

  IF v_guard_pos = 0 THEN
    RAISE EXCEPTION 'NO-GO: C2C wallet-provenance guard missing from public.pay_job_from_wallet';
  END IF;
  IF v_paid_pos = 0 THEN
    RAISE EXCEPTION 'NO-GO: already_paid return missing from public.pay_job_from_wallet';
  END IF;
  IF v_wallet_insert_pos = 0 OR v_wallet_update_pos = 0 OR v_jobs_update_pos = 0 THEN
    RAISE EXCEPTION 'NO-GO: expected wallet INSERT / wallet UPDATE / jobs UPDATE statements missing';
  END IF;
  IF v_guard_pos > v_wallet_insert_pos OR v_guard_pos > v_wallet_update_pos OR v_guard_pos > v_jobs_update_pos THEN
    RAISE EXCEPTION 'NO-GO: guard must occur before wallet INSERT, wallet UPDATE, and jobs UPDATE';
  END IF;

  -- F. accidental auth overload NO LONGER EXISTS.
  IF to_regprocedure('auth.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'NO-GO: accidental auth.pay_job_from_wallet overload still exists';
  END IF;

  -- G. public ACL exact posture.
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

  -- H. required columns remain present.
  IF EXISTS (
    SELECT 1 FROM (VALUES
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
    )
  ) THEN
    RAISE EXCEPTION 'NO-GO: a required column is missing';
  END IF;

  -- I. Phase A trigger exists, non-internal, disabled.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    WHERE tg.tgname = 'trg_enforce_job_acquisition_eligibility'
      AND tg.tgrelid = to_regclass('public.jobs')
      AND NOT tg.tgisinternal
      AND tg.tgenabled = 'D'
  ) THEN
    RAISE EXCEPTION 'NO-GO: Phase A trigger missing or not disabled';
  END IF;

  -- J. N12 index unique and valid.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = to_regclass('public.jobs')
      AND i.indexrelid = to_regclass('public.idx_jobs_one_active_per_driver')
      AND i.indisunique AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'NO-GO: idx_jobs_one_active_per_driver missing, not unique, or not valid';
  END IF;

  -- K. N12 frozen predicate matches driver_occupying_statuses() exactly (BUG 2 fix).
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

-- 7. Sentinel (only reached when every hard gate passes).
SELECT 'corrective_postflight' AS section, 'CORRECTIVE_POSTFLIGHT_COMPLETE' AS check_name, 'sentinel' AS object,
       'PASS' AS verdict,
       'public guard (structurally proven), auth overload absent, ACL, Phase A disabled, and N12 frozen set verified. '
       || 'If this row is absent the postflight aborted.' AS detail;

ROLLBACK;
