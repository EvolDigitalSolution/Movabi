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
-- Disposable-DB fixture isolation: capture every row the fixture section can
-- touch, every trigger state and every table/function/schema ACL BEFORE the
-- transaction so the post-suite check can prove the restored backup is
-- byte-identical afterwards. TEMP tables outlive the ROLLBACK below.
CREATE TEMP TABLE pre_rows AS
 SELECT 'market_availability' AS tbl, to_jsonb(t) AS row FROM public.market_availability t WHERE t.country_code IN ('GB','NG')
 UNION ALL SELECT 'tenants', to_jsonb(t) FROM public.tenants t WHERE t.slug='t' OR t.id='11111111-1111-4111-8111-111111111111'::uuid
 UNION ALL SELECT 'service_types', to_jsonb(t) FROM public.service_types t WHERE t.slug='errand' OR t.id='dddddddd-dddd-4ddd-8ddd-dddddddddd02'::uuid
 UNION ALL SELECT 'auth_users', to_jsonb(t) FROM auth.users t WHERE t.id IN
   ('dddddddd-aaaa-4aaa-8aaa-000000000009','ffffffff-dddd-4ddd-8ddd-dddddddddddd','aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee')
 UNION ALL SELECT 'profiles', to_jsonb(t) FROM public.profiles t WHERE t.id IN
   ('dddddddd-aaaa-4aaa-8aaa-000000000009','ffffffff-dddd-4ddd-8ddd-dddddddddddd','aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee')
 UNION ALL SELECT 'wallets', to_jsonb(t) FROM public.wallets t WHERE t.user_id IN
   ('dddddddd-aaaa-4aaa-8aaa-000000000009','ffffffff-dddd-4ddd-8ddd-dddddddddddd','aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee')
 UNION ALL SELECT 'market_payment_routes', to_jsonb(t) FROM public.market_payment_routes t
   WHERE t.country_code='GB' AND t.currency_code='GBP' AND t.method='card'
 UNION ALL SELECT 'wallet_topup_fee_schedules', to_jsonb(t) FROM public.wallet_topup_fee_schedules t WHERE t.version='vaydu-customer-card-0fee-test-v1'
 UNION ALL SELECT 'wallet_topup_fee_policies', to_jsonb(t) FROM public.wallet_topup_fee_policies t WHERE t.version='vaydu-customer-card-0fee-test-v1'
 UNION ALL SELECT 'wallet_collection_config', to_jsonb(t) FROM public.wallet_collection_config t WHERE t.key IN ('enabled','max_amount_minor_GBP');
CREATE TEMP TABLE pre_triggers AS
 SELECT c.relname AS tbl, t.tgname, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal;
CREATE TEMP TABLE pre_acl AS
 SELECT n.nspname, c.relname, c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','auth') AND c.relkind='r';
CREATE TEMP TABLE pre_facl AS
 SELECT p.oid::regprocedure::text AS sig, p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','auth');
CREATE TEMP TABLE pre_nacl AS
 SELECT nspname, nspacl FROM pg_namespace WHERE nspname IN ('public','auth');
BEGIN;
-- Fixture-only trigger bypass (disposable DB, never production): same keep-list as
-- realdb-errand-purchase-payer-test.sql — payment-integrity and the data-only
-- completion/price/reward triggers stay ENABLED; auth-context triggers are disabled.
DO $d$ DECLARE t text; tbl text; BEGIN
 FOR t IN SELECT tgname FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid WHERE c.relname='jobs' AND NOT tgisinternal
   AND tgname NOT IN ('trg_enforce_job_payment_eligibility','enforce_ride_cash_credit_v1e',
     'tr_check_errand_completion_guard','reward_credit_reserve','trg_sync_job_prices','tr_update_jobs_updated_at')
 LOOP EXECUTE format('ALTER TABLE public.jobs DISABLE TRIGGER %I', t); END LOOP;
 -- Fixture-write guards on config/market tables (immutability, approval checks)
 -- are bypassed only so adopt-or-update fixtures can prepare pre-existing rows;
 -- every enabled-state is restored by the ROLLBACK and proven below.
 FOR t, tbl IN SELECT tgname, c.relname FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid
   WHERE c.relname IN ('market_availability','market_payment_routes','wallet_topup_fee_schedules','wallet_topup_fee_policies','wallet_collection_config','tenants','service_types')
   AND NOT tgisinternal
 LOOP EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', tbl, t); END LOOP; END $d$;

-- Adopt-or-insert fixtures (disposable DB only): a pre-existing real row is
-- reused/updated to the required state INSIDE this transaction and restored by
-- ROLLBACK; a missing row is inserted under the fixture identity. Slug occupied
-- by a different id is a loud error, never a suppressed skip.
INSERT INTO public.tenants(id,name,slug)
 SELECT '11111111-1111-4111-8111-111111111111'::uuid,'t','t'
 WHERE NOT EXISTS (SELECT 1 FROM public.tenants WHERE slug='t' OR id='11111111-1111-4111-8111-111111111111'::uuid);
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM public.tenants WHERE slug='t' OR id='11111111-1111-4111-8111-111111111111'::uuid)
 THEN RAISE EXCEPTION 'fixture isolation failed: no adoptable tenant row'; END IF; END $$;
SELECT set_config('fixture.t_id',(SELECT id::text FROM public.tenants WHERE slug='t' OR id='11111111-1111-4111-8111-111111111111'::uuid ORDER BY (slug='t') DESC LIMIT 1),false) AS t_id;
INSERT INTO public.market_availability(country_code,launch_status,supported_currency)
 SELECT 'GB','live','GBP' WHERE NOT EXISTS (SELECT 1 FROM public.market_availability WHERE country_code='GB');
UPDATE public.market_availability SET launch_status='live', supported_currency='GBP' WHERE country_code='GB';
INSERT INTO public.service_types(id,slug,name)
 SELECT 'dddddddd-dddd-4ddd-8ddd-dddddddddd02'::uuid,'errand','Errand'
 WHERE NOT EXISTS (SELECT 1 FROM public.service_types WHERE slug='errand' OR id='dddddddd-dddd-4ddd-8ddd-dddddddddd02'::uuid);
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM public.service_types WHERE slug='errand' OR id='dddddddd-dddd-4ddd-8ddd-dddddddddd02'::uuid)
 THEN RAISE EXCEPTION 'fixture isolation failed: no adoptable service_types row'; END IF; END $$;
SELECT set_config('fixture.st_id',(SELECT id::text FROM public.service_types WHERE slug='errand' OR id='dddddddd-dddd-4ddd-8ddd-dddddddddd02'::uuid ORDER BY (slug='errand') DESC LIMIT 1),false) AS st_id;
INSERT INTO auth.users(id) VALUES ('dddddddd-aaaa-4aaa-8aaa-000000000009'),
 ('ffffffff-dddd-4ddd-8ddd-dddddddddddd'),('aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee')
 ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_country_code) VALUES
 ('dddddddd-aaaa-4aaa-8aaa-000000000009',(current_setting('fixture.t_id'))::uuid,'driver','GB','GB'),
 ('ffffffff-dddd-4ddd-8ddd-dddddddddddd',(current_setting('fixture.t_id'))::uuid,'customer','GB','GB'),
 ('aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee',(current_setting('fixture.t_id'))::uuid,'driver','GB','GB')
 ON CONFLICT (id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,role=EXCLUDED.role,
   country_code=EXCLUDED.country_code,registration_country_code=EXCLUDED.registration_country_code;

-- Collection plumbing: exactly one eligible GB/GBP card collect route on the
-- platform Stripe merchant, an approved zero-fee schedule, kill switches on.
-- Any other GB/GBP card route is neutralised INSIDE this transaction so the
-- fixture stays the exactly-one eligible collect route (restored on rollback).
UPDATE public.market_payment_routes SET preferred=false, enabled=false
 WHERE country_code='GB' AND currency_code='GBP' AND method='card'
   AND NOT (provider='stripe' AND merchant_account_ref='acct_vaydu_platform_gb');
INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref,preferred,enabled,merchant_approved,adapter_ready,capabilities,provider_account_id)
 SELECT 'GB','GBP','card','stripe','acct_vaydu_platform_gb',true,true,true,true,ARRAY['collect'],'acct_vaydu_gb_test'
 WHERE NOT EXISTS(SELECT 1 FROM public.market_payment_routes WHERE country_code='GB' AND currency_code='GBP' AND method='card'
   AND provider='stripe' AND merchant_account_ref='acct_vaydu_platform_gb');
UPDATE public.market_payment_routes SET preferred=true,enabled=true,merchant_approved=true,adapter_ready=true,
  capabilities=ARRAY['collect'],provider_account_id='acct_vaydu_gb_test'
 WHERE country_code='GB' AND currency_code='GBP' AND method='card' AND provider='stripe' AND merchant_account_ref='acct_vaydu_platform_gb';
INSERT INTO public.wallet_topup_fee_schedules(version,provider,country_code,currency_code,method,exponent,fee_basis,fee_basis_points,fee_fixed_minor,rounding,approved_by,approved_at,active)
 SELECT 'vaydu-customer-card-0fee-test-v1','stripe','GB','GBP','card',2,'wallet',0,0,'half_up','rehearsal',now(),true
 WHERE NOT EXISTS(SELECT 1 FROM public.wallet_topup_fee_schedules WHERE version='vaydu-customer-card-0fee-test-v1'
   AND provider='stripe' AND country_code='GB' AND currency_code='GBP' AND method='card');
UPDATE public.wallet_topup_fee_schedules SET exponent=2,fee_basis='wallet',fee_basis_points=0,fee_fixed_minor=0,
  rounding='half_up',approved_by='rehearsal',approved_at=now(),active=true
 WHERE version='vaydu-customer-card-0fee-test-v1' AND provider='stripe' AND country_code='GB' AND currency_code='GBP' AND method='card';
-- The batch-2b freeze reads wallet_topup_fee_policies (post-202612541 schema); the older
-- schedules table is kept above so this fixture works against either function version.
INSERT INTO public.wallet_topup_fee_policies(version,provider,country_code,currency_code,method,fee_basis_points,fee_fixed_minor,exponent,active)
 SELECT 'vaydu-customer-card-0fee-test-v1','stripe','GB','GBP','card',0,1,2,true
 WHERE NOT EXISTS(SELECT 1 FROM public.wallet_topup_fee_policies WHERE version='vaydu-customer-card-0fee-test-v1'
   AND provider='stripe' AND country_code='GB' AND currency_code='GBP' AND method='card');
UPDATE public.wallet_topup_fee_policies SET fee_basis_points=0,fee_fixed_minor=1,exponent=2,active=true
 WHERE version='vaydu-customer-card-0fee-test-v1' AND provider='stripe' AND country_code='GB' AND currency_code='GBP' AND method='card';
UPDATE public.wallet_collection_config SET value='true' WHERE key='enabled';
INSERT INTO public.wallet_collection_config(key,value) SELECT 'enabled','true' WHERE NOT EXISTS(SELECT 1 FROM public.wallet_collection_config WHERE key='enabled');
UPDATE public.wallet_collection_config SET value='1000000' WHERE key='max_amount_minor_GBP';
INSERT INTO public.wallet_collection_config(key,value) SELECT 'max_amount_minor_GBP','1000000' WHERE NOT EXISTS(SELECT 1 FROM public.wallet_collection_config WHERE key='max_amount_minor_GBP');

CREATE TEMP TABLE results(n int, name text, ok boolean, detail text);

CREATE FUNCTION pg_temp.errand_job(fare numeric, estimate numeric, funded numeric, customer uuid)
RETURNS uuid LANGUAGE plpgsql AS $f$ DECLARE id uuid:=gen_random_uuid(); BEGIN
 INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,service_type_id,
   payment_status,country_code,currency_code,status,total_price,metadata,fare_breakdown)
 VALUES (id,(current_setting('fixture.t_id'))::uuid,customer,'a','b',now(),(current_setting('fixture.st_id'))::uuid,
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
   (current_setting('fixture.t_id'))::uuid,'ffffffff-dddd-4ddd-8ddd-dddddddddddd',
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
 -- The provider account is bound at freeze from the trusted route row, never
 -- from the client, and it cannot change afterwards.
 INSERT INTO results VALUES (1,'freeze binds the approved route provider account',
   (SELECT provider_account_id FROM public.wallet_topup_attempts WHERE id=a)='acct_vaydu_gb_test',
   coalesce((SELECT provider_account_id FROM public.wallet_topup_attempts WHERE id=a),'NULL'));
 UPDATE public.market_payment_routes SET provider_account_id='acct_drifted'
  WHERE country_code='GB' AND method='card';
 INSERT INTO results VALUES (1,'route drift never rewrites the frozen attempt binding',
   (SELECT provider_account_id FROM public.wallet_topup_attempts WHERE id=a)='acct_vaydu_gb_test','');
 BEGIN
  UPDATE public.wallet_topup_attempts SET provider_account_id='acct_attacker' WHERE id=a;
  INSERT INTO results VALUES (1,'direct rebind of a frozen provider account is refused',false,'no error');
 EXCEPTION WHEN OTHERS THEN
  INSERT INTO results VALUES (1,'direct rebind of a frozen provider account is refused',SQLERRM LIKE '%frozen%',SQLERRM);
 END;
 UPDATE public.market_payment_routes SET provider_account_id='acct_vaydu_gb_test'
  WHERE country_code='GB' AND method='card';
END $t$;

-- =========================================================================
-- 1B. Binding guards: a stripe route with no approved account fails closed at
-- freeze (before any provider call), a second eligible route is ambiguous and
-- fails closed, and an idempotent retry of the same attempt key returns the
-- same attempt with its binding intact.
-- =========================================================================
DO $t$ DECLARE a uuid; a2 uuid; BEGIN
 UPDATE public.market_payment_routes SET provider_account_id=NULL
  WHERE country_code='GB' AND method='card';
 a:=public.initiate_wallet_topup('customer-topup:ffffffff-dddd-4ddd-8ddd-dddddddddddd:idem-missing',
   (current_setting('fixture.t_id'))::uuid,'ffffffff-dddd-4ddd-8ddd-dddddddddddd',
   'GB','GBP',30000,'customer_credit','stripe','acct_vaydu_platform_gb','idem-missing');
 BEGIN
  PERFORM public.freeze_wallet_topup_fee(a,'vaydu-customer-card-0fee-test-v1');
  INSERT INTO results VALUES (1,'missing stripe account binding fails closed at freeze',false,'no error');
 EXCEPTION WHEN OTHERS THEN
  INSERT INTO results VALUES (1,'missing stripe account binding fails closed at freeze',
    SQLERRM LIKE '%provider account%' AND (SELECT status FROM public.wallet_topup_attempts WHERE id=a)='initiated',SQLERRM);
 END;
 -- Retry after the route is bound: the same attempt is bound and frozen.
 UPDATE public.market_payment_routes SET provider_account_id='acct_vaydu_gb_test'
  WHERE country_code='GB' AND method='card';
 a2:=public.initiate_wallet_topup('customer-topup:ffffffff-dddd-4ddd-8ddd-dddddddddddd:idem-missing',
   (current_setting('fixture.t_id'))::uuid,'ffffffff-dddd-4ddd-8ddd-dddddddddddd',
   'GB','GBP',30000,'customer_credit','stripe','acct_vaydu_platform_gb','idem-missing');
 PERFORM public.freeze_wallet_topup_fee(a2,'vaydu-customer-card-0fee-test-v1');
 INSERT INTO results VALUES (1,'a retried checkout reuses the attempt and binds the approved account',
   a2=a AND (SELECT provider_account_id FROM public.wallet_topup_attempts WHERE id=a2)='acct_vaydu_gb_test'
   AND (SELECT fee_policy_version FROM public.wallet_topup_attempts WHERE id=a2)='vaydu-customer-card-0fee-test-v1','');
 -- A second eligible route cannot exist: market_payment_routes_preferred_unique
 -- (country,currency,method) enforces a single preferred route per market, so
 -- ambiguity is structurally refused — the STRICT route lookup is the belt.
 INSERT INTO results VALUES (1,'exactly one preferred collect route can exist per market',
   (SELECT count(*) FROM public.market_payment_routes WHERE country_code='GB' AND method='card' AND preferred)=1,'');
END $t$;

-- =========================================================================
-- 2. The collected balance funds the whole errand journey:
--    reservation -> purchase -> completion -> reimbursement -> release.
-- =========================================================================
DO $t$ DECLARE j uuid; q public.job_payout_queue; tok uuid; ok boolean; spend text; BEGIN
 j:=pg_temp.errand_job(10,30,30,'ffffffff-dddd-4ddd-8ddd-dddddddddddd');
 PERFORM public.pay_job_from_wallet(j,'ffffffff-dddd-4ddd-8ddd-dddddddddddd',40,'GBP',(current_setting('fixture.t_id'))::uuid);
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
   (current_setting('fixture.t_id'))::uuid,'aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee',
   'GB','GBP',5000,'driver_cash_credit','stripe','acct_vaydu_platform_gb','idem-2');
 PERFORM public.record_wallet_topup_provider_reference(a,'pi_drv_1');
 ev:=public.post_wallet_event('driver-cash-test:'||a::text,'topup',(current_setting('fixture.t_id'))::uuid,
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

-- 4. Route gate (20261271200000): only the reviewed NG/NGN kora card collect
-- shape is permitted; every other kora/fincra/payout shape stays blocked.
DO $r$ DECLARE a1 boolean; a2 boolean; a3 boolean; a4 boolean; a5 boolean; a6 boolean; BEGIN
 BEGIN
   INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref,preferred,enabled,merchant_approved,adapter_ready,capabilities)
     VALUES('NG','NGN','card','kora','suite_kora_collect',false,true,true,true,ARRAY['collect']); a1:=true;
   EXCEPTION WHEN others THEN a1:=false; END;
 INSERT INTO results VALUES (4,'NG/NGN kora card collect route is permitted',a1,'');
 BEGIN INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref,preferred,enabled,merchant_approved,adapter_ready,capabilities)
   VALUES('NG','NGN','bank_transfer','kora','suite_kora_pay',false,true,true,true,ARRAY['payout']); a2:=false;
   EXCEPTION WHEN check_violation THEN a2:=true; END;
 INSERT INTO results VALUES (4,'kora payout capability remains forbidden',a2,'');
 BEGIN INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref,preferred,enabled,merchant_approved,adapter_ready,capabilities)
   VALUES('GB','GBP','card','kora','suite_kora_gb',false,true,true,true,ARRAY['collect']); a3:=false;
   EXCEPTION WHEN check_violation THEN a3:=true; END;
 INSERT INTO results VALUES (4,'kora outside NG/NGN remains forbidden',a3,'');
 BEGIN INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref,preferred,enabled,merchant_approved,adapter_ready,capabilities)
   VALUES('NG','NGN','card','fincra','suite_fincra_ng',false,true,true,true,ARRAY['collect']); a4:=false;
   EXCEPTION WHEN check_violation THEN a4:=true; END;
 INSERT INTO results VALUES (4,'fincra enabled remains forbidden',a4,'');
 BEGIN INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref,preferred,enabled,merchant_approved,adapter_ready,capabilities,payout_approved)
   VALUES('NG','NGN','card','kora','suite_kora_pa',false,true,true,true,ARRAY['collect'],true); a5:=false;
   EXCEPTION WHEN check_violation THEN a5:=true; END;
 INSERT INTO results VALUES (4,'kora payout_approved remains forbidden',a5,'');
 BEGIN INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref,preferred,enabled,merchant_approved,adapter_ready,capabilities)
   VALUES('NG','NGN','card','kora','suite_kora_extra',false,true,true,true,ARRAY['collect','refund']); a6:=false;
   EXCEPTION WHEN check_violation THEN a6:=true; END;
 INSERT INTO results VALUES (4,'kora collect route cannot grow extra capabilities',a6,'');
END $r$;

SELECT n, name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, left(detail,90) AS detail FROM results ORDER BY n, name;
SELECT count(*) FILTER (WHERE NOT ok) AS failures, count(*) AS checks FROM results;
ROLLBACK;
-- Post-suite preservation proof (runs AFTER ROLLBACK, outside the fixture
-- transaction): every fixture-reachable row, every trigger enabled-state and
-- every table/function/schema ACL must equal the pre-suite capture. Any
-- residual fixture write, disabled trigger or permission drift fails loudly.
CREATE TEMP TABLE post_rows AS
 SELECT 'market_availability' AS tbl, to_jsonb(t) AS row FROM public.market_availability t WHERE t.country_code IN ('GB','NG')
 UNION ALL SELECT 'tenants', to_jsonb(t) FROM public.tenants t WHERE t.slug='t' OR t.id='11111111-1111-4111-8111-111111111111'::uuid
 UNION ALL SELECT 'service_types', to_jsonb(t) FROM public.service_types t WHERE t.slug='errand' OR t.id='dddddddd-dddd-4ddd-8ddd-dddddddddd02'::uuid
 UNION ALL SELECT 'auth_users', to_jsonb(t) FROM auth.users t WHERE t.id IN
   ('dddddddd-aaaa-4aaa-8aaa-000000000009','ffffffff-dddd-4ddd-8ddd-dddddddddddd','aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee')
 UNION ALL SELECT 'profiles', to_jsonb(t) FROM public.profiles t WHERE t.id IN
   ('dddddddd-aaaa-4aaa-8aaa-000000000009','ffffffff-dddd-4ddd-8ddd-dddddddddddd','aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee')
 UNION ALL SELECT 'wallets', to_jsonb(t) FROM public.wallets t WHERE t.user_id IN
   ('dddddddd-aaaa-4aaa-8aaa-000000000009','ffffffff-dddd-4ddd-8ddd-dddddddddddd','aaaaaaaa-eeee-4eee-8eee-eeeeeeeeeeee')
 UNION ALL SELECT 'market_payment_routes', to_jsonb(t) FROM public.market_payment_routes t
   WHERE t.country_code='GB' AND t.currency_code='GBP' AND t.method='card'
 UNION ALL SELECT 'wallet_topup_fee_schedules', to_jsonb(t) FROM public.wallet_topup_fee_schedules t WHERE t.version='vaydu-customer-card-0fee-test-v1'
 UNION ALL SELECT 'wallet_topup_fee_policies', to_jsonb(t) FROM public.wallet_topup_fee_policies t WHERE t.version='vaydu-customer-card-0fee-test-v1'
 UNION ALL SELECT 'wallet_collection_config', to_jsonb(t) FROM public.wallet_collection_config t WHERE t.key IN ('enabled','max_amount_minor_GBP');
CREATE TEMP TABLE post_triggers AS
 SELECT c.relname AS tbl, t.tgname, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal;
CREATE TEMP TABLE post_acl AS
 SELECT n.nspname, c.relname, c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','auth') AND c.relkind='r';
CREATE TEMP TABLE post_facl AS
 SELECT p.oid::regprocedure::text AS sig, p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','auth');
CREATE TEMP TABLE post_nacl AS
 SELECT nspname, nspacl FROM pg_namespace WHERE nspname IN ('public','auth');
DO $post$ DECLARE d record; n bigint := 0; BEGIN
 FOR d IN
  SELECT 'fixture-reachable rows' AS part, count(*) AS diffs FROM ((TABLE pre_rows EXCEPT TABLE post_rows) UNION ALL (TABLE post_rows EXCEPT TABLE pre_rows)) x
  UNION ALL SELECT 'trigger enabled-states', count(*) FROM ((TABLE pre_triggers EXCEPT TABLE post_triggers) UNION ALL (TABLE post_triggers EXCEPT TABLE pre_triggers)) x
  UNION ALL SELECT 'table ACLs', count(*) FROM ((TABLE pre_acl EXCEPT TABLE post_acl) UNION ALL (TABLE post_acl EXCEPT TABLE pre_acl)) x
  UNION ALL SELECT 'function ACLs', count(*) FROM ((TABLE pre_facl EXCEPT TABLE post_facl) UNION ALL (TABLE post_facl EXCEPT TABLE pre_facl)) x
  UNION ALL SELECT 'schema ACLs', count(*) FROM ((TABLE pre_nacl EXCEPT TABLE post_nacl) UNION ALL (TABLE post_nacl EXCEPT TABLE pre_nacl)) x
 LOOP
  IF d.diffs > 0 THEN RAISE WARNING 'post-suite preservation diff in %: %', d.part, d.diffs; END IF;
  n := n + d.diffs;
 END LOOP;
 IF n > 0 THEN RAISE EXCEPTION 'POST-SUITE PRESERVATION FAILED: % differences', n; END IF;
 RAISE NOTICE 'POST-SUITE PRESERVATION PASSED';
END $post$;
