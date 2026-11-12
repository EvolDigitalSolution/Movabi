-- Real-Postgres behaviour test for 20261266000000_driver_cash_credit_market_pilot.
-- Run ONLY against a disposable database loaded with supabase/baseline/deployed_public_schema.sql
-- plus the migration. Everything runs in one transaction that is rolled back at the end.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.tenants(id,name,slug) VALUES ('11111111-1111-4111-8111-111111111111','Pilot test','pilot-test');
INSERT INTO public.market_availability(country_code,launch_status,supported_currency) VALUES ('GB','live','GBP'),('NG','live','NGN');
INSERT INTO auth.users(id,email) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','gb@x.test'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','ng@x.test'),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','cust@x.test');
INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_country_code,registration_activated_at)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','driver','GB','GB',now()),
       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111','driver','NG','NG',now());

CREATE TEMP TABLE results(step int, check_name text, ok boolean, detail text);
CREATE FUNCTION pg_temp.st(d uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT (public.driver_cash_credit_status_v1f(d)->>'pilotEnabled')::boolean $$;
CREATE FUNCTION pg_temp.rec(n int, name text, ok boolean, detail text) RETURNS void LANGUAGE sql AS $$ INSERT INTO results VALUES (n,name,ok,detail) $$;

-- 1. Nothing enabled: both markets off.
SELECT pg_temp.rec(1,'all off: GB driver pilot off',NOT pg_temp.st('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),'');
SELECT pg_temp.rec(1,'all off: NG driver pilot off',NOT pg_temp.st('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),'');
-- 2. Global switch on, no market rows: still off everywhere (before the migration this was ON for every market).
INSERT INTO public.driver_cash_credit_config_v1e(key,enabled) VALUES ('ride_cash_credit',true);
SELECT pg_temp.rec(2,'global on, no market: GB off',NOT pg_temp.st('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),'');
SELECT pg_temp.rec(2,'global on, no market: NG off',NOT pg_temp.st('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),'');
-- 3. GB/GBP enabled: GB on, NG still off.
INSERT INTO public.driver_cash_credit_markets_v1e(country_code,currency_code,enabled,note) VALUES ('GB','GBP',true,'develop test');
SELECT pg_temp.rec(3,'GB market on: GB driver on',pg_temp.st('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),'');
SELECT pg_temp.rec(3,'GB market on: NG driver off',NOT pg_temp.st('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),'');
SELECT pg_temp.rec(3,'market check GB/GBP true',public.driver_cash_credit_market_enabled_v1e('GB','GBP'),'');
SELECT pg_temp.rec(3,'market check GB/EUR false (currency must match)',NOT public.driver_cash_credit_market_enabled_v1e('GB','EUR'),'');
SELECT pg_temp.rec(3,'market check NULL false',NOT coalesce(public.driver_cash_credit_market_enabled_v1e(NULL,NULL),false),'');
-- 4. A market row whose currency does not match market_availability is never enabled.
INSERT INTO public.driver_cash_credit_markets_v1e(country_code,currency_code,enabled) VALUES ('NG','USD',true);
SELECT pg_temp.rec(4,'NG/USD row ignored (NG is NGN)',NOT public.driver_cash_credit_market_enabled_v1e('NG','USD') AND NOT pg_temp.st('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),'');
-- 5. Global kill switch still overrides every market.
UPDATE public.driver_cash_credit_config_v1e SET enabled=false WHERE key='ride_cash_credit';
SELECT pg_temp.rec(5,'kill switch off: GB off',NOT pg_temp.st('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') AND NOT public.driver_cash_credit_market_enabled_v1e('GB','GBP'),'');
UPDATE public.driver_cash_credit_config_v1e SET enabled=true WHERE key='ride_cash_credit';

-- 6. reserve_cash_job_credit_v1e on real job rows: NG job stops at the MARKET gate (CE001),
--    GB job passes it and stops at the next existing gate (no enrolment / no cash custody).
INSERT INTO public.service_types(id,slug,name) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','ride','Ride') ON CONFLICT DO NOTHING;
SELECT id AS ride FROM public.service_types WHERE slug='ride' LIMIT 1 \gset
DO $t$
DECLARE ng uuid:=gen_random_uuid(); gb uuid:=gen_random_uuid(); st text; msg text;
BEGIN
 SET LOCAL session_replication_role=replica;  -- insert fixtures without unrelated job triggers
 INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,service_type_id,payment_method,country_code,currency_code,status,driver_id)
 VALUES (ng,'11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','a','b',now(),(SELECT id FROM public.service_types WHERE slug='ride' LIMIT 1),'cash','NG','NGN','assigned','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
        (gb,'11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','a','b',now(),(SELECT id FROM public.service_types WHERE slug='ride' LIMIT 1),'cash','GB','GBP','assigned','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 SET LOCAL session_replication_role=origin;
 BEGIN PERFORM public.reserve_cash_job_credit_v1e(ng,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'); st:='none'; msg:='';
 EXCEPTION WHEN OTHERS THEN st:=SQLSTATE; msg:=SQLERRM; END;
 PERFORM pg_temp.rec(6,'NG job: reserve stops at market gate (CE001)',st='CE001' AND msg LIKE '%this market%',st||' '||msg);
 BEGIN PERFORM public.reserve_cash_job_credit_v1e(gb,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); st:='none'; msg:='';
 EXCEPTION WHEN OTHERS THEN st:=SQLSTATE; msg:=SQLERRM; END;
 PERFORM pg_temp.rec(6,'GB job: passes market gate, then existing gates apply (not CE001)',st<>'CE001' AND st<>'none',st||' '||msg);
 -- 7. The jobs trigger on a real UPDATE: an NG cash ride is left alone while GB is the pilot market.
 BEGIN UPDATE public.jobs SET status='accepted' WHERE id=ng; st:='none'; msg:='';
 EXCEPTION WHEN OTHERS THEN st:=SQLSTATE; msg:=SQLERRM; END;
 PERFORM pg_temp.rec(7,'NG cash ride update: no cash-credit error (CE00x)',st NOT LIKE 'CE00_',st||' '||msg);
 BEGIN UPDATE public.jobs SET status='accepted' WHERE id=gb; st:='none'; msg:='';
 EXCEPTION WHEN OTHERS THEN st:=SQLSTATE; msg:=SQLERRM; END;
 PERFORM pg_temp.rec(7,'GB cash ride update: cash-credit enforcement runs (CE00x)',st LIKE 'CE00_',st||' '||msg);
END $t$;

SELECT step, check_name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, detail FROM results ORDER BY step, check_name;
SELECT count(*) FILTER (WHERE NOT ok) AS failures, count(*) AS checks FROM results;
ROLLBACK;
