-- MOVABI 2.1 — POSTFLIGHT for 20261203000000_release_authority_hardening.sql
-- READ ONLY. Verifies the POST-state the hardening migration produces.
BEGIN TRANSACTION READ ONLY;

-- A. Column-level authority: client can no longer UPDATE money/acquisition columns.
SELECT 'postflight' AS section, 'authenticated cannot update payment_status' AS check_name,
       CASE WHEN has_column_privilege('authenticated', 'public.jobs', 'payment_status', 'UPDATE') THEN 'FAIL' ELSE 'PASS' END AS verdict;
SELECT 'postflight' AS section, 'authenticated cannot update driver_id' AS check_name,
       CASE WHEN has_column_privilege('authenticated', 'public.jobs', 'driver_id', 'UPDATE') THEN 'FAIL' ELSE 'PASS' END AS verdict;
SELECT 'postflight' AS section, 'authenticated cannot update agreed_fare' AS check_name,
       CASE WHEN has_column_privilege('authenticated', 'public.jobs', 'agreed_fare', 'UPDATE') THEN 'FAIL' ELSE 'PASS' END AS verdict;
SELECT 'postflight' AS section, 'authenticated can still update status (lifecycle)' AS check_name,
       CASE WHEN has_column_privilege('authenticated', 'public.jobs', 'status', 'UPDATE') THEN 'PASS' ELSE 'FAIL' END AS verdict;

-- B. assign_driver_to_job admin gate present in body.
SELECT 'postflight' AS section, 'assign_driver_to_job admin gate present' AS check_name,
       CASE WHEN pg_get_functiondef(p.oid) LIKE '%Only an administrator can assign%' THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p WHERE p.oid = to_regprocedure('public.assign_driver_to_job(uuid,uuid)');

-- C. claim/release/fetch: anon revoked, identity gate present.
SELECT 'postflight' AS section, 'claim/release/fetch anon revoked' AS check_name,
       CASE WHEN NOT has_function_privilege('anon', 'public.claim_marketplace_negotiation(uuid,uuid)', 'EXECUTE')
             AND NOT has_function_privilege('anon', 'public.release_marketplace_negotiation(uuid,uuid,text)', 'EXECUTE')
             AND NOT has_function_privilege('anon', 'public.fetch_hybrid_opportunities(uuid)', 'EXECUTE') THEN 'PASS' ELSE 'FAIL' END AS verdict;
SELECT 'postflight' AS section, 'claim identity gate present' AS check_name,
       CASE WHEN pg_get_functiondef(p.oid) LIKE '%claim a negotiation for yourself%' THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p WHERE p.oid = to_regprocedure('public.claim_marketplace_negotiation(uuid,uuid)');

-- HARD GATE.
DO $$
BEGIN
  IF has_column_privilege('authenticated', 'public.jobs', 'payment_status', 'UPDATE') THEN
    RAISE EXCEPTION 'NO-GO: payment_status still client-updatable';
  END IF;
  IF has_column_privilege('authenticated', 'public.jobs', 'driver_id', 'UPDATE') THEN
    RAISE EXCEPTION 'NO-GO: driver_id still client-updatable';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.jobs', 'status', 'UPDATE') THEN
    RAISE EXCEPTION 'NO-GO: status lifecycle write broken';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.assign_driver_to_job(uuid,uuid)') AND pg_get_functiondef(p.oid) LIKE '%Only an administrator can assign%') THEN
    RAISE EXCEPTION 'NO-GO: assign_driver_to_job admin gate missing';
  END IF;
  IF has_function_privilege('anon', 'public.claim_marketplace_negotiation(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'NO-GO: claim_marketplace_negotiation still anon-reachable';
  END IF;
END
$$;

SELECT 'postflight' AS section, 'POSTFLIGHT_COMPLETE' AS check_name, 'PASS' AS verdict, 'authority hardening verified' AS detail;
ROLLBACK;
