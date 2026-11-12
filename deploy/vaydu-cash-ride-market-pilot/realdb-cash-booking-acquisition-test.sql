-- Real-Postgres test for 20261266100000_cash_ride_booking_fee_hold (driver acquisition rule).
-- Disposable database only: deployed baseline + 20261266000000 + 20261266100000.
-- Every other jobs trigger is disabled INSIDE this transaction so only
-- trg_enforce_job_payment_eligibility decides; everything is rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $d$ DECLARE t text; BEGIN
 FOR t IN SELECT tgname FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid WHERE c.relname='jobs' AND NOT tgisinternal AND tgname<>'trg_enforce_job_payment_eligibility'
 LOOP EXECUTE format('ALTER TABLE public.jobs DISABLE TRIGGER %I', t); END LOOP; END $d$;
INSERT INTO public.tenants(id,name,slug) VALUES ('11111111-1111-4111-8111-111111111111','t','t');
INSERT INTO public.market_availability(country_code,launch_status,supported_currency) VALUES ('GB','live','GBP'),('NG','live','NGN');
INSERT INTO public.service_types(id,slug,name) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddd01','ride','Ride'),('dddddddd-dddd-4ddd-8ddd-dddddddddd02','delivery','Delivery');
INSERT INTO auth.users(id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),('cccccccc-cccc-4ccc-8ccc-ccccccccccc2');
INSERT INTO public.profiles(id,tenant_id,role) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','driver'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111','customer'),('cccccccc-cccc-4ccc-8ccc-ccccccccccc2','11111111-1111-4111-8111-111111111111','customer');
INSERT INTO public.driver_cash_credit_config_v1e VALUES ('ride_cash_credit',true);
CREATE TEMP TABLE results(n int, name text, ok boolean, detail text);

CREATE FUNCTION pg_temp.job(country text, currency text, method text, pstatus text, svc text, mode text, pi text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE id uuid:=gen_random_uuid(); BEGIN
 INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,service_type_id,payment_method,payment_status,country_code,currency_code,status,metadata,payment_intent_id)
 VALUES (id,'11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','a','b',now(),
   (SELECT st.id FROM public.service_types st WHERE st.slug=svc),method,pstatus,country,currency,'searching',
   CASE WHEN mode IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cash_collection_mode',mode) END,pi);
 RETURN id; END $f$;
CREATE FUNCTION pg_temp.hold(j uuid, st text, customer uuid DEFAULT 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', cur text DEFAULT 'GBP') RETURNS void LANGUAGE sql AS $f$
 INSERT INTO public.cash_ride_fee_holds_v1e(job_id,tenant_id,customer_id,provider,merchant_account_ref,provider_payment_reference,amount_minor,currency_code,fee_terms,status)
 VALUES (j,'11111111-1111-4111-8111-111111111111',customer,'stripe','stripe-platform',CASE WHEN st IN ('authorized','captured','released') THEN 'pi_hold_'||replace(j::text,'-','') END,500,cur,'{"noShowFeeMinor":500}',st) $f$;
-- Tries a driver acquisition; returns 'ok' or the SQLSTATE.
CREATE FUNCTION pg_temp.acquire(j uuid) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN UPDATE public.jobs SET driver_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status='accepted' WHERE id=j;
 -- Free the driver again (one active job per driver is enforced by a unique index).
 UPDATE public.jobs SET driver_id=NULL, status='cancelled' WHERE id=j; RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $f$;

DO $t$ DECLARE j uuid; r text; BEGIN
 -- Card jobs: unchanged behaviour.
 j:=pg_temp.job('GB','GBP','card','pending','ride',NULL,NULL); r:=pg_temp.acquire(j);
 INSERT INTO results VALUES (1,'unpaid card ride cannot be acquired (MB003, unchanged)',r='MB003',r);
 j:=pg_temp.job('GB','GBP','card','paid','ride',NULL,'pi_card'); r:=pg_temp.acquire(j);
 INSERT INTO results VALUES (1,'paid card ride can be acquired (unchanged)',r='ok',r);
 -- Cash ride in GB, market NOT enabled yet: blocked even with an authorised hold.
 j:=pg_temp.job('GB','GBP','cash','cash_due','ride','full_customer_charge',NULL); PERFORM pg_temp.hold(j,'authorized'); r:=pg_temp.acquire(j);
 INSERT INTO results VALUES (2,'cash ride, market not enabled: blocked',r='MB003',r);
END $t$;
INSERT INTO public.driver_cash_credit_markets_v1e(country_code,currency_code,enabled) VALUES ('GB','GBP',true);
DO $t$ DECLARE j uuid; r text; BEGIN
 j:=pg_temp.job('GB','GBP','cash','cash_due','ride','full_customer_charge',NULL); PERFORM pg_temp.hold(j,'authorized'); r:=pg_temp.acquire(j);
 INSERT INTO results VALUES (3,'cash ride, GB enabled, authorised hold: acquirable',r='ok',r);
 j:=pg_temp.job('GB','GBP','cash','cash_due','ride','full_customer_charge',NULL); r:=pg_temp.acquire(j);
 INSERT INTO results VALUES (4,'no fee hold: blocked',r='MB003',r);
 j:=pg_temp.job('GB','GBP','cash','cash_due','ride','full_customer_charge',NULL); PERFORM pg_temp.hold(j,'created'); r:=pg_temp.acquire(j);
 INSERT INTO results VALUES (4,'hold not authorised yet: blocked',r='MB003',r);
 j:=pg_temp.job('GB','GBP','cash','cash_due','ride','full_customer_charge',NULL); PERFORM pg_temp.hold(j,'released'); r:=pg_temp.acquire(j);
 INSERT INTO results VALUES (4,'hold released: blocked',r='MB003',r);
 j:=pg_temp.job('GB','GBP','cash','cash_due','ride','full_customer_charge',NULL); PERFORM pg_temp.hold(j,'authorized','cccccccc-cccc-4ccc-8ccc-ccccccccccc2'); r:=pg_temp.acquire(j);
 INSERT INTO results VALUES (4,'hold for another customer: blocked',r='MB003',r);
 j:=pg_temp.job('GB','GBP','cash','cash_due','ride','full_customer_charge',NULL); PERFORM pg_temp.hold(j,'authorized','cccccccc-cccc-4ccc-8ccc-cccccccccccc','EUR'); r:=pg_temp.acquire(j);
 INSERT INTO results VALUES (4,'hold in another currency: blocked',r='MB003',r);
 j:=pg_temp.job('GB','GBP','cash','cash_due','delivery','full_customer_charge',NULL); PERFORM pg_temp.hold(j,'authorized'); r:=pg_temp.acquire(j);
 INSERT INTO results VALUES (5,'cash delivery (not Ride): blocked',r='MB003',r);
 j:=pg_temp.job('GB','GBP','cash','cash_due','ride',NULL,NULL); PERFORM pg_temp.hold(j,'authorized'); r:=pg_temp.acquire(j);
 INSERT INTO results VALUES (5,'no full cash collection mode: blocked',r='MB003',r);
 j:=pg_temp.job('GB','GBP','cash','cash_due','ride','full_customer_charge','pi_should_not_exist'); PERFORM pg_temp.hold(j,'authorized'); r:=pg_temp.acquire(j);
 INSERT INTO results VALUES (5,'cash job carrying a PaymentIntent: blocked',r='MB003',r);
 j:=pg_temp.job('GB','GBP','cash','pending','ride','full_customer_charge',NULL); PERFORM pg_temp.hold(j,'authorized'); r:=pg_temp.acquire(j);
 INSERT INTO results VALUES (5,'cash job not cash_due: blocked',r='MB003',r);
 j:=pg_temp.job('NG','NGN','cash','cash_due','ride','full_customer_charge',NULL); PERFORM pg_temp.hold(j,'authorized','cccccccc-cccc-4ccc-8ccc-cccccccccccc','NGN'); r:=pg_temp.acquire(j);
 INSERT INTO results VALUES (6,'cash ride in NG (market not enabled): blocked',r='MB003',r);
END $t$;
-- Hold table constraints.
DO $t$ DECLARE r text; BEGIN
 BEGIN INSERT INTO public.cash_ride_fee_holds_v1e(job_id,tenant_id,customer_id,provider,merchant_account_ref,amount_minor,currency_code,fee_terms,status)
  VALUES (pg_temp.job('GB','GBP','cash','cash_due','ride','full_customer_charge',NULL),'11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','stripe','m',500,'GBP','{}','authorized'); r:='ok';
 EXCEPTION WHEN OTHERS THEN r:=SQLSTATE; END;
 INSERT INTO results VALUES (7,'authorised hold without provider reference rejected',r='23514',r);
 BEGIN INSERT INTO public.cash_ride_fee_holds_v1e(job_id,tenant_id,customer_id,provider,merchant_account_ref,amount_minor,currency_code,fee_terms,status,captured_minor,provider_payment_reference)
  VALUES (pg_temp.job('GB','GBP','cash','cash_due','ride','full_customer_charge',NULL),'11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','stripe','m',500,'GBP','{}','captured',600,'pi_x1'); r:='ok';
 EXCEPTION WHEN OTHERS THEN r:=SQLSTATE; END;
 INSERT INTO results VALUES (7,'capture above the hold rejected',r='23514',r);
END $t$;
SELECT n, name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, detail FROM results ORDER BY n, name;
SELECT count(*) FILTER (WHERE NOT ok) AS failures, count(*) AS checks FROM results;
ROLLBACK;
