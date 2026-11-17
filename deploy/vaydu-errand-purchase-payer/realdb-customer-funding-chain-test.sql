-- Real-Postgres test for the verified customer wallet funding chain, covering
-- 20261270600000_customer_wallet_booking_bridge.sql on a schema that includes
-- the batch-2 collection objects (develop_live baseline).
--
--   initiate (customer_credit, one eligible route, limit, market pair)
--   -> fee freeze -> submission claim -> provider reference binding
--   -> provider-verified confirm posts the wallet event
--   -> bridge trigger credits the booking wallet atomically (topup txn once)
--   -> confirm replay is idempotent (no double funding)
--   -> collected balance -> pay_job_from_wallet reservation -> driver spend
--   -> completion -> queued fare+reimbursement -> reimbursed once
--   -> unused budget released
--   * driver_cash_credit attempts must NOT bridge (no booking-wallet credit)
--
-- Everything runs in one transaction and ROLLS BACK.
\set ON_ERROR_STOP on
BEGIN;
-- Fixture-only trigger bypass (disposable DB, never production): same keep-list as
-- realdb-errand-purchase-payer-test.sql — payment-integrity and the data-only
-- completion/price/reward triggers stay ENABLED; auth-context triggers are disabled.
DO $d$ DECLARE t text; BEGIN
 FOR t IN SELECT tgname FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid WHERE c.relname='jobs' AND NOT tgisinternal
   AND tgname NOT IN ('trg_enforce_job_payment_eligibility','enforce_ride_cash_credit_v1e',
     'tr_check_errand_completion_guard','reward_credit_reserve','trg_sync_job_prices','tr_update_jobs_updated_at')
 LOOP EXECUTE format('ALTER TABLE public.jobs DISABLE TRIGGER %I', t); END LOOP; END $d$;

INSERT INTO public.tenants(id,name,slug) VALUES ('11111111-1111-4111-8111-111111111111','t','t');
INSERT INTO public.market_availability(country_code,launch_status,supported_currency) VALUES ('GB','live','GBP');
INSERT INTO public.service_types(id,slug,name) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddd02','errand','Errand');
INSERT INTO auth.users(id) VALUES ('dddddddd-aaaa-4aaa-8aaa-000000000009'),
 ('ffffffff-dddd-4ddd-8ddd-dddddddddddd'),('aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee');
INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_country_code) VALUES
 ('dddddddd-aaaa-4aaa-8aaa-000000000009','11111111-1111-4111-8111-111111111111','driver','GB','GB'),
 ('ffffffff-dddd-4ddd-8ddd-dddddddddddd','11111111-1111-4111-8111-111111111111','customer','GB','GB'),
 ('aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee','11111111-1111-4111-8111-111111111111','driver','GB','GB')
 ON CONFLICT (id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,role=EXCLUDED.role,
   country_code=EXCLUDED.country_code,registration_country_code=EXCLUDED.registration_country_code;

-- Collection plumbing: exactly one eligible GB/GBP card collect route on the
-- platform Stripe merchant, an approved zero-fee schedule, kill switches on.
INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref,preferred,enabled,merchant_approved,adapter_ready,capabilities)
 VALUES ('GB','GBP','card','stripe','acct_vaydu_platform_gb',true,true,true,true,ARRAY['collect']);
INSERT INTO public.wallet_topup_fee_schedules(version,provider,country_code,currency_code,method,exponent,fee_basis,fee_basis_points,fee_fixed_minor,rounding,approved_by,approved_at,active)
 VALUES ('vaydu-customer-card-0fee-test-v1','stripe','GB','GBP','card',2,'wallet',0,0,'half_up','rehearsal',now(),true);
-- The batch-2b freeze reads wallet_topup_fee_policies (post-202612541 schema); the older
-- schedules table is kept above so this fixture works against either function version.
INSERT INTO public.wallet_topup_fee_policies(version,provider,country_code,currency_code,method,fee_basis_points,fee_fixed_minor,exponent,active)
 VALUES ('vaydu-customer-card-0fee-test-v1','stripe','GB','GBP','card',0,1,2,true);
INSERT INTO public.wallet_collection_config(key,value) VALUES ('enabled','true'),('max_amount_minor_GBP','1000000');

CREATE TEMP TABLE results(n int, name text, ok boolean, detail text);

CREATE FUNCTION pg_temp.errand_job(fare numeric, estimate numeric, funded numeric, customer uuid)
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
CREATE FUNCTION pg_temp.wbal(customer uuid) RETURNS text LANGUAGE sql AS $f$
 SELECT available_balance||'/'||reserved_balance FROM public.wallets WHERE user_id=customer $f$;
CREATE FUNCTION pg_temp.spend(j uuid, amount numeric) RETURNS text LANGUAGE plpgsql AS $f$ BEGIN
 UPDATE public.errand_details SET actual_spending=amount WHERE job_id=j; RETURN 'ok';
 EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $f$;
CREATE FUNCTION pg_temp.job_terms() RETURNS jsonb LANGUAGE sql AS $f$ SELECT jsonb_build_object(
 'total',10,'payout',8.5,'platformFee',1,'commission',0.5,'commissionRate',15,
 'currency','gbp','amountMinor',850,'destination','acct_drv_test','country','GB') $f$;

-- =========================================================================
-- 1. Verified customer collection bridges to the booking wallet atomically.
-- =========================================================================
DO $t$ DECLARE a uuid; ev uuid; ev2 uuid; ok boolean; BEGIN
 -- A customer_credit collection for a customer with NO wallet row yet.
 a:=public.initiate_wallet_topup('customer-topup:ffffffff-dddd-4ddd-8ddd-dddddddddddd:idem-1',
   '11111111-1111-4111-8111-111111111111','ffffffff-dddd-4ddd-8ddd-dddddddddddd',
   'GB','GBP',30000,'customer_credit','stripe','acct_vaydu_platform_gb','idem-1');
 PERFORM public.freeze_wallet_topup_fee(a,'vaydu-customer-card-0fee-test-v1');
 ok:=public.claim_wallet_topup_submission(a);
 INSERT INTO results VALUES (1,'a frozen customer collection can be submitted',ok,'');
 ok:=public.record_wallet_topup_provider_reference(a,'pi_cust_1');
 INSERT INTO results VALUES (1,'the provider reference binds to the frozen attempt',ok,'');

 -- Provider-verified confirm posts the event AND bridges the booking wallet.
 ev:=public.confirm_wallet_topup_with_total(a,'pi_cust_1','acct_vaydu_platform_gb','GBP',(SELECT total_charge_minor FROM public.wallet_topup_attempts WHERE id=a),'succeeded');
 INSERT INTO results VALUES (1,'verified collection credits the customer booking wallet (300.00)',
   pg_temp.wbal('ffffffff-dddd-4ddd-8ddd-dddddddddddd')='300.00/0.00'
   AND (SELECT status FROM public.wallet_topup_attempts WHERE id=a)='credited'
   AND (SELECT credited_event_id FROM public.wallet_topup_attempts WHERE id=a)=ev,
   pg_temp.wbal('ffffffff-dddd-4ddd-8ddd-dddddddddddd'));
 INSERT INTO results VALUES (1,'the booking ledger records the verified top-up once',
   (SELECT count(*) FROM public.wallet_transactions WHERE user_id='ffffffff-dddd-4ddd-8ddd-dddddddddddd'
     AND transaction_type='topup' AND event_key='wallet-topup-booking:'||a::text
     AND balance_purpose='customer_credit' AND payment_provider='stripe'
     AND merchant_account_ref='acct_vaydu_platform_gb' AND provider_reference='pi_cust_1'
     AND stripe_payment_intent_id='pi_cust_1' AND amount=300)=1,'');
 INSERT INTO results VALUES (1,'the wallet business event is posted for the credit',
   EXISTS(SELECT 1 FROM public.wallet_business_events WHERE id=ev AND operation='topup'
     AND event_key='wallet-topup:'||a::text AND payment_provider='stripe'),'');

 -- Replay is idempotent: same event, no second wallet credit.
 ev2:=public.confirm_wallet_topup_with_total(a,'pi_cust_1','acct_vaydu_platform_gb','GBP',(SELECT total_charge_minor FROM public.wallet_topup_attempts WHERE id=a),'succeeded');
 INSERT INTO results VALUES (1,'replayed confirm returns the same credit and does not double-fund',
   ev2=ev AND pg_temp.wbal('ffffffff-dddd-4ddd-8ddd-dddddddddddd')='300.00/0.00','');
END $t$;

-- =========================================================================
-- 2. The collected balance funds the whole errand journey:
--    reservation -> purchase -> completion -> reimbursement -> release.
-- =========================================================================
DO $t$ DECLARE j uuid; q public.job_payout_queue; tok uuid; ok boolean; spend text; BEGIN
 j:=pg_temp.errand_job(10,30,30,'ffffffff-dddd-4ddd-8ddd-dddddddddddd');
 PERFORM public.pay_job_from_wallet(j,'ffffffff-dddd-4ddd-8ddd-dddddddddddd',40,'GBP','11111111-1111-4111-8111-111111111111');
 INSERT INTO results VALUES (2,'the collected balance reserves fare + budget (40.00)',
   pg_temp.wbal('ffffffff-dddd-4ddd-8ddd-dddddddddddd')='260.00/40.00',
   pg_temp.wbal('ffffffff-dddd-4ddd-8ddd-dddddddddddd'));
 UPDATE public.jobs SET driver_id='dddddddd-aaaa-4aaa-8aaa-000000000009',
   accepted_driver_id='dddddddd-aaaa-4aaa-8aaa-000000000009',status='accepted' WHERE id=j;
 spend:=pg_temp.spend(j,20);
 INSERT INTO results VALUES (2,'driver spend inside the funded budget records payer evidence',
   spend='ok'
   AND (SELECT payer FROM public.errand_purchase_payments WHERE job_id=j)='driver',
   spend||' '||coalesce((SELECT payer||'/'||purchase_method FROM public.errand_purchase_payments WHERE job_id=j),'NO ROW'));
 UPDATE public.jobs SET status='in_progress' WHERE id=j;
 PERFORM public.complete_job_with_pending_payout(j,'dddddddd-aaaa-4aaa-8aaa-000000000009',pg_temp.job_terms(),
   jsonb_build_object('completion_pin_verified_at',now()));
 SELECT * INTO q FROM public.job_payout_queue WHERE job_id=j;
 INSERT INTO results VALUES (2,'completion queues fare + reimbursement; unused budget released',
   q.amount_minor=2850
   AND pg_temp.wbal('ffffffff-dddd-4ddd-8ddd-dddddddddddd')='270.00/0.00'
   AND (SELECT status FROM public.errand_funding WHERE job_id=j)='settled'
   AND (SELECT refund_amount FROM public.errand_funding WHERE job_id=j)=10,
   pg_temp.wbal('ffffffff-dddd-4ddd-8ddd-dddddddddddd'));
 SELECT * INTO q FROM public.claim_queued_job_payout(j) LIMIT 1; tok:=q.token;
 ok:=public.finish_queued_job_payout(j,tok,'tr_cust_1');
 INSERT INTO results VALUES (2,'the queued transfer reimburses the driver once (customer-funded path)',
   ok AND (SELECT status FROM public.errand_purchase_payments WHERE job_id=j)='reimbursed'
   AND (SELECT reimbursement_transfer_id FROM public.errand_purchase_payments WHERE job_id=j)='tr_cust_1','');
END $t$;

-- =========================================================================
-- 3. driver_cash_credit never bridges: the driver-side ledger credit must not
--    appear in the booking wallet (customer funds stay segregated). The driver
--    card sandbox itself is database-gated to movabi_develop, so a driver
--    collection cannot be produced here — the credited transition is applied
--    directly to prove the bridge purpose guard refuses it.
-- =========================================================================
DO $t$ DECLARE a uuid; ev uuid; BEGIN
 a:=public.initiate_wallet_topup('driver-cash-topup-test:aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee:idem-1',
   '11111111-1111-4111-8111-111111111111','aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee',
   'GB','GBP',5000,'driver_cash_credit','stripe','acct_vaydu_platform_gb','idem-2');
 PERFORM public.record_wallet_topup_provider_reference(a,'pi_drv_1');
 ev:=public.post_wallet_event('driver-cash-test:'||a::text,'topup','11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee','GBP',
   jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit','amountMinor',5000),
     jsonb_build_object('accountPurpose','platform_funding','amountMinor',-5000)),
   'stripe','acct_vaydu_platform_gb','pi_drv_1');
 UPDATE public.wallet_topup_attempts SET status='credited',credited_event_id=ev WHERE id=a;
 -- handle_new_user auto-provisions a zero wallet row for every auth user; leakage means a
 -- nonzero booking balance or a customer_credit ledger row, not the row's existence.
 INSERT INTO results VALUES (3,'driver cash credit does not leak into the booking wallet',
   coalesce((SELECT available_balance+reserved_balance FROM public.wallets WHERE user_id='aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee'),0)=0
   AND NOT EXISTS(SELECT 1 FROM public.wallet_transactions WHERE user_id='aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee'
     AND balance_purpose='customer_credit'),'');
END $t$;

SELECT n, name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, left(detail,90) AS detail FROM results ORDER BY n, name;
SELECT count(*) FILTER (WHERE NOT ok) AS failures, count(*) AS checks FROM results;
ROLLBACK;
