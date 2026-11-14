-- After activate-gb.sql has run TWICE: GB-only, idempotent, and the money paths compute the approved values.
-- Checks run in a rolled-back transaction. Last line: "<failures> | <passed>/<total>".
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE results(n int, name text, ok boolean, detail text);
\set GB '''6b000000-0000-4000-8000-0000000000aa'''
\set NG '''6b000000-0000-4000-8000-0000000000bb'''

-- 1. Exactly what was approved, once, GB only.
INSERT INTO results SELECT 1,'one enabled GB cancellation policy: fee 300, cap 300, grace 120 s, 80% compensation on collection, debt threshold 150 (50% of 3.00)',
  count(*)=1 AND bool_and(fee_minor=300 AND fee_cap_minor=300 AND grace_seconds=120 AND driver_compensation_percent=80 AND compensation_funding='on_collection' AND debt_threshold_minor=150),
  string_agg(fee_minor||'/'||fee_cap_minor||'/'||grace_seconds||'/'||debt_threshold_minor,',') FROM public.cancellation_policies WHERE tenant_id=:GB AND market_code='GB' AND enabled;
INSERT INTO results SELECT 1,'two GB campaigns, enabled, with the approved terms',
  count(*)=2 AND bool_and(market_code='GB' AND currency_code='GBP' AND budget_minor=50000)
  AND bool_or(code='FIRST5GB' AND value_type='percent' AND value=5 AND qualification='{"firstBookingOnly":true,"max_discount_minor":500,"min_qualifying_fare_minor":800}'::jsonb AND per_user_cap=1)
  AND bool_or(code='REFERGB' AND referral_reward_bps=500 AND qualification='{"reward_cap_minor":500,"min_qualifying_fare_minor":800}'::jsonb),
  string_agg(code,',') FROM public.campaigns WHERE tenant_id=:GB AND enabled;
INSERT INTO results SELECT 1,'nothing for NG: no policy, no campaign, NG PIN setting unchanged',
  NOT EXISTS (SELECT 1 FROM public.cancellation_policies WHERE tenant_id=:NG OR market_code<>'GB')
  AND NOT EXISTS (SELECT 1 FROM public.campaigns WHERE tenant_id=:NG OR market_code<>'GB')
  AND (SELECT value FROM public.marketplace_settings WHERE tenant_id=:NG AND key='completion_pin_policy')='{"markets":{"NG":"optional"}}'::jsonb, NULL;
INSERT INTO results SELECT 1,'GB tenant PIN setting: markets.GB = required',value='{"markets":{"GB":"required"}}'::jsonb,value::text
  FROM public.marketplace_settings WHERE tenant_id=:GB AND key='completion_pin_policy';
INSERT INTO results SELECT 1,'audit rows for the publish and the activation',
  (SELECT count(*) FROM public.audit_logs a JOIN public.cancellation_policies p ON p.id=a.entity_id WHERE a.action='admin_policy_publish' AND a.metadata->>'source'='develop-activation-2026-11-14' AND p.tenant_id=:GB)=1
  AND (SELECT count(*) FROM public.audit_logs WHERE action='admin_develop_activation' AND metadata->>'tenant'=:GB)=2, NULL;

-- 2. Cancellation fee through the real quote function (GB booking, driver accepted 5 minutes ago).
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs(id,tenant_id,customer_id,driver_id,accepted_driver_id,pickup_address,dropoff_address,scheduled_time,payment_method,payment_status,country_code,currency_code,status,price,total_price,accepted_at)
 VALUES ('6f000000-0000-4000-8000-000000000001',:GB,'6c000000-0000-4000-8000-0000000000c1','6d000000-0000-4000-8000-0000000000d1','6d000000-0000-4000-8000-0000000000d1','a','b',now(),'card','authorized','GB','GBP','assigned',20.00,20.00,now()-interval '5 minutes'),
        ('6f000000-0000-4000-8000-000000000002',:GB,'6c000000-0000-4000-8000-0000000000c1',NULL,'6d000000-0000-4000-8000-0000000000d1','a','b',now(),'card','authorized','GB','GBP','searching',20.00,20.00,now()-interval '60 seconds'),
        ('6f000000-0000-4000-8000-000000000003',:NG,'6e000000-0000-4000-8000-0000000000e1',NULL,NULL,'a','b',now(),'card','authorized','NG','NGN','assigned',5000,5000,now()-interval '5 minutes');
SET LOCAL session_replication_role = origin;
INSERT INTO results SELECT 2,'GB, accepted 5 min ago: fee due 300 GBP minor',(q->>'due')::boolean AND (q->>'feeMinor')::int=300 AND q->>'currency'='GBP',q::text
  FROM (SELECT public.cancellation_fee_quote('6f000000-0000-4000-8000-000000000001','customer') q) s;
INSERT INTO results SELECT 2,'GB, accepted 60 s ago: within the 120 s grace',q->>'reasonCode'='within_grace',q->>'reasonCode'
  FROM (SELECT public.cancellation_fee_quote('6f000000-0000-4000-8000-000000000002','customer') q) s;
INSERT INTO results SELECT 2,'NG booking: no fee (no NG policy)',NOT (q->>'due')::boolean,q->>'reasonCode'
  FROM (SELECT public.cancellation_fee_quote('6f000000-0000-4000-8000-000000000003','customer') q) s;

-- 3. Promotion through the real discount function (the API now sends minor units: 12.50 GBP = 1250).
INSERT INTO results SELECT 3,'first booking 12.50 GBP: 5% = 62 minor',discount_minor=62,discount_minor::text
  FROM public.apply_campaign_discount((SELECT id FROM public.campaigns WHERE tenant_id=:GB AND code='FIRST5GB'),'6c000000-0000-4000-8000-0000000000c1','q-1',1250);
DO $t$ DECLARE r text; c uuid := (SELECT id FROM public.campaigns WHERE code='FIRST5GB' AND tenant_id='6b000000-0000-4000-8000-0000000000aa'); BEGIN
 BEGIN PERFORM public.apply_campaign_discount(c,'6c000000-0000-4000-8000-0000000000c1','q-2',1250); r:='none'; EXCEPTION WHEN OTHERS THEN r:=SQLERRM; END;
 INSERT INTO results VALUES (3,'one use per customer',r='campaign_cap_reached',r);
 BEGIN PERFORM public.apply_campaign_discount(c,'6c000000-0000-4000-8000-0000000000c2','q-3',700); r:='none'; EXCEPTION WHEN OTHERS THEN r:=SQLERRM; END;
 INSERT INTO results VALUES (3,'7.00 GBP is below the 8.00 minimum',r='campaign_fare_below_minimum',r);
END $t$;
INSERT INTO results SELECT 3,'200.00 GBP: 5% = 1000, capped at 500',discount_minor=500,discount_minor::text
  FROM public.apply_campaign_discount((SELECT id FROM public.campaigns WHERE tenant_id=:GB AND code='FIRST5GB'),'6c000000-0000-4000-8000-0000000000c2','q-4',20000);

SELECT n, CASE WHEN ok THEN 'ok' ELSE 'FAIL' END, name, coalesce(detail,'') FROM results ORDER BY n;
SELECT count(*) FILTER (WHERE NOT ok) || ' | ' || count(*) FILTER (WHERE ok) || '/' || count(*) FROM results;
ROLLBACK;
