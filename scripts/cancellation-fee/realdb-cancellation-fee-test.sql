-- Real-Postgres test: cancellation_fee_quote, frozen quote in cancel_job_with_actor, policy enablement.
-- Disposable database only: deployed baseline + 20261101000000 + 20261104000000 + 20261267000000 +
-- 20261268000000. One transaction, rolled back. Setup inserts use session_replication_role=replica
-- (skips triggers without changing their state); quotes and cancellations run with deployed triggers.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE results(n int, name text, ok boolean, detail text);
INSERT INTO public.tenants(id,name,slug) VALUES ('11111111-1111-4111-8111-111111111111','f','f'),('22222222-2222-4222-8222-222222222222','o','o');
INSERT INTO public.market_availability(country_code,launch_status,supported_currency) VALUES ('GB','live','GBP'),('JP','live','JPY'),('KW','live','KWD')
 ON CONFLICT DO NOTHING;
INSERT INTO auth.users(id) VALUES ('c0000000-0000-4000-8000-00000000000c'),('d0000000-0000-4000-8000-00000000000d'),('a0000000-0000-4000-8000-00000000000a');
INSERT INTO public.profiles(id,tenant_id,role,country_code) VALUES
 ('c0000000-0000-4000-8000-00000000000c','11111111-1111-4111-8111-111111111111','customer','GB'),
 ('d0000000-0000-4000-8000-00000000000d','11111111-1111-4111-8111-111111111111','driver','GB'),
 ('a0000000-0000-4000-8000-00000000000a','11111111-1111-4111-8111-111111111111','admin','GB');
-- A booking: market/currency, fare (major units), driver, minutes since the driver accepted (NULL = never).
CREATE FUNCTION pg_temp.job(p_id uuid, p_country text, p_currency text, p_fare numeric, p_driver uuid, p_accepted_mins_ago int,
                            p_status text DEFAULT 'assigned', p_assign boolean DEFAULT true) RETURNS uuid LANGUAGE plpgsql AS $f$
BEGIN
 SET LOCAL session_replication_role = replica;
 INSERT INTO public.jobs(id,tenant_id,customer_id,driver_id,accepted_driver_id,pickup_address,dropoff_address,scheduled_time,payment_method,payment_status,
                         country_code,currency_code,status,price,total_price,accepted_at)
 VALUES (p_id,'11111111-1111-4111-8111-111111111111','c0000000-0000-4000-8000-00000000000c',CASE WHEN p_assign THEN p_driver END,p_driver,'a','b',now(),'card','authorized',
         p_country,p_currency,p_status,p_fare,p_fare,CASE WHEN p_accepted_mins_ago IS NULL THEN NULL ELSE now()-make_interval(mins=>p_accepted_mins_ago) END);
 SET LOCAL session_replication_role = origin;
 RETURN p_id;
END $f$;
-- What publish_cancellation_policy inserts (a new version, enabled = false).
CREATE FUNCTION pg_temp.publish(p_tenant uuid, p_market text, p_fee bigint, p_cap bigint, p_grace int) RETURNS uuid LANGUAGE sql AS $f$
 INSERT INTO public.cancellation_policies(tenant_id,market_code,version,enabled,grace_seconds,fee_minor,fee_cap_minor,driver_compensation_percent)
 VALUES (p_tenant,p_market,(SELECT coalesce(max(version),0)+1 FROM public.cancellation_policies WHERE tenant_id=p_tenant AND market_code=p_market),
         false,p_grace,p_fee,p_cap,80) RETURNING id $f$;
CREATE FUNCTION pg_temp.q(p_job uuid, p_role text DEFAULT 'customer') RETURNS jsonb LANGUAGE sql AS $f$ SELECT public.cancellation_fee_quote(p_job,p_role) $f$;
\set D '''d0000000-0000-4000-8000-00000000000d'''
\set T '''11111111-1111-4111-8111-111111111111'''

-- 1. No policy, then a published-but-not-enabled version: still no fee (the old "never active" state).
SELECT pg_temp.job('00000000-0000-4000-8000-000000000001','GB','GBP',20.00,:D,30);
INSERT INTO results SELECT 1,'no policy: not due (no_active_policy)',q->>'reasonCode'='no_active_policy' AND NOT (q->>'due')::boolean,q::text FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000001') q) s;
SELECT pg_temp.publish(:T,'GB',500,400,300) AS gb_v1 \gset
INSERT INTO results SELECT 1,'published, not enabled: still not due',q->>'reasonCode'='no_active_policy',q->>'reasonCode' FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000001') q) s;
DO $t$ DECLARE r text; BEGIN
 BEGIN PERFORM public.set_cancellation_policy_enabled((SELECT id FROM public.cancellation_policies WHERE market_code='GB' AND version=1),'22222222-2222-4222-8222-222222222222',true); r:='none';
 EXCEPTION WHEN OTHERS THEN r:=SQLSTATE; END;
 INSERT INTO results VALUES (1,'enabling with another tenant is refused (P0002), nothing changes',
   r='P0002' AND NOT (SELECT enabled FROM public.cancellation_policies WHERE market_code='GB' AND version=1),r);
END $t$;
SELECT public.set_cancellation_policy_enabled(:'gb_v1',:T,true) IS NOT NULL AS enabled_ok \gset
INSERT INTO results SELECT 1,'enabled for its tenant: after grace the fee is due',(q->>'due')::boolean AND q->>'reasonCode'='due',q::text FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000001') q) s;
INSERT INTO results SELECT 1,'amount = least(fee 500, cap 400) = 400 GBP minor, version 1, exponent 2',
  (q->>'feeMinor')::int=400 AND (q->>'policyVersion')::int=1 AND (q->>'exponent')::int=2 AND q->>'currency'='GBP',q::text FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000001') q) s;

-- 2. Who cancels, driver, acceptance, grace.
INSERT INTO results SELECT 2,'driver cancelling never charges the customer (not_customer)',q->>'reasonCode'='not_customer' AND (q->>'feeMinor')::int=0,q->>'reasonCode' FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000001','driver') q) s;
INSERT INTO results SELECT 2,'admin cancelling never charges the customer (not_customer)',q->>'reasonCode'='not_customer',q->>'reasonCode' FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000001','admin') q) s;
SELECT pg_temp.job('00000000-0000-4000-8000-000000000002','GB','GBP',20.00,NULL,NULL,'searching');
INSERT INTO results SELECT 2,'no driver assigned: not due (no_driver)',q->>'reasonCode'='no_driver',q->>'reasonCode' FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000002') q) s;
SELECT pg_temp.job('00000000-0000-4000-8000-000000000003','GB','GBP',20.00,'d0000000-0000-4000-8000-00000000000d',NULL,'searching');
INSERT INTO results SELECT 2,'driver but no acceptance time: not due (no_acceptance_time)',q->>'reasonCode'='no_acceptance_time',q->>'reasonCode' FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000003') q) s;
SELECT pg_temp.job('00000000-0000-4000-8000-000000000004','GB','GBP',20.00,'d0000000-0000-4000-8000-00000000000d',1,'searching',false);
INSERT INTO results SELECT 2,'accepted 1 min ago, grace 300 s: within_grace, graceUntil = accepted + 300 s',
  q->>'reasonCode'='within_grace' AND (q->>'graceUntil')::timestamptz=(SELECT accepted_at+interval '300 seconds' FROM public.jobs WHERE id='00000000-0000-4000-8000-000000000004'),q::text
  FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000004') q) s;

-- 3. Fare cap and currencies (0, 2, 3 decimals); currency mismatch fails closed.
SELECT pg_temp.job('00000000-0000-4000-8000-000000000005','GB','GBP',3.00,'d0000000-0000-4000-8000-00000000000d',30,'searching',false);
INSERT INTO results SELECT 3,'fee never exceeds the fare (GBP 3.00 -> 300)',(q->>'feeMinor')::int=300,q->>'feeMinor' FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000005') q) s;
SELECT public.set_cancellation_policy_enabled(pg_temp.publish(:T,'JP',500,NULL,60),:T,true) IS NOT NULL AS jp \gset
SELECT public.set_cancellation_policy_enabled(pg_temp.publish(:T,'KW',1500,NULL,60),:T,true) IS NOT NULL AS kw \gset
SELECT pg_temp.job('00000000-0000-4000-8000-000000000006','JP','JPY',1200,'d0000000-0000-4000-8000-00000000000d',30,'searching',false);
INSERT INTO results SELECT 3,'JPY (0 decimals): 500 yen due, exponent 0',(q->>'feeMinor')::int=500 AND (q->>'exponent')::int=0,q::text FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000006') q) s;
SELECT pg_temp.job('00000000-0000-4000-8000-000000000007','KW','KWD',1.000,'d0000000-0000-4000-8000-00000000000d',30,'searching',false);
INSERT INTO results SELECT 3,'KWD (3 decimals): fee 1500 capped by fare 1.000 -> 1000, exponent 3',(q->>'feeMinor')::int=1000 AND (q->>'exponent')::int=3,q::text FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000007') q) s;
SELECT pg_temp.job('00000000-0000-4000-8000-000000000008','GB','USD',20.00,'d0000000-0000-4000-8000-00000000000d',30,'searching',false);
INSERT INTO results SELECT 3,'booking currency differs from the market currency: no fee (currency_mismatch)',q->>'reasonCode'='currency_mismatch' AND NOT (q->>'due')::boolean,q->>'reasonCode' FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000008') q) s;

-- 4. Versions: highest enabled wins; disabling falls back; disabling all turns fees off.
SELECT pg_temp.publish(:T,'GB',350,NULL,300) AS gb_v2 \gset
INSERT INTO results SELECT 4,'v2 published but disabled: v1 still applies',(q->>'policyVersion')::int=1,q->>'policyVersion' FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000001') q) s;
SELECT public.set_cancellation_policy_enabled(:'gb_v2',:T,true) IS NOT NULL AS v2on \gset
INSERT INTO results SELECT 4,'v2 enabled: v2 applies (350)',(q->>'policyVersion')::int=2 AND (q->>'feeMinor')::int=350,q::text FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000001') q) s;

-- 5. Frozen at cancellation (same transaction), never re-priced, never overwritten by a retry.
INSERT INTO results SELECT 5,'customer cancels after grace',public.cancel_job_with_actor('00000000-0000-4000-8000-000000000001','changed plans','c0000000-0000-4000-8000-00000000000c','customer'),'';
INSERT INTO results SELECT 5,'frozen quote: due, 350, v2, with the cancellation',
  (metadata->'cancellation_fee_quote'->>'due')::boolean AND (metadata->'cancellation_fee_quote'->>'feeMinor')::int=350 AND (metadata->'cancellation_fee_quote'->>'policyVersion')::int=2
  AND status='cancelled' AND metadata->>'cancelled_by_role'='customer',metadata->>'cancellation_fee_quote' FROM public.jobs WHERE id='00000000-0000-4000-8000-000000000001';
SELECT public.set_cancellation_policy_enabled(:'gb_v2',:T,false) IS NOT NULL AS v2off \gset
SELECT public.set_cancellation_policy_enabled(:'gb_v1',:T,false) IS NOT NULL AS v1off \gset
SELECT public.cancel_job_with_actor('00000000-0000-4000-8000-000000000001','retry','c0000000-0000-4000-8000-00000000000c','customer');
INSERT INTO results SELECT 5,'policy disabled + retry afterwards: frozen quote unchanged',(metadata->'cancellation_fee_quote'->>'feeMinor')::int=350,metadata->'cancellation_fee_quote'->>'feeMinor' FROM public.jobs WHERE id='00000000-0000-4000-8000-000000000001';
INSERT INTO results SELECT 4,'all GB versions disabled: fees off (no_active_policy)',q->>'reasonCode'='no_active_policy',q->>'reasonCode' FROM (SELECT pg_temp.q('00000000-0000-4000-8000-000000000005') q) s;
SELECT public.set_cancellation_policy_enabled(:'gb_v1',:T,true) IS NOT NULL AS v1on \gset
SELECT pg_temp.job('00000000-0000-4000-8000-000000000009','GB','GBP',20.00,:D,30);
SELECT public.cancel_job_with_actor('00000000-0000-4000-8000-000000000009','cannot make it',:D,'driver');
INSERT INTO results SELECT 5,'driver cancels after grace: frozen quote not due (not_customer)',
  NOT (metadata->'cancellation_fee_quote'->>'due')::boolean AND metadata->'cancellation_fee_quote'->>'reasonCode'='not_customer',metadata->>'cancellation_fee_quote' FROM public.jobs WHERE id='00000000-0000-4000-8000-000000000009';

-- 6. Privileges.
INSERT INTO results SELECT 6,'cancellation_fee_quote and set_cancellation_policy_enabled: service_role only',
  has_function_privilege('service_role','public.cancellation_fee_quote(uuid,text,timestamptz)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.cancellation_fee_quote(uuid,text,timestamptz)','EXECUTE')
  AND NOT has_function_privilege('anon','public.cancellation_fee_quote(uuid,text,timestamptz)','EXECUTE')
  AND has_function_privilege('service_role','public.set_cancellation_policy_enabled(uuid,uuid,boolean)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.set_cancellation_policy_enabled(uuid,uuid,boolean)','EXECUTE')
  AND NOT has_function_privilege('anon','public.set_cancellation_policy_enabled(uuid,uuid,boolean)','EXECUTE'),'';

SELECT n, name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, left(coalesce(detail,''),90) AS detail FROM results ORDER BY n, name;
SELECT count(*) FILTER (WHERE NOT ok) AS failures, count(*) AS checks FROM results;
ROLLBACK;
