-- Disposable DB only. Isolated fixture assignment bypasses onboarding as the existing PIN suite
-- does; all production acquisition/ownership/completion functions and triggers remain unchanged.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE results(name text,ok boolean);
ALTER TABLE public.jobs DISABLE TRIGGER enforce_driver_market_jobs_v23;
ALTER TABLE public.jobs DISABLE TRIGGER enforce_job_vehicle_category_trigger;
ALTER TABLE public.jobs DISABLE TRIGGER trg_enforce_job_acquisition_eligibility;
ALTER TABLE public.jobs DISABLE TRIGGER trg_enforce_job_payment_eligibility;
ALTER TABLE public.jobs DISABLE TRIGGER trg_gb_mot_job;
ALTER TABLE public.jobs DISABLE TRIGGER enforce_ride_cash_credit_v1e;
INSERT INTO public.tenants(id,name,slug) VALUES('71200000-0000-4000-8000-000000000001','PIN Africa A','pin-africa-a'),('71200000-0000-4000-8000-000000000002','PIN Africa B','pin-africa-b');
INSERT INTO auth.users(id) SELECT ('71300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,5)n;
SET LOCAL session_replication_role=replica;
INSERT INTO public.profiles(id,tenant_id,role,country_code)
 SELECT ('71300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'71200000-0000-4000-8000-000000000001',CASE WHEN n=1 THEN 'customer' ELSE 'driver' END,'NG' FROM generate_series(1,5)n;
INSERT INTO public.jobs(id,tenant_id,customer_id,country_code,currency_code,pickup_address,dropoff_address,scheduled_time,status,payment_method,payment_status,metadata)
 SELECT ('71400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'71200000-0000-4000-8000-000000000001','71300000-0000-4000-8000-000000000001',
 CASE WHEN n IN(3,6) THEN 'GB' WHEN n=7 THEN 'FR' ELSE 'NG' END,CASE WHEN n IN(3,6) THEN 'GBP' WHEN n=7 THEN 'EUR' ELSE 'NGN' END,'a','b',now(),'searching','card','authorized','{"completion_pin_market_policy":"required","completion_pin_required":true}'::jsonb
 FROM generate_series(1,8)n;
-- Existing frozen NG job remains required across status writes and later setting/override changes.
UPDATE public.jobs SET driver_id='71300000-0000-4000-8000-000000000005',metadata=metadata||'{"completion_pin_effective":"required","completion_pin_driver_id":"71300000-0000-4000-8000-000000000005"}',status='assigned' WHERE id='71400000-0000-4000-8000-000000000008';
SET LOCAL session_replication_role=origin;
INSERT INTO public.driver_pin_policies(driver_id,tenant_id,policy) VALUES
 ('71300000-0000-4000-8000-000000000003','71200000-0000-4000-8000-000000000001','required'),
 ('71300000-0000-4000-8000-000000000004','71200000-0000-4000-8000-000000000001','disabled'),
 ('71300000-0000-4000-8000-000000000002','71200000-0000-4000-8000-000000000002','required');
CREATE FUNCTION pg_temp.assign_pin(n int,d int) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 SET LOCAL session_replication_role=replica;
 UPDATE public.jobs SET status='completed' WHERE driver_id=('71300000-0000-4000-8000-'||lpad(d::text,12,'0'))::uuid;
 SET LOCAL session_replication_role=origin;
 UPDATE public.jobs SET driver_id=('71300000-0000-4000-8000-'||lpad(d::text,12,'0'))::uuid,status='assigned' WHERE id=('71400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
END $$;
SELECT pg_temp.assign_pin(1,2);
INSERT INTO results SELECT 'old pending NG booking follows current explicit disabled default on first acceptance; foreign tenant override ignored',metadata->>'completion_pin_effective'='disabled' AND metadata->>'completion_pin_source'='market' AND metadata->>'completion_pin_policy_version'='acceptance-market-v3' FROM public.jobs WHERE id='71400000-0000-4000-8000-000000000001';
INSERT INTO results SELECT 'NG disabled assignment mints no PIN',NOT EXISTS(SELECT 1 FROM public.job_completion_secrets WHERE job_id='71400000-0000-4000-8000-000000000001');
SELECT pg_temp.assign_pin(2,3);
INSERT INTO results SELECT 'authorised same-tenant required override wins in NG',metadata->>'completion_pin_effective'='required' AND metadata->>'completion_pin_source'='driver' FROM public.jobs WHERE id='71400000-0000-4000-8000-000000000002';
INSERT INTO results SELECT 'required override mints customer secret',completion_pin ~ '^[1-9][0-9]{3}$' FROM public.job_completion_secrets WHERE job_id='71400000-0000-4000-8000-000000000002';
SELECT pg_temp.assign_pin(3,2);
INSERT INTO results SELECT 'GB remains required with no same-tenant override',metadata->>'completion_pin_effective'='required' FROM public.jobs WHERE id='71400000-0000-4000-8000-000000000003';
SELECT pg_temp.assign_pin(6,4);
INSERT INTO results SELECT 'authorised GB driver disabled override retained',metadata->>'completion_pin_effective'='disabled' AND metadata->>'completion_pin_source'='driver' FROM public.jobs WHERE id='71400000-0000-4000-8000-000000000006';
SELECT pg_temp.assign_pin(7,2);
INSERT INTO results SELECT 'FR is not treated as Africa',metadata->>'completion_pin_effective'='required' AND metadata->>'completion_pin_policy_version' IS NULL FROM public.jobs WHERE id='71400000-0000-4000-8000-000000000007';
-- A tenant-specific entry always wins over the platform row. This fixture represents a later
-- explicit tenant policy, not another tenant's setting leaking into the job.
INSERT INTO public.marketplace_settings(tenant_id,key,value) VALUES('71200000-0000-4000-8000-000000000001','completion_pin_policy','{"markets":{"NG":"required"}}');
SELECT pg_temp.assign_pin(4,2);
INSERT INTO results SELECT 'own tenant NG entry wins over platform disabled',metadata->>'completion_pin_effective'='required' FROM public.jobs WHERE id='71400000-0000-4000-8000-000000000004';
UPDATE public.marketplace_settings SET value='{"default":"required","markets":{"FR":"optional"}}' WHERE tenant_id='71200000-0000-4000-8000-000000000001' AND key='completion_pin_policy';
SELECT pg_temp.assign_pin(5,2);
INSERT INTO results SELECT 'new tenant generic default does not hide explicit platform NG country default',metadata->>'completion_pin_effective'='disabled' FROM public.jobs WHERE id='71400000-0000-4000-8000-000000000005';
UPDATE public.marketplace_settings SET value='{"markets":{"NG":"disabled"}}' WHERE tenant_id='71200000-0000-4000-8000-000000000001' AND key='completion_pin_policy';
UPDATE public.jobs SET status='in_progress',driver_id=driver_id WHERE id='71400000-0000-4000-8000-000000000008';
INSERT INTO results SELECT 'existing frozen NG job stays required',metadata->>'completion_pin_effective'='required' FROM public.jobs WHERE id='71400000-0000-4000-8000-000000000008';
INSERT INTO results SELECT 'new helper is not executable by clients',NOT has_function_privilege('authenticated','public.refresh_completion_pin_market_on_acceptance()','EXECUTE') AND NOT has_function_privilege('service_role','public.refresh_completion_pin_market_on_acceptance()','EXECUTE');
INSERT INTO results SELECT 'policy audit records explicit country list',EXISTS(SELECT 1 FROM public.audit_logs WHERE action='admin_completion_pin_market_defaults' AND metadata#>>'{scope,NG}'='disabled' AND metadata#>>'{scope,GB}'='required' AND NOT(metadata->'scope' ? 'FR'));
-- Exercise the unchanged real settlement RPC on a legitimately GBP-denominated GB fixture.
-- PIN admission is exercised by the real LogisticsService tests, not bypassed by production SQL.
SET LOCAL session_replication_role=replica;
UPDATE public.jobs SET status='completed' WHERE driver_id='71300000-0000-4000-8000-000000000002';
UPDATE public.jobs SET status='in_progress',payment_status='paid',price=20,total_price=20 WHERE id='71400000-0000-4000-8000-000000000003';
SET LOCAL session_replication_role=origin;
SELECT count(*) FROM public.complete_job_with_pending_payout('71400000-0000-4000-8000-000000000003','71300000-0000-4000-8000-000000000002',
 '{"total":20,"payout":16,"platformFee":2,"commission":2,"commissionRate":10,"amountMinor":1600,"currency":"GBP","destination":"acct_pin_fixture","country":"GB"}',
 '{"completion_pin_verified_at":"2026-11-16T00:00:00Z"}');
SELECT count(*) FROM public.complete_job_with_pending_payout('71400000-0000-4000-8000-000000000003','71300000-0000-4000-8000-000000000002',
 '{"total":20,"payout":16,"platformFee":2,"commission":2,"commissionRate":10,"amountMinor":1600,"currency":"GBP","destination":"acct_pin_fixture","country":"GB"}',
 '{"completion_pin_verified_at":"2026-11-16T00:00:00Z"}');
INSERT INTO results SELECT 'settlement retry creates exactly one unchanged payout and earnings row',
 (SELECT count(*)=1 AND min(amount_minor)=1600 FROM public.job_payout_queue WHERE job_id='71400000-0000-4000-8000-000000000003')
 AND (SELECT count(*)=1 AND min(amount)=16 FROM public.driver_earnings WHERE job_id='71400000-0000-4000-8000-000000000003');
SELECT CASE WHEN ok THEN 'ok' ELSE 'FAIL' END,name FROM results;
SELECT count(*) FILTER(WHERE NOT coalesce(ok,false))||' | '||count(*) FILTER(WHERE ok)||'/'||count(*) FROM results;
ROLLBACK;
