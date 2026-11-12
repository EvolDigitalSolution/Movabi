-- Real-Postgres chain test for cash-ride booking phase 2 (disposable database only):
-- deployed baseline + 20261266000000 + 20261266100000 + 20261266200000.
-- Covers activate_cash_ride_v1e, then the full path: cash booking -> authorised fee hold ->
-- activation -> enrolled driver accepts -> cash-credit 1E reserves commission + fee.
-- Only trg_enforce_job_payment_eligibility and enforce_ride_cash_credit_v1e stay enabled on jobs
-- (driver-approval triggers need full onboarding fixtures and are unrelated). Rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $d$ DECLARE t text; BEGIN
 FOR t IN SELECT tgname FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid WHERE c.relname='jobs' AND NOT tgisinternal
   AND tgname NOT IN ('trg_enforce_job_payment_eligibility','enforce_ride_cash_credit_v1e')
 LOOP EXECUTE format('ALTER TABLE public.jobs DISABLE TRIGGER %I', t); END LOOP; END $d$;
INSERT INTO public.tenants(id,name,slug) VALUES ('11111111-1111-4111-8111-111111111111','t','t');
INSERT INTO public.market_availability(country_code,launch_status,supported_currency) VALUES ('GB','live','GBP');
INSERT INTO public.service_types(id,slug,name) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddd01','ride','Ride');
INSERT INTO auth.users(id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_country_code,registration_activated_at) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','driver','GB','GB',now()),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111','customer','GB','GB',NULL),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','11111111-1111-4111-8111-111111111111','customer','GB','GB',NULL);
INSERT INTO public.driver_cash_credit_config_v1e VALUES ('ride_cash_credit',true);
INSERT INTO public.driver_cash_credit_markets_v1e(country_code,currency_code,enabled) VALUES ('GB','GBP',true);
INSERT INTO public.driver_cash_credit_enrolments_v1e(tenant_id,driver_id,country_code,currency_code,terms_version,consented_at,enabled)
 VALUES ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','GB','GBP','chain-test',now()-interval '1 day',true);
-- GBP 100.00 of credited cash-ride credit for the driver (same shape as a real top-up credit).
DO $c$ DECLARE eid uuid:=gen_random_uuid(); acc uuid:=gen_random_uuid(); att uuid:=gen_random_uuid(); BEGIN
 INSERT INTO public.wallet_business_events(id,event_key,operation,payment_provider,merchant_account_ref,provider_reference,tenant_id,owner_id,currency_code,entries)
  VALUES (eid,'wallet-topup:'||att::text,'topup','stripe','stripe-platform','ref-chain','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','GBP',
   jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit','amountMinor',10000),jsonb_build_object('accountPurpose','platform_funding','amountMinor',-10000)));
 INSERT INTO public.wallet_accounts(id,tenant_id,owner_id,currency_code,balance_purpose) VALUES (acc,'11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','GBP','driver_cash_credit');
 INSERT INTO public.wallet_movements(event_id,account_id,amount_minor,entry_seq) VALUES (eid,acc,10000,1);
 INSERT INTO public.wallet_topup_attempts(id,attempt_key,tenant_id,owner_id,country_code,currency_code,amount_minor,destination_account_purpose,payment_provider,merchant_account_ref,provider_idempotency_identity,provider_reference,status,credited_event_id)
  VALUES (att,'chain','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','GB','GBP',10000,'driver_cash_credit','stripe','stripe-platform','idem-chain','ref-chain','credited',eid);
END $c$;
CREATE TEMP TABLE results(n int, name text, ok boolean, detail text);
-- A cash job exactly as /api/booking/create writes it: requested, cash_due, custody, canonical fare (GBP 11.00).
CREATE FUNCTION pg_temp.cash_job(customer uuid DEFAULT 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sched timestamptz DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE id uuid:=gen_random_uuid(); BEGIN
 INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,service_type_id,payment_method,payment_status,country_code,currency_code,status,metadata,fare_breakdown)
 VALUES (id,'11111111-1111-4111-8111-111111111111',customer,'a','b',coalesce(sched,now()),'dddddddd-dddd-4ddd-8ddd-dddddddddd01','cash','cash_due','GB','GBP','requested',
  '{"cash_collection_mode":"full_customer_charge","payment_choice":"cash"}',
  '{"policyVersion":"fare-split-v1","currency":"GBP","platformFeeType":"percentage","driverBase":10.00,"customerCharge":11.00,"platformFeeAmount":1.00,"platformFeePercent":10,"platformFeeFixed":0,"driverCommissionAmount":1.50,"commissionPercent":15,"driverEntitlement":8.50}');
 RETURN id; END $f$;
CREATE FUNCTION pg_temp.hold(j uuid, ref text, amount bigint DEFAULT 500, customer uuid DEFAULT 'cccccccc-cccc-4ccc-8ccc-cccccccccccc') RETURNS void LANGUAGE sql AS $f$
 INSERT INTO public.cash_ride_fee_holds_v1e(job_id,tenant_id,customer_id,provider,merchant_account_ref,provider_payment_reference,amount_minor,currency_code,fee_terms,status)
 VALUES (j,'11111111-1111-4111-8111-111111111111',customer,'stripe','stripe-platform',ref,amount,'GBP','{"version":"cash-fee-hold-v1"}','created') $f$;
CREATE FUNCTION pg_temp.act(j uuid, ref text, amount bigint DEFAULT 500, customer uuid DEFAULT 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', prov text DEFAULT 'stripe') RETURNS text LANGUAGE sql AS $f$
 SELECT public.activate_cash_ride_v1e(j, customer, prov, ref, amount, 'GBP') $f$;

DO $t$ DECLARE j uuid; r text; st text; BEGIN
 j:=pg_temp.cash_job(); r:=pg_temp.act(j,'pi_none');
 INSERT INTO results VALUES (1,'no hold: refused',r='no_hold',r);
 j:=pg_temp.cash_job(); PERFORM pg_temp.hold(j,'pi_a1');
 INSERT INTO results VALUES (1,'another customer: refused',pg_temp.act(j,'pi_a1',500,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')='not_owner','');
 INSERT INTO results VALUES (1,'other provider reference: refused',pg_temp.act(j,'pi_other')='hold_mismatch','');
 INSERT INTO results VALUES (1,'other amount: refused',pg_temp.act(j,'pi_a1',400)='hold_mismatch','');
 INSERT INTO results VALUES (1,'other provider: refused',pg_temp.act(j,'pi_a1',500,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','kora')='hold_mismatch','');
 SELECT status INTO st FROM public.jobs WHERE id=j;
 INSERT INTO results VALUES (1,'refusals leave the job requested',st='requested',st);
 r:=pg_temp.act(j,'pi_a1'); SELECT status INTO st FROM public.jobs WHERE id=j;
 INSERT INTO results VALUES (2,'matching hold: activated, job searching, hold authorised',r='activated' AND st='searching'
   AND (SELECT status FROM public.cash_ride_fee_holds_v1e WHERE job_id=j)='authorized'
   AND (SELECT driver_search_expires_at>now() AND dispatch_attempts=1 FROM public.jobs WHERE id=j),r||' '||st);
 INSERT INTO results VALUES (2,'repeat activation is idempotent',pg_temp.act(j,'pi_a1')='already_activated','');
 j:=pg_temp.cash_job('cccccccc-cccc-4ccc-8ccc-cccccccccccc',now()+interval '2 hours'); PERFORM pg_temp.hold(j,'pi_s1');
 INSERT INTO results VALUES (3,'scheduled cash ride: not activatable',pg_temp.act(j,'pi_s1')='not_activatable','');
 UPDATE public.driver_cash_credit_markets_v1e SET enabled=false;
 j:=pg_temp.cash_job(); PERFORM pg_temp.hold(j,'pi_d1');
 INSERT INTO results VALUES (3,'market disabled: not activatable',pg_temp.act(j,'pi_d1')='not_activatable','');
 UPDATE public.driver_cash_credit_markets_v1e SET enabled=true;
END $t$;

-- Full chain: activated cash ride -> enrolled driver accepts -> 1E reserves commission + fee (GBP 2.50).
DO $t$ DECLARE j uuid; st text; h record; bal jsonb; BEGIN
 j:=pg_temp.cash_job(); PERFORM pg_temp.hold(j,'pi_chain');
 PERFORM pg_temp.act(j,'pi_chain');
 BEGIN UPDATE public.jobs SET driver_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', accepted_driver_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status='accepted' WHERE id=j; st:='ok';
 EXCEPTION WHEN OTHERS THEN st:=SQLSTATE||' '||SQLERRM; END;
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=j;
 bal:=public.driver_cash_credit_balance_v1e('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','GBP');
 INSERT INTO results VALUES (4,'driver accepts the activated cash ride',st='ok',st);
 INSERT INTO results VALUES (4,'1E reserved commission + fee from cash-ride credit (250)',h.required_credit_minor=250 AND h.status='held',coalesce(h.required_credit_minor::text,'no hold'));
 INSERT INTO results VALUES (4,'credit balance: 100.00 -> 97.50 available, 2.50 reserved, consistent',
   bal->>'availableMinor'='9750' AND bal->>'heldMinor'='250' AND (bal->>'consistent')::boolean,bal::text);
END $t$;

SELECT n, name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, left(detail,90) AS detail FROM results ORDER BY n, name;
SELECT count(*) FILTER (WHERE NOT ok) AS failures, count(*) AS checks FROM results;
ROLLBACK;
