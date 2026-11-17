-- Real-Postgres test for 20261270500000_errand_purchase_payer.sql (disposable database only).
-- Deployed baseline + the migration. Covers:
--   funded-budget authority (estimate above funded, requested-but-unfunded increase)
--   per-purchase payer records, method lock, unsupported/mixed-method rejection
--   driver-personal errand end to end: reservation -> spend -> completion -> queued
--     payout (fare entitlement + reimbursement in one outbox transfer) -> reimbursed
--   payout-worker semantics: pending keeps purchases 'recorded', exactly-once finish,
--     retry after an uncertain provider outcome
--   cancellation after purchase requires reconciliation (no silent customer release)
-- Everything runs in one transaction and ROLLS BACK.
\set ON_ERROR_STOP on
BEGIN;
-- Fixture-only trigger bypass (disposable DB, never production): jobs triggers that
-- require live auth context (auth.uid()/notification fan-out/market eligibility) are
-- disabled for fixture inserts. KEPT ENABLED — the production payment/completion
-- path is exercised with them on:
--   trg_enforce_job_payment_eligibility, enforce_ride_cash_credit_v1e (payment integrity)
--   tr_check_errand_completion_guard (blocks completion with a pending over-budget request)
--   reward_credit_reserve, trg_sync_job_prices, tr_update_jobs_updated_at (data-only)
DO $d$ DECLARE t text; BEGIN
 FOR t IN SELECT tgname FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid WHERE c.relname='jobs' AND NOT tgisinternal
   AND tgname NOT IN ('trg_enforce_job_payment_eligibility','enforce_ride_cash_credit_v1e',
     'tr_check_errand_completion_guard','reward_credit_reserve','trg_sync_job_prices','tr_update_jobs_updated_at')
 LOOP EXECUTE format('ALTER TABLE public.jobs DISABLE TRIGGER %I', t); END LOOP; END $d$;

INSERT INTO public.tenants(id,name,slug) VALUES ('11111111-1111-4111-8111-111111111111','t','t');
INSERT INTO public.market_availability(country_code,launch_status,supported_currency) VALUES ('GB','live','GBP');
INSERT INTO public.service_types(id,slug,name) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddd02','errand','Errand');
-- One driver per concurrently-active job: idx_jobs_one_active_per_driver enforces it.
INSERT INTO auth.users(id) SELECT ('dddddddd-aaaa-4aaa-8aaa-'||lpad(to_hex(g),12,'0'))::uuid FROM generate_series(1,8) g;
INSERT INTO auth.users(id) VALUES ('cccccccc-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),('eeeeeeee-cccc-4ccc-8ccc-cccccccccccc');
INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_country_code)
 SELECT ('dddddddd-aaaa-4aaa-8aaa-'||lpad(to_hex(g),12,'0'))::uuid,'11111111-1111-4111-8111-111111111111','driver','GB','GB' FROM generate_series(1,8) g
 ON CONFLICT (id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,role=EXCLUDED.role,
   country_code=EXCLUDED.country_code,registration_country_code=EXCLUDED.registration_country_code;
INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_country_code) VALUES
 ('cccccccc-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111','customer','GB','GB'),
 ('eeeeeeee-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111','customer','GB','GB')
 ON CONFLICT (id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,role=EXCLUDED.role,
   country_code=EXCLUDED.country_code,registration_country_code=EXCLUDED.registration_country_code;
INSERT INTO public.wallets(user_id,available_balance,reserved_balance,currency_code)
 VALUES ('cccccccc-bbbb-4bbb-8bbb-bbbbbbbbbbbb',500,0,'GBP'),('eeeeeeee-cccc-4ccc-8ccc-cccccccccccc',300,0,'GBP')
 ON CONFLICT (user_id) DO UPDATE SET available_balance=EXCLUDED.available_balance,
   reserved_balance=EXCLUDED.reserved_balance,currency_code=EXCLUDED.currency_code;

CREATE TEMP TABLE results(n int, name text, ok boolean, detail text);

-- A payable errand exactly as create -> wallet pay sees it: requested/pending job, a
-- future-dated quote, errand_details with the (larger) customer estimate and an
-- optional pre-existing 'pending' funding row with the SMALLER funded item budget.
CREATE FUNCTION pg_temp.errand_job(fare numeric, estimate numeric, funded numeric, customer uuid DEFAULT 'cccccccc-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
RETURNS uuid LANGUAGE plpgsql AS $f$ DECLARE id uuid:=gen_random_uuid(); BEGIN
 INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,service_type_id,
   payment_status,country_code,currency_code,status,total_price,metadata,fare_breakdown)
 VALUES (id,'11111111-1111-4111-8111-111111111111',customer,'a','b',now(),'dddddddd-dddd-4ddd-8ddd-dddddddddd02',
   'pending','GB','GBP','requested',fare,
   jsonb_build_object('quote_id',gen_random_uuid(),'quote_expires_at',now()+interval '10 minutes'),
   jsonb_build_object('calculationVersion','test-v1'));
 INSERT INTO public.errand_details(job_id,items_list,estimated_budget) VALUES (id,'[]',estimate);
 IF funded IS NOT NULL THEN
  INSERT INTO public.errand_funding(job_id,customer_id,item_budget,service_estimate,amount_reserved,status)
  VALUES (id,customer,funded,fare,funded,'pending');
 END IF;
 RETURN id; END $f$;
CREATE FUNCTION pg_temp.pay(j uuid, amount numeric, customer uuid DEFAULT 'cccccccc-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
RETURNS jsonb LANGUAGE sql AS $f$ SELECT public.pay_job_from_wallet(j,customer,amount,'GBP','11111111-1111-4111-8111-111111111111'::uuid) $f$;
CREATE FUNCTION pg_temp.drv(n int) RETURNS uuid LANGUAGE sql AS $f$
 SELECT ('dddddddd-aaaa-4aaa-8aaa-'||lpad(to_hex(n),12,'0'))::uuid $f$;
CREATE FUNCTION pg_temp.assign(j uuid, d uuid) RETURNS void LANGUAGE sql AS $f$
 UPDATE public.jobs SET driver_id=d,accepted_driver_id=d,status='accepted' WHERE id=j $f$;
CREATE FUNCTION pg_temp.spend(j uuid, amount numeric) RETURNS text LANGUAGE plpgsql AS $f$ BEGIN
 UPDATE public.errand_details SET actual_spending=amount WHERE job_id=j; RETURN 'ok';
 EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $f$;
CREATE FUNCTION pg_temp.job_terms() RETURNS jsonb LANGUAGE sql AS $f$ SELECT jsonb_build_object(
 'total',10,'payout',8.5,'platformFee',1,'commission',0.5,'commissionRate',15,
 'currency','gbp','amountMinor',850,'destination','acct_drv_test','country','GB') $f$;
CREATE FUNCTION pg_temp.purchases(j uuid) RETURNS jsonb LANGUAGE sql AS $f$
 SELECT coalesce(jsonb_agg(jsonb_build_object('m',purchase_method,'p',payer,'k',kind,'a',amount_minor,'s',status,'t',reimbursement_transfer_id,'r',provider_reference) ORDER BY created_at),'[]')
 FROM public.errand_purchase_payments WHERE job_id=j $f$;
CREATE FUNCTION pg_temp.wbal(customer uuid DEFAULT 'cccccccc-bbbb-4bbb-8bbb-bbbbbbbbbbbb') RETURNS text LANGUAGE sql AS $f$
 SELECT available_balance||'/'||reserved_balance FROM public.wallets WHERE user_id=customer $f$;

-- =========================================================================
-- 1. Funded budget is authoritative; a higher estimate never grants spend.
-- =========================================================================
DO $t$ DECLARE j uuid; r text; BEGIN
 j:=pg_temp.errand_job(10,50,30);
 r:=(pg_temp.pay(j,40))->>'status';
 INSERT INTO results VALUES (1,'wallet pay reserves fare + funded budget (30), not the estimate',r='paid' AND pg_temp.wbal()='460.00/40.00',r||' '||pg_temp.wbal());
 PERFORM pg_temp.assign(j,pg_temp.drv(1));
 INSERT INTO results VALUES (1,'spend inside the funded budget is recorded',pg_temp.spend(j,30)='ok','');
 INSERT INTO results VALUES (1,'payer evidence: one driver-personal manual purchase',pg_temp.purchases(j)
   ='[{"m":"driver_personal","p":"driver","k":"manual","a":3000,"s":"recorded","t":null,"r":"manual-spend"}]'::jsonb,pg_temp.purchases(j)::text);
 INSERT INTO results VALUES (1,'estimate (50) above the funded budget cannot be spent',pg_temp.spend(j,31) LIKE '%exceeds the funded budget%','');
 INSERT INTO results VALUES (1,'the job method locked to driver_personal',
   (SELECT purchase_method FROM public.errand_funding WHERE job_id=j)='driver_personal','');
 PERFORM public.request_errand_over_budget(j,80,'items cost more than listed');
 INSERT INTO results VALUES (1,'requested-but-unfunded increase still caps at 30',pg_temp.spend(j,31) LIKE '%exceeds the funded budget%','');
 PERFORM public.approve_errand_over_budget(j);
 INSERT INTO results VALUES (1,'approved increase is funded: delta reserved, budget now 80',
   (SELECT item_budget FROM public.errand_funding WHERE job_id=j)=80 AND pg_temp.wbal()='410.00/90.00',pg_temp.wbal());
 INSERT INTO results VALUES (1,'spend above the NEW funded budget is rejected',pg_temp.spend(j,81) LIKE '%exceeds the funded budget%','');
 INSERT INTO results VALUES (1,'spend within the funded budget updates the payer record',pg_temp.spend(j,75)='ok'
   AND pg_temp.purchases(j)='[{"m":"driver_personal","p":"driver","k":"manual","a":7500,"s":"recorded","t":null,"r":"manual-spend"}]'::jsonb,pg_temp.purchases(j)::text);
END $t$;

-- =========================================================================
-- 2. Method lock + unsupported / mixed-method rejection.
-- =========================================================================
DO $t$ DECLARE j uuid; msg text; BEGIN
 j:=pg_temp.errand_job(10,50,30); PERFORM pg_temp.pay(j,40); PERFORM pg_temp.assign(j,pg_temp.drv(2)); PERFORM pg_temp.spend(j,20);
 BEGIN PERFORM public.activate_job_issuing_control(j,'card_late',30,'{}'); msg:='NO ERROR';
 EXCEPTION WHEN OTHERS THEN msg:=SQLERRM; END;
 INSERT INTO results VALUES (2,'cannot switch to the Vaydu card after driver spend is recorded',msg LIKE '%different purchase method%',msg);
 BEGIN
  INSERT INTO public.errand_purchase_payments(job_id,purchase_method,payer,kind,amount_minor,currency,provider_reference)
   VALUES (j,'customer_direct','customer','capture',2000,'GBP','shop-ref-1'); msg:='NO ERROR';
 EXCEPTION WHEN OTHERS THEN msg:=SQLERRM; END;
 INSERT INTO results VALUES (2,'customer-direct purchases are rejected until enabled',msg LIKE '%not enabled%',msg);
 BEGIN
  INSERT INTO public.errand_purchase_payments(job_id,purchase_method,payer,kind,amount_minor,currency,provider_reference)
   VALUES (j,'vaydu_card','vaydu','capture',2000,'GBP','txn-x'); msg:='NO ERROR';
 EXCEPTION WHEN OTHERS THEN msg:=SQLERRM; END;
 INSERT INTO results VALUES (2,'a second method on the same job is rejected',msg LIKE '%Mixed purchase methods%',msg);
 BEGIN
  INSERT INTO public.errand_purchase_payments(job_id,purchase_method,payer,kind,amount_minor,currency,provider_reference)
   VALUES (j,'vaydu_card','driver','capture',100,'GBP','txn-y'); msg:='NO ERROR';
 EXCEPTION WHEN OTHERS THEN msg:=SQLERRM; END;
 INSERT INTO results VALUES (2,'a payer that does not match the method is rejected',msg LIKE '%does not match%',msg);
END $t$;

-- =========================================================================
-- 3. Card-funded errand: activation locks the method; spend comes only from
--    the issuing ledger; ledger replays dedupe.
-- =========================================================================
DO $t$ DECLARE j uuid; f uuid:=gen_random_uuid(); msg text; ap jsonb; BEGIN
 j:=pg_temp.errand_job(10,50,NULL,'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc');
 UPDATE public.jobs SET payment_method='card',payment_status='authorized',payment_intent_id='pi_c1',
   driver_id=pg_temp.drv(3),accepted_driver_id=pg_temp.drv(3),status='accepted' WHERE id=j;
 INSERT INTO public.errand_funding(job_id,customer_id,item_budget,service_estimate,amount_reserved,status)
  VALUES (j,'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc',50,10,50,'reserved');
 PERFORM public.activate_job_issuing_control(j,'card_c1',50,'{}');
 INSERT INTO results VALUES (3,'card activation locks the job to vaydu_card',
   (SELECT purchase_method FROM public.errand_funding WHERE job_id=j)='vaydu_card','');
 INSERT INTO results VALUES (3,'manual spend cannot be recorded under a card method',
   pg_temp.spend(j,10) LIKE '%card ledger%','');
 INSERT INTO public.job_issuing_reserves(job_id,currency,amount_remaining) VALUES (j,'gbp',50);
 ap:=public.record_issuing_authorization_request('card_c1','iauth_c1',20,'gbp','{"merchant_data":{"name":"Shop A","category":"grocery"},"status":"authorized"}');
 INSERT INTO results VALUES (3,'an authorization inside the card limit is approved',(ap->>'approved')::boolean,ap::text);
 PERFORM public.record_issuing_transaction('txn_c1','iauth_c1','card_c1',20,'gbp','capture','{"merchant_data":{"name":"Shop A"}}');
 INSERT INTO results VALUES (3,'the capture wrote a vaydu-payer purchase row',pg_temp.purchases(j)
   ='[{"m":"vaydu_card","p":"vaydu","k":"capture","a":2000,"s":"recorded","t":null,"r":"txn_c1"}]'::jsonb,pg_temp.purchases(j)::text);
 PERFORM public.record_issuing_transaction('txn_c1','iauth_c1','card_c1',20,'gbp','capture','{"merchant_data":{"name":"Shop A"}}');
 INSERT INTO results VALUES (3,'replaying the same transaction dedupes the payer record',
   (SELECT count(*) FROM public.errand_purchase_payments WHERE job_id=j)=1,'');
 INSERT INTO results VALUES (3,'ledger spend syncs to errand_details (allowed: equals ledger)',pg_temp.spend(j,20)='ok','');
 INSERT INTO results VALUES (3,'a manual value different from the ledger is rejected',pg_temp.spend(j,25) LIKE '%card ledger%','');
END $t$;

-- =========================================================================
-- 4. Full driver-personal errand: reservation -> spend -> completion -> queued
--    payout (fare entitlement + reimbursement) -> reimbursed exactly once.
-- =========================================================================
DO $t$ DECLARE j uuid; q public.job_payout_queue; n int; e record; tok uuid; ok boolean; r text; BEGIN
 j:=pg_temp.errand_job(10,50,30,'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc');
 PERFORM pg_temp.pay(j,40,'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc'); PERFORM pg_temp.assign(j,pg_temp.drv(4)); PERFORM pg_temp.spend(j,20);
 UPDATE public.jobs SET status='in_progress' WHERE id=j;
 PERFORM public.complete_job_with_pending_payout(j,pg_temp.drv(4),pg_temp.job_terms(),
   jsonb_build_object('completion_pin_verified_at',now()));
 SELECT * INTO q FROM public.job_payout_queue WHERE job_id=j;
 INSERT INTO results VALUES (4,'one outbox transfer carries fare entitlement + reimbursement (850+2000)',
   q.amount_minor=2850 AND q.status='pending' AND (q.terms->>'reimbursementMinor')::int=2000
   AND q.terms->>'purchaseMethod'='driver_personal',q.terms::text);
 INSERT INTO results VALUES (4,'customer settled fare + spend; unused budget released',
   pg_temp.wbal('eeeeeeee-cccc-4ccc-8ccc-cccccccccccc')='270.00/0.00'
   AND (SELECT status FROM public.errand_funding WHERE job_id=j)='settled'
   AND (SELECT refund_amount FROM public.errand_funding WHERE job_id=j)=10,pg_temp.wbal('eeeeeeee-cccc-4ccc-8ccc-cccccccccccc'));
 SELECT amount,gross_amount,status INTO e FROM public.driver_earnings WHERE job_id=j;
 INSERT INTO results VALUES (4,'earnings stay commissionable-fare only (8.50 of 10.00)',
   e.amount=8.5 AND e.gross_amount=10 AND e.status='pending',e.amount::text);
 -- spend can no longer change after completion
 INSERT INTO results VALUES (4,'spend is frozen once the booking ends',pg_temp.spend(j,22) LIKE '%ended%','');
 -- payout worker: claim -> processing; purchases must NOT be marked paid yet
 SELECT * INTO q FROM public.claim_queued_job_payout(j) LIMIT 1; tok:=q.token;
 INSERT INTO results VALUES (4,'claimed payout stays recorded until the transfer lands',
   q.status='processing' AND (SELECT status FROM public.errand_purchase_payments WHERE job_id=j)='recorded',q.status);
 SELECT count(*) INTO n FROM public.claim_queued_job_payout(j);
 INSERT INTO results VALUES (4,'a live lease blocks a second claim (exactly-once worker)',n=0,n::text);
 ok:=public.finish_queued_job_payout(j,gen_random_uuid(),'tr_wrong');
 INSERT INTO results VALUES (4,'a wrong claim token cannot finish the payout',NOT ok AND q.status='processing','');
 ok:=public.finish_queued_job_payout(j,tok,'tr_main_1');
 INSERT INTO results VALUES (4,'confirmed transfer marks the purchase reimbursed once',
   ok AND pg_temp.purchases(j)='[{"m":"driver_personal","p":"driver","k":"manual","a":2000,"s":"reimbursed","t":"tr_main_1","r":"manual-spend"}]'::jsonb
   AND (SELECT status FROM public.job_payout_queue WHERE job_id=j)='paid',pg_temp.purchases(j)::text);
 ok:=public.finish_queued_job_payout(j,tok,'tr_main_1');
 INSERT INTO results VALUES (4,'replayed finish is idempotent (still one reimbursed purchase)',
   ok AND (SELECT count(*) FROM public.errand_purchase_payments WHERE job_id=j AND status='reimbursed')=1,'');
 INSERT INTO results VALUES (4,'the job records the completed settlement',
   (SELECT settlement_status='transferred' AND status='completed' FROM public.jobs WHERE id=j),'');
 -- retrying the whole completion is a safe replay
 PERFORM public.complete_job_with_pending_payout(j,pg_temp.drv(4),pg_temp.job_terms(),
   jsonb_build_object('completion_pin_verified_at',now()));
 INSERT INTO results VALUES (4,'replayed completion does not create a second payout',
   (SELECT count(*) FROM public.job_payout_queue WHERE job_id=j)=1,'');
 r:=(public.settle_job_wallet_reservation(j,10))->>'status';
 INSERT INTO results VALUES (4,'wallet settlement is exactly-once',r='already_settled',r);
END $t$;

-- =========================================================================
-- 5. Legacy spend + retry after an uncertain provider outcome.
--    A missing purchase row is NOT proof the driver paid:
--    * issuing-funded records are excluded (Vaydu paid, no reimbursement);
--    * an already-paid job enters reconciliation;
--    * ambiguous spend (no driver receipt) enters reconciliation;
--    * positive driver-paid evidence (the recorded receipt) is reimbursed.
-- =========================================================================
DO $t$ DECLARE j uuid; q public.job_payout_queue; tok uuid; ok boolean; msg text; BEGIN
 -- 5a. Ambiguous legacy spend: no payer row, no issuing records, no receipt.
 j:=pg_temp.errand_job(10,50,30,'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc');
 PERFORM pg_temp.pay(j,40,'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc'); PERFORM pg_temp.assign(j,pg_temp.drv(5));
 PERFORM pg_temp.spend(j,20);
 DELETE FROM public.errand_purchase_payments WHERE job_id=j;
 UPDATE public.errand_funding SET purchase_method=NULL WHERE job_id=j;
 UPDATE public.jobs SET status='in_progress' WHERE id=j;
 BEGIN
  PERFORM public.complete_job_with_pending_payout(j,pg_temp.drv(5),pg_temp.job_terms(),
    jsonb_build_object('completion_pin_verified_at',now())); msg:='NO ERROR';
 EXCEPTION WHEN OTHERS THEN msg:=SQLERRM; END;
 INSERT INTO results VALUES (5,'ambiguous legacy spend enters reconciliation, never auto-paid',
   msg LIKE '%requires reconciliation%' AND (SELECT count(*) FROM public.job_payout_queue WHERE job_id=j)=0,msg);

 -- 5b. Positive driver-paid evidence (the recorded receipt) is backfilled.
 UPDATE public.errand_details SET receipt_url='receipts/legacy-a.jpg' WHERE job_id=j;
 PERFORM public.complete_job_with_pending_payout(j,pg_temp.drv(5),pg_temp.job_terms(),
   jsonb_build_object('completion_pin_verified_at',now()));
 INSERT INTO results VALUES (5,'receipt-evidenced legacy spend is backfilled into the outbox',
   (SELECT amount_minor FROM public.job_payout_queue WHERE job_id=j)=2850
   AND (SELECT payer FROM public.errand_purchase_payments WHERE job_id=j)='driver',
   pg_temp.purchases(j)::text);
 SELECT * INTO q FROM public.claim_queued_job_payout(j) LIMIT 1;
 -- Provider outcome was uncertain: worker marks the row 'reconcile'.
 UPDATE public.job_payout_queue SET status='reconcile',lease_until=now()-interval '1 minute' WHERE job_id=j;
 SELECT * INTO q FROM public.claim_queued_job_payout(j) LIMIT 1; tok:=q.token;
 INSERT INTO results VALUES (5,'an uncertain outcome is reclaimable as reconcile without a new attempt',
   q.status='reconcile' AND q.attempt=1,q.attempt::text);
 ok:=public.finish_queued_job_payout(j,tok,'tr_retry_1');
 INSERT INTO results VALUES (5,'the retried transfer reimburses the driver exactly once',
   ok AND (SELECT reimbursement_transfer_id FROM public.errand_purchase_payments WHERE job_id=j)='tr_retry_1','');

 -- 5c. Issuing-funded legacy spend is excluded: Vaydu paid, nothing owed the driver.
 j:=pg_temp.errand_job(10,50,30,'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc');
 PERFORM pg_temp.pay(j,40,'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc'); PERFORM pg_temp.assign(j,pg_temp.drv(6));
 UPDATE public.errand_details SET actual_spending=20 WHERE job_id=j;
 DELETE FROM public.errand_purchase_payments WHERE job_id=j;
 UPDATE public.errand_funding SET purchase_method=NULL,metadata=metadata||'{"shopping_spend_source":"issuing"}' WHERE job_id=j;
 INSERT INTO public.job_issuing_spend_controls(job_id,driver_id,customer_id,tenant_id,stripe_card_id,amount_limit,currency_code,status)
  VALUES (j,pg_temp.drv(6),'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111','card_leg',50,'GBP','active');
 UPDATE public.jobs SET status='in_progress' WHERE id=j;
 PERFORM public.complete_job_with_pending_payout(j,pg_temp.drv(6),pg_temp.job_terms(),
   jsonb_build_object('completion_pin_verified_at',now()));
 INSERT INTO results VALUES (5,'issuing-funded legacy spend pays no driver reimbursement',
   (SELECT amount_minor FROM public.job_payout_queue WHERE job_id=j)=850
   AND (SELECT purchase_method FROM public.errand_funding WHERE job_id=j)='vaydu_card'
   AND NOT EXISTS(SELECT 1 FROM public.errand_purchase_payments WHERE job_id=j AND payer='driver'),'');

 -- 5d. An already-paid job with unrecorded spend is an obligation to reconcile.
 j:=pg_temp.errand_job(10,50,30,'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc');
 PERFORM pg_temp.pay(j,40,'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc'); PERFORM pg_temp.assign(j,pg_temp.drv(7));
 UPDATE public.errand_details SET actual_spending=20 WHERE job_id=j;
 DELETE FROM public.errand_purchase_payments WHERE job_id=j;
 UPDATE public.errand_funding SET purchase_method=NULL WHERE job_id=j;
 INSERT INTO public.driver_earnings(driver_id,job_id,amount,platform_fee,gross_amount,status,currency_code,country_code,stripe_transfer_id)
  VALUES (pg_temp.drv(7),j,8.5,1,10,'paid','GBP','GB','tr_old_1');
 UPDATE public.jobs SET status='in_progress' WHERE id=j;
 BEGIN
  PERFORM public.complete_job_with_pending_payout(j,pg_temp.drv(7),pg_temp.job_terms(),
    jsonb_build_object('completion_pin_verified_at',now())); msg:='NO ERROR';
 EXCEPTION WHEN OTHERS THEN msg:=SQLERRM; END;
 INSERT INTO results VALUES (5,'already-paid earnings with unrecorded spend requires reconciliation',
   msg LIKE '%requires reconciliation%' AND (SELECT count(*) FROM public.job_payout_queue WHERE job_id=j)=0,msg);
END $t$;

-- =========================================================================
-- 6. Cancellation after purchase requires reconciliation; funds stay put.
-- =========================================================================
DO $t$ DECLARE j uuid; msg text; BEGIN
 j:=pg_temp.errand_job(10,50,30,'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc');
 PERFORM pg_temp.pay(j,40,'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc'); PERFORM pg_temp.assign(j,pg_temp.drv(6));
 PERFORM pg_temp.spend(j,15);
 UPDATE public.jobs SET status='cancelled' WHERE id=j;
 BEGIN PERFORM public.release_job_wallet_reservation(j,'test cancel'); msg:='NO ERROR';
 EXCEPTION WHEN OTHERS THEN msg:=SQLERRM; END;
 INSERT INTO results VALUES (6,'release with recorded purchases requires reconciliation',
   msg LIKE '%purchase payments require reconciliation%',msg);
 INSERT INTO results VALUES (6,'the reservation is untouched and the purchase stays recorded',
   pg_temp.wbal('eeeeeeee-cccc-4ccc-8ccc-cccccccccccc')='130.00/80.00'
   AND (SELECT status FROM public.errand_purchase_payments WHERE job_id=j)='recorded',pg_temp.wbal('eeeeeeee-cccc-4ccc-8ccc-cccccccccccc'));
END $t$;

-- =========================================================================
-- 7. Fail-closed edges.
-- =========================================================================
DO $t$ DECLARE j uuid; BEGIN
 j:=pg_temp.errand_job(10,50,NULL,'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc');
 UPDATE public.jobs SET payment_method='card',payment_status='authorized',payment_intent_id='pi_nf',status='accepted',
   driver_id=pg_temp.drv(8) WHERE id=j;
 INSERT INTO results VALUES (7,'no funding row means nothing was funded: spend rejected',
   pg_temp.spend(j,5) LIKE '%exceeds the funded budget%','');
 j:=pg_temp.errand_job(10,50,NULL,'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc');
 INSERT INTO public.errand_funding(job_id,customer_id,item_budget,service_estimate,amount_reserved,status)
  VALUES (j,'eeeeeeee-cccc-4ccc-8ccc-cccccccccccc',0,10,0,'pending');
 INSERT INTO results VALUES (7,'an unfunded (zero-reserved) marker cannot be spent against',
   pg_temp.spend(j,5) LIKE '%exceeds the funded budget%','');
END $t$;

-- =========================================================================
-- 8. Market-specific settlement: an NG errand completes via the Flutterwave
--    provider branch, never Stripe Connect. The acct_ destination path and
--    the flutterwave path are mutually exclusive and provider-verified.
-- =========================================================================
DO $t$ DECLARE j uuid; ng_driver uuid:='dddddddd-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid;
  acct uuid:=gen_random_uuid(); msg text; BEGIN
 INSERT INTO auth.users(id) VALUES (ng_driver);
 INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_country_code,registration_activated_at)
  VALUES (ng_driver,'11111111-1111-4111-8111-111111111111','driver','NG','NG',now())
  ON CONFLICT (id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,role=EXCLUDED.role,
    country_code=EXCLUDED.country_code,registration_country_code=EXCLUDED.registration_country_code,
    registration_activated_at=EXCLUDED.registration_activated_at;
 INSERT INTO public.market_availability(country_code,launch_status,supported_currency) VALUES ('NG','live','NGN');
 INSERT INTO public.driver_payment_accounts(id,driver_id,tenant_id,country_code,currency_code,provider,merchant_account_ref,state,beneficiary_id,bank_code,last4,fingerprint)
  VALUES (acct,ng_driver,'11111111-1111-4111-8111-111111111111','NG','NGN','flutterwave','flw_merchant_ng','completed',
    '123456','044','1234',repeat('a',64));
 INSERT INTO public.driver_payout_markets(country_code,currency_code,provider,merchant_account_ref,enabled,merchant_approved,adapter_ready,capability_verified_at,capability_evidence_ref,merchant_mode,sandbox_driver_id,sandbox_tenant_id)
  VALUES ('NG','NGN','flutterwave','flw_merchant_ng',true,true,true,now(),'cap-evidence-1','test',ng_driver,'11111111-1111-4111-8111-111111111111');
 -- An NG errand (no purchase spend): completes on the verified flutterwave identity.
 INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,service_type_id,
   payment_status,country_code,currency_code,status,total_price,metadata,fare_breakdown,driver_id,accepted_driver_id)
 VALUES (gen_random_uuid(),'11111111-1111-4111-8111-111111111111','eeeeeeee-cccc-4ccc-8ccc-cccccccccccc','a','b',now(),'dddddddd-dddd-4ddd-8ddd-dddddddddd02',
   'paid','NG','NGN','in_progress',1000,
   jsonb_build_object('quote_id',gen_random_uuid(),'quote_expires_at',now()+interval '10 minutes','driver_settlement_method','transfer'),
   jsonb_build_object('calculationVersion','test-v1'),ng_driver,ng_driver) RETURNING id INTO j;
 INSERT INTO public.errand_details(job_id,items_list,estimated_budget) VALUES (j,'[]',0);
 PERFORM public.complete_job_with_pending_payout(j,ng_driver,
   jsonb_build_object('total',1000,'payout',800,'platformFee',150,'commission',50,'commissionRate',15,
     'currency','ngn','amountMinor',80000,'destination','flw:'||acct::text,'country','NG',
     'payout_provider','flutterwave','payout_account_id',acct::text,'payout_merchant','flw_merchant_ng',
     'payout_tenant','11111111-1111-4111-8111-111111111111'),
   jsonb_build_object('completion_pin_verified_at',now()));
 INSERT INTO results VALUES (8,'NG completion queued on the flutterwave provider, not Stripe Connect',
   (SELECT q.terms->>'payout_provider' FROM public.job_payout_queue q WHERE q.job_id=j)='flutterwave'
   AND (SELECT q.destination FROM public.job_payout_queue q WHERE q.job_id=j)='flw:'||acct::text,
   (SELECT q.destination||'/'||coalesce(q.terms->>'payout_provider','?') FROM public.job_payout_queue q WHERE q.job_id=j));
 -- A stripe-shaped destination with NG terms is refused (provider isolation).
 INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,service_type_id,
   payment_status,country_code,currency_code,status,total_price,metadata,fare_breakdown,driver_id,accepted_driver_id)
 VALUES (gen_random_uuid(),'11111111-1111-4111-8111-111111111111','eeeeeeee-cccc-4ccc-8ccc-cccccccccccc','a','b',now(),'dddddddd-dddd-4ddd-8ddd-dddddddddd02',
   'paid','NG','NGN','in_progress',1000,jsonb_build_object('quote_id',gen_random_uuid(),'driver_settlement_method','transfer'),'{}'::jsonb,ng_driver,ng_driver) RETURNING id INTO j;
 INSERT INTO public.errand_details(job_id,items_list,estimated_budget) VALUES (j,'[]',0);
 BEGIN PERFORM public.complete_job_with_pending_payout(j,ng_driver,
   jsonb_build_object('total',1000,'payout',800,'platformFee',150,'commission',50,'commissionRate',15,
     'currency','ngn','amountMinor',80000,'destination','acct_stripe_dest','country','NG'),
   jsonb_build_object()); msg:='NO ERROR';
 EXCEPTION WHEN OTHERS THEN msg:=SQLERRM; END;
 INSERT INTO results VALUES (8,'a Stripe Connect destination is refused for NG terms',
   msg LIKE '%Invalid payout identity%',msg);
END $t$;

-- =========================================================================
-- 9. Wallet settlement mode: an NG entitlement can settle to the shared
--    earnings ledger and withdraw to the verified bank destination — frozen
--    per entitlement, reserved during withdrawal, never double-paid.
-- =========================================================================
DO $t$ DECLARE j uuid; ng_driver uuid:='dddddddd-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid;
  acct uuid; q public.job_payout_queue%ROWTYPE; w public.driver_withdrawals%ROWTYPE;
  msg text; bal bigint; ev_count int; v_ok boolean; v_ok2 boolean; BEGIN
 -- The NG sandbox market row binds to section 8's driver (m.sandbox_driver_id);
 -- its refused-job fixture is still in_progress and idx_jobs_one_active_per_driver
 -- allows only one active job per driver, so close it first.
 UPDATE public.jobs SET status='cancelled' WHERE driver_id=ng_driver AND status='in_progress';
 SELECT a.id INTO acct FROM public.driver_payment_accounts a WHERE a.driver_id=ng_driver;
 -- An NG errand whose settlement method is 'wallet' completes onto the same
 -- verified flutterwave identity, but its frozen terms carry settlement_mode.
 INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,service_type_id,
   payment_status,country_code,currency_code,status,total_price,metadata,fare_breakdown,driver_id,accepted_driver_id)
 VALUES (gen_random_uuid(),'11111111-1111-4111-8111-111111111111','eeeeeeee-cccc-4ccc-8ccc-cccccccccccc','a','b',now(),'dddddddd-dddd-4ddd-8ddd-dddddddddd02',
   'paid','NG','NGN','in_progress',1000,
   jsonb_build_object('quote_id',gen_random_uuid(),'quote_expires_at',now()+interval '10 minutes','driver_settlement_method','wallet'),
   jsonb_build_object('calculationVersion','test-v1'),ng_driver,ng_driver) RETURNING id INTO j;
 INSERT INTO public.errand_details(job_id,items_list,estimated_budget) VALUES (j,'[]',0);
 PERFORM public.complete_job_with_pending_payout(j,ng_driver,
   jsonb_build_object('total',1000,'payout',800,'platformFee',150,'commission',50,'commissionRate',15,
     'currency','ngn','amountMinor',80000,'destination','flw:'||acct::text,'country','NG',
     'payout_provider','flutterwave','payout_account_id',acct::text,'payout_merchant','flw_merchant_ng',
     'payout_tenant','11111111-1111-4111-8111-111111111111','settlement_mode','wallet'),
   jsonb_build_object('completion_pin_verified_at',now()));
 INSERT INTO results VALUES (9,'wallet method frozen on the entitlement record',
   (SELECT s.method FROM public.job_settlement_methods s WHERE s.job_id=j)='wallet'
   AND (SELECT q2.terms->>'settlement_mode' FROM public.job_payout_queue q2 WHERE q2.job_id=j)='wallet',
   (SELECT s.method||'/'||coalesce(q2.terms->>'settlement_mode','?') FROM public.job_settlement_methods s,public.job_payout_queue q2 WHERE s.job_id=j AND q2.job_id=j));
 -- Claim then settle through the wallet finish: ledger credit, queue paid with
 -- the wallet reference, no provider submission row.
 SELECT * INTO q FROM public.claim_queued_job_payout(j);
 v_ok:=public.finish_wallet_job_payout(j,q.token);
 INSERT INTO results VALUES (9,'wallet finish credits earnings_payable once',
   v_ok
   AND public.driver_earnings_wallet_balance(ng_driver,'11111111-1111-4111-8111-111111111111','NGN')=80000
   AND (SELECT q2.transfer_id FROM public.job_payout_queue q2 WHERE q2.job_id=j)='wallet:'||j::text,
   'finish='||v_ok||' balance='||public.driver_earnings_wallet_balance(ng_driver,'11111111-1111-4111-8111-111111111111','NGN'));
 SELECT count(*) INTO ev_count FROM public.wallet_business_events WHERE event_key='driver-earnings:'||j::text;
 v_ok:=public.finish_wallet_job_payout(j,q.token);
 INSERT INTO results VALUES (9,'wallet finish replay does not credit twice',
   v_ok AND ev_count=1
   AND public.driver_earnings_wallet_balance(ng_driver,'11111111-1111-4111-8111-111111111111','NGN')=80000
   AND (SELECT d.payout_provider FROM public.driver_earnings d WHERE d.job_id=j)='wallet',
   'events='||ev_count);
 -- Mutual exclusion: provider paths cannot touch a wallet-mode entitlement.
 INSERT INTO results VALUES (9,'provider finishes refuse a wallet-mode entitlement',
   NOT public.claim_flutterwave_job_submission(j,q.token,'vaydu-'||j::text||'_PMCK')
   AND NOT public.finish_flutterwave_job_payout(j,q.token,'vaydu-'||j::text||'_PMCK','1',0)
   AND NOT public.finish_queued_job_payout(j,q.token,'tr_fake'),
   'excluded');
 -- Withdrawal reserves held funds before any provider contact.
 SELECT * INTO w FROM public.request_driver_withdrawal(ng_driver,30000);
 INSERT INTO results VALUES (9,'withdrawal reserves the spendable balance',
   w.status='processing' AND w.payout_account_id=acct
   AND public.driver_earnings_wallet_balance(ng_driver,'11111111-1111-4111-8111-111111111111','NGN')=50000,
   'spendable='||public.driver_earnings_wallet_balance(ng_driver,'11111111-1111-4111-8111-111111111111','NGN'));
 -- Over-balance withdrawal is refused before any reservation.
 BEGIN PERFORM public.request_driver_withdrawal(ng_driver,999999); msg:='NO ERROR';
 EXCEPTION WHEN OTHERS THEN msg:=SQLERRM; END;
 INSERT INTO results VALUES (9,'over-balance withdrawal is refused',
   msg LIKE '%exceeds the withdrawable%' AND public.driver_earnings_wallet_balance(ng_driver,'11111111-1111-4111-8111-111111111111','NGN')=50000,msg);
 -- Settle path: submission marker, then verified transfer moves held→paid_out.
 SELECT * INTO w FROM public.claim_driver_withdrawal(w.id);
 v_ok:=public.claim_withdrawal_submission(w.id,w.lease_token,w.reference);
 v_ok2:=public.finish_driver_withdrawal(w.id,w.lease_token,'777000111',500);
 INSERT INTO results VALUES (9,'withdrawal settles held funds on verified transfer',
   v_ok AND v_ok2
   AND (SELECT w2.status FROM public.driver_withdrawals w2 WHERE w2.id=w.id)='paid'
   AND public.driver_earnings_wallet_balance(ng_driver,'11111111-1111-4111-8111-111111111111','NGN')=50000,
   'claim='||v_ok||' finish='||v_ok2||' status='||(SELECT w2.status FROM public.driver_withdrawals w2 WHERE w2.id=w.id));
 -- A definitive provider failure reverses the reserve back to spendable.
 SELECT * INTO w FROM public.request_driver_withdrawal(ng_driver,10000);
 SELECT * INTO w FROM public.claim_driver_withdrawal(w.id);
 PERFORM public.claim_withdrawal_submission(w.id,w.lease_token,w.reference);
 v_ok:=public.reverse_driver_withdrawal(w.id,w.lease_token,'provider_transfer_failed');
 INSERT INTO results VALUES (9,'failed transfer reverses the reservation',
   v_ok
   AND public.driver_earnings_wallet_balance(ng_driver,'11111111-1111-4111-8111-111111111111','NGN')=50000
   AND (SELECT w2.status FROM public.driver_withdrawals w2 WHERE w2.id=w.id)='failed',
   'reverse='||v_ok||' spendable='||public.driver_earnings_wallet_balance(ng_driver,'11111111-1111-4111-8111-111111111111','NGN'));
 -- A transfer-method entitlement cannot carry wallet terms (mode confusion).
 INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,service_type_id,
   payment_status,country_code,currency_code,status,total_price,metadata,fare_breakdown,driver_id,accepted_driver_id)
 VALUES (gen_random_uuid(),'11111111-1111-4111-8111-111111111111','eeeeeeee-cccc-4ccc-8ccc-cccccccccccc','a','b',now(),'dddddddd-dddd-4ddd-8ddd-dddddddddd02',
   'paid','NG','NGN','in_progress',1000,jsonb_build_object('quote_id',gen_random_uuid(),'driver_settlement_method','transfer'),'{}'::jsonb,ng_driver,ng_driver) RETURNING id INTO j;
 INSERT INTO public.errand_details(job_id,items_list,estimated_budget) VALUES (j,'[]',0);
 BEGIN PERFORM public.complete_job_with_pending_payout(j,ng_driver,
   jsonb_build_object('total',1000,'payout',800,'platformFee',150,'commission',50,'commissionRate',15,
     'currency','ngn','amountMinor',80000,'destination','flw:'||acct::text,'country','NG',
     'payout_provider','flutterwave','payout_account_id',acct::text,'payout_merchant','flw_merchant_ng',
     'payout_tenant','11111111-1111-4111-8111-111111111111','settlement_mode','wallet'),
   jsonb_build_object('completion_pin_verified_at',now())); msg:='NO ERROR';
 EXCEPTION WHEN OTHERS THEN msg:=SQLERRM; END;
 INSERT INTO results VALUES (9,'transfer method refuses wallet terms',
   msg LIKE '%Transfer settlement cannot carry wallet terms%',msg);
END $t$;

SELECT n, name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, left(detail,90) AS detail FROM results ORDER BY n, name;
SELECT count(*) FILTER (WHERE NOT ok) AS failures, count(*) AS checks FROM results;
ROLLBACK;
