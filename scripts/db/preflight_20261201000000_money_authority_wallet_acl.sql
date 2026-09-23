-- ============================================================================
-- MOVABI PHASE C2B — PREFLIGHT: wallet & marketplace RPC ACL (rev 2)
-- READ ONLY. Run BEFORE supabase/migrations/20261201000000_money_authority_wallet_acl.sql
-- ============================================================================
--
-- rev 2: the original preflight only checked function-FAMILY presence and still
-- returned PREFLIGHT_COMPLETE even though the migration referenced a nonexistent
-- explicit signature (finalize_wallet_topup(uuid,numeric,text)), which aborted the
-- migration at runtime. rev 2 enforces an EXACT SIGNATURE CONTRACT:
--   * every explicit signature the migration targets MUST exist (to_regprocedure);
--   * a missing required signature is a NO-GO and RAISES, so `psql -v ON_ERROR_STOP=1`
--     exits non-zero and the migration can never be executed against a drifted DB;
--   * an unexpected EXTRA overload on a money function is exposed (and the migration
--     only ever REVOKEs it dynamically — never GRANTs).
-- Read-only by construction: BEGIN TRANSACTION READ ONLY / ROLLBACK; SELECT only; no
-- application function is invoked (only pg_proc/pg_roles/aclexplode/acldefault).
-- ============================================================================

BEGIN TRANSACTION READ ONLY;

-- 1. Live overloads (signature + SECURITY DEFINER + search_path).
SELECT 'preflight' AS section, 'live overload' AS check_name,
       p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS object,
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

-- 2. Live EXECUTE matrix (PUBLIC pseudo-role via acldefault grantee 0).
SELECT 'preflight' AS section, 'EXECUTE grant' AS check_name,
       p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS object,
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

-- 3. EXACT SIGNATURE CONTRACT: one row per required signature.
SELECT 'preflight' AS section, 'REQUIRED SIGNATURE' AS check_name,
       want.sig AS object,
       CASE WHEN to_regprocedure('public.' || want.sig) IS NULL THEN 'MISSING REQUIRED SIGNATURE' ELSE 'EXPECTED EXACT SIGNATURE' END AS verdict,
       'the migration references this exact signature' AS detail
FROM (VALUES
  ('credit_wallet_topup(uuid,numeric,text,text)'),
  ('credit_wallet_topup(uuid,numeric,text,text,jsonb)'),
  ('finalize_wallet_topup(numeric,text,text,uuid)'),
  ('finalize_wallet_topup(uuid,numeric,text,text)'),
  ('pay_job_from_wallet(uuid,uuid,numeric,text,uuid)'),
  ('claim_marketplace_negotiation(uuid,uuid)'),
  ('release_marketplace_negotiation(uuid,uuid,text)'),
  ('fetch_hybrid_opportunities(uuid)'),
  ('get_marketplace_commission(text,text,text,uuid)'),
  ('get_marketplace_setting(text,uuid)'),
  ('settle_job_wallet_reservation(uuid,numeric)')
) AS want(sig)
ORDER BY want.sig;

-- 4. UNEXPECTED EXTRA OVERLOAD on a money function (revoke-only, not a NO-GO).
SELECT 'preflight' AS section, 'UNEXPECTED EXTRA OVERLOAD (revoke-only)' AS check_name,
       p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS object,
       'EXTRA' AS verdict,
       'not in the migration contract; the catch-all DO block revokes anon/authenticated/PUBLIC only' AS detail
FROM pg_proc p
WHERE p.pronamespace = to_regnamespace('public')
  AND p.proname IN ('credit_wallet_topup','finalize_wallet_topup','pay_job_from_wallet')
  AND translate(oidvectortypes(p.proargtypes), ' ', '') NOT IN (
    'uuid,numeric,text,text', 'uuid,numeric,text,text,jsonb',
    'numeric,text,text,uuid', 'uuid,numeric,text,text',
    'uuid,uuid,numeric,text,uuid'
  )
ORDER BY 3;

-- 5. HARD GATE: raise if any required signature is missing, so `psql -v ON_ERROR_STOP=1`
--    exits non-zero and the migration cannot be executed.
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY[
    'credit_wallet_topup(uuid,numeric,text,text)',
    'credit_wallet_topup(uuid,numeric,text,text,jsonb)',
    'finalize_wallet_topup(numeric,text,text,uuid)',
    'finalize_wallet_topup(uuid,numeric,text,text)',
    'pay_job_from_wallet(uuid,uuid,numeric,text,uuid)',
    'claim_marketplace_negotiation(uuid,uuid)',
    'release_marketplace_negotiation(uuid,uuid,text)',
    'fetch_hybrid_opportunities(uuid)',
    'get_marketplace_commission(text,text,text,uuid)',
    'get_marketplace_setting(text,uuid)',
    'settle_job_wallet_reservation(uuid,numeric)'
  ] LOOP
    IF to_regprocedure('public.' || s) IS NULL THEN
      missing := array_append(missing, s);
    END IF;
  END LOOP;

  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'NO-GO: missing required function signature(s): %', array_to_string(missing, ', ');
  END IF;
END
$$;

-- 6. Sentinel (only reached when every required signature exists).
SELECT 'preflight' AS section, 'PREFLIGHT_COMPLETE' AS check_name, 'sentinel' AS object,
       'READY_TO_APPLY' AS verdict,
       'all required signatures present. If this row is absent the preflight aborted.' AS detail;

ROLLBACK;
