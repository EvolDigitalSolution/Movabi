-- Driver cancellation attribution + offer metrics from recorded events.
--
-- Policy D9 (user decision, 2026-11-12): a driver-attributable cancellation is DRIVER-INITIATED
-- ONLY. It is decided by the server-verified actor, never by free-text reasons. Two driver-initiated
-- actions exist and are counted separately:
--   * the ASSIGNED driver cancels the booking (POST /api/booking/cancel by the session driver);
--   * the driver hands an ACCEPTED offer back (POST /api/booking/driver-unable), recorded as a
--     'declined' offer event after that offer's 'accepted' event (close_driver_offer).
-- Customer and admin cancellations, and legacy cancellations with no recorded actor, never count.
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

-- 2) Offer metrics computed in the database from recorded events (bounded, no row limits).
--    Per OFFER (job_id, offer_key), not per job. Denominator for cancellations = jobs this driver
--    ACCEPTED in the window (from 'accepted' events), so later reassignment never hides them.
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
  ), accepted_jobs as (
    select distinct job_id from offers where ack and accepted_at is not null
  ), handoffs as (
    select distinct job_id from offers where ack and accepted_at is not null and declined_at > accepted_at
  ), driver_cancels as (
    select a.job_id from accepted_jobs a join public.jobs j on j.id = a.job_id
     where j.status in ('cancelled','canceled')
       and j.metadata->>'cancelled_by_role' = 'driver'
       and j.metadata->>'cancelled_by' = p_driver::text
  ), unattributed as (
    select a.job_id from accepted_jobs a join public.jobs j on j.id = a.job_id
     where j.status in ('cancelled','canceled') and j.metadata->>'cancelled_by_role' is null
  )
  select jsonb_build_object(
    'acknowledgedOffers', (select count(*) from offers where ack),
    'deliveredAttempts',  (select count(*) from offers where attempted),
    'acceptedOffers',     (select count(*) from offers where ack and accepted_at is not null),
    'declinedOffers',     (select count(*) from offers where ack and declined_at is not null and accepted_at is null),
    'expiredOffers',      (select count(*) from offers where ack and expired and accepted_at is null),
    'acceptedBookings',   (select count(*) from accepted_jobs),
    'driverCancelledBookings', (select count(*) from driver_cancels),
    'driverHandoffs',     (select count(*) from handoffs h where not exists (select 1 from driver_cancels c where c.job_id = h.job_id)),
    'unattributedCancellations', (select count(*) from unattributed));
$$;
revoke all on function public.driver_offer_metrics_v2(uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.driver_offer_metrics_v2(uuid,timestamptz) to service_role;
