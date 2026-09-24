-- MOVABI 2.1 — POSTFLIGHT for 20261205000000_settle_errand_economics.sql (READ ONLY)
BEGIN TRANSACTION READ ONLY;

SELECT 'postflight' AS section, 'settle no longer caps fare to spend' AS check_name,
       CASE WHEN pg_get_functiondef(p.oid) NOT LIKE '%LEAST(v_amount, v_actual_spending)%'
             AND pg_get_functiondef(p.oid) LIKE '%v_settlement_amount := ROUND((v_amount + v_actual_spending)%' THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p WHERE p.oid = to_regprocedure('public.settle_job_wallet_reservation(uuid,numeric)');

SELECT 'postflight' AS section, 'settle computes unused-budget release' AS check_name,
       CASE WHEN pg_get_functiondef(p.oid) LIKE '%v_budget := ROUND(GREATEST(v_job_reserved - v_amount%'
             AND pg_get_functiondef(p.oid) LIKE '%v_refund_amount := ROUND(GREATEST(v_job_reserved - v_settlement_amount%' THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p WHERE p.oid = to_regprocedure('public.settle_job_wallet_reservation(uuid,numeric)');

SELECT 'postflight' AS section, 'settle SECURITY DEFINER + pinned search_path + already_settled intact' AS check_name,
       CASE WHEN p.prosecdef
             AND array_to_string(p.proconfig, ',') LIKE '%search_path=public, pg_temp%'
             AND pg_get_functiondef(p.oid) LIKE '%already_settled%' THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p WHERE p.oid = to_regprocedure('public.settle_job_wallet_reservation(uuid,numeric)');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.settle_job_wallet_reservation(uuid,numeric)')
             AND pg_get_functiondef(p.oid) LIKE '%LEAST(v_amount, v_actual_spending)%') THEN
    RAISE EXCEPTION 'NO-GO: settle still caps service fare to spend';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.settle_job_wallet_reservation(uuid,numeric)')
                 AND pg_get_functiondef(p.oid) LIKE '%v_settlement_amount := ROUND((v_amount + v_actual_spending)%') THEN
    RAISE EXCEPTION 'NO-GO: fare+spend settlement missing';
  END IF;
END
$$;

SELECT 'postflight' AS section, 'POSTFLIGHT_COMPLETE' AS check_name, 'PASS' AS verdict, 'errand economics verified' AS detail;
ROLLBACK;
