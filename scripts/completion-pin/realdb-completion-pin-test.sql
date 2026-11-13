-- Real-Postgres test: per-driver completion PIN, frozen at assignment (area 3, 20261270100000).
-- Disposable database only: develop's live schema + release 1 + release 2. One transaction, rolled back.
-- Fixture rows are inserted with session_replication_role=replica (skips triggers without changing
-- their state). Driver ASSIGNMENT runs with triggers on; the driver-eligibility guards on jobs
-- (market, vehicle category, acquisition, payment, MOT, cash credit) are disabled inside this
-- rolled-back transaction because the fixture drivers are not fully onboarded; those guards have
-- their own suites. Every other jobs trigger stays on. Last line: "<failures> | <passed>/<total>".
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE results(n int, name text, ok boolean, detail text);
ALTER TABLE public.jobs DISABLE TRIGGER enforce_driver_market_jobs_v23;
ALTER TABLE public.jobs DISABLE TRIGGER enforce_job_vehicle_category_trigger;
ALTER TABLE public.jobs DISABLE TRIGGER trg_enforce_job_acquisition_eligibility;
ALTER TABLE public.jobs DISABLE TRIGGER trg_enforce_job_payment_eligibility;
ALTER TABLE public.jobs DISABLE TRIGGER trg_gb_mot_job;
ALTER TABLE public.jobs DISABLE TRIGGER enforce_ride_cash_credit_v1e;

INSERT INTO public.tenants(id,name,slug) VALUES ('11111111-1111-4111-8111-111111111111','t1','pin-t1'),('22222222-2222-4222-8222-222222222222','t2','pin-t2');
INSERT INTO auth.users(id) VALUES ('c0000000-0000-4000-8000-00000000000c'),('d1000000-0000-4000-8000-0000000000d1'),('d2000000-0000-4000-8000-0000000000d2'),('d3000000-0000-4000-8000-0000000000d3');
SET LOCAL session_replication_role = replica;
INSERT INTO public.profiles(id,tenant_id,role,country_code) VALUES
 ('c0000000-0000-4000-8000-00000000000c','11111111-1111-4111-8111-111111111111','customer','GB'),
 ('d1000000-0000-4000-8000-0000000000d1','11111111-1111-4111-8111-111111111111','driver','GB'),
 ('d2000000-0000-4000-8000-0000000000d2','11111111-1111-4111-8111-111111111111','driver','GB'),
 ('d3000000-0000-4000-8000-0000000000d3','22222222-2222-4222-8222-222222222222','driver','NG');
SET LOCAL session_replication_role = origin;
-- Overrides: d1 disabled in t1; d2 required in t1; d3 has an override only in t2 (another tenant).
INSERT INTO public.driver_pin_policies(driver_id,tenant_id,policy) VALUES
 ('d1000000-0000-4000-8000-0000000000d1','11111111-1111-4111-8111-111111111111','disabled'),
 ('d2000000-0000-4000-8000-0000000000d2','11111111-1111-4111-8111-111111111111','required'),
 ('d3000000-0000-4000-8000-0000000000d3','22222222-2222-4222-8222-222222222222','optional');

-- A searching booking in tenant t1 with the market policy the API wrote at booking time.
CREATE FUNCTION pg_temp.job(p_id uuid, p_market_policy text, p_country text DEFAULT 'GB') RETURNS uuid LANGUAGE plpgsql AS $f$
BEGIN
 SET LOCAL session_replication_role = replica;
 INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,payment_method,payment_status,country_code,currency_code,status,price,total_price,metadata)
 VALUES (p_id,'11111111-1111-4111-8111-111111111111','c0000000-0000-4000-8000-00000000000c','a','b',now(),'card','authorized',p_country,'GBP','searching',20,20,
   CASE WHEN p_market_policy IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('completion_pin_market_policy',p_market_policy,'completion_pin_required',p_market_policy<>'disabled') END);
 SET LOCAL session_replication_role = origin;
 RETURN p_id;
END $f$;
-- Develop allows one active job per driver (idx_jobs_one_active_per_driver): the driver's earlier
-- fixture job is closed (fixture write, triggers skipped) before the next assignment.
CREATE FUNCTION pg_temp.assign(p_job uuid, p_driver uuid) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
 SET LOCAL session_replication_role = replica;
 UPDATE public.jobs SET status='completed' WHERE driver_id=p_driver AND id<>p_job;
 SET LOCAL session_replication_role = origin;
 UPDATE public.jobs SET driver_id=p_driver, accepted_driver_id=p_driver, status='assigned' WHERE id=p_job;
END $f$;
CREATE FUNCTION pg_temp.m(p_job uuid) RETURNS jsonb LANGUAGE sql AS $f$ SELECT metadata FROM public.jobs WHERE id=p_job $f$;
CREATE FUNCTION pg_temp.pin(p_job uuid) RETURNS text LANGUAGE sql AS $f$ SELECT completion_pin FROM public.job_completion_secrets WHERE job_id=p_job $f$;

-- 1. Market policy applies when the driver has no override.
SELECT pg_temp.job('00000000-0000-4000-8000-000000000001','optional');
SELECT pg_temp.assign('00000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-0000000000d3');
INSERT INTO results SELECT 1,'no override in the job''s tenant: market policy (optional), source market',
  m->>'completion_pin_effective'='optional' AND m->>'completion_pin_source'='market' AND (m->>'completion_pin_required')::boolean, m::text
  FROM (SELECT pg_temp.m('00000000-0000-4000-8000-000000000001') m) s;
INSERT INTO results SELECT 1,'an override in ANOTHER tenant never applies (d3''s t2 override ignored on a t1 job)',
  m->>'completion_pin_driver_id'='d3000000-0000-4000-8000-0000000000d3' AND m->>'completion_pin_source'='market', m::text
  FROM (SELECT pg_temp.m('00000000-0000-4000-8000-000000000001') m) s;
INSERT INTO results SELECT 1,'optional: a 4-digit PIN is minted for the customer',pg_temp.pin('00000000-0000-4000-8000-000000000001') ~ '^[1-9][0-9]{3}$',pg_temp.pin('00000000-0000-4000-8000-000000000001');

-- 2. Driver override beats the market: disabled.
SELECT pg_temp.job('00000000-0000-4000-8000-000000000002','required');
SET LOCAL session_replication_role = replica;
INSERT INTO public.job_completion_secrets(job_id,completion_pin) VALUES ('00000000-0000-4000-8000-000000000002','4321');
SET LOCAL session_replication_role = origin;
SELECT pg_temp.assign('00000000-0000-4000-8000-000000000002','d1000000-0000-4000-8000-0000000000d1');
INSERT INTO results SELECT 2,'driver override disabled beats market required; required flag false; source driver',
  m->>'completion_pin_effective'='disabled' AND NOT (m->>'completion_pin_required')::boolean AND m->>'completion_pin_source'='driver', m::text
  FROM (SELECT pg_temp.m('00000000-0000-4000-8000-000000000002') m) s;
INSERT INTO results SELECT 2,'the secret minted at booking is kept (not deleted, not changed)',pg_temp.pin('00000000-0000-4000-8000-000000000002')='4321',pg_temp.pin('00000000-0000-4000-8000-000000000002');

-- 3. Driver override required in a market that disables the PIN: a PIN is minted at assignment.
SELECT pg_temp.job('00000000-0000-4000-8000-000000000003','disabled');
INSERT INTO results SELECT 3,'market disabled, no driver yet: no PIN',pg_temp.pin('00000000-0000-4000-8000-000000000003') IS NULL,coalesce(pg_temp.pin('00000000-0000-4000-8000-000000000003'),'none');
SELECT pg_temp.assign('00000000-0000-4000-8000-000000000003','d2000000-0000-4000-8000-0000000000d2');
INSERT INTO results SELECT 3,'driver override required beats market disabled; required flag true',
  m->>'completion_pin_effective'='required' AND (m->>'completion_pin_required')::boolean, m::text FROM (SELECT pg_temp.m('00000000-0000-4000-8000-000000000003') m) s;
INSERT INTO results SELECT 3,'a PIN is minted for the customer at assignment',pg_temp.pin('00000000-0000-4000-8000-000000000003') ~ '^[1-9][0-9]{3}$',coalesce(pg_temp.pin('00000000-0000-4000-8000-000000000003'),'none');

-- 4. Reassignment re-resolves for the new driver; the existing secret is kept.
SELECT pg_temp.pin('00000000-0000-4000-8000-000000000003') AS pin3 \gset
SELECT pg_temp.assign('00000000-0000-4000-8000-000000000003','d1000000-0000-4000-8000-0000000000d1');
INSERT INTO results SELECT 4,'reassigned to d1 (override disabled): effective disabled, driver id updated',
  m->>'completion_pin_effective'='disabled' AND m->>'completion_pin_driver_id'='d1000000-0000-4000-8000-0000000000d1', m::text FROM (SELECT pg_temp.m('00000000-0000-4000-8000-000000000003') m) s;
INSERT INTO results SELECT 4,'reassignment keeps the existing secret',pg_temp.pin('00000000-0000-4000-8000-000000000003')=:'pin3',pg_temp.pin('00000000-0000-4000-8000-000000000003');

-- 5. Frozen: an override changed after assignment does not touch the job; non-driver updates do not re-stamp.
UPDATE public.driver_pin_policies SET policy='required' WHERE driver_id='d1000000-0000-4000-8000-0000000000d1';
UPDATE public.jobs SET status='heading_to_pickup' WHERE id='00000000-0000-4000-8000-000000000003';
INSERT INTO results SELECT 5,'override changed after assignment + status update: job keeps disabled (applies from next assignment)',
  m->>'completion_pin_effective'='disabled', m::text FROM (SELECT pg_temp.m('00000000-0000-4000-8000-000000000003') m) s;
UPDATE public.jobs SET driver_id=driver_id WHERE id='00000000-0000-4000-8000-000000000003';
INSERT INTO results SELECT 5,'setting the same driver again does not re-stamp',(pg_temp.m('00000000-0000-4000-8000-000000000003'))->>'completion_pin_effective'='disabled',NULL;

-- 6. Legacy bookings and bad values fail closed.
SELECT pg_temp.job('00000000-0000-4000-8000-000000000006',NULL);
SELECT pg_temp.assign('00000000-0000-4000-8000-000000000006','d3000000-0000-4000-8000-0000000000d3');
INSERT INTO results SELECT 6,'booking with no PIN metadata (pre-release): required',(pg_temp.m('00000000-0000-4000-8000-000000000006'))->>'completion_pin_effective'='required',NULL;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,payment_method,payment_status,country_code,currency_code,status,price,total_price,metadata)
 VALUES ('00000000-0000-4000-8000-000000000007','11111111-1111-4111-8111-111111111111','c0000000-0000-4000-8000-00000000000c','a','b',now(),'card','authorized','GB','GBP','searching',20,20,'{"completion_pin_market_policy":"maybe","completion_pin_required":false}');
SET LOCAL session_replication_role = origin;
SELECT pg_temp.assign('00000000-0000-4000-8000-000000000007','d3000000-0000-4000-8000-0000000000d3');
INSERT INTO results SELECT 6,'unreadable market policy value: fails closed to required',(pg_temp.m('00000000-0000-4000-8000-000000000007'))->>'completion_pin_effective'='required',NULL;
SELECT pg_temp.job('00000000-0000-4000-8000-000000000008','required');
UPDATE public.jobs SET driver_id=NULL WHERE id='00000000-0000-4000-8000-000000000008';
INSERT INTO results SELECT 6,'no driver: nothing stamped, no PIN minted',NOT (pg_temp.m('00000000-0000-4000-8000-000000000008') ? 'completion_pin_effective') AND pg_temp.pin('00000000-0000-4000-8000-000000000008') IS NULL,NULL;

-- 7. A job created with a driver already set (admin-created) is stamped and gets a PIN.
INSERT INTO public.jobs(id,tenant_id,customer_id,driver_id,pickup_address,dropoff_address,scheduled_time,payment_method,payment_status,country_code,currency_code,status,price,total_price,metadata)
 VALUES ('00000000-0000-4000-8000-000000000009','11111111-1111-4111-8111-111111111111','c0000000-0000-4000-8000-00000000000c','d2000000-0000-4000-8000-0000000000d2','a','b',now(),'card','authorized','GB','GBP','assigned',20,20,'{"completion_pin_market_policy":"disabled","completion_pin_required":false}');
INSERT INTO results SELECT 7,'insert with a driver: stamped required (d2 override) and a PIN minted',
  (pg_temp.m('00000000-0000-4000-8000-000000000009'))->>'completion_pin_effective'='required' AND pg_temp.pin('00000000-0000-4000-8000-000000000009') IS NOT NULL,NULL;

-- 8. Privileges: only the table owner runs the trigger functions; clients cannot call them.
INSERT INTO results SELECT 8,'anon/authenticated cannot execute the PIN functions',
  NOT has_function_privilege('authenticated','public.stamp_completion_pin_policy()','EXECUTE')
  AND NOT has_function_privilege('anon','public.completion_pin_market_policy(jsonb)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.mint_completion_pin_on_assignment()','EXECUTE'),NULL;

SELECT n, CASE WHEN ok THEN 'ok' ELSE 'FAIL' END, name, coalesce(detail,'') FROM results ORDER BY n;
SELECT count(*) FILTER (WHERE NOT ok) || ' | ' || count(*) FILTER (WHERE ok) || '/' || count(*) FROM results;
ROLLBACK;
