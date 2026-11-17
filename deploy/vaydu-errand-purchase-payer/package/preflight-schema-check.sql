-- Pre-deploy schema check for the errand purchase-payer + wallet settlement
-- package (migrations 202612705..202612711). Read-only: reports each required
-- object and whether it is already present on this database. Apply ONLY the
-- migration files whose required objects report 'missing' — in the order
-- shown in RUNBOOK.md §1 — and never replay an applied migration.
\set ON_ERROR_STOP on
SELECT CASE WHEN current_database()='movabi_develop' THEN 'movabi_develop' ELSE 'WRONG DATABASE: '||current_database() END AS target;

WITH req(migration,obj) AS (VALUES
 -- prerequisites from the already-deployed chain (must exist before 705)
 ('prereq/547','function:public.claim_flutterwave_job_submission'),
 ('prereq/547','table:public.flutterwave_job_submissions'),
 ('prereq/547','column:public.jobs.payout_provider'),
 ('prereq/547','column:public.driver_earnings.payout_provider'),
 ('prereq/collection','function:public.initiate_wallet_topup'),
 ('prereq/collection','function:public.freeze_wallet_topup_fee'),
 ('prereq/collection','table:public.wallet_topup_attempts'),
 ('prereq/collection','table:public.market_payment_routes'),
 ('prereq/collection','column:public.wallet_topup_attempts.provider_account_id'),
 -- 705 errand purchase payer
 ('202612705','table:public.errand_purchase_payments'),
 ('202612705','function:public.claim_queued_job_payout'),
 ('202612705','function:public.finish_queued_job_payout'),
 -- 706 booking wallet bridge
 ('202612706','function:public.pay_job_from_wallet'),
 ('202612706','function:public.confirm_wallet_topup_with_total'),
 -- 707 driver wallet settlement + withdrawal machine
 ('202612707','table:public.driver_withdrawals'),
 ('202612707','table:public.driver_withdrawal_submissions'),
 ('202612707','table:public.driver_payout_markets'),
 ('202612707','function:public.request_driver_withdrawal'),
 ('202612707','function:public.claim_driver_withdrawal'),
 ('202612707','function:public.claim_withdrawal_submission'),
 ('202612707','function:public.mark_driver_withdrawal_retry'),
 ('202612707','function:public.reverse_driver_withdrawal'),
 ('202612707','function:public.driver_earnings_wallet_balance'),
 -- 708 settlement policy
 ('202612708','table:public.driver_payout_preferences'),
 ('202612708','function:public.resolve_driver_settlement_method'),
 ('202612708','function:public.set_driver_settlement_preference'),
 -- 709 kora adapter
 ('202612709','function:public.payout_withdrawal_provider_supported'),
 ('202612709','function:public.finish_driver_withdrawal'),
 -- 710 collection account binding
 ('202612710','column:public.market_payment_routes.provider_account_id'),
 -- 711 kora settle reference (function replaced; presence proven by 709 row)
 ('202612711','function:public.finish_driver_withdrawal')
), chk AS (
 SELECT migration,obj,
  CASE
   WHEN obj LIKE 'table:%' THEN to_regclass(substring(obj from 7)) IS NOT NULL
   WHEN obj LIKE 'column:%' THEN EXISTS(
     SELECT 1 FROM information_schema.columns
     WHERE table_schema||'.'||table_name=split_part(substring(obj from 8),'.',1)||'.'||split_part(substring(obj from 8),'.',2)
       AND column_name=split_part(substring(obj from 8),'.',3))
   WHEN obj LIKE 'function:%' THEN EXISTS(
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname||'.'||p.proname=substring(obj from 10))
  END AS present
 FROM req)
SELECT * INTO TEMP TABLE _preflight_chk FROM chk;
SELECT migration,obj,CASE WHEN present THEN 'present' ELSE 'missing' END AS state
FROM _preflight_chk ORDER BY migration,obj;

-- Recorded application state, not just object presence: a migration is
-- APPLY-eligible only when its version is unrecorded AND its objects are
-- missing. A recorded version with missing objects is schema DRIFT —
-- investigate before applying anything (never silently replay).
CREATE TEMP TABLE _preflight_recorded(version text);
DO $$ BEGIN
 IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
  EXECUTE 'INSERT INTO _preflight_recorded SELECT version FROM supabase_migrations.schema_migrations';
 END IF;
END $$;
SELECT CASE WHEN to_regclass('supabase_migrations.schema_migrations') IS NULL
 THEN 'no supabase_migrations.schema_migrations table — inventory by object state only'
 ELSE 'schema_migrations present' END AS migration_registry;

SELECT v.filename,
 CASE WHEN to_regclass('supabase_migrations.schema_migrations') IS NULL THEN 'unknown'
      WHEN EXISTS(SELECT 1 FROM _preflight_recorded r WHERE r.version=v.version)
      THEN 'recorded-applied' ELSE 'not-recorded' END AS recorded,
 coalesce(m.cnt,0) AS objects_missing
FROM (VALUES
 ('20261270500000','20261270500000_errand_purchase_payer.sql','202612705'),
 ('20261270600000','20261270600000_customer_wallet_booking_bridge.sql','202612706'),
 ('20261270700000','20261270700000_driver_wallet_settlement.sql','202612707'),
 ('20261270800000','20261270800000_driver_settlement_policy.sql','202612708'),
 ('20261270900000','20261270900000_kora_payout_adapter.sql','202612709'),
 ('20261271000000','20261271000000_customer_collection_account_binding.sql','202612710'),
 ('20261271100000','20261271100000_kora_settle_reference.sql','202612711')
) v(version,filename,mig)
LEFT JOIN (SELECT migration,count(*) AS cnt FROM _preflight_chk WHERE NOT present GROUP BY migration) m
 ON m.migration=v.mig
ORDER BY v.version;

-- Dependency order is defined by the package manifest, not discovered from
-- objects: apply files strictly in filename order; each file's in-file guard
-- also raises when its prerequisites are absent.
