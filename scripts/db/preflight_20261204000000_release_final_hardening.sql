-- MOVABI 2.1 — PREFLIGHT for 20261204000000_release_final_hardening.sql (READ ONLY)
BEGIN TRANSACTION READ ONLY;

SELECT 'preflight' AS section, 'payout trigger still present (pre-state)' AS check_name,
       CASE WHEN EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                         WHERE t.tgname = 'tr_calculate_job_payouts' AND c.relname = 'jobs') THEN 'PASS' ELSE 'FAIL' END AS verdict;

SELECT 'preflight' AS section, 'pay_job_from_wallet still inflates total_price (pre-state)' AS check_name,
       CASE WHEN pg_get_functiondef(p.oid) LIKE '%total_price = v_amount%' THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p WHERE p.oid = to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)');

SELECT 'preflight' AS section, 'no payment-eligibility trigger yet (pre-state)' AS check_name,
       CASE WHEN NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'trg_enforce_job_payment_eligibility') THEN 'PASS' ELSE 'FAIL' END AS verdict;

SELECT 'preflight' AS section, 'no completion secret table yet (pre-state)' AS check_name,
       CASE WHEN to_regclass('public.job_completion_secrets') IS NULL THEN 'PASS' ELSE 'FAIL' END AS verdict;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                 WHERE t.tgname = 'tr_calculate_job_payouts' AND c.relname = 'jobs') THEN
    RAISE EXCEPTION 'NO-GO: payout trigger already removed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)')
                 AND pg_get_functiondef(p.oid) LIKE '%total_price = v_amount%') THEN
    RAISE EXCEPTION 'NO-GO: pay_job_from_wallet already hardened';
  END IF;
END
$$;

SELECT 'preflight' AS section, 'PREFLIGHT_COMPLETE' AS check_name, 'PASS' AS verdict, 'pre-state verified' AS detail;
ROLLBACK;
