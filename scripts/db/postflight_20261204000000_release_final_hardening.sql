-- MOVABI 2.1 — POSTFLIGHT for 20261204000000_release_final_hardening.sql (READ ONLY)
BEGIN TRANSACTION READ ONLY;

SELECT 'postflight' AS section, 'payout trigger retired' AS check_name,
       CASE WHEN NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'tr_calculate_job_payouts') THEN 'PASS' ELSE 'FAIL' END AS verdict;

SELECT 'postflight' AS section, 'payment-eligibility trigger present' AS check_name,
       CASE WHEN EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'trg_enforce_job_payment_eligibility' AND t.tgenabled = 'O') THEN 'PASS' ELSE 'FAIL' END AS verdict;

SELECT 'postflight' AS section, 'pay_job_from_wallet no longer inflates total_price' AS check_name,
       CASE WHEN pg_get_functiondef(p.oid) LIKE '%total_price = COALESCE(total_price, v_amount)%'
             AND pg_get_functiondef(p.oid) NOT LIKE '%total_price = v_amount%' THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_proc p WHERE p.oid = to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)');

SELECT 'postflight' AS section, 'completion secret table exists with customer-only RLS' AS check_name,
       CASE WHEN to_regclass('public.job_completion_secrets') IS NOT NULL
             AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'job_completion_secrets' AND policyname = 'Customers can view own completion pin') THEN 'PASS' ELSE 'FAIL' END AS verdict;

SELECT 'postflight' AS section, 'anon cannot read completion secrets' AS check_name,
       CASE WHEN NOT has_table_privilege('anon', 'public.job_completion_secrets', 'SELECT') THEN 'PASS' ELSE 'FAIL' END AS verdict;

SELECT 'postflight' AS section, 'Phase A still disabled' AS check_name,
       CASE WHEN tg.tgenabled = 'D' THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (SELECT 1) o LEFT JOIN pg_trigger tg ON tg.tgname = 'trg_enforce_job_acquisition_eligibility' AND NOT tg.tgisinternal;

SELECT 'postflight' AS section, 'N12 still unique + valid' AS check_name,
       CASE WHEN i.indisunique AND i.indisvalid THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM (SELECT 1) o LEFT JOIN pg_index i ON i.indrelid = to_regclass('public.jobs') AND i.indexrelid = to_regclass('public.idx_jobs_one_active_per_driver');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'tr_calculate_job_payouts') THEN
    RAISE EXCEPTION 'NO-GO: payout trigger still present';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'trg_enforce_job_payment_eligibility') THEN
    RAISE EXCEPTION 'NO-GO: payment-eligibility trigger missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)')
             AND pg_get_functiondef(p.oid) LIKE '%total_price = v_amount%') THEN
    RAISE EXCEPTION 'NO-GO: pay_job_from_wallet still inflates total_price';
  END IF;
  IF to_regclass('public.job_completion_secrets') IS NULL THEN
    RAISE EXCEPTION 'NO-GO: completion secret table missing';
  END IF;
END
$$;

SELECT 'postflight' AS section, 'POSTFLIGHT_COMPLETE' AS check_name, 'PASS' AS verdict, 'final hardening verified' AS detail;
ROLLBACK;
