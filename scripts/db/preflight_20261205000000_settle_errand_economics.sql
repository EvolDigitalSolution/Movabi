-- MOVABI 2.1 — PREFLIGHT for 20261205000000_settle_errand_economics.sql (READ ONLY)
BEGIN TRANSACTION READ ONLY;

SELECT 'preflight' AS section, 'settle errand cap still conflates fare with spend (pre-state)' AS check_name,
       CASE WHEN pg_get_functiondef(p.oid) LIKE '%LEAST(v_amount, v_actual_spending)%' THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p WHERE p.oid = to_regprocedure('public.settle_job_wallet_reservation(uuid,numeric)');

SELECT 'preflight' AS section, 'settle function exists + SECURITY DEFINER + pinned search_path' AS check_name,
       CASE WHEN p.prosecdef AND array_to_string(p.proconfig, ',') LIKE '%search_path=public, pg_temp%' THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p WHERE p.oid = to_regprocedure('public.settle_job_wallet_reservation(uuid,numeric)');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.settle_job_wallet_reservation(uuid,numeric)')
                 AND pg_get_functiondef(p.oid) LIKE '%LEAST(v_amount, v_actual_spending)%') THEN
    RAISE EXCEPTION 'NO-GO: settle errand cap already fixed (migration already applied?)';
  END IF;
END
$$;

SELECT 'preflight' AS section, 'PREFLIGHT_COMPLETE' AS check_name, 'PASS' AS verdict, 'pre-state verified' AS detail;
ROLLBACK;
