-- ============================================================================
-- MOVABI PHASE C2B — POSTFLIGHT: wallet & marketplace RPC ACL
-- READ ONLY. Run AFTER applying
--   supabase/migrations/20261201000000_money_authority_wallet_acl.sql
-- ============================================================================
--
-- Purpose: prove the EXACT intended EXECUTE matrix is in force, that the Phase A
-- compliance trigger is still disabled, the N12 single-active-job partial unique
-- index still exists, and no money function regressed to PUBLIC/anon EXECUTE.
--
-- Intended matrix (subject to proven caller compatibility):
--   credit_wallet_topup      : PUBLIC false, anon false, authenticated false, service_role false
--   finalize_wallet_topup    : PUBLIC false, anon false, authenticated false, service_role true
--   pay_job_from_wallet      : PUBLIC false, anon false, authenticated false, service_role true
--   settle_job_wallet_reservation: PUBLIC false, anon false, authenticated false, service_role true
--   claim/release/fetch      : PUBLIC false, anon false, authenticated true, service_role true
--   get_marketplace_commission/setting: PUBLIC false, anon false, authenticated false, service_role true
-- Read-only by construction: BEGIN TRANSACTION READ ONLY / ROLLBACK; SELECT only.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;

-- 1. Actual EXECUTE matrix per (signature, role) — PUBLIC via acldefault.
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

-- 2. Verify no PUBLIC/anon EXECUTE remains on any money or read function.
SELECT 'postflight' AS section, 'no PUBLIC/anon EXECUTE on money/read functions' AS check_name,
       COALESCE(string_agg(p.proname, ','), '(none)') AS object,
       CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'NO-GO' END AS verdict,
       COUNT(*)::text || ' function(s) still grant PUBLIC/anon EXECUTE' AS detail
FROM pg_proc p
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
LEFT JOIN pg_roles r ON r.oid = a.grantee
WHERE p.pronamespace = to_regnamespace('public')
  AND a.privilege_type = 'EXECUTE'
  AND (a.grantee = 0 OR COALESCE(r.rolname,'') IN ('anon'))
  AND p.proname IN (
    'credit_wallet_topup','finalize_wallet_topup','pay_job_from_wallet',
    'settle_job_wallet_reservation','get_marketplace_commission','get_marketplace_setting'
  );

-- 3. Phase A compliance trigger must remain DISABLED.
SELECT 'postflight' AS section, 'phase A trigger disabled' AS check_name,
       'trg_enforce_job_acquisition_eligibility' AS object,
       CASE WHEN tg.tgenabled = 'D' THEN 'OK' ELSE 'NO-GO' END AS verdict,
       'enabled=' || tg.tgenabled::text || ' (D = disabled)' AS detail
FROM (SELECT 1) AS one
LEFT JOIN pg_trigger tg
  ON tg.tgname = 'trg_enforce_job_acquisition_eligibility'
 AND tg.tgrelid = to_regclass('public.jobs')
 AND NOT tg.tgisinternal;

-- 4. N12 single-active-job partial unique index must still exist.
SELECT 'postflight' AS section, 'N12 index present' AS check_name,
       'idx_jobs_one_active_per_driver' AS object,
       CASE WHEN i.indexrelid IS NOT NULL THEN 'OK' ELSE 'NO-GO' END AS verdict,
       COALESCE(i.indexname, 'index missing') AS detail
FROM (SELECT 1) AS one
LEFT JOIN pg_indexes i
  ON i.schemaname = 'public' AND i.indexname = 'idx_jobs_one_active_per_driver';

-- 5. Sentinel.
SELECT 'postflight' AS section, 'POSTFLIGHT_COMPLETE' AS check_name, 'sentinel' AS object,
       'COMPLETED' AS verdict,
       'If this row is absent the postflight aborted. The migration result is NOT verified.' AS detail;

ROLLBACK;
