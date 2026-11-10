-- ============================================================================
-- MOVABI PHASE C2B — POSTFLIGHT: wallet & marketplace RPC ACL (rev 2)
-- READ ONLY. Run AFTER supabase/migrations/20261201000000_money_authority_wallet_acl.sql
-- ============================================================================
--
-- rev 2: verify the EXACT resulting ACL contract PER SIGNATURE (not just "PUBLIC
-- disappeared"), plus SECURITY DEFINER + pinned search_path for the marketplace
-- RPCs, Phase A trigger still disabled, N12 index still present, and no jobs RLS
-- change. Fails non-zero (RAISE) under `psql -v ON_ERROR_STOP=1` if any hard
-- assertion is violated.
-- Read-only by construction: BEGIN TRANSACTION READ ONLY / ROLLBACK; SELECT only.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;

-- 1. Actual EXECUTE matrix per signature (informational, incl. PUBLIC).
SELECT 'postflight' AS section, 'EXECUTE grant' AS check_name,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object,
       'EXISTS' AS verdict,
       'grantee=' || COALESCE(r.rolname, 'PUBLIC') AS detail
FROM pg_proc p
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
LEFT JOIN pg_roles r ON r.oid = a.grantee
WHERE p.pronamespace = to_regnamespace('public')
  AND a.privilege_type = 'EXECUTE'
  AND p.proname IN (
    'credit_wallet_topup','finalize_wallet_topup','pay_job_from_wallet',
    'settle_job_wallet_reservation','claim_marketplace_negotiation',
    'release_marketplace_negotiation','fetch_hybrid_opportunities',
    'get_marketplace_commission','get_marketplace_setting'
  )
ORDER BY 3, 5;

-- 2. PER-SIGNATURE ACL MATRIX: PASS/FAIL per (signature, role, expected).
SELECT 'postflight' AS section, 'ACL matrix' AS check_name,
       want.sig AS object,
       want.role || '=' || CASE WHEN want.expect THEN 'grant' ELSE 'no-grant' END AS detail,
       CASE
         WHEN want.role = 'PUBLIC' AND (EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')) = want.expect THEN 'PASS'
         WHEN want.role <> 'PUBLIC' AND has_function_privilege(want.role, 'public.' || want.sig, 'EXECUTE') = want.expect THEN 'PASS'
         ELSE 'FAIL'
       END AS verdict
FROM (VALUES
  ('credit_wallet_topup(uuid,numeric,text,text)', 'PUBLIC', false),
  ('credit_wallet_topup(uuid,numeric,text,text)', 'anon', false),
  ('credit_wallet_topup(uuid,numeric,text,text)', 'authenticated', false),
  ('credit_wallet_topup(uuid,numeric,text,text)', 'service_role', false),
  ('credit_wallet_topup(uuid,numeric,text,text,jsonb)', 'PUBLIC', false),
  ('credit_wallet_topup(uuid,numeric,text,text,jsonb)', 'anon', false),
  ('credit_wallet_topup(uuid,numeric,text,text,jsonb)', 'authenticated', false),
  ('credit_wallet_topup(uuid,numeric,text,text,jsonb)', 'service_role', false),
  ('finalize_wallet_topup(numeric,text,text,uuid)', 'PUBLIC', false),
  ('finalize_wallet_topup(numeric,text,text,uuid)', 'anon', false),
  ('finalize_wallet_topup(numeric,text,text,uuid)', 'authenticated', false),
  ('finalize_wallet_topup(numeric,text,text,uuid)', 'service_role', true),
  ('finalize_wallet_topup(uuid,numeric,text,text)', 'PUBLIC', false),
  ('finalize_wallet_topup(uuid,numeric,text,text)', 'anon', false),
  ('finalize_wallet_topup(uuid,numeric,text,text)', 'authenticated', false),
  ('finalize_wallet_topup(uuid,numeric,text,text)', 'service_role', true),
  ('pay_job_from_wallet(uuid,uuid,numeric,text,uuid)', 'PUBLIC', false),
  ('pay_job_from_wallet(uuid,uuid,numeric,text,uuid)', 'anon', false),
  ('pay_job_from_wallet(uuid,uuid,numeric,text,uuid)', 'authenticated', false),
  ('pay_job_from_wallet(uuid,uuid,numeric,text,uuid)', 'service_role', true),
  ('settle_job_wallet_reservation(uuid,numeric)', 'PUBLIC', false),
  ('settle_job_wallet_reservation(uuid,numeric)', 'anon', false),
  ('settle_job_wallet_reservation(uuid,numeric)', 'authenticated', false),
  ('settle_job_wallet_reservation(uuid,numeric)', 'service_role', true),
  ('claim_marketplace_negotiation(uuid,uuid)', 'PUBLIC', false),
  ('claim_marketplace_negotiation(uuid,uuid)', 'anon', false),
  ('claim_marketplace_negotiation(uuid,uuid)', 'authenticated', true),
  ('claim_marketplace_negotiation(uuid,uuid)', 'service_role', true),
  ('release_marketplace_negotiation(uuid,uuid,text)', 'PUBLIC', false),
  ('release_marketplace_negotiation(uuid,uuid,text)', 'anon', false),
  ('release_marketplace_negotiation(uuid,uuid,text)', 'authenticated', true),
  ('release_marketplace_negotiation(uuid,uuid,text)', 'service_role', true),
  ('fetch_hybrid_opportunities(uuid)', 'PUBLIC', false),
  ('fetch_hybrid_opportunities(uuid)', 'anon', false),
  ('fetch_hybrid_opportunities(uuid)', 'authenticated', true),
  ('fetch_hybrid_opportunities(uuid)', 'service_role', true),
  ('get_marketplace_commission(text,text,text,uuid)', 'PUBLIC', false),
  ('get_marketplace_commission(text,text,text,uuid)', 'anon', false),
  ('get_marketplace_commission(text,text,text,uuid)', 'authenticated', false),
  ('get_marketplace_commission(text,text,text,uuid)', 'service_role', true),
  ('get_marketplace_setting(text,uuid)', 'PUBLIC', false),
  ('get_marketplace_setting(text,uuid)', 'anon', false),
  ('get_marketplace_setting(text,uuid)', 'authenticated', false),
  ('get_marketplace_setting(text,uuid)', 'service_role', true)
) AS want(sig, role, expect)
JOIN pg_proc p ON p.oid = to_regprocedure('public.' || want.sig)
ORDER BY want.sig, want.role;

-- 3. Marketplace mutating RPCs: SECURITY DEFINER + pinned search_path + auth.uid() guard.
SELECT 'postflight' AS section, 'marketplace RPC posture' AS check_name,
       p.proname AS object,
       CASE WHEN p.prosecdef
             AND array_to_string(p.proconfig, ',') LIKE '%search_path=%public, pg_temp%'
             AND pg_get_functiondef(p.oid) LIKE '%auth.uid()%'
            THEN 'PASS' ELSE 'FAIL' END AS verdict,
       'security_definer=' || p.prosecdef::text
       || ' search_path=' || COALESCE(array_to_string(p.proconfig, ','), '<UNPINNED>')
       || ' auth_uid_guard=' || CASE WHEN pg_get_functiondef(p.oid) LIKE '%auth.uid()%' THEN 'yes' ELSE 'no' END AS detail
FROM pg_proc p
WHERE p.pronamespace = to_regnamespace('public')
  AND p.proname IN ('claim_marketplace_negotiation','release_marketplace_negotiation','fetch_hybrid_opportunities')
ORDER BY p.proname;

-- 4. Phase A compliance trigger still disabled.
SELECT 'postflight' AS section, 'phase A trigger disabled' AS check_name,
       'trg_enforce_job_acquisition_eligibility' AS object,
       CASE WHEN tg.tgenabled = 'D' THEN 'PASS' ELSE 'FAIL' END AS verdict,
       'enabled=' || tg.tgenabled::text || ' (D = disabled)' AS detail
FROM (SELECT 1) AS one
LEFT JOIN pg_trigger tg
  ON tg.tgname = 'trg_enforce_job_acquisition_eligibility'
 AND tg.tgrelid = to_regclass('public.jobs')
 AND NOT tg.tgisinternal;

-- 5. N12 single-active-job partial unique index still present on public.jobs.
--    pg_index (catalog) has indexrelid/indrelid/indisunique/indisvalid; the
--    pg_indexes view does NOT expose indexrelid, which caused the rev-1 failure.
SELECT 'postflight' AS section, 'N12 index present' AS check_name,
       'idx_jobs_one_active_per_driver' AS object,
       CASE WHEN i.indexrelid IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict,
       CASE WHEN i.indexrelid IS NULL THEN 'index missing or not attached to public.jobs'
            ELSE 'unique=' || i.indisunique::text || ' valid=' || i.indisvalid::text
                 || ' def=' || pg_get_indexdef(i.indexrelid) END AS detail
FROM (SELECT 1) AS one
LEFT JOIN pg_index i
  ON i.indrelid = to_regclass('public.jobs')
 AND i.indexrelid = to_regclass('public.idx_jobs_one_active_per_driver');

-- 6. HARD GATE: raise if any hard assertion is violated.
DO $$
DECLARE
  v_bad boolean := false;
BEGIN
  -- No PUBLIC/anon/authenticated EXECUTE on any money/read function.
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    LEFT JOIN pg_roles r ON r.oid = a.grantee
    WHERE p.pronamespace = to_regnamespace('public')
      AND a.privilege_type = 'EXECUTE'
      AND (a.grantee = 0 OR COALESCE(r.rolname,'') IN ('anon','authenticated'))
      AND p.proname IN ('credit_wallet_topup','finalize_wallet_topup','pay_job_from_wallet','settle_job_wallet_reservation','get_marketplace_commission','get_marketplace_setting')
  ) THEN v_bad := true; END IF;

  -- authenticated must retain EXECUTE on the marketplace mutating RPCs.
  IF NOT (has_function_privilege('authenticated', 'public.claim_marketplace_negotiation(uuid,uuid)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.release_marketplace_negotiation(uuid,uuid,text)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.fetch_hybrid_opportunities(uuid)', 'EXECUTE')) THEN v_bad := true; END IF;

  -- service_role must retain EXECUTE on finalize/pay_job.
  IF NOT (has_function_privilege('service_role', 'public.finalize_wallet_topup(uuid,numeric,text,text)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)', 'EXECUTE')) THEN v_bad := true; END IF;

  -- Phase A trigger must remain disabled.
  IF EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgname = 'trg_enforce_job_acquisition_eligibility' AND tg.tgenabled <> 'D') THEN v_bad := true; END IF;

  IF v_bad THEN
    RAISE EXCEPTION 'NO-GO: postflight ACL/invariant verification failed';
  END IF;
END
$$;

-- 7. Sentinel (only reached when every hard assertion passes).
SELECT 'postflight' AS section, 'POSTFLIGHT_COMPLETE' AS check_name, 'sentinel' AS object,
       'VERIFIED' AS verdict,
       'exact ACL matrix, RPC posture, Phase A disabled, and N12 index all verified. '
       || 'If this row is absent the postflight aborted.' AS detail;

ROLLBACK;
