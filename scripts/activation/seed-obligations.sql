-- Rehearsal fixture (disposable database only), run WHILE the GB features are on and committed, so that
-- deactivate-gb.sql runs against real obligations created by the real functions:
--   a referral linked but not yet earned, a reward already earned, a discount already applied,
--   a customer debt already recorded.
\set ON_ERROR_STOP on
BEGIN;
\set GB '''6b000000-0000-4000-8000-0000000000aa'''
SET LOCAL session_replication_role = replica;
-- Completed, paid GB rides for the referees.
INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,payment_method,payment_status,country_code,currency_code,status,price,total_price) VALUES
 ('6f100000-0000-4000-8000-000000000001',:GB,'6c000000-0000-4000-8000-0000000000c4','a','b',now(),'card','paid','GB','GBP','completed',20.00,20.00),
 ('6f100000-0000-4000-8000-000000000002',:GB,'6c000000-0000-4000-8000-0000000000c6','a','b',now(),'card','paid','GB','GBP','completed',15.00,15.00),
 ('6f100000-0000-4000-8000-000000000003',:GB,'6c000000-0000-4000-8000-0000000000c1','a','b',now(),'card','authorized','GB','GBP','cancelled',20.00,20.00);
-- Referrals as /referrals/redeem writes them (terms frozen at link time).
INSERT INTO public.referrals(id,tenant_id,campaign_id,referrer_id,referee_id,status,referral_kind,reward_rate_bps,reward_cap_minor,qualifying_fare_minor)
SELECT x.id, :GB, c.id, x.referrer, x.referee, 'pending','customer',500,500,800
  FROM public.campaigns c,
       (VALUES ('6f200000-0000-4000-8000-000000000001'::uuid,'6c000000-0000-4000-8000-0000000000c3'::uuid,'6c000000-0000-4000-8000-0000000000c4'::uuid),
               ('6f200000-0000-4000-8000-000000000002'::uuid,'6c000000-0000-4000-8000-0000000000c5'::uuid,'6c000000-0000-4000-8000-0000000000c6'::uuid)) x(id,referrer,referee)
 WHERE c.tenant_id=:GB AND c.code='REFERGB';
SET LOCAL session_replication_role = origin;
-- Earned BEFORE deactivation: 20.00 GBP -> 5% = 100 minor credit for c3.
SELECT (public.earn_referral('6f200000-0000-4000-8000-000000000001','6f100000-0000-4000-8000-000000000001')).status AS earned_before;
-- Applied BEFORE deactivation: c1's first-booking discount on quote q-ob (12.50 GBP -> 62).
SELECT discount_minor AS applied_before FROM public.apply_campaign_discount((SELECT id FROM public.campaigns WHERE tenant_id=:GB AND code='FIRST5GB'),'6c000000-0000-4000-8000-0000000000c1','q-ob',1250);
-- Owed BEFORE deactivation: an uncollected 3.00 GBP cancellation fee under policy version 1.
SELECT (public.record_customer_receivable(:GB,'6c000000-0000-4000-8000-0000000000c1','6f100000-0000-4000-8000-000000000003','GBP',300,'cancellation_fee',1)) IS NOT NULL AS debt_recorded;
COMMIT;
