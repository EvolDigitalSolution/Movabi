-- Driver cancellation attribution + offer metrics from recorded events.
--
-- Policy D9 (user decisions, 2026-11-12): a driver-attributable cancellation is DRIVER-INITIATED
-- ONLY, decided by the server-verified actor, never by free text. Two driver-initiated actions:
--   * the ASSIGNED driver cancels the booking (POST /api/booking/cancel by the session driver);
--   * the driver voluntarily hands back an ACCEPTED assignment (POST /api/booking/driver-unable),
--     recorded as a 'declined' offer event after that offer's 'accepted' event (close_driver_offer).
--     A handback counts once as a driver cancellation and is also reported as driverHandoffs.
-- Customer, admin and system removals (incl. no-shows) never count; historical cancellations with no
-- recorded actor are reported separately as unattributed.
--
-- Metric identity and window: one ASSIGNMENT = (driver, job) accepted by this driver, counted once
-- however many offers or re-acceptances it took. The denominator is the driver's assignments whose
-- acceptance falls in the window; every numerator/exclusion class is a subset of exactly those
-- assignments and each assignment is classified once.
--
-- Additive: cancel_job_safely is unchanged and still callable; nothing is enabled.

-- 1) Cancellation with the verified actor recorded in the SAME transaction.
create or replace function public.cancel_job_with_actor(
  p_job_id uuid, p_reason text, p_actor uuid, p_actor_role text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.jobs%rowtype; ok boolean;
begin
  if p_actor is null or p_actor_role is null or p_actor_role not in ('customer','driver','admin') then
    raise exception 'invalid cancellation actor' using errcode = '22023';
  end if;
  select * into strict j from public.jobs where id = p_job_id for update;
  if p_actor_role = 'driver' and j.driver_id is distinct from p_actor and j.accepted_driver_id is distinct from p_actor then
    raise exception 'cancellation actor is not the assigned driver' using errcode = '42501';
  end if;
  if p_actor_role = 'customer' and j.customer_id is distinct from p_actor then
    raise exception 'cancellation actor is not the customer' using errcode = '42501';
  end if;
  ok := public.cancel_job_safely(p_job_id, p_reason);
  -- Record the actor only for the call that actually cancelled. A repeat cancel of an already
  -- cancelled job returns true but never overwrites the original actor.
  if ok and j.status not in ('cancelled','canceled') then
    update public.jobs
       set metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
             'cancelled_by', p_actor, 'cancelled_by_role', p_actor_role, 'cancelled_driver_id', coalesce(j.driver_id, j.accepted_driver_id))
     where id = p_job_id;
  end if;
  return ok;
end $$;
revoke all on function public.cancel_job_with_actor(uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function public.cancel_job_with_actor(uuid,text,uuid,text) to service_role;

-- 2) Negotiated acceptances (customer accepts a driver's bid / driver accepts a counter-offer) do not
--    pass through dispatch offers. Record them as an accepted assignment so they enter the same
--    denominator. Only when the driver actually owns the job now; idempotent (one 'negotiation' offer).
create or replace function public.record_negotiated_assignment(p_job uuid, p_driver uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.jobs%rowtype;
begin
  select * into j from public.jobs where id = p_job;
  if not found or p_driver is null or (j.driver_id is distinct from p_driver and j.accepted_driver_id is distinct from p_driver) then
    return false;
  end if;
  perform public.record_driver_offer_event(j.tenant_id, p_job, p_driver, 'negotiation', e, p_driver, jsonb_build_object('via','negotiation'))
     from unnest(array['created','acknowledged','accepted']) e;
  return true;
end $$;
revoke all on function public.record_negotiated_assignment(uuid,uuid) from public, anon, authenticated;
grant execute on function public.record_negotiated_assignment(uuid,uuid) to service_role;

-- 3) Metrics computed in the database from recorded events (bounded, no row limits).
create or replace function public.driver_offer_metrics_v2(p_driver uuid, p_since timestamptz)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with ev as (
    select job_id, offer_key, event, event_at from public.driver_offer_events
     where driver_id = p_driver and event_at >= p_since
  ), offers as (
    select job_id, offer_key,
           bool_or(event = 'acknowledged')        as ack,
           bool_or(event = 'delivery_attempted')  as attempted,
           max(event_at) filter (where event = 'accepted') as accepted_at,
           max(event_at) filter (where event = 'declined') as declined_at,
           bool_or(event = 'expired')             as expired
      from ev group by job_id, offer_key
  ), assignments as (                       -- identity: (driver, job), acceptance in the window
    select job_id, bool_or(declined_at > accepted_at) as handed_back
      from offers where ack and accepted_at is not null group by job_id
  ), classified as (                        -- exactly one class per assignment
    select a.job_id,
      case
        when j.status in ('cancelled','canceled') and j.metadata->>'cancelled_by_role' = 'driver'
             and j.metadata->>'cancelled_by' = p_driver::text then 'driver_cancelled'
        when a.handed_back then 'driver_handoff'
        when j.status not in ('cancelled','canceled') or j.id is null then 'not_cancelled'
        when j.metadata->>'cancelled_by_role' = 'customer' then 'customer'
        when j.metadata->>'cancelled_by_role' = 'admin' then 'admin'
        when j.metadata->>'cancelled_by_role' = 'driver' then 'other_driver'
        when j.no_show_status is not null then 'customer_no_show'
        else 'unattributed'
      end as class
    from assignments a left join public.jobs j on j.id = a.job_id
  )
  select jsonb_build_object(
    'acknowledgedOffers', (select count(*) from offers where ack),
    'deliveredAttempts',  (select count(*) from offers where attempted),
    'acceptedOffers',     (select count(*) from offers where ack and accepted_at is not null),
    'declinedOffers',     (select count(*) from offers where ack and declined_at is not null and accepted_at is null),
    'expiredOffers',      (select count(*) from offers where ack and expired and accepted_at is null),
    'acceptedBookings',   (select count(*) from assignments),
    'driverCancelledBookings', (select count(*) from classified where class = 'driver_cancelled'),
    'driverHandoffs',     (select count(*) from classified where class = 'driver_handoff'),
    'customerCancellations', (select count(*) from classified where class = 'customer'),
    'adminCancellations', (select count(*) from classified where class = 'admin'),
    'otherDriverCancellations', (select count(*) from classified where class = 'other_driver'),
    'customerNoShows',    (select count(*) from classified where class = 'customer_no_show'),
    'unattributedCancellations', (select count(*) from classified where class = 'unattributed'));
$$;
revoke all on function public.driver_offer_metrics_v2(uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.driver_offer_metrics_v2(uuid,timestamptz) to service_role;
