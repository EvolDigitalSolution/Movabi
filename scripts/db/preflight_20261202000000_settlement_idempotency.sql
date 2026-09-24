-- ============================================================================
-- MOVABI PHASE C2C — PREFLIGHT: settlement idempotency (wallet payment retry)
-- READ ONLY. Run BEFORE supabase/migrations/20261202000000_settlement_idempotency.sql
-- ============================================================================
--
-- The migration replaces ONLY public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)
-- with an identical body plus a wallet-PROVENANCE idempotency guard. This
-- preflight hard-checks the prerequisites that must already hold for that
-- replacement to be safe:
--   * the exact target signature exists (to_regprocedure);
--   * its current posture is the known pre-C2C posture (INVOKER, unpinned
--     search_path, old status-guard anchor present, new guard NOT yet present);
--   * service_role has EXECUTE and PUBLIC/anon/authenticated do NOT;
--   * every jobs/wallets/wallet_transactions column the body references exists;
--   * Phase A trigger is still DISABLED (enabled='D');
--   * the frozen N12 single-active-job index exists, is UNIQUE and VALID.
--
-- Read-only by construction: BEGIN TRANSACTION READ ONLY / ROLLBACK; SELECT and
-- catalog reads only. No application function is invoked, no mutation occurs.
-- The hard gate raises so `psql -v ON_ERROR_STOP=1` exits non-zero on a NO-GO.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;

-- 1. Live target overload posture (INVOKER, search_path, guard presence).
SELECT 'preflight' AS section, 'pay_job_from_wallet posture' AS check_name,
       'pay_job_from_wallet(uuid,uuid,numeric,text,uuid)' AS object,
       CASE
         WHEN to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)') IS NULL THEN 'MISSING'
         WHEN p.prosecdef THEN 'DRIFT: SECURITY DEFINER'
         WHEN array_to_string(p.proconfig, ',') LIKE '%search_path%' THEN 'DRIFT: search_path pinned'
         WHEN pg_get_functiondef(p.oid) LIKE '%v_job.payment_method = ''wallet'' OR v_job.payment_status = ''wallet_funded''%'
              THEN 'DRIFT: new guard already present'
         ELSE 'EXPECTED PRE-C2C POSTURE'
       END AS verdict,
       'security_definer=' || p.prosecdef::text
       || ' search_path=' || COALESCE(array_to_string(p.proconfig, ','), '<UNPINNED>')
       || ' old_anchor=' || CASE WHEN pg_get_functiondef(p.oid) LIKE '%v_job.status IN (''cancelled'', ''completed'')%'
                                 THEN 'yes' ELSE 'NO' END AS detail
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)');

-- 2. EXACT SIGNATURE CONTRACT for the single function this migration touches.
SELECT 'preflight' AS section, 'REQUIRED SIGNATURE' AS check_name,
       want.sig AS object,
       CASE WHEN to_regprocedure('public.' || want.sig) IS NULL
            THEN 'MISSING REQUIRED SIGNATURE' ELSE 'EXPECTED EXACT SIGNATURE' END AS verdict,
       'the migration replaces exactly this signature' AS detail
FROM (VALUES
  ('pay_job_from_wallet(uuid,uuid,numeric,text,uuid)')
) AS want(sig);

-- 3. UNEXPECTED EXTRA OVERLOAD (informational — the migration does not touch any other overload).
SELECT 'preflight' AS section, 'UNEXPECTED EXTRA OVERLOAD' AS check_name,
       p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS object,
       'EXTRA' AS verdict,
       'not the migration target; left untouched' AS detail
FROM pg_proc p
WHERE p.pronamespace = to_regnamespace('public')
  AND p.proname = 'pay_job_from_wallet'
  AND translate(oidvectortypes(p.proargtypes), ' ', '') <> 'uuid,uuid,numeric,text,uuid'
ORDER BY 3;

-- 4. EXECUTE matrix (informational). service_role must be the ONLY concrete grant.
SELECT 'preflight' AS section, 'EXECUTE grant' AS check_name,
       p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS object,
       'EXISTS' AS verdict,
       'grantee=' || COALESCE(r.rolname, 'PUBLIC') AS detail
FROM pg_proc p
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
LEFT JOIN pg_roles r ON r.oid = a.grantee
WHERE p.pronamespace = to_regnamespace('public')
  AND a.privilege_type = 'EXECUTE'
  AND p.proname = 'pay_job_from_wallet'
ORDER BY 3, 5;

-- 5. Required columns referenced by the replacement function body.
SELECT 'preflight' AS section, 'required column' AS check_name,
       want.tbl || '.' || want.col AS object,
       CASE WHEN c.column_name IS NULL THEN 'MISSING REQUIRED COLUMN' ELSE 'EXISTS' END AS verdict,
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
  ON c.table_schema = 'public'
 AND c.table_name = want.tbl
 AND c.column_name = want.col
ORDER BY want.tbl, want.col;

-- 6. wallet_transactions transaction-type column: transaction_type OR type must exist
--    (the function probes both and inserts into whichever exists).
SELECT 'preflight' AS section, 'wallet_transactions type column' AS check_name,
       'wallet_transactions.transaction_type|type' AS object,
       CASE WHEN EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'wallet_transactions'
                AND column_name IN ('transaction_type', 'type')
            ) THEN 'EXISTS' ELSE 'MISSING REQUIRED COLUMN' END AS verdict,
       'the function inserts a ''reservation'' ledger row into this column' AS detail;

-- 7. Phase A compliance trigger still disabled.
SELECT 'preflight' AS section, 'phase A trigger disabled' AS check_name,
       'trg_enforce_job_acquisition_eligibility' AS object,
       CASE WHEN tg.tgenabled = 'D' THEN 'PASS' ELSE 'FAIL' END AS verdict,
       'enabled=' || COALESCE(tg.tgenabled::text, '<trigger absent>') || ' (D = disabled)' AS detail
FROM (SELECT 1) AS one
LEFT JOIN pg_trigger tg
  ON tg.tgname = 'trg_enforce_job_acquisition_eligibility'
 AND tg.tgrelid = to_regclass('public.jobs')
 AND NOT tg.tgisinternal;

-- 8. Frozen N12 single-active-job index present, UNIQUE and VALID.
SELECT 'preflight' AS section, 'N12 index present' AS check_name,
       'idx_jobs_one_active_per_driver' AS object,
       CASE
         WHEN i.indexrelid IS NULL THEN 'FAIL'
         WHEN NOT i.indisunique THEN 'FAIL'
         WHEN NOT i.indisvalid THEN 'FAIL'
         ELSE 'PASS'
       END AS verdict,
       CASE WHEN i.indexrelid IS NULL THEN 'index missing or not attached to public.jobs'
            ELSE 'unique=' || i.indisunique::text || ' valid=' || i.indisvalid::text END AS detail
FROM (SELECT 1) AS one
LEFT JOIN pg_index i
  ON i.indrelid = to_regclass('public.jobs')
 AND i.indexrelid = to_regclass('public.idx_jobs_one_active_per_driver');

-- 9. HARD GATE: raise on any NO-GO so `psql -v ON_ERROR_STOP=1` exits non-zero.
DO $$
DECLARE
  missing_cols text := '';
  has_type_col boolean;
  p RECORD;
BEGIN
  -- Target signature must exist.
  IF to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'NO-GO: pay_job_from_wallet(uuid,uuid,numeric,text,uuid) does not exist';
  END IF;

  -- Posture must be the known pre-C2C posture (INVOKER, unpinned search_path).
  SELECT prosecdef, array_to_string(proconfig, ',')
    INTO p
    FROM pg_proc
   WHERE oid = to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)');
  IF p.prosecdef THEN
    RAISE EXCEPTION 'NO-GO: pay_job_from_wallet is SECURITY DEFINER (expected INVOKER)';
  END IF;
  IF COALESCE(p.proconfig, '') LIKE '%search_path%' THEN
    RAISE EXCEPTION 'NO-GO: pay_job_from_wallet has a pinned search_path (expected unpinned)';
  END IF;

  -- service_role must have EXECUTE; PUBLIC/anon/authenticated must NOT.
  IF NOT has_function_privilege('service_role', 'public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'NO-GO: service_role lacks EXECUTE on pay_job_from_wallet';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_roles r ON r.oid = a.grantee
    WHERE p.pronamespace = to_regnamespace('public')
      AND p.proname = 'pay_job_from_wallet'
      AND a.privilege_type = 'EXECUTE'
      AND (a.grantee = 0 OR COALESCE(r.rolname,'') IN ('anon','authenticated'))
  ) THEN
    RAISE EXCEPTION 'NO-GO: PUBLIC/anon/authenticated has EXECUTE on pay_job_from_wallet';
  END IF;

  -- Required columns must exist.
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

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'wallet_transactions'
      AND column_name IN ('transaction_type', 'type')
  ) INTO has_type_col;
  IF NOT has_type_col THEN
    RAISE EXCEPTION 'NO-GO: wallet_transactions has neither transaction_type nor type column';
  END IF;

  -- Phase A trigger must be disabled.
  IF EXISTS (
    SELECT 1 FROM pg_trigger tg
    WHERE tg.tgname = 'trg_enforce_job_acquisition_eligibility' AND tg.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'NO-GO: Phase A trigger is not disabled';
  END IF;

  -- N12 index must be present, unique and valid.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = to_regclass('public.jobs')
      AND i.indexrelid = to_regclass('public.idx_jobs_one_active_per_driver')
      AND i.indisunique AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'NO-GO: idx_jobs_one_active_per_driver missing, not unique, or not valid';
  END IF;
END
$$;

-- 10. Sentinel (only reached when every hard assertion passes).
SELECT 'preflight' AS section, 'PREFLIGHT_COMPLETE' AS check_name, 'sentinel' AS object,
       'PASS' AS verdict,
       'target signature, pre-C2C posture, ACL, columns, Phase A disabled, and N12 index verified. '
       || 'If this row is absent the preflight aborted.' AS detail;

ROLLBACK;
