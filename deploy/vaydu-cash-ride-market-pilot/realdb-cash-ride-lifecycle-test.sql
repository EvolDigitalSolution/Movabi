-- Real-Postgres lifecycle test, cash-ride booking phase 3 (disposable database only):
-- deployed baseline + 20261266000000 + 20261266100000 + 20261266200000 + 20261266300000.
-- Completion (cash earnings, 1E settles commission + fee), cancellation (1E releases),
-- no-show (finalize_job_no_show -> cancelled, 1E releases). Only the payment-eligibility and
-- cash-credit triggers stay enabled on jobs. Rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $d$ DECLARE t text; BEGIN
 FOR t IN SELECT tgname FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid WHERE c.relname='jobs' AND NOT tgisinternal
   AND tgname NOT IN ('trg_enforce_job_payment_eligibility','enforce_ride_cash_credit_v1e')
 LOOP EXECUTE format('ALTER TABLE public.jobs DISABLE TRIGGER %I', t); END LOOP; END $d$;
INSERT INTO public.tenants(id,name,slug) VALUES ('11111111-1111-4111-8111-111111111111','t','t');
INSERT INTO public.market_availability(country_code,launch_status,supported_currency) VALUES ('GB','live','GBP');
INSERT INTO public.service_types(id,slug,name) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddd01','ride','Ride');
INSERT INTO auth.users(id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_country_code,registration_activated_at) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','driver','GB','GB',now()),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111','driver','GB','GB',now()),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111','customer','GB','GB',NULL);
INSERT INTO public.driver_cash_credit_config_v1e VALUES ('ride_cash_credit',true);
INSERT INTO public.driver_cash_credit_markets_v1e(country_code,currency_code,enabled) VALUES ('GB','GBP',true);
INSERT INTO public.driver_cash_credit_enrolments_v1e(tenant_id,driver_id,country_code,currency_code,terms_version,consented_at,enabled)
 VALUES ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','GB','GBP','lifecycle-test',now()-interval '1 day',true);
DO $c$ DECLARE eid uuid:=gen_random_uuid(); acc uuid:=gen_random_uuid(); att uuid:=gen_random_uuid(); BEGIN
 INSERT INTO public.wallet_business_events(id,event_key,operation,payment_provider,merchant_account_ref,provider_reference,tenant_id,owner_id,currency_code,entries)
  VALUES (eid,'wallet-topup:'||att::text,'topup','stripe','stripe-platform','ref-life','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','GBP',
   jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit','amountMinor',10000),jsonb_build_object('accountPurpose','platform_funding','amountMinor',-10000)));
 INSERT INTO public.wallet_accounts(id,tenant_id,owner_id,currency_code,balance_purpose) VALUES (acc,'11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','GBP','driver_cash_credit');
 INSERT INTO public.wallet_movements(event_id,account_id,amount_minor,entry_seq) VALUES (eid,acc,10000,1);
 INSERT INTO public.wallet_topup_attempts(id,attempt_key,tenant_id,owner_id,country_code,currency_code,amount_minor,destination_account_purpose,payment_provider,merchant_account_ref,provider_idempotency_identity,provider_reference,status,credited_event_id)
  VALUES (att,'life','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','GB','GBP',10000,'driver_cash_credit','stripe','stripe-platform','idem-life','ref-life','credited',eid);
END $c$;
CREATE TEMP TABLE results(n int, name text, ok boolean, detail text);
CREATE FUNCTION pg_temp.bal() RETURNS jsonb LANGUAGE sql AS $f$ SELECT public.driver_cash_credit_balance_v1e('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','GBP') $f$;
-- An activated, accepted cash ride (as phases 1-2 produce it), fare GBP 11.00 (base 10.00, fee 1.00, commission 1.50).
CREATE FUNCTION pg_temp.accepted_cash_ride(ref text, noshow boolean DEFAULT false) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_job uuid:=gen_random_uuid(); BEGIN
 INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,service_type_id,payment_method,payment_status,country_code,currency_code,status,metadata,fare_breakdown,total_price,price)
 VALUES (v_job,'11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','a','b',now(),'dddddddd-dddd-4ddd-8ddd-dddddddddd01','cash','cash_due','GB','GBP','requested',
  '{"cash_collection_mode":"full_customer_charge","payment_choice":"cash"}',
  ('{"policyVersion":"fare-split-v1","currency":"GBP","platformFeeType":"percentage","driverBase":10.00,"customerCharge":11.00,"platformFeeAmount":1.00,"platformFeePercent":10,"platformFeeFixed":0,"driverCommissionAmount":1.50,"commissionPercent":15,"driverEntitlement":8.50'
   ||CASE WHEN noshow THEN ',"noShowPolicyVersion":"ride-no-show-v2","noShowFeeMinor":500' ELSE '' END||'}')::jsonb,11.00,11.00);
 INSERT INTO public.cash_ride_fee_holds_v1e(job_id,tenant_id,customer_id,provider,merchant_account_ref,provider_payment_reference,amount_minor,currency_code,fee_terms,status)
 VALUES (v_job,'11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','stripe','stripe-platform',ref,500,'GBP','{"version":"cash-fee-hold-v1"}','created');
 IF public.activate_cash_ride_v1e(v_job,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','stripe',ref,500,'GBP')<>'activated' THEN RAISE EXCEPTION 'activation failed'; END IF;
 UPDATE public.jobs SET driver_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', accepted_driver_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status='accepted' WHERE id=v_job;
 RETURN v_job; END $f$;
CREATE FUNCTION pg_temp.try_complete(j uuid, d uuid, meta jsonb DEFAULT '{"completion_pin_verified_at":"2026-11-12T00:00:00Z"}') RETURNS text LANGUAGE plpgsql AS $f$
BEGIN PERFORM public.complete_cash_ride_v1e(j,d,meta); RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE||' '||SQLERRM; END $f$;

-- 1. Completion.
DO $t$ DECLARE j uuid; r text; e record; h record; b jsonb; BEGIN
 j:=pg_temp.accepted_cash_ride('pi_life1');
 b:=pg_temp.bal(); INSERT INTO results VALUES (1,'after acceptance: 97.50 available, 2.50 reserved',b->>'availableMinor'='9750' AND b->>'heldMinor'='250',b::text);
 r:=pg_temp.try_complete(j,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 INSERT INTO results VALUES (1,'not in progress yet: refused',r LIKE '%not ready for completion%',r);
 UPDATE public.jobs SET status='in_progress' WHERE id=j;
 r:=pg_temp.try_complete(j,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
 INSERT INTO results VALUES (1,'another driver: refused',r LIKE '%Only the assigned driver%',r);
 r:=pg_temp.try_complete(j,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{}');
 INSERT INTO results VALUES (1,'no verified completion evidence: refused',r LIKE '%Verified completion evidence missing%',r);
 r:=pg_temp.try_complete(j,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 INSERT INTO results VALUES (1,'assigned driver completes',r='ok',r);
 INSERT INTO results VALUES (1,'job completed, cash_collected, GBP 11.00 collected in cash',(SELECT status='completed' AND payment_status='cash_collected' AND (metadata->>'cash_collected_minor')::int=1100 AND driver_payout=8.50 AND platform_fee=1.00 AND commission_fee=1.50 FROM public.jobs WHERE id=j),'');
 SELECT * INTO e FROM public.driver_earnings WHERE job_id=j;
 INSERT INTO results VALUES (1,'earnings: cash ride, paid, gross 11.00, fee 1.00, net 8.50, no transfer',e.settlement_purpose='cash_ride' AND e.status='paid' AND e.gross_amount=11.00 AND e.platform_fee=1.00 AND e.amount=8.50 AND e.stripe_transfer_id IS NULL,
   coalesce(e.settlement_purpose,'none')||' '||coalesce(e.amount::text,''));
 INSERT INTO results VALUES (1,'no payout queued',NOT EXISTS (SELECT 1 FROM public.job_payout_queue WHERE job_id=j),'');
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=j;
 b:=pg_temp.bal();
 INSERT INTO results VALUES (1,'1E settled the hold: 97.50 available, nothing reserved, consistent',h.status='settled' AND b->>'availableMinor'='9750' AND b->>'heldMinor'='0' AND (b->>'consistent')::boolean,h.status||' '||b::text);
 r:=pg_temp.try_complete(j,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 INSERT INTO results VALUES (1,'repeat completion is a no-op (one earnings row, balance unchanged)',r='ok' AND (SELECT count(*) FROM public.driver_earnings WHERE job_id=j)=1 AND pg_temp.bal()->>'availableMinor'='9750',r);
END $t$;
-- 2. Cancellation after acceptance: 1E releases the reservation.
DO $t$ DECLARE j uuid; b jsonb; BEGIN
 j:=pg_temp.accepted_cash_ride('pi_life2');
 INSERT INTO results VALUES (2,'accepted: 2.50 reserved',pg_temp.bal()->>'heldMinor'='250','');
 UPDATE public.jobs SET status='cancelled' WHERE id=j;
 b:=pg_temp.bal();
 INSERT INTO results VALUES (2,'cancelled: reservation released, 97.50 available',(SELECT status FROM public.driver_cash_credit_holds_v1e WHERE job_id=j)='released' AND b->>'heldMinor'='0' AND b->>'availableMinor'='9750',b::text);
 INSERT INTO results VALUES (2,'a cancelled cash ride cannot be completed',pg_temp.try_complete(j,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') LIKE '%not ready%','');
END $t$;
-- 3. No-show: finalize_job_no_show cancels; 1E releases.
DO $t$ DECLARE j uuid; r jsonb; b jsonb; BEGIN
 j:=pg_temp.accepted_cash_ride('pi_life3', true);
 UPDATE public.jobs SET status='arrived', no_show_grace_until=now()-interval '1 minute' WHERE id=j;
 PERFORM public.finalize_job_no_show(j,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,'customer did not arrive',true);
 b:=pg_temp.bal();
 INSERT INTO results VALUES (3,'no-show: job cancelled with no_show_status pending (fee then taken from the card hold by the server)',(SELECT status='cancelled' AND no_show_status='pending' FROM public.jobs WHERE id=j),'');
 INSERT INTO results VALUES (3,'no-show: reservation released, 97.50 available',b->>'heldMinor'='0' AND b->>'availableMinor'='9750',b::text);
END $t$;

SELECT n, name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, left(detail,80) AS detail FROM results ORDER BY n, name;
SELECT count(*) FILTER (WHERE NOT ok) AS failures, count(*) AS checks FROM results;
ROLLBACK;
