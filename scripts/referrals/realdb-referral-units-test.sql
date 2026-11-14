-- Real-Postgres test: referral rewards in minor units, caps, qualifying fare, market isolation (7b, 20261270200000).
-- Disposable database only: develop's live schema + release 1 + release 2. One transaction, rolled back.
-- Fixture rows use session_replication_role=replica; earn_referral runs as in production.
-- Last line: "<failures> | <passed>/<total>".
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE results(n int, name text, ok boolean, detail text);
SET LOCAL session_replication_role = replica;
INSERT INTO public.tenants(id,name,slug) VALUES ('11111111-1111-4111-8111-1111111111aa','r','ref-t');
INSERT INTO auth.users(id) VALUES ('a1000000-0000-4000-8000-0000000000a1'),('b1000000-0000-4000-8000-0000000000b1'),('b2000000-0000-4000-8000-0000000000b2'),('d1000000-0000-4000-8000-0000000000e1'),('d2000000-0000-4000-8000-0000000000e2');
INSERT INTO public.profiles(id,tenant_id,role,country_code) VALUES
 ('a1000000-0000-4000-8000-0000000000a1','11111111-1111-4111-8111-1111111111aa','customer','GB'),
 ('b1000000-0000-4000-8000-0000000000b1','11111111-1111-4111-8111-1111111111aa','customer','GB'),
 ('b2000000-0000-4000-8000-0000000000b2','11111111-1111-4111-8111-1111111111aa','customer','GB'),
 ('d1000000-0000-4000-8000-0000000000e1','11111111-1111-4111-8111-1111111111aa','driver','GB'),
 ('d2000000-0000-4000-8000-0000000000e2','11111111-1111-4111-8111-1111111111aa','driver','GB');
INSERT INTO public.campaigns(id,tenant_id,code,kind,market_code,currency_code,service_slug,enabled,budget_minor,referral_reward_bps,qualification)
 VALUES ('ca000000-0000-4000-8000-0000000000c1','11111111-1111-4111-8111-1111111111aa','REFGB','referral','GB','GBP','ride',true,50000,500,'{}');
-- Terms as the redeem route snapshots them (P5: cap 500, qualifying fare 800; driver: 20 jobs in 30 days, 7-day review).
INSERT INTO public.referrals(id,tenant_id,campaign_id,referrer_id,referee_id,status,referral_kind,reward_rate_bps,reward_cap_minor,qualifying_fare_minor) VALUES
 ('fe000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-1111111111aa','ca000000-0000-4000-8000-0000000000c1','a1000000-0000-4000-8000-0000000000a1','b1000000-0000-4000-8000-0000000000b1','pending','customer',500,500,800),
 ('fe000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-1111111111aa','ca000000-0000-4000-8000-0000000000c1','a1000000-0000-4000-8000-0000000000a1','b2000000-0000-4000-8000-0000000000b2','pending','customer',500,500,800);
INSERT INTO public.referrals(id,tenant_id,campaign_id,referrer_id,referee_id,status,referral_kind,reward_rate_bps,reward_cap_minor,qualifying_jobs_required,qualifying_window_days,review_days) VALUES
 ('fe000000-0000-4000-8000-000000000003','11111111-1111-4111-8111-1111111111aa','ca000000-0000-4000-8000-0000000000c1','d1000000-0000-4000-8000-0000000000e1','d2000000-0000-4000-8000-0000000000e2','pending','driver',500,500,20,30,7);
CREATE FUNCTION pg_temp.job(p_id uuid, p_customer uuid, p_country text, p_ccy text, p_fare numeric, p_driver uuid DEFAULT NULL) RETURNS uuid LANGUAGE sql AS $f$
 INSERT INTO public.jobs(id,tenant_id,customer_id,driver_id,pickup_address,dropoff_address,scheduled_time,payment_method,payment_status,country_code,currency_code,status,price,total_price)
 VALUES (p_id,'11111111-1111-4111-8111-1111111111aa',p_customer,p_driver,'a','b',now(),'card','paid',p_country,p_ccy,'completed',p_fare,p_fare) RETURNING id $f$;
SELECT pg_temp.job('00000000-0000-4000-8000-0000000000f1','b1000000-0000-4000-8000-0000000000b1','GB','GBP',12.50);
SELECT pg_temp.job('00000000-0000-4000-8000-0000000000f2','b2000000-0000-4000-8000-0000000000b2','GB','GBP',7.00);
SELECT pg_temp.job('00000000-0000-4000-8000-0000000000f3','b2000000-0000-4000-8000-0000000000b2','NG','NGN',5000);
SELECT pg_temp.job('00000000-0000-4000-8000-0000000000f4','b2000000-0000-4000-8000-0000000000b2','GB','GBP',200.00);
SELECT pg_temp.job(('00000000-0000-4000-8000-0000000001'||lpad(g::text,2,'0'))::uuid,'b1000000-0000-4000-8000-0000000000b1','GB','GBP',30.00,'d2000000-0000-4000-8000-0000000000e2') FROM generate_series(1,20) g;
SET LOCAL session_replication_role = origin;

-- 1. Customer referral: 12.50 GBP = 1250 minor; 5% = 62 minor (0.62 GBP), above the 800 qualifying fare.
SELECT (public.earn_referral('fe000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000f1')).status AS s1 \gset
INSERT INTO results SELECT 1,'12.50 GBP ride: earned, fare recorded as 1250 minor, reward 62 minor',
  status='earned' AND qualifying_fare_minor=1250 AND reward_minor=62, status||' '||qualifying_fare_minor||' '||reward_minor
  FROM public.referrals WHERE id='fe000000-0000-4000-8000-000000000001';
INSERT INTO results SELECT 1,'reward credit 62 GBP minor, non-withdrawable, expires in 90 days',
  amount_minor=62 AND currency_code='GBP' AND NOT withdrawable AND expires_at > now()+interval '89 days', amount_minor||' '||currency_code
  FROM public.reward_credits WHERE source_id='fe000000-0000-4000-8000-000000000001';
INSERT INTO results SELECT 1,'campaign budget charged 62',spent_minor=62,spent_minor::text FROM public.campaigns WHERE id='ca000000-0000-4000-8000-0000000000c1';

-- 2. Qualifying fare, market isolation, cap.
DO $t$ DECLARE r text; BEGIN
 BEGIN PERFORM public.earn_referral('fe000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000f2'); r:='none'; EXCEPTION WHEN OTHERS THEN r:=SQLERRM; END;
 INSERT INTO results VALUES (2,'7.00 GBP (700 minor) is below the 800 qualifying fare: refused',r='qualifying_fare_below_minimum',r);
 BEGIN PERFORM public.earn_referral('fe000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000f3'); r:='none'; EXCEPTION WHEN OTHERS THEN r:=SQLERRM; END;
 INSERT INTO results VALUES (2,'an NG/NGN job never earns on a GB/GBP campaign',r='referral_currency_mismatch',r);
END $t$;
SELECT (public.earn_referral('fe000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000f4')).status AS s2 \gset
INSERT INTO results SELECT 2,'200.00 GBP: 5% = 1000 minor, capped at 500',reward_minor=500,reward_minor::text FROM public.referrals WHERE id='fe000000-0000-4000-8000-000000000002';

-- 3. Driver referral: 20 jobs x 30.00 GBP = 60000 minor; 5% = 3000, capped 500; released after the 7-day review.
DO $t$ BEGIN
 FOR g IN 1..20 LOOP PERFORM public.earn_referral('fe000000-0000-4000-8000-000000000003',('00000000-0000-4000-8000-0000000001'||lpad(g::text,2,'0'))::uuid); END LOOP;
END $t$;
INSERT INTO results SELECT 3,'driver: earned after 20 jobs, progress in minor units (60000), reward capped 500, release in 7 days',
  status='earned' AND qualifying_fare_minor=60000 AND reward_minor=500 AND release_at BETWEEN now()+interval '6 days 23 hours' AND now()+interval '7 days 1 hour',
  status||' '||qualifying_fare_minor||' '||reward_minor FROM public.referrals WHERE id='fe000000-0000-4000-8000-000000000003';
INSERT INTO results SELECT 3,'each progress row is the job fare in minor units (3000)',min(fare_minor)=3000 AND max(fare_minor)=3000 AND count(*)=20,min(fare_minor)||'/'||count(*)
  FROM public.referral_driver_progress WHERE referral_id='fe000000-0000-4000-8000-000000000003';

SELECT n, CASE WHEN ok THEN 'ok' ELSE 'FAIL' END, name, coalesce(detail,'') FROM results ORDER BY n;
SELECT count(*) FILTER (WHERE NOT ok) || ' | ' || count(*) FILTER (WHERE ok) || '/' || count(*) FROM results;
ROLLBACK;
