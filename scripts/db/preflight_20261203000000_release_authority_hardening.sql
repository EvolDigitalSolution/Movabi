-- MOVABI 2.1 — PREFLIGHT for 20261203000000_release_authority_hardening.sql
-- READ ONLY. Verifies the PRE-state the hardening migration expects.
BEGIN TRANSACTION READ ONLY;

-- A. Broad RLS still present: authenticated can UPDATE payment_status (pre-state).
SELECT 'preflight' AS section, 'authenticated can update payment_status (expected pre-state)' AS check_name,
       CASE WHEN has_column_privilege('authenticated', 'public.jobs', 'payment_status', 'UPDATE') THEN 'PASS' ELSE 'FAIL' END AS verdict;

-- B. assign_driver_to_job still EXECUTE-granted to authenticated (pre-state).
SELECT 'preflight' AS section, 'assign_driver_to_job authenticated EXECUTE (expected pre-state)' AS check_name,
       CASE WHEN has_function_privilege('authenticated', 'public.assign_driver_to_job(uuid,uuid)', 'EXECUTE') THEN 'PASS' ELSE 'FAIL' END AS verdict;

-- C. claim/release/fetch still anon-reachable (pre-state).
SELECT 'preflight' AS section, 'claim_marketplace_negotiation anon EXECUTE (expected pre-state)' AS check_name,
       CASE WHEN has_function_privilege('anon', 'public.claim_marketplace_negotiation(uuid,uuid)', 'EXECUTE') THEN 'PASS' ELSE 'FAIL' END AS verdict;

-- HARD GATE: all pre-state conditions must hold.
DO $$
BEGIN
  IF NOT has_column_privilege('authenticated', 'public.jobs', 'payment_status', 'UPDATE') THEN
    RAISE EXCEPTION 'NO-GO: jobs payment_status already column-revoked (hardening already applied?)';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.assign_driver_to_job(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'NO-GO: assign_driver_to_job already revoked from authenticated';
  END IF;
  IF NOT has_function_privilege('anon', 'public.claim_marketplace_negotiation(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'NO-GO: claim_marketplace_negotiation already revoked from anon';
  END IF;
END
$$;

SELECT 'preflight' AS section, 'PREFLIGHT_COMPLETE' AS check_name, 'PASS' AS verdict, 'pre-state verified' AS detail;
ROLLBACK;
