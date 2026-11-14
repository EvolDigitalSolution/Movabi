-- After activate-gb-cash.sql for ONE GB driver (gb-driver@act.test): only that driver can take cash rides;
-- no other driver or market is enabled OR blocked; and turning cash off preserves in-flight obligations.
-- Only trg_enforce_job_payment_eligibility and enforce_ride_cash_credit_v1e stay enabled on jobs (the
-- driver-approval triggers need full onboarding fixtures and have their own suites). Rolled back.
-- Last line: "<failures> | <passed>/<total>".
\set ON_ERROR_STOP on
BEGIN;
DO $d$ DECLARE t text; BEGIN
 FOR t IN SELECT tgname FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid WHERE c.relname='jobs' AND NOT tgisinternal
   AND tgname NOT IN ('trg_enforce_job_payment_eligibility','enforce_ride_cash_credit_v1e')
 LOOP EXECUTE format('ALTER TABLE public.jobs DISABLE TRIGGER %I', t); END LOOP; END $d$;
CREATE TEMP TABLE results(n int, name text, ok boolean, detail text);
CREATE TEMP TABLE ng_on(result text);
CREATE TEMP TABLE ids AS SELECT
 '6b000000-0000-4000-8000-0000000000aa'::uuid AS gb, '6b000000-0000-4000-8000-0000000000bb'::uuid AS ng,
 '6d000000-0000-4000-8000-0000000000d1'::uuid AS d1, '6d000000-0000-4000-8000-0000000000d2'::uuid AS d2, '6e000000-0000-4000-8000-0000000000e2'::uuid AS dng,
 '6c000000-0000-4000-8000-0000000000c1'::uuid AS c1, '6e000000-0000-4000-8000-0000000000e1'::uuid AS cng,
 (SELECT id FROM public.service_types WHERE slug='ride' LIMIT 1) AS ride;

-- GBP 100.00 of cash-ride credit for BOTH GB drivers (same shape as a real top-up), so that enrolment
-- is the only difference between the selected driver and the other one.
CREATE FUNCTION pg_temp.fund(p_driver uuid) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE eid uuid:=gen_random_uuid(); acc uuid:=gen_random_uuid(); att uuid:=gen_random_uuid(); t uuid:=(SELECT gb FROM ids); BEGIN
 INSERT INTO public.wallet_business_events(id,event_key,operation,payment_provider,merchant_account_ref,provider_reference,tenant_id,owner_id,currency_code,entries)
  VALUES (eid,'wallet-topup:'||att::text,'topup','stripe','stripe-platform','ref-'||att::text,t,p_driver,'GBP',
   jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit','amountMinor',10000),jsonb_build_object('accountPurpose','platform_funding','amountMinor',-10000)));
 INSERT INTO public.wallet_accounts(id,tenant_id,owner_id,currency_code,balance_purpose) VALUES (acc,t,p_driver,'GBP','driver_cash_credit');
 INSERT INTO public.wallet_movements(event_id,account_id,amount_minor,entry_seq) VALUES (eid,acc,10000,1);
 INSERT INTO public.wallet_topup_attempts(id,attempt_key,tenant_id,owner_id,country_code,currency_code,amount_minor,destination_account_purpose,payment_provider,merchant_account_ref,provider_idempotency_identity,provider_reference,status,credited_event_id)
  VALUES (att,'act-'||att::text,t,p_driver,'GB','GBP',10000,'driver_cash_credit','stripe','stripe-platform','idem-'||att::text,'ref-'||att::text,'credited',eid);
END $f$;
SELECT pg_temp.fund((SELECT d1 FROM ids)), pg_temp.fund((SELECT d2 FROM ids));
CREATE FUNCTION pg_temp.bal(p_driver uuid) RETURNS jsonb LANGUAGE sql AS $f$ SELECT public.driver_cash_credit_balance_v1e((SELECT gb FROM ids),p_driver,'GBP') $f$;

-- An activated GB cash ride exactly as the booking route + activation produce it (GBP 11.00, hold 500).
CREATE FUNCTION pg_temp.cash_ride(ref text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v uuid:=gen_random_uuid(); BEGIN
 INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,service_type_id,payment_method,payment_status,country_code,currency_code,status,metadata,fare_breakdown,total_price,price)
 VALUES (v,(SELECT gb FROM ids),(SELECT c1 FROM ids),'a','b',now(),(SELECT ride FROM ids),'cash','cash_due','GB','GBP','requested',
  '{"cash_collection_mode":"full_customer_charge","payment_choice":"cash"}',
  '{"policyVersion":"fare-split-v1","currency":"GBP","platformFeeType":"percentage","driverBase":10.00,"customerCharge":11.00,"platformFeeAmount":1.00,"platformFeePercent":10,"platformFeeFixed":0,"driverCommissionAmount":1.50,"commissionPercent":15,"driverEntitlement":8.50}',11.00,11.00);
 INSERT INTO public.cash_ride_fee_holds_v1e(job_id,tenant_id,customer_id,provider,merchant_account_ref,provider_payment_reference,amount_minor,currency_code,fee_terms,status)
 VALUES (v,(SELECT gb FROM ids),(SELECT c1 FROM ids),'stripe','stripe-platform',ref,500,'GBP','{"version":"cash-fee-hold-v1"}','created');
 IF public.activate_cash_ride_v1e(v,(SELECT c1 FROM ids),'stripe',ref,500,'GBP')<>'activated' THEN RAISE EXCEPTION 'activation failed for %', ref; END IF;
 RETURN v; END $f$;
CREATE FUNCTION pg_temp.card_ride(p_tenant uuid, p_customer uuid, p_country text, p_ccy text, pi text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v uuid:=gen_random_uuid(); BEGIN
 INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,service_type_id,payment_method,payment_status,country_code,currency_code,status,metadata,payment_intent_id,total_price,price)
 VALUES (v,p_tenant,p_customer,'a','b',now(),(SELECT ride FROM ids),'card','paid',p_country,p_ccy,'searching','{}',pi,11.00,11.00);
 RETURN v; END $f$;
-- Tries an acceptance; returns 'ok' or the SQLSTATE. keep=false frees the driver again.
CREATE FUNCTION pg_temp.accept(j uuid, d uuid, keep boolean DEFAULT false) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN UPDATE public.jobs SET driver_id=d, accepted_driver_id=d, status='accepted' WHERE id=j;
 IF NOT keep THEN UPDATE public.jobs SET status='cancelled' WHERE id=j; END IF;
 RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $f$;

-- 1. What the activation switched on: exactly one enrolment, GB/GBP only.
INSERT INTO results SELECT 1,'exactly one enrolment: the selected driver, GB/GBP, terms fare-split-v1',
  count(*)=1 AND bool_and(driver_id=(SELECT d1 FROM ids) AND country_code='GB' AND currency_code='GBP' AND terms_version='fare-split-v1' AND enabled),count(*)::text
  FROM public.driver_cash_credit_enrolments_v1e;
INSERT INTO results SELECT 1,'cash market enabled for GB/GBP only',
  (SELECT string_agg(country_code||'/'||currency_code,',') FROM public.driver_cash_credit_markets_v1e WHERE enabled)='GB/GBP'
  AND NOT public.driver_cash_credit_market_enabled_v1e('NG','NGN'),NULL;
INSERT INTO results SELECT 1,'driver status: selected driver enrolled; the other GB driver and the NG driver are not',
  (public.driver_cash_credit_status_v1f((SELECT d1 FROM ids))->>'enrolled')::boolean
  AND NOT (public.driver_cash_credit_status_v1f((SELECT d2 FROM ids))->>'enrolled')::boolean
  AND NOT coalesce((public.driver_cash_credit_status_v1f((SELECT dng FROM ids))->>'enrolled')::boolean,false)
  AND NOT coalesce((public.driver_cash_credit_status_v1f((SELECT dng FROM ids))->>'pilotEnabled')::boolean,false),
  public.driver_cash_credit_status_v1f((SELECT dng FROM ids))::text;

-- 2. Only the selected driver can take a cash ride; nobody else is blocked from card work.
DO $t$ DECLARE r text; j uuid; i record; BEGIN
 SELECT * INTO i FROM ids;
 j:=pg_temp.cash_ride('pi_other'); r:=pg_temp.accept(j,i.d2);
 INSERT INTO results VALUES (2,'the other GB driver (funded, not enrolled) cannot take a cash ride (CE002)',r='CE002',r);
 INSERT INTO results VALUES (2,'the refused driver was charged nothing: 100.00 available, nothing reserved',pg_temp.bal(i.d2)->>'availableMinor'='10000' AND pg_temp.bal(i.d2)->>'heldMinor'='0',pg_temp.bal(i.d2)::text);
 r:=pg_temp.accept(pg_temp.card_ride(i.gb,i.c1,'GB','GBP','pi_card_d2'),i.d2);
 INSERT INTO results VALUES (2,'the other GB driver still takes card rides (not blocked)',r='ok',r);
 r:=pg_temp.accept(pg_temp.card_ride(i.gb,i.c1,'GB','GBP','pi_card_d1'),i.d1);
 INSERT INTO results VALUES (2,'the selected driver still takes card rides',r='ok',r);
 r:=pg_temp.accept(pg_temp.card_ride(i.ng,i.cng,'NG','NGN','pi_card_ng'),i.dng);
 INSERT INTO ng_on VALUES (r);
 INSERT INTO results VALUES (2,'the NG driver takes NG card rides (not blocked by GB cash)',r='ok',r);
 r:=pg_temp.accept(j,i.d1,true);
 INSERT INTO results VALUES (2,'the selected driver takes the cash ride',r='ok',r);
 INSERT INTO results VALUES (2,'commission + fee reserved from the selected driver''s credit: 97.50 available, 2.50 reserved',
   pg_temp.bal(i.d1)->>'availableMinor'='9750' AND pg_temp.bal(i.d1)->>'heldMinor'='250' AND (pg_temp.bal(i.d1)->>'consistent')::boolean,pg_temp.bal(i.d1)::text);
END $t$;
-- 3. Deactivation (the statement deactivate-gb-cash.sql runs) with a cash ride in flight: obligations hold.
DO $t$ DECLARE i record; j uuid; r text; h record; BEGIN SELECT * INTO i FROM ids;
 SELECT id INTO j FROM public.jobs WHERE driver_id=i.d1 AND payment_method='cash' AND status='accepted';
 UPDATE public.jobs SET status='in_progress' WHERE id=j;
 UPDATE public.driver_cash_credit_markets_v1e SET enabled=false, updated_at=now() WHERE country_code='GB' AND currency_code='GBP';
 BEGIN PERFORM public.complete_cash_ride_v1e(j,i.d1,'{"completion_pin_verified_at":"2026-11-14T00:00:00Z"}'); r:='ok'; EXCEPTION WHEN OTHERS THEN r:=SQLSTATE||' '||SQLERRM; END;
 INSERT INTO results VALUES (3,'cash ride accepted before deactivation still completes afterwards',r='ok',r);
 INSERT INTO results VALUES (3,'completed: cash_collected 11.00, driver earnings recorded (net 8.50, cash ride, no transfer)',
   (SELECT status='completed' AND payment_status='cash_collected' FROM public.jobs WHERE id=j)
   AND (SELECT settlement_purpose='cash_ride' AND amount=8.50 AND stripe_transfer_id IS NULL FROM public.driver_earnings WHERE job_id=j),NULL);
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=j;
 INSERT INTO results VALUES (3,'the reservation is settled exactly once: 97.50 available, nothing reserved, consistent',
   h.status='settled' AND pg_temp.bal(i.d1)->>'availableMinor'='9750' AND pg_temp.bal(i.d1)->>'heldMinor'='0' AND (pg_temp.bal(i.d1)->>'consistent')::boolean,h.status||' '||pg_temp.bal(i.d1)::text);
 -- A second ride accepted while on, then cancelled after the market is turned off: the reservation is released.
 UPDATE public.driver_cash_credit_markets_v1e SET enabled=true WHERE country_code='GB';
 j:=pg_temp.cash_ride('pi_second'); r:=pg_temp.accept(j,i.d1,true);
 UPDATE public.driver_cash_credit_markets_v1e SET enabled=false WHERE country_code='GB';
 UPDATE public.jobs SET status='cancelled' WHERE id=j;
 INSERT INTO results VALUES (3,'cash ride cancelled after deactivation: reservation released in full (97.50 available, 0 reserved)',
   r='ok' AND (SELECT status FROM public.driver_cash_credit_holds_v1e WHERE job_id=j)='released' AND pg_temp.bal(i.d1)->>'availableMinor'='9750' AND pg_temp.bal(i.d1)->>'heldMinor'='0',pg_temp.bal(i.d1)::text);
 INSERT INTO results VALUES (3,'the customer''s card fee hold row is kept for the server to release or capture',(SELECT count(*) FROM public.cash_ride_fee_holds_v1e WHERE job_id=j)=1,NULL);
 -- New cash business is refused while off; enrolment and credit are kept.
 BEGIN j:=pg_temp.cash_ride('pi_new'); r:='activated'; EXCEPTION WHEN OTHERS THEN r:=SQLERRM; END;
 INSERT INTO results VALUES (3,'new cash ride after deactivation: cannot be activated',r LIKE 'activation failed%',r);
 INSERT INTO results VALUES (3,'enrolment and remaining credit are kept (97.50)',
   (SELECT count(*) FROM public.driver_cash_credit_enrolments_v1e WHERE driver_id=i.d1 AND enabled)=1 AND pg_temp.bal(i.d1)->>'availableMinor'='9750',NULL);
 -- With cash OFF, card acceptance by the other GB driver and the NG driver is the same as it was with cash ON.
 r:=pg_temp.accept(pg_temp.card_ride(i.gb,i.c1,'GB','GBP','pi_off_d2'),i.d2);
 INSERT INTO results VALUES (4,'card rides with cash OFF: other GB driver ok (same as with cash ON)',r='ok',r);
 r:=pg_temp.accept(pg_temp.card_ride(i.ng,i.cng,'NG','NGN','pi_off_ng'),i.dng);
 INSERT INTO results VALUES (4,'card rides with cash OFF: NG driver result equals the result with cash ON',r=(SELECT result FROM ng_on),r);
END $t$;

SELECT n, CASE WHEN ok THEN 'ok' ELSE 'FAIL' END, name, coalesce(detail,'') FROM results ORDER BY n;
SELECT count(*) FILTER (WHERE NOT ok) || ' | ' || count(*) FILTER (WHERE ok) || '/' || count(*) FROM results;
ROLLBACK;
