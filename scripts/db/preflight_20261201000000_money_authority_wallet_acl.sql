-- ============================================================================
-- MOVABI PHASE C2B — PREFLIGHT: wallet & marketplace RPC ACL
-- READ ONLY. Run BEFORE applying
--   supabase/migrations/20261201000000_money_authority_wallet_acl.sql
-- ============================================================================
--
-- Purpose: enumerate the EXACT live signatures, SECURITY DEFINER posture and
-- EXECUTE matrix of every function the migration revokes/grants, and expose any
-- unexpected overload so the migration cannot be applied blind. NO-GO if a
-- money function the migration expects is missing.
--
-- Read-only by construction: BEGIN TRANSACTION READ ONLY / ROLLBACK; SELECT only;
-- no function is invoked; only pg_proc / pg_roles / aclexplode / acldefault.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;

-- 1. Live overloads (signature + definer + search_path).
SELECT 'preflight' AS section, 'overload' AS check_name,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object,
       'EXISTS' AS verdict,
       'security_definer=' || p.prosecdef::text
       || ' search_path=' || COALESCE(array_to_string(p.proconfig, ','), '<UNPINNED>') AS detail
FROM pg_proc p
WHERE p.pronamespace = to_regnamespace('public')
  AND p.proname IN (
    'credit_wallet_topup','finalize_wallet_topup','pay_job_from_wallet',
    'settle_job_wallet_reservation','claim_marketplace_negotiation',
    'release_marketplace_negotiation','fetch_hybrid_opportunities',
    'get_marketplace_commission','get_marketplace_setting'
  )
ORDER BY p.proname, 3;

-- 2. Live EXECUTE matrix (PUBLIC pseudo-role shown as grantee 0 via acldefault).
SELECT 'preflight' AS section, 'EXECUTE grant' AS check_name,
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

-- 3. NO-GO if an expected function has no overload at all.
SELECT 'preflight' AS section, 'expected function present' AS check_name,
       want.fn AS object,
       CASE WHEN COUNT(p.oid) > 0 THEN 'OK' ELSE 'NO-GO' END AS verdict,
       COUNT(p.oid)::text || ' overload(s)' AS detail
FROM (VALUES
  ('credit_wallet_topup'),('finalize_wallet_topup'),('pay_job_from_wallet'),
  ('settle_job_wallet_reservation'),('claim_marketplace_negotiation'),
  ('release_marketplace_negotiation'),('fetch_hybrid_opportunities'),
  ('get_marketplace_commission'),('get_marketplace_setting')
) AS want(fn)
LEFT JOIN pg_proc p ON p.pronamespace = to_regnamespace('public') AND p.proname = want.fn
GROUP BY want.fn
ORDER BY want.fn;

-- 4. Sentinel.
SELECT 'preflight' AS section, 'PREFLIGHT_COMPLETE' AS check_name, 'sentinel' AS object,
       'COMPLETED' AS verdict,
       'If this row is absent the preflight aborted. Do NOT apply the migration.' AS detail;

ROLLBACK;
