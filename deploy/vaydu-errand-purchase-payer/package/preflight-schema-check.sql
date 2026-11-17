-- Pre-deploy schema check for the errand purchase-payer + wallet settlement
-- package (migrations 202612705..202612711). Read-only: reports each required
-- object and whether it is already present on this database. Apply ONLY the
-- migration files whose required objects report 'missing' — in the order
-- shown in RUNBOOK.md §1 — and never replay an applied migration.
\set ON_ERROR_STOP on
SELECT CASE WHEN current_database()='movabi_develop' THEN 'movabi_develop' ELSE 'WRONG DATABASE: '||current_database() END AS target;

WITH req(migration,obj) AS (VALUES
 -- baseline dependencies the chain consumes but never creates (must already
 -- exist on a healthy develop; if any reports 'missing' STOP — the restore or
 -- database is not the reviewed develop state and there is no shipped file
 -- that is authorised to create it)
 ('prereq/baseline','table:public.jobs'),
 ('prereq/baseline','table:public.profiles'),
 ('prereq/baseline','table:public.driver_earnings'),
 ('prereq/baseline','table:public.job_payout_queue'),
 ('prereq/baseline','table:public.driver_payment_accounts'),
 ('prereq/baseline','table:public.driver_payout_markets'),
 ('prereq/baseline','table:public.wallet_movements'),
 ('prereq/baseline','table:public.refund_operations'),
 ('prereq/baseline','function:public.complete_job_with_pending_payout'),
 -- prerequisite migration 202612547 (flutterwave payout outbox)
 ('prereq/547','function:public.claim_flutterwave_job_submission'),
 ('prereq/547','table:public.flutterwave_job_submissions'),
 ('prereq/547','column:public.jobs.payout_provider'),
 ('prereq/547','column:public.driver_earnings.payout_provider'),
 -- prerequisite migration 202612548 (collection subaccounts + settlement methods)
 ('prereq/548','table:public.job_settlement_methods'),
 ('prereq/548','table:public.driver_collection_markets'),
 ('prereq/548','table:public.driver_collection_subaccounts'),
 ('prereq/548','function:public.guard_job_transfer_method'),
 ('prereq/548','function:public.claim_driver_collection_subaccount'),
 -- collection chain prerequisites (batch-2 wallet collection, already deployed)
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
 ('202612706','function:public.bridge_customer_wallet_topup'),
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

-- Object presence is not enough. Two checks on deployed function DEFINITIONS:
--
-- A) Apply-safety: 202612547 rewrites complete_job_with_pending_payout only
--    when it finds the exact deployed GBP/'acct_%' Stripe identity check. If
--    the source differs, applying 547 raises 'Completion authority differs;
--    review required' — nothing may be applied until reconciled.
SELECT 'patch-target/547' AS grp,'complete_job_with_pending_payout' AS name,
 CASE WHEN d.def IS NULL THEN 'function-absent — STOP (baseline prerequisite)'
      WHEN position('Invalid payout identity' IN d.def)>0
        AND position('acct_%' IN d.def)>0 AND position('gbp' IN d.def)>0
      THEN 'definition-verified'
      ELSE 'DEFINITION-DIFFERS — STOP' END AS state
FROM (SELECT (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
       JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='complete_job_with_pending_payout'
         AND oidvectortypes(p.proargtypes)='uuid, uuid, jsonb, jsonb' LIMIT 1) AS def) d;

-- B) Convergence: functions the chain CREATE OR REPLACEs may already exist
--    with pre-release definitions while every object reports 'present'. A
--    DEFINITION-DIFFERS row means the deployed source is the old shape and
--    the mapped file still needs applying (or, if recorded-applied, drift).
SELECT d.grp,d.name,
 CASE WHEN f.def IS NULL THEN 'function-absent'
      WHEN (d.anchor1 IS NULL OR position(d.anchor1 IN f.def)>0)
        AND (d.anchor2 IS NULL OR position(d.anchor2 IN f.def)>0)
        AND (d.absent IS NULL OR position(d.absent IN f.def)=0)
      THEN 'definition-verified'
      ELSE 'DEFINITION-DIFFERS' END AS state
FROM (VALUES
 ('202612705','complete_job_with_pending_payout','uuid, uuid, jsonb, jsonb','Invalid sandbox payout identity',NULL::text,NULL::text),
 ('202612705','finish_queued_job_payout',NULL,'settlement_mode',NULL,NULL),
 ('202612705','finish_flutterwave_job_payout',NULL,'flutterwave_job_submissions',NULL,NULL),
 ('202612707','guard_job_transfer_method',NULL,'settlement_mode',NULL,NULL),
 ('202612708','guard_job_transfer_method',NULL,'resolve_driver_settlement_method',NULL,NULL),
 ('202612709','payout_withdrawal_provider_supported',NULL,'kora',NULL,NULL),
 ('202612710','freeze_wallet_topup_fee','uuid, text','provider_account_id',NULL,NULL),
 ('202612711','finish_driver_withdrawal',NULL,NULL,NULL,'KPY-'),
 ('prereq/547','claim_flutterwave_job_submission',NULL,'flutterwave_job_submissions','_PMCK',NULL)
) d(grp,name,sig,anchor1,anchor2,absent)
LEFT JOIN LATERAL (
 SELECT pg_get_functiondef(p.oid) AS def
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname=d.name
   AND (d.sig IS NULL OR oidvectortypes(p.proargtypes)=d.sig) LIMIT 1
) f ON true;

-- Recorded application state, not just object presence: a migration is
-- APPLY-eligible only when its version is unrecorded AND its objects are
-- missing. A recorded version with missing objects is schema DRIFT —
-- investigate before applying anything (never silently replay). Likewise an
-- unrecorded version whose objects are all present is drift in the other
-- direction — do not apply; reconcile how the objects got there first.
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
 ('20261254700000','20261254700000_flutterwave_payout_outbox.sql','prereq/547'),
 ('20261254800000','20261254800000_flutterwave_collection_subaccounts.sql','prereq/548'),
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

-- Apply decision (from definitions + records, not object presence alone):
--  * objects_missing>0 AND recorded IN('not-recorded','unknown') -> apply that file
--  * a convergence row DEFINITION-DIFFERS for the file's group with the
--    function PRESENT                                         -> apply that file
--    (its objects exist but its code change was never deployed)
--  * objects_missing=0 AND recorded='recorded-applied'
--    AND that group's convergence rows are definition-verified  -> skip entirely
--  * objects_missing>0 AND recorded='recorded-applied'          -> DRIFT: stop
--  * objects_missing=0 AND recorded IN('not-recorded','unknown')
--    AND that group's convergence rows are all verified/absent  -> DRIFT: stop
--  * a convergence DEFINITION-DIFFERS on a recorded-applied file -> DRIFT: stop
--  * patch-target/547 not 'definition-verified'                 -> STOP:
--    the deployed function was changed outside the reviewed chain
--  * any 'prereq/baseline' or 'prereq/collection' row 'missing'   -> STOP:
--    no shipped file is authorised to fix it; reconcile manually first.
-- Dependency order is defined by the package manifest, not discovered from
-- objects: apply files strictly in this order —
--   202612547 -> 202612548 -> 202612705 -> 706 -> 707 -> 708 -> 709 -> 710 -> 711
-- each file's in-file guard also raises when its prerequisites are absent.
