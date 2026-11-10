-- Per-driver completion PIN policy + attempt limiting.
-- Precedence: driver override > market completion_pin_policy > default(required).
create table if not exists driver_pin_policies (
  driver_id uuid not null,
  tenant_id uuid not null,
  policy text not null check (policy in ('required','optional','disabled')),
  set_by uuid,
  set_at timestamptz not null default now(),
  reason text,
  primary key (driver_id, tenant_id)
);
alter table driver_pin_policies enable row level security;
drop policy if exists dpp_service on driver_pin_policies;
create policy dpp_service on driver_pin_policies for all using ((auth.jwt() ->> 'role') = 'service_role');
grant select, insert, update, delete on driver_pin_policies to service_role;

-- Effective policy resolution (server-side only).
create or replace function effective_completion_pin_policy(p_driver uuid, p_tenant uuid, p_market_enabled boolean default true)
returns text language plpgsql security definer set search_path=public as $$
declare v text;
begin
  select policy into v from driver_pin_policies where driver_id=p_driver and tenant_id=p_tenant;
  if found then return v; end if;
  return case when p_market_enabled then 'required' else 'disabled' end;
end$$;
revoke all on function effective_completion_pin_policy(uuid,uuid,boolean) from public, anon, authenticated;
grant execute on function effective_completion_pin_policy(uuid,uuid,boolean) to service_role;

-- Attempt limiting + replay protection on the secret store.
alter table job_completion_secrets add column if not exists attempts int not null default 0;
alter table job_completion_secrets add column if not exists locked_until timestamptz;
alter table job_completion_secrets add column if not exists verified_at timestamptz;

-- Atomic attempt recording: returns 'ok'|'locked'|'wrong'|'done'.
-- 5 wrong attempts lock for 15 minutes; success locks the secret to replay.
create or replace function record_pin_attempt(p_job uuid, p_pin text, p_expected text)
returns text language plpgsql security definer set search_path=public as $$
declare v job_completion_secrets;
begin
  select * into v from job_completion_secrets where job_id=p_job for update;
  if not found then return 'no_secret'; end if;
  if v.verified_at is not null then return 'done'; end if;
  if v.locked_until is not null and v.locked_until > now() then return 'locked'; end if;
  if p_pin = p_expected then
    update job_completion_secrets set verified_at=now(), locked_until=null where job_id=p_job;
    return 'ok';
  end if;
  update job_completion_secrets set attempts=attempts+1,
    locked_until = case when attempts+1 >= 5 then now() + interval '15 minutes' else locked_until end
    where job_id=p_job;
  return 'wrong';
end$$;
revoke all on function record_pin_attempt(uuid,text,text) from public, anon, authenticated;
grant execute on function record_pin_attempt(uuid,text,text) to service_role;
