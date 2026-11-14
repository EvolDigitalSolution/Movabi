-- After deactivate-gb.sql: everything off for GB, history kept, NG untouched. Last line: "<failures> | <passed>/<total>".
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE results(n int, name text, ok boolean, detail text);
INSERT INTO results SELECT 1,'no GB policy or GB campaign enabled',
  NOT EXISTS (SELECT 1 FROM public.cancellation_policies WHERE enabled) AND NOT EXISTS (SELECT 1 FROM public.campaigns WHERE enabled), NULL;
INSERT INTO results SELECT 1,'history kept: the published version and both campaigns still exist',
  (SELECT count(*) FROM public.cancellation_policies WHERE market_code='GB' AND tenant_id='6b000000-0000-4000-8000-0000000000aa')=1
  AND (SELECT count(*) FROM public.campaigns WHERE code IN ('FIRST5GB','REFERGB') AND tenant_id='6b000000-0000-4000-8000-0000000000aa')=2, NULL;
INSERT INTO results SELECT 1,'PIN: GB key removed (GB falls back to required); NG setting unchanged',
  (SELECT value FROM public.marketplace_settings WHERE tenant_id='6b000000-0000-4000-8000-0000000000aa' AND key='completion_pin_policy')='{"markets":{}}'::jsonb
  AND (SELECT value FROM public.marketplace_settings WHERE tenant_id='6b000000-0000-4000-8000-0000000000bb' AND key='completion_pin_policy')='{"markets":{"NG":"optional"}}'::jsonb, NULL;
INSERT INTO results SELECT 1,'matching and surge: GB keys removed (GB falls back to previous ranking, no surge)',
  (SELECT count(*) FROM public.marketplace_settings WHERE key IN ('smart_matching','dynamic_pricing') AND value #> '{markets,GB}' IS NOT NULL)=0
  AND (SELECT count(*) FROM public.marketplace_settings WHERE tenant_id='6b000000-0000-4000-8000-0000000000aa' AND key IN ('smart_matching','dynamic_pricing'))=2, NULL;
-- 2. Obligations created while the features were on (seed-obligations.sql) stay valid after deactivation.
\set GB '''6b000000-0000-4000-8000-0000000000aa'''
INSERT INTO results SELECT 2,'reward earned before deactivation: credit kept in full (100 minor available, GBP)',
  count(*)=1 AND bool_and(public.reward_credit_available(id)=100 AND currency_code='GBP' AND expires_at > now()),string_agg(amount_minor::text,',')
  FROM public.reward_credits WHERE source_id='6f200000-0000-4000-8000-000000000001';
INSERT INTO results SELECT 2,'discount applied before deactivation: still applied (62), not reversed',status='applied' AND discount_minor=62,status||' '||discount_minor
  FROM public.campaign_discount_applications WHERE customer_id='6c000000-0000-4000-8000-0000000000c1' AND quote_reference='q-ob';
INSERT INTO results SELECT 2,'customer debt recorded before deactivation: still open, 300 minor, policy version 1',
  public.customer_open_debt_minor('6c000000-0000-4000-8000-0000000000c1')=300
  AND (SELECT status='open' AND policy_version=1 AND market_code='GB' FROM public.customer_receivables WHERE customer_id='6c000000-0000-4000-8000-0000000000c1'),NULL;
-- A referral linked before deactivation still earns when its referee completes a qualifying ride.
SELECT (public.earn_referral('6f200000-0000-4000-8000-000000000002','6f100000-0000-4000-8000-000000000002')).status AS earned_after \gset
INSERT INTO results SELECT 2,'referral linked before deactivation: still earns afterwards (15.00 GBP -> 75) and is credited',
  r.status='earned' AND r.reward_minor=75 AND EXISTS (SELECT 1 FROM public.reward_credits c WHERE c.source_id=r.id AND c.amount_minor=75),r.status||' '||coalesce(r.reward_minor::text,'')
  FROM public.referrals r WHERE r.id='6f200000-0000-4000-8000-000000000002';
-- New business is refused.
DO $t$ DECLARE r text; BEGIN
 BEGIN PERFORM public.apply_campaign_discount((SELECT id FROM public.campaigns WHERE code='FIRST5GB' AND tenant_id='6b000000-0000-4000-8000-0000000000aa'),'6c000000-0000-4000-8000-0000000000c2','q-new',1250); r:='none';
 EXCEPTION WHEN OTHERS THEN r:=SQLERRM; END;
 INSERT INTO results VALUES (3,'new discount after deactivation: refused',r='campaign_unavailable',r);
END $t$;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs(id,tenant_id,customer_id,driver_id,accepted_driver_id,pickup_address,dropoff_address,scheduled_time,payment_method,payment_status,country_code,currency_code,status,price,total_price,accepted_at)
 VALUES ('6f300000-0000-4000-8000-000000000001',:GB,'6c000000-0000-4000-8000-0000000000c2',NULL,'6d000000-0000-4000-8000-0000000000d1','a','b',now(),'card','authorized','GB','GBP','searching',20.00,20.00,now()-interval '10 minutes');
SET LOCAL session_replication_role = origin;
INSERT INTO results SELECT 3,'new cancellation after deactivation: no fee',NOT (q->>'due')::boolean AND q->>'reasonCode'='no_active_policy',q->>'reasonCode'
  FROM (SELECT public.cancellation_fee_quote('6f300000-0000-4000-8000-000000000001','customer') q) s;

SELECT n, CASE WHEN ok THEN 'ok' ELSE 'FAIL' END, name, coalesce(detail,'') FROM results ORDER BY n;
SELECT count(*) FILTER (WHERE NOT ok) || ' | ' || count(*) FILTER (WHERE ok) || '/' || count(*) FROM results;
ROLLBACK;
