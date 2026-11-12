-- Rollback for 20261268000000_cancellation_fee_quote. Restores cancel_job_with_actor exactly as
-- 20261267000000 defines it and drops the two added functions. Frozen quotes already written to
-- jobs.metadata stay (history is never erased). Roll the API back first: an API that calls
-- set_cancellation_policy_enabled / cancellation_fee_quote fails closed once this has run.
drop function if exists public.set_cancellation_policy_enabled(uuid,uuid,boolean);
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
drop function if exists public.cancellation_fee_quote(uuid, text, timestamptz);
