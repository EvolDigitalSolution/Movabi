-- ============================================================================
-- MOVABI PHASE C2C — POSTFLIGHT: settlement idempotency (wallet payment retry)
-- READ ONLY. Run AFTER supabase/migrations/20261202000000_settlement_idempotency.sql
-- ============================================================================
--
-- Verifies the EXACT resulting state of public.pay_job_from_wallet after the
-- migration, plus the invariants that must not have drifted:
--   * exact signature and INVOKER / unpinned-search_path posture unchanged;
--   * the final wallet-PROVENANCE idempotency guard is present in the body;
--   * PUBLIC/anon/authenticated = NO EXECUTE, service_role = EXECUTE;
--   * Phase A trigger still DISABLED (enabled='D');
--   * frozen N12 index present, unique and valid, and its predicate's quoted
--     status literals match public.driver_occupying_statuses() EXACTLY.
--
-- Read-only by construction: BEGIN TRANSACTION READ ONLY / ROLLBACK; SELECT and
-- catalog reads only. The hard gate raises so `psql -v ON_ERROR_STOP=1` exits
-- non-zero on any violation. The final sentinel is `POSTFLIGHT_COMPLETE | PASS`.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;

-- 1. Live target overload posture (signature + INVOKER + search_path).
SELECT 'postflight' AS section, 'pay_job_from_wallet posture' AS check_name,
       p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS object,
       CASE WHEN p.prosecdef THEN 'FAIL' ELSE 'PASS' END AS verdict,
       'security_definer=' || p.prosecdef::text
       || ' search_path=' || COALESCE(array_to_string(p.proconfig, ','), '<UNPINNED>') AS detail
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)');

-- 2. EXACT SIGNATURE CONTRACT.
SELECT 'postflight' AS section, 'REQUIRED SIGNATURE' AS check_name,
       want.sig AS object,
       CASE WHEN to_regprocedure('public.' || want.sig) IS NULL
            THEN 'MISSING' ELSE 'PASS' END AS verdict,
       'the migration must leave exactly this signature' AS detail
FROM (VALUES
  ('pay_job_from_wallet(uuid,uuid,numeric,text,uuid)')
) AS want(sig);

-- 3. Final wallet-PROVENANCE idempotency guard present in the body.
SELECT 'postflight' AS section, 'wallet provenance guard' AS check_name,
       'pay_job_from_wallet(uuid,uuid,numeric,text,uuid)' AS object,
       CASE WHEN pg_get_functiondef(p.oid) LIKE
                '%v_job.payment_method = ''wallet'' OR v_job.payment_status = ''wallet_funded''%'
            THEN 'PASS' ELSE 'FAIL' END AS verdict,
       'guard proves wallet provenance (payment_method=''wallet'' OR payment_status=''wallet_funded''); '
       || 'generic ''paid'' must NOT be the guard basis' AS detail
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)');

-- 4. EXECUTE matrix (informational, incl. PUBLIC).
SELECT 'postflight' AS section, 'EXECUTE grant' AS check_name,
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

-- 5. PER-ROLE ACL MATRIX: PASS/FAIL per (role, expected).
SELECT 'postflight' AS section, 'ACL matrix' AS check_name,
       want.sig AS object,
       want.role || '=' || CASE WHEN want.expect THEN 'grant' ELSE 'no-grant' END AS detail,
       CASE
         WHEN want.role = 'PUBLIC' AND (EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')) = want.expect THEN 'PASS'
         WHEN want.role <> 'PUBLIC' AND has_function_privilege(want.role, 'public.' || want.sig, 'EXECUTE') = want.expect THEN 'PASS'
         ELSE 'FAIL'
       END AS verdict
FROM (VALUES
  ('pay_job_from_wallet(uuid,uuid,numeric,text,uuid)', 'PUBLIC', false),
  ('pay_job_from_wallet(uuid,uuid,numeric,text,uuid)', 'anon', false),
  ('pay_job_from_wallet(uuid,uuid,numeric,text,uuid)', 'authenticated', false),
  ('pay_job_from_wallet(uuid,uuid,numeric,text,uuid)', 'service_role', true)
) AS want(sig, role, expect)
JOIN pg_proc p ON p.oid = to_regprocedure('public.' || want.sig)
ORDER BY want.role;

-- 6. Phase A compliance trigger still disabled.
SELECT 'postflight' AS section, 'phase A trigger disabled' AS check_name,
       'trg_enforce_job_acquisition_eligibility' AS object,
       CASE WHEN tg.tgenabled = 'D' THEN 'PASS' ELSE 'FAIL' END AS verdict,
       'enabled=' || COALESCE(tg.tgenabled::text, '<trigger absent>') || ' (D = disabled)' AS detail
FROM (SELECT 1) AS one
LEFT JOIN pg_trigger tg
  ON tg.tgname = 'trg_enforce_job_acquisition_eligibility'
 AND tg.tgrelid = to_regclass('public.jobs')
 AND NOT tg.tgisinternal;

-- 7. Frozen N12 single-active-job index present, UNIQUE and VALID.
SELECT 'postflight' AS section, 'N12 index present' AS check_name,
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

-- 8. Frozen N12 predicate EXACTLY matches driver_occupying_statuses().
--    The predicate's quoted literals (the 16 occupying statuses) are extracted
--    from pg_get_expr and diffed against the helper's frozen array. Any
--    helper-only or predicate-only status is a FAIL.
SELECT 'postflight' AS section, 'N12 predicate frozen set' AS check_name,
       'idx_jobs_one_active_per_driver' AS object,
       CASE
         WHEN h.helper_only IS NULL AND p.predicate_only IS NULL THEN 'PASS'
         ELSE 'FAIL'
       END AS verdict,
       'helper_only=' || COALESCE(h.helper_only::text, 'none')
       || ' predicate_only=' || COALESCE(p.predicate_only::text, 'none') AS detail
FROM (SELECT 1) AS one
CROSS JOIN LATERAL (
  SELECT array_agg(s ORDER BY s) AS helper_only
  FROM (
    SELECT s FROM unnest(public.driver_occupying_statuses()) AS u(s)
    EXCEPT
    SELECT lit FROM (
      SELECT (m.match)[1] AS lit
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      CROSS JOIN LATERAL pg_catalog.regexp_matches(
                     pg_catalog.pg_get_expr(i.indpred, i.indrelid),
                     '''([^'']*)''', 'g') AS m(match)
      WHERE ic.relname = 'idx_jobs_one_active_per_driver'
    ) lits
  ) d
) h
CROSS JOIN LATERAL (
  SELECT array_agg(s ORDER BY s) AS predicate_only
  FROM (
    SELECT lit FROM (
      SELECT (m.match)[1] AS lit
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      CROSS JOIN LATERAL pg_catalog.regexp_matches(
                     pg_catalog.pg_get_expr(i.indpred, i.indrelid),
                     '''([^'']*)''', 'g') AS m(match)
      WHERE ic.relname = 'idx_jobs_one_active_per_driver'
    ) lits
    EXCEPT
    SELECT s FROM unnest(public.driver_occupying_statuses()) AS u(s)
  ) d
) p;

-- 9. HARD GATE: raise on any violation.
DO $$
DECLARE
  p RECORD;
BEGIN
  -- Signature must exist.
  IF to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'NO-GO: pay_job_from_wallet(uuid,uuid,numeric,text,uuid) missing';
  END IF;

  -- INVOKER (not SECURITY DEFINER), unpinned search_path.
  SELECT prosecdef, array_to_string(proconfig, ',') AS proconfig
    INTO p
    FROM pg_proc
   WHERE oid = to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)');
  IF p.prosecdef THEN
    RAISE EXCEPTION 'NO-GO: pay_job_from_wallet became SECURITY DEFINER';
  END IF;
  IF COALESCE(p.proconfig, '') LIKE '%search_path%' THEN
    RAISE EXCEPTION 'NO-GO: pay_job_from_wallet gained a pinned search_path';
  END IF;

  -- Provenance guard present in the body.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc x
    WHERE x.oid = to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)')
      AND pg_get_functiondef(x.oid) LIKE
          '%v_job.payment_method = ''wallet'' OR v_job.payment_status = ''wallet_funded''%'
  ) THEN
    RAISE EXCEPTION 'NO-GO: wallet provenance guard missing from pay_job_from_wallet';
  END IF;

  -- ACL: PUBLIC/anon/authenticated must NOT execute; service_role MUST.
  IF EXISTS (
    SELECT 1 FROM pg_proc x
    CROSS JOIN LATERAL aclexplode(COALESCE(x.proacl, acldefault('f', x.proowner))) a
    LEFT JOIN pg_roles r ON r.oid = a.grantee
    WHERE x.pronamespace = to_regnamespace('public')
      AND x.proname = 'pay_job_from_wallet'
      AND a.privilege_type = 'EXECUTE'
      AND (a.grantee = 0 OR COALESCE(r.rolname,'') IN ('anon','authenticated'))
  ) THEN
    RAISE EXCEPTION 'NO-GO: PUBLIC/anon/authenticated has EXECUTE on pay_job_from_wallet';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'NO-GO: service_role lost EXECUTE on pay_job_from_wallet';
  END IF;

  -- Phase A trigger must remain disabled.
  IF EXISTS (
    SELECT 1 FROM pg_trigger tg
    WHERE tg.tgname = 'trg_enforce_job_acquisition_eligibility' AND tg.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'NO-GO: Phase A trigger is not disabled';
  END IF;

  -- N12 index must remain present, unique and valid.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = to_regclass('public.jobs')
      AND i.indexrelid = to_regclass('public.idx_jobs_one_active_per_driver')
      AND i.indisunique AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'NO-GO: idx_jobs_one_active_per_driver missing, not unique, or not valid';
  END IF;

  -- N12 predicate must still equal the frozen 16-status helper set.
  IF EXISTS (
    WITH pred AS (
      SELECT (m.match)[1] AS lit
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      CROSS JOIN LATERAL pg_catalog.regexp_matches(
                     pg_catalog.pg_get_expr(i.indpred, i.indrelid),
                     '''([^'']*)''', 'g') AS m(match)
      WHERE ic.relname = 'idx_jobs_one_active_per_driver'
    )
    SELECT 1
    FROM (
      SELECT lit FROM pred
      EXCEPT
      SELECT s FROM unnest(public.driver_occupying_statuses()) AS u(s)
    ) d
    UNION ALL
    SELECT 1
    FROM (
      SELECT s FROM unnest(public.driver_occupying_statuses()) AS u(s)
      EXCEPT
      SELECT lit FROM pred
    ) d
  ) THEN
    RAISE EXCEPTION 'NO-GO: N12 predicate status set diverged from driver_occupying_statuses()';
  END IF;
END
$$;

-- 10. Sentinel (only reached when every hard assertion passes).
SELECT 'postflight' AS section, 'POSTFLIGHT_COMPLETE' AS check_name, 'sentinel' AS object,
       'PASS' AS verdict,
       'signature, INVOKER posture, provenance guard, ACL, Phase A disabled, and frozen N12 set all verified. '
       || 'If this row is absent the postflight aborted.' AS detail;

ROLLBACK;
