-- Driver offer identity + immutable lifecycle events.
-- Events are append-only; ordering tolerates late acks racing expiry/acceptance.
create table if not exists driver_offer_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  job_id uuid not null references jobs(id) on delete cascade,
  driver_id uuid not null,
  offer_key text not null,
  event text not null check (event in ('created','delivery_attempted','acknowledged','accepted','declined','expired','withdrawn')),
  event_at timestamptz not null default now(),
  evidence jsonb not null default '{}'::jsonb,
  actor uuid,
  created_at timestamptz not null default now(),
  unique (job_id, driver_id, event, offer_key)
);
create index if not exists doe_driver_time on driver_offer_events(driver_id, event_at desc);
create index if not exists doe_job on driver_offer_events(job_id);
create index if not exists doe_tenant on driver_offer_events(tenant_id, event_at desc);

alter table driver_offer_events enable row level security;
drop policy if exists doe_tenant_read on driver_offer_events;
create policy doe_tenant_read on driver_offer_events for select
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid or (auth.jwt() ->> 'role') = 'service_role');

-- Append-only: no updates/deletes; events may arrive out of order.
create or replace function record_driver_offer_event(
  p_tenant uuid, p_job uuid, p_driver uuid, p_offer_key text, p_event text,
  p_actor uuid default null, p_evidence jsonb default '{}'::jsonb)
returns driver_offer_events language plpgsql security definer as $$
declare v driver_offer_events;
begin
  insert into driver_offer_events(tenant_id, job_id, driver_id, offer_key, event, actor, evidence)
    values(p_tenant,p_job,p_driver,p_offer_key,p_event,p_actor,coalesce(p_evidence,'{}'::jsonb))
  on conflict (job_id,driver_id,event,offer_key) do update set id=excluded.id
  returning * into v;
  return v;
end$$;

-- Authenticated delivery acknowledgement: driver-actor, recipient must match,
-- offer must exist and be unexpired per evidence.expires_at.
create or replace function acknowledge_driver_offer(
  p_job uuid, p_offer_key text)
returns driver_offer_events language plpgsql security definer set search_path=public as $$
declare v_actor uuid; v_job jobs; v driver_offer_events; v_created driver_offer_events;
begin
  v_actor := auth.uid();
  if v_actor is null then raise exception 'unauthenticated'; end if;
  select * into v_job from jobs where id=p_job;
  if not found then raise exception 'offer_job_missing'; end if;
  select * into v_created from driver_offer_events
   where job_id=p_job and driver_id=v_actor and event in ('created','delivery_attempted')
   order by event_at desc limit 1;
  if not found then raise exception 'offer_not_for_driver'; end if;
  if coalesce((v_created.evidence->>'expires_at')::timestamptz, now()+interval '1 second') <= now() then
    raise exception 'offer_expired';
  end if;
  return record_driver_offer_event(v_job.tenant_id,p_job,v_actor,p_offer_key,'acknowledged',v_actor,jsonb_build_object('ack_at',now()));
end$$;

-- Terminal lifecycle events (accepted/declined/expired/withdrawn) resolve the
-- latest open offer_key for (job,driver); idempotent on the same terminal.
create or replace function close_driver_offer(
  p_job uuid, p_driver uuid, p_event text)
returns driver_offer_events language plpgsql security definer set search_path=public as $$
declare v_created driver_offer_events;
begin
  if p_event not in ('accepted','declined','expired','withdrawn') then
    raise exception 'invalid_terminal_event';
  end if;
  select * into v_created from driver_offer_events
   where job_id=p_job and driver_id=p_driver and event='created'
   order by event_at desc limit 1;
  if not found then return null; end if;
  return record_driver_offer_event(v_created.tenant_id,p_job,p_driver,v_created.offer_key,p_event,null);
end$$;

-- Service-role ack variant: the route authenticates the driver, then passes
-- the verified actor. Same recipient/expiry checks as acknowledge_driver_offer.
create or replace function acknowledge_driver_offer_for(
  p_job uuid, p_driver uuid, p_offer_key text)
returns driver_offer_events language plpgsql security definer set search_path=public as $$
declare v_job jobs; v_created driver_offer_events;
begin
  select * into v_job from jobs where id=p_job;
  if not found then raise exception 'offer_job_missing'; end if;
  select * into v_created from driver_offer_events
   where job_id=p_job and driver_id=p_driver and event in ('created','delivery_attempted')
   order by event_at desc limit 1;
  if not found then raise exception 'offer_not_for_driver'; end if;
  if coalesce((v_created.evidence->>'expires_at')::timestamptz, now()+interval '1 second') <= now() then
    raise exception 'offer_expired';
  end if;
  return record_driver_offer_event(v_job.tenant_id,p_job,p_driver,p_offer_key,'acknowledged',p_driver,jsonb_build_object('ack_at',now()));
end$$;

-- Accepting an offer proves receipt: record acknowledgement atomically.
create or replace function close_driver_offer(
  p_job uuid, p_driver uuid, p_event text)
returns driver_offer_events language plpgsql security definer set search_path=public as $$
declare v_created driver_offer_events; v_out driver_offer_events;
begin
  if p_event not in ('accepted','declined','expired','withdrawn') then
    raise exception 'invalid_terminal_event';
  end if;
  select * into v_created from driver_offer_events
   where job_id=p_job and driver_id=p_driver and event='created'
   order by event_at desc limit 1;
  if not found then return null; end if;
  if p_event='accepted' then
    perform record_driver_offer_event(v_created.tenant_id,p_job,p_driver,v_created.offer_key,'acknowledged',p_driver,jsonb_build_object('ack_via','acceptance'));
  end if;
  return record_driver_offer_event(v_created.tenant_id,p_job,p_driver,v_created.offer_key,p_event,null);
end$$;

-- Privileged RPCs are service-role only — ordinary clients must not
-- impersonate another driver or forge lifecycle outcomes.
revoke all on function record_driver_offer_event(uuid,uuid,uuid,text,text,uuid,jsonb) from public, anon, authenticated;
revoke all on function close_driver_offer(uuid,uuid,text) from public, anon, authenticated;
revoke all on function acknowledge_driver_offer_for(uuid,uuid,text) from public, anon, authenticated;
grant execute on function record_driver_offer_event(uuid,uuid,uuid,text,text,uuid,jsonb) to service_role;
grant execute on function close_driver_offer(uuid,uuid,text) to service_role;
grant execute on function acknowledge_driver_offer_for(uuid,uuid,text) to service_role;
-- Self-ack stays available to authenticated drivers (auth.uid() = caller only).
revoke all on function acknowledge_driver_offer(uuid,text) from public, anon;
grant execute on function acknowledge_driver_offer(uuid,text) to authenticated, service_role;
