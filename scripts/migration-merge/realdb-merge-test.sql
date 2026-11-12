-- Real-Postgres behaviour test for 20261269000000_merge_cash_pilot_with_roadmap_cash.
-- Disposable database: deployed baseline + roadmap chain + cash-ride chain (either order) + the merge.
-- One transaction, rolled back. Seed rows use session_replication_role=replica (no trigger state change);
-- every acquisition/reserve/reassign below runs with the deployed trigger configuration.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE results(n int, name text, ok boolean, detail text);
SET LOCAL session_replication_role = replica;
INSERT INTO public.tenants(id,name,slug) VALUES ('11111111-1111-4111-8111-111111111111','m','m') ON CONFLICT DO NOTHING;
INSERT INTO public.market_availability(country_code,launch_status,supported_currency) VALUES ('GB','live','GBP'),('NG','live','NGN') ON CONFLICT DO NOTHING;
INSERT INTO public.service_types(id,slug,name) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddd01','ride','Ride'),('dddddddd-dddd-4ddd-8ddd-dddddddddd02','delivery','Delivery'),('dddddddd-dddd-4ddd-8ddd-dddddddddd03','errand','Errand')
 ON CONFLICT DO NOTHING;
INSERT INTO auth.users(id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),('ffffffff-ffff-4fff-8fff-ffffffffffff');
INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_country_code,registration_activated_at) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','driver','GB','GB',now()),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111','driver','GB','GB',now()),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','11111111-1111-4111-8111-111111111111','driver','NG','NG',now()),
 ('ffffffff-ffff-4fff-8fff-ffffffffffff','11111111-1111-4111-8111-111111111111','driver','GB','GB',now()),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111','customer','GB','GB',NULL);
INSERT INTO public.driver_cash_credit_config_v1e VALUES ('ride_cash_credit',true) ON CONFLICT (key) DO UPDATE SET enabled=true;
INSERT INTO public.driver_cash_credit_markets_v1e(country_code,currency_code,enabled) VALUES ('GB','GBP',true);
INSERT INTO public.driver_cash_credit_enrolments_v1e(tenant_id,driver_id,country_code,currency_code,terms_version,consented_at,enabled) VALUES
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','GB','GBP','merge-test',now()-interval '1 day',true),
 ('11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','GB','GBP','merge-test',now()-interval '1 day',true),
 ('11111111-1111-4111-8111-111111111111','ffffffff-ffff-4fff-8fff-ffffffffffff','GB','GBP','merge-test',now()-interval '1 day',true);
-- GBP 100.00 credited cash-ride credit for drivers A and B (same ledger shape the top-up confirms).
DO $c$ DECLARE d uuid; eid uuid; acc uuid; att uuid; BEGIN
 FOREACH d IN ARRAY ARRAY['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','ffffffff-ffff-4fff-8fff-ffffffffffff']::uuid[] LOOP
  eid:=gen_random_uuid(); acc:=gen_random_uuid(); att:=gen_random_uuid();
  INSERT INTO public.wallet_business_events(id,event_key,operation,payment_provider,merchant_account_ref,provider_reference,tenant_id,owner_id,currency_code,entries)
   VALUES (eid,'wallet-topup:'||att::text,'topup','stripe','stripe-platform','ref-'||att::text,'11111111-1111-4111-8111-111111111111',d,'GBP',
    jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit','amountMinor',10000),jsonb_build_object('accountPurpose','platform_funding','amountMinor',-10000)));
  INSERT INTO public.wallet_accounts(id,tenant_id,owner_id,currency_code,balance_purpose) VALUES (acc,'11111111-1111-4111-8111-111111111111',d,'GBP','driver_cash_credit');
  INSERT INTO public.wallet_movements(event_id,account_id,amount_minor,entry_seq) VALUES (eid,acc,10000,1);
  INSERT INTO public.wallet_topup_attempts(id,attempt_key,tenant_id,owner_id,country_code,currency_code,amount_minor,destination_account_purpose,payment_provider,merchant_account_ref,provider_idempotency_identity,provider_reference,status,credited_event_id)
   VALUES (att,'merge-'||att::text,'11111111-1111-4111-8111-111111111111',d,'GB','GBP',10000,'driver_cash_credit','stripe','stripe-platform','idem-'||att::text,'ref-'||att::text,'credited',eid);
 END LOOP;
END $c$;
SET LOCAL session_replication_role = origin;
CREATE FUNCTION pg_temp.fare() RETURNS jsonb LANGUAGE sql AS $f$ SELECT '{"policyVersion":"fare-split-v1","currency":"GBP","platformFeeType":"percentage","driverBase":10.00,"customerCharge":11.00,"platformFeeAmount":1.00,"platformFeePercent":10,"platformFeeFixed":0,"driverCommissionAmount":1.50,"commissionPercent":15,"driverEntitlement":8.50}'::jsonb $f$;
-- A cash job (seeded without triggers) in a given market/service; optionally already carrying a driver.
CREATE FUNCTION pg_temp.cash_job(p_id uuid, p_service uuid, p_country text, p_currency text, p_status text, p_payment_status text) RETURNS uuid LANGUAGE plpgsql AS $f$
BEGIN
 SET LOCAL session_replication_role = replica;
 INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,service_type_id,payment_method,payment_status,country_code,currency_code,status,metadata,fare_breakdown,total_price,price)
 VALUES (p_id,'11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','a','b',now(),p_service,'cash',p_payment_status,p_country,p_currency,p_status,
  '{"cash_collection_mode":"full_customer_charge"}',pg_temp.fare(),11.00,11.00);
 SET LOCAL session_replication_role = origin;
 RETURN p_id;
END $f$;
CREATE FUNCTION pg_temp.try(q text) RETURNS text LANGUAGE plpgsql AS $f$ BEGIN EXECUTE q; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $f$;
CREATE FUNCTION pg_temp.st(d uuid) RETURNS boolean LANGUAGE sql AS $f$ SELECT (public.driver_cash_credit_status_v1f(d)->>'pilotEnabled')::boolean $f$;

-- 1. Who may use cash where (courier cash OFF by default; D10).
INSERT INTO results SELECT 1,'ride GB (pilot market) enabled',public.cash_service_enabled_v1e('ride','GB','GBP'),'';
INSERT INTO results SELECT 1,'delivery GB: courier cash off by default',NOT public.cash_service_enabled_v1e('delivery','GB','GBP'),'';
INSERT INTO results SELECT 1,'ride NG (no market row) not enabled',NOT public.cash_service_enabled_v1e('ride','NG','NGN'),'';
INSERT INTO results SELECT 1,'unknown service never enabled',NOT public.cash_service_enabled_v1e('van-moving','GB','GBP'),'';
INSERT INTO results SELECT 1,'driver status: GB pilot on, NG off',pg_temp.st('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') AND NOT pg_temp.st('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),'';

-- 2. Restored disabled-acquisition gate (dropped by 20261255700000): an INSERT arriving with a driver
--    where cash is not enabled fails CE001 (the BEFORE UPDATE eligibility trigger never sees inserts).
INSERT INTO results SELECT 2,'INSERT cash delivery with driver, courier off (GB) -> CE001',r='CE001',r FROM (SELECT pg_temp.try($q$
 INSERT INTO public.jobs(tenant_id,customer_id,driver_id,accepted_driver_id,pickup_address,dropoff_address,scheduled_time,service_type_id,payment_method,payment_status,country_code,currency_code,status,metadata,fare_breakdown,total_price,price)
 VALUES ('11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a','b',now(),'dddddddd-dddd-4ddd-8ddd-dddddddddd02','cash','pending','GB','GBP','assigned','{"cash_collection_mode":"full_customer_charge"}',pg_temp.fare(),11,11)$q$) r) s;
INSERT INTO results SELECT 2,'INSERT cash ride with driver in a non-pilot market (NG) -> CE001',r='CE001',r FROM (SELECT pg_temp.try($q$
 INSERT INTO public.jobs(tenant_id,customer_id,driver_id,accepted_driver_id,pickup_address,dropoff_address,scheduled_time,service_type_id,payment_method,payment_status,country_code,currency_code,status,metadata,fare_breakdown,total_price,price)
 VALUES ('11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','a','b',now(),'dddddddd-dddd-4ddd-8ddd-dddddddddd01','cash','pending','NG','NGN','assigned','{"cash_collection_mode":"full_customer_charge"}',pg_temp.fare(),11,11)$q$) r) s;

-- 3. UPDATE acquisition (eligibility trigger): cash rides follow the cash-ride plan.
SELECT pg_temp.cash_job('00000000-0000-4000-8000-000000000003','dddddddd-dddd-4ddd-8ddd-dddddddddd01','GB','GBP','searching','cash_due');
INSERT INTO results SELECT 3,'GB cash ride with NO card hold cannot acquire a driver (MB003)',r='MB003',r
 FROM (SELECT pg_temp.try($q$UPDATE public.jobs SET driver_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',accepted_driver_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status='accepted' WHERE id='00000000-0000-4000-8000-000000000003'$q$) r) s;
INSERT INTO results SELECT 3,'refused acquisition left the job unassigned',driver_id IS NULL AND status='searching',status FROM public.jobs WHERE id='00000000-0000-4000-8000-000000000003';
SET LOCAL session_replication_role = replica;
INSERT INTO public.cash_ride_fee_holds_v1e(job_id,tenant_id,customer_id,provider,merchant_account_ref,provider_payment_reference,amount_minor,currency_code,fee_terms,status)
 VALUES ('00000000-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','stripe','stripe-platform','pi_merge_3',500,'GBP','{"version":"cash-fee-hold-v1"}','authorized');
SET LOCAL session_replication_role = origin;
INSERT INTO results SELECT 3,'GB cash ride WITH an authorised hold: enrolled driver acquires it',r='ok',r
 FROM (SELECT pg_temp.try($q$UPDATE public.jobs SET driver_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',accepted_driver_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status='accepted' WHERE id='00000000-0000-4000-8000-000000000003'$q$) r) s;
INSERT INTO results SELECT 3,'merged reserve held the credit (250) on the ride',count(*)=1 AND max(required_credit_minor)=250,count(*)::text
 FROM public.driver_cash_credit_holds_v1e WHERE job_id='00000000-0000-4000-8000-000000000003' AND status='held';

-- 4. Courier cash (roadmap) keeps working once explicitly enabled — including atomic reassignment.
SELECT pg_temp.cash_job('00000000-0000-4000-8000-000000000004','dddddddd-dddd-4ddd-8ddd-dddddddddd02','GB','GBP','searching','pending');
INSERT INTO results SELECT 4,'delivery, courier off: acquisition refused (MB003)',r='MB003',r
 FROM (SELECT pg_temp.try($q$UPDATE public.jobs SET driver_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',accepted_driver_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',status='assigned' WHERE id='00000000-0000-4000-8000-000000000004'$q$) r) s;
UPDATE public.driver_cash_credit_markets_v1e SET courier_enabled=true WHERE country_code='GB';
INSERT INTO results SELECT 4,'courier enabled for GB: delivery and errand enabled',public.cash_service_enabled_v1e('delivery','GB','GBP') AND public.cash_service_enabled_v1e('errand','GB','GBP'),'';
INSERT INTO results SELECT 4,'delivery, courier on: driver B acquires it',r='ok',r
 FROM (SELECT pg_temp.try($q$UPDATE public.jobs SET driver_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',accepted_driver_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',status='assigned' WHERE id='00000000-0000-4000-8000-000000000004'$q$) r) s;
INSERT INTO results SELECT 4,'roadmap reassignment through the merged reserve: B -> F (a free, enrolled driver)',r='ok',r
 FROM (SELECT pg_temp.try($q$SELECT public.reassign_cash_job_credit_v1f('00000000-0000-4000-8000-000000000004','ffffffff-ffff-4fff-8fff-ffffffffffff')$q$) r) s;
INSERT INTO results SELECT 4,'old hold reassigned, one live hold for F',
  count(*) FILTER (WHERE status='reassigned' AND driver_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')=1 AND count(*) FILTER (WHERE status='held' AND driver_id='ffffffff-ffff-4fff-8fff-ffffffffffff')=1,
  string_agg(status||':'||left(driver_id::text,4),',') FROM public.driver_cash_credit_holds_v1e WHERE job_id='00000000-0000-4000-8000-000000000004';
DO $t$ DECLARE r public.jobs; base boolean; BEGIN
 SELECT * INTO r FROM public.jobs WHERE id='00000000-0000-4000-8000-000000000004';
 base := public.cash_acquisition_allowed_v1e(r);
 r.payment_intent_id := 'pi_x';
 INSERT INTO results VALUES (4,'courier cash needs full custody: the same delivery with a PaymentIntent is not cash-acquirable',
   base AND NOT public.cash_acquisition_allowed_v1e(r), base::text);
END $t$;

-- 5. Reserve is market-scoped; kill switches still win.
SELECT pg_temp.cash_job('00000000-0000-4000-8000-000000000005','dddddddd-dddd-4ddd-8ddd-dddddddddd01','NG','NGN','assigned','cash_due');
-- With its (NG) driver, so the eligibility check (CE002) passes and the market gate is what decides.
SET LOCAL session_replication_role = replica;
UPDATE public.jobs SET driver_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',accepted_driver_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' WHERE id='00000000-0000-4000-8000-000000000005';
SET LOCAL session_replication_role = origin;
INSERT INTO results SELECT 5,'reserve for an NG cash job stops at the market gate (CE001)',r='CE001',r
 FROM (SELECT pg_temp.try($q$SELECT public.reserve_cash_job_credit_v1e('00000000-0000-4000-8000-000000000005','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')$q$) r) s;
UPDATE public.driver_cash_credit_markets_v1e SET enabled=false WHERE country_code='GB';
INSERT INTO results SELECT 5,'GB market disabled: ride not enabled, driver status off',NOT public.cash_service_enabled_v1e('ride','GB','GBP') AND NOT pg_temp.st('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),'';
UPDATE public.driver_cash_credit_markets_v1e SET enabled=true WHERE country_code='GB';
UPDATE public.driver_cash_credit_config_v1e SET enabled=false WHERE key='ride_cash_credit';
INSERT INTO results SELECT 5,'global kill switch off: everything off despite the market row',NOT public.cash_service_enabled_v1e('ride','GB','GBP') AND NOT public.cash_service_enabled_v1e('delivery','GB','GBP'),'';

-- 6. Privileges of the new helpers.
INSERT INTO results SELECT 6,'merge helpers: service_role only',
  has_function_privilege('service_role','public.cash_service_enabled_v1e(text,text,text)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.cash_service_enabled_v1e(text,text,text)','EXECUTE')
  AND NOT has_function_privilege('anon','public.cash_service_enabled_v1e(text,text,text)','EXECUTE')
  AND has_function_privilege('service_role','public.cash_acquisition_allowed_v1e(public.jobs)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.cash_acquisition_allowed_v1e(public.jobs)','EXECUTE'),'';

SELECT n, name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, left(coalesce(detail,''),90) AS detail FROM results ORDER BY n, name;
SELECT count(*) FILTER (WHERE NOT ok) AS failures, count(*) AS checks FROM results;
ROLLBACK;
