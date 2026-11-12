-- Real-Postgres test: driver cancellation attribution (policy D9, driver-initiated only) and
-- driver_offer_metrics_v2 against recorded events. Disposable database only:
-- deployed baseline + 20261101000000_driver_offer_events + 20261267000000_driver_cancellation_attribution.
-- One transaction, rolled back.
\set ON_ERROR_STOP on
BEGIN;
-- Setup inserts bypass unrelated jobs triggers; they are re-enabled before any cancellation, so the
-- real cancel path (cancel_job_safely + the actor update) runs with every jobs trigger active.
DO $d$ DECLARE t text; BEGIN
 FOR t IN SELECT tgname FROM pg_trigger tr JOIN pg_class c ON c.oid=tr.tgrelid WHERE c.relname='jobs' AND NOT tgisinternal
 LOOP EXECUTE format('ALTER TABLE public.jobs DISABLE TRIGGER %I', t); END LOOP; END $d$;
INSERT INTO public.tenants(id,name,slug) VALUES ('11111111-1111-4111-8111-111111111111','m','m');
INSERT INTO auth.users(id) VALUES
 ('d0000000-0000-4000-8000-00000000000d'),('e0000000-0000-4000-8000-00000000000e'),('f0000000-0000-4000-8000-00000000000f'),
 ('90000000-0000-4000-8000-000000000009'),('c0000000-0000-4000-8000-00000000000c'),('a0000000-0000-4000-8000-00000000000a');
INSERT INTO public.profiles(id,tenant_id,role,country_code) VALUES
 ('d0000000-0000-4000-8000-00000000000d','11111111-1111-4111-8111-111111111111','driver','GB'),
 ('e0000000-0000-4000-8000-00000000000e','11111111-1111-4111-8111-111111111111','driver','GB'),
 ('f0000000-0000-4000-8000-00000000000f','11111111-1111-4111-8111-111111111111','driver','GB'),
 ('90000000-0000-4000-8000-000000000009','11111111-1111-4111-8111-111111111111','driver','GB'),
 ('c0000000-0000-4000-8000-00000000000c','11111111-1111-4111-8111-111111111111','customer','GB'),
 ('a0000000-0000-4000-8000-00000000000a','11111111-1111-4111-8111-111111111111','admin','GB');
CREATE TEMP TABLE results(n int, name text, ok boolean, detail text);
-- Setup insert only: unrelated jobs triggers are off for the INSERT and back on immediately, so
-- every cancellation below runs with all jobs triggers active. The deployed schema allows one
-- active job per driver (idx_jobs_one_active_per_driver), so each active job is created just
-- before it is acted on.
CREATE FUNCTION pg_temp.job(p_id uuid, p_driver uuid, p_status text DEFAULT 'accepted') RETURNS uuid LANGUAGE plpgsql AS $f$
BEGIN
 ALTER TABLE public.jobs DISABLE TRIGGER USER;
 INSERT INTO public.jobs(id,tenant_id,customer_id,driver_id,accepted_driver_id,pickup_address,dropoff_address,scheduled_time,payment_method,payment_status,country_code,currency_code,status)
 VALUES (p_id,'11111111-1111-4111-8111-111111111111','c0000000-0000-4000-8000-00000000000c',p_driver,p_driver,'a','b',now(),'card','authorized','GB','GBP',p_status);
 ALTER TABLE public.jobs ENABLE TRIGGER USER;
 RETURN p_id;
END $f$;
-- Recorded offer lifecycle; events spaced one second apart in the given order.
CREATE FUNCTION pg_temp.offer(p_job uuid, p_driver uuid, p_key text, p_events text[], p_at timestamptz DEFAULT now()-interval '1 hour') RETURNS void LANGUAGE sql AS $f$
 INSERT INTO public.driver_offer_events(tenant_id,job_id,driver_id,offer_key,event,event_at)
 SELECT '11111111-1111-4111-8111-111111111111',p_job,p_driver,p_key,e,p_at+(i||' seconds')::interval FROM unnest(p_events) WITH ORDINALITY u(e,i) $f$;
CREATE FUNCTION pg_temp.m(p_driver uuid) RETURNS jsonb LANGUAGE sql AS $f$ SELECT public.driver_offer_metrics_v2(p_driver, now()-interval '30 days') $f$;

-- Driver D accepts seven bookings through recorded offers (J1-J7); J8 stays active for the guards.
SELECT pg_temp.job('00000000-0000-4000-8000-000000000006','d0000000-0000-4000-8000-00000000000d','completed');
SELECT pg_temp.job('00000000-0000-4000-8000-000000000005',NULL,'searching');  -- J5: released by a handoff
SELECT pg_temp.offer('00000000-0000-4000-8000-000000000006','d0000000-0000-4000-8000-00000000000d','k6',ARRAY['created','delivery_attempted','acknowledged','accepted']);
-- J5: handed back after acceptance (what /driver-unable records): declined after accepted.
SELECT pg_temp.offer('00000000-0000-4000-8000-000000000005','d0000000-0000-4000-8000-00000000000d','k5',ARRAY['created','delivery_attempted','acknowledged','accepted']);
SELECT pg_temp.offer('00000000-0000-4000-8000-000000000005','d0000000-0000-4000-8000-00000000000d','k5',ARRAY['declined'],now()-interval '30 minutes');

-- 1. Attribution by the recorded actor, never by the free-text reason (all jobs triggers active).
SELECT pg_temp.job('00000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-00000000000d');
SELECT pg_temp.offer('00000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-00000000000d','k1',ARRAY['created','delivery_attempted','acknowledged','accepted']);
INSERT INTO results SELECT 1,'driver cancels (reason never mentions a driver): cancelled',
  public.cancel_job_with_actor('00000000-0000-4000-8000-000000000001','Customer asked me to cancel','d0000000-0000-4000-8000-00000000000d','driver'),'';
SELECT pg_temp.job('00000000-0000-4000-8000-000000000002','d0000000-0000-4000-8000-00000000000d');
SELECT pg_temp.offer('00000000-0000-4000-8000-000000000002','d0000000-0000-4000-8000-00000000000d','k2',ARRAY['created','delivery_attempted','acknowledged','accepted']);
INSERT INTO results SELECT 1,'customer cancels with reason "driver was late": cancelled',
  public.cancel_job_with_actor('00000000-0000-4000-8000-000000000002','driver was late','c0000000-0000-4000-8000-00000000000c','customer'),'';
SELECT pg_temp.job('00000000-0000-4000-8000-000000000003','d0000000-0000-4000-8000-00000000000d');
SELECT pg_temp.offer('00000000-0000-4000-8000-000000000003','d0000000-0000-4000-8000-00000000000d','k3',ARRAY['created','delivery_attempted','acknowledged','accepted']);
INSERT INTO results SELECT 1,'admin cancels: cancelled',
  public.cancel_job_with_actor('00000000-0000-4000-8000-000000000003','driver no-show reported','a0000000-0000-4000-8000-00000000000a','admin'),'';
SELECT pg_temp.job('00000000-0000-4000-8000-000000000004','d0000000-0000-4000-8000-00000000000d');
SELECT pg_temp.offer('00000000-0000-4000-8000-000000000004','d0000000-0000-4000-8000-00000000000d','k4',ARRAY['created','delivery_attempted','acknowledged','accepted']);
INSERT INTO results SELECT 1,'legacy cancel_job_safely (no actor) still works',public.cancel_job_safely('00000000-0000-4000-8000-000000000004','driver cancelled'),'';
-- J7: D accepted, then it was reassigned to driver E, and E cancels.
SELECT pg_temp.job('00000000-0000-4000-8000-000000000007','e0000000-0000-4000-8000-00000000000e');
SELECT pg_temp.offer('00000000-0000-4000-8000-000000000007','d0000000-0000-4000-8000-00000000000d','k7',ARRAY['created','delivery_attempted','acknowledged','accepted']);
INSERT INTO results SELECT 1,'E cancels the job reassigned to E: cancelled',
  public.cancel_job_with_actor('00000000-0000-4000-8000-000000000007','x','e0000000-0000-4000-8000-00000000000e','driver'),'';
SELECT pg_temp.job('00000000-0000-4000-8000-000000000008','d0000000-0000-4000-8000-00000000000d');
INSERT INTO results SELECT 1,'actor recorded with the cancellation (driver, D, assigned D)',
  metadata->>'cancelled_by_role'='driver' AND metadata->>'cancelled_by'='d0000000-0000-4000-8000-00000000000d' AND metadata->>'cancelled_driver_id'='d0000000-0000-4000-8000-00000000000d' AND status='cancelled',metadata::text
  FROM public.jobs WHERE id='00000000-0000-4000-8000-000000000001';
INSERT INTO results SELECT 1,'cancel_job_safely reason/time still written',metadata->>'cancellation_reason'='Customer asked me to cancel' AND metadata ? 'cancelled_at',''
  FROM public.jobs WHERE id='00000000-0000-4000-8000-000000000001';
-- 2. Guards and idempotency.
DO $t$ DECLARE r text; BEGIN
 BEGIN PERFORM public.cancel_job_with_actor('00000000-0000-4000-8000-000000000008','x','e0000000-0000-4000-8000-00000000000e','driver'); r:='none';
 EXCEPTION WHEN OTHERS THEN r:=SQLSTATE; END;
 INSERT INTO results VALUES (2,'another driver cannot cancel as driver (42501)',r='42501',r);
 BEGIN PERFORM public.cancel_job_with_actor('00000000-0000-4000-8000-000000000008','x','e0000000-0000-4000-8000-00000000000e','customer'); r:='none';
 EXCEPTION WHEN OTHERS THEN r:=SQLSTATE; END;
 INSERT INTO results VALUES (2,'non-customer cannot cancel as customer (42501)',r='42501',r);
 BEGIN PERFORM public.cancel_job_with_actor('00000000-0000-4000-8000-000000000008','x','d0000000-0000-4000-8000-00000000000d','system'); r:='none';
 EXCEPTION WHEN OTHERS THEN r:=SQLSTATE; END;
 INSERT INTO results VALUES (2,'unknown role rejected (22023)',r='22023',r);
 BEGIN PERFORM public.cancel_job_with_actor('00000000-0000-4000-8000-000000000008','x',NULL,'driver'); r:='none';
 EXCEPTION WHEN OTHERS THEN r:=SQLSTATE; END;
 INSERT INTO results VALUES (2,'missing actor rejected (22023)',r='22023',r);
END $t$;
INSERT INTO results SELECT 2,'refused attempts left J8 untouched',status='accepted' AND NOT (coalesce(metadata,'{}'::jsonb) ? 'cancelled_by'),status FROM public.jobs WHERE id='00000000-0000-4000-8000-000000000008';
INSERT INTO results SELECT 2,'repeat cancel by the customer returns true',
  public.cancel_job_with_actor('00000000-0000-4000-8000-000000000001','again','c0000000-0000-4000-8000-00000000000c','customer'),'';
INSERT INTO results SELECT 2,'repeat cancel never overwrites the original actor',metadata->>'cancelled_by_role'='driver' AND metadata->>'cancelled_by'='d0000000-0000-4000-8000-00000000000d',metadata->>'cancelled_by_role'
  FROM public.jobs WHERE id='00000000-0000-4000-8000-000000000001';
INSERT INTO results SELECT 2,'completed job cannot be cancelled (false, no actor)',
  NOT public.cancel_job_with_actor('00000000-0000-4000-8000-000000000006','x','c0000000-0000-4000-8000-00000000000c','customer')
  AND NOT EXISTS (SELECT 1 FROM public.jobs WHERE id='00000000-0000-4000-8000-000000000006' AND metadata ? 'cancelled_by'),'';

-- 3. Metrics for D from recorded events.
INSERT INTO results SELECT 3,'D accepted 7 bookings (reassigned and released ones still counted)',(m->>'acceptedBookings')::int=7,m::text FROM (SELECT pg_temp.m('d0000000-0000-4000-8000-00000000000d') m) s;
INSERT INTO results SELECT 3,'D driver-cancelled bookings = 1 (J1 only; not J2 customer, J3 admin, J7 by E)',(m->>'driverCancelledBookings')::int=1,m->>'driverCancelledBookings' FROM (SELECT pg_temp.m('d0000000-0000-4000-8000-00000000000d') m) s;
INSERT INTO results SELECT 3,'D handoffs after acceptance = 1 (J5)',(m->>'driverHandoffs')::int=1,m->>'driverHandoffs' FROM (SELECT pg_temp.m('d0000000-0000-4000-8000-00000000000d') m) s;
INSERT INTO results SELECT 3,'legacy cancellation without actor reported, not attributed (J4)',(m->>'unattributedCancellations')::int=1,m->>'unattributedCancellations' FROM (SELECT pg_temp.m('d0000000-0000-4000-8000-00000000000d') m) s;
INSERT INTO results SELECT 3,'D: 7 acknowledged offers, 7 accepted, 0 declined (handoff is not a pre-acceptance decline)',
  (m->>'acknowledgedOffers')::int=7 AND (m->>'acceptedOffers')::int=7 AND (m->>'declinedOffers')::int=0,m::text FROM (SELECT pg_temp.m('d0000000-0000-4000-8000-00000000000d') m) s;
INSERT INTO results SELECT 3,'E: the reassigned job E cancelled is not in E''s accepted set (no offer to E)',(m->>'acceptedBookings')::int=0 AND (m->>'driverCancelledBookings')::int=0,m::text FROM (SELECT pg_temp.m('e0000000-0000-4000-8000-00000000000e') m) s;

-- Contrast: the previous rule (reason text contains "driver", job still assigned to D) on the same
-- rows counts J2 (customer), J3 (admin) and J4 (no actor), misses J1 (D did cancel) and J5 (handoff).
INSERT INTO results SELECT 3,'contrast: old free-text rule gives 3 wrong attributions and misses J1',
  count(*)=3 AND bool_and(id<>'00000000-0000-4000-8000-000000000001'),string_agg(right(id::text,2),',' ORDER BY id)
  FROM public.jobs WHERE driver_id='d0000000-0000-4000-8000-00000000000d' AND status='cancelled'
   AND lower(coalesce(metadata->>'cancellation_reason','')) LIKE '%driver%';

-- 4. Per offer, not per job; window; attempted-only never counts.
DO $o$ BEGIN
 ALTER TABLE public.jobs DISABLE TRIGGER USER;
 PERFORM pg_temp.job('00000000-0000-4000-8000-000000000021',NULL,'searching');
 PERFORM pg_temp.job('00000000-0000-4000-8000-000000000022',NULL,'searching');
 PERFORM pg_temp.job('00000000-0000-4000-8000-000000000023',NULL,'searching');
 ALTER TABLE public.jobs ENABLE TRIGGER USER;
 PERFORM pg_temp.offer('00000000-0000-4000-8000-000000000021','f0000000-0000-4000-8000-00000000000f','a',ARRAY['created','acknowledged','declined'],now()-interval '3 hours');
 PERFORM pg_temp.offer('00000000-0000-4000-8000-000000000021','f0000000-0000-4000-8000-00000000000f','b',ARRAY['created','acknowledged','accepted'],now()-interval '2 hours');
 PERFORM pg_temp.offer('00000000-0000-4000-8000-000000000022','f0000000-0000-4000-8000-00000000000f','c',ARRAY['created','delivery_attempted'],now()-interval '2 hours');
 PERFORM pg_temp.offer('00000000-0000-4000-8000-000000000023','f0000000-0000-4000-8000-00000000000f','old',ARRAY['created','acknowledged','accepted'],now()-interval '40 days');
END $o$;
INSERT INTO results SELECT 4,'same job offered twice: 2 acknowledged offers, 1 accepted, 1 declined',
  (m->>'acknowledgedOffers')::int=2 AND (m->>'acceptedOffers')::int=1 AND (m->>'declinedOffers')::int=1,m::text FROM (SELECT pg_temp.m('f0000000-0000-4000-8000-00000000000f') m) s;
INSERT INTO results SELECT 4,'attempted-only offer: delivered 1, never acknowledged',(m->>'deliveredAttempts')::int=1,m->>'deliveredAttempts' FROM (SELECT pg_temp.m('f0000000-0000-4000-8000-00000000000f') m) s;
INSERT INTO results SELECT 4,'event older than the window excluded (1 accepted booking, not 2)',(m->>'acceptedBookings')::int=1,m->>'acceptedBookings' FROM (SELECT pg_temp.m('f0000000-0000-4000-8000-00000000000f') m) s;

-- 5. Volume: 1500 accepted offers are counted exactly (no row limit in the aggregate).
ALTER TABLE public.jobs DISABLE TRIGGER USER;
INSERT INTO public.jobs(id,tenant_id,customer_id,driver_id,pickup_address,dropoff_address,scheduled_time,payment_method,payment_status,country_code,currency_code,status)
 SELECT gen_random_uuid(),'11111111-1111-4111-8111-111111111111','c0000000-0000-4000-8000-00000000000c','90000000-0000-4000-8000-000000000009','a','b',now(),'card','authorized','GB','GBP','completed' FROM generate_series(1,1500);
ALTER TABLE public.jobs ENABLE TRIGGER USER;
SELECT pg_temp.offer(id,'90000000-0000-4000-8000-000000000009','v',ARRAY['created','acknowledged','accepted']) FROM public.jobs WHERE driver_id='90000000-0000-4000-8000-000000000009';
INSERT INTO results SELECT 5,'1500 accepted offers counted exactly',(m->>'acceptedOffers')::int=1500 AND (m->>'acceptedBookings')::int=1500,m::text FROM (SELECT pg_temp.m('90000000-0000-4000-8000-000000000009') m) s;

-- 6. Privileges: service_role only.
INSERT INTO results SELECT 6,'cancel_job_with_actor: service_role yes, authenticated/anon no',
  has_function_privilege('service_role','public.cancel_job_with_actor(uuid,text,uuid,text)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.cancel_job_with_actor(uuid,text,uuid,text)','EXECUTE')
  AND NOT has_function_privilege('anon','public.cancel_job_with_actor(uuid,text,uuid,text)','EXECUTE'),'';
INSERT INTO results SELECT 6,'driver_offer_metrics_v2: service_role yes, authenticated/anon no',
  has_function_privilege('service_role','public.driver_offer_metrics_v2(uuid,timestamptz)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.driver_offer_metrics_v2(uuid,timestamptz)','EXECUTE')
  AND NOT has_function_privilege('anon','public.driver_offer_metrics_v2(uuid,timestamptz)','EXECUTE'),'';

SELECT n, name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, left(coalesce(detail,''),90) AS detail FROM results ORDER BY n, name;
SELECT count(*) FILTER (WHERE NOT ok) AS failures, count(*) AS checks FROM results;
ROLLBACK;
