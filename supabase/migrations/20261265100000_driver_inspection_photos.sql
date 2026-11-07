-- Requires the tracked profile/vehicle schema reconciliation and submission guard.
alter table public.vehicles add column if not exists vehicle_subtype text;
alter table public.vehicles add column if not exists inspection_revision uuid not null default gen_random_uuid();
alter table public.profiles add column if not exists tenant_id uuid;
alter table public.profiles add column if not exists inspection_market_code text;
alter table public.profiles add column if not exists goods_in_transit_url text;

create or replace function public.protect_inspection_tenant()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.tenant_id is not null or new.inspection_market_code is not null or new.role = 'admin' then
        raise exception using errcode = '42501', message = 'Tenant, inspection market and admin assignment are server managed';
      end if;
    elsif new.tenant_id is distinct from old.tenant_id
       or new.inspection_market_code is distinct from old.inspection_market_code
       or (new.role = 'admin' and new.role is distinct from old.role) then
      raise exception using errcode = '42501', message = 'Tenant, inspection market and admin assignment are server managed';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists protect_inspection_tenant on public.profiles;
create trigger protect_inspection_tenant before insert or update on public.profiles
for each row execute function public.protect_inspection_tenant();

create or replace function public.rotate_vehicle_inspection_revision()
returns trigger language plpgsql set search_path = public as $$
begin
  if row(new.user_id,new.driver_id,new.type,new.capacity,new.vehicle_subtype,new.make,new.model,new.year,new.color,new.license_plate)
     is distinct from row(old.user_id,old.driver_id,old.type,old.capacity,old.vehicle_subtype,old.make,old.model,old.year,old.color,old.license_plate) then
    new.inspection_revision := gen_random_uuid();
  else
    new.inspection_revision := old.inspection_revision;
  end if;
  return new;
end;
$$;
drop trigger if exists rotate_vehicle_inspection_revision on public.vehicles;
create trigger rotate_vehicle_inspection_revision before update on public.vehicles
for each row execute function public.rotate_vehicle_inspection_revision();

create table if not exists public.driver_inspection_photos (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.profiles(id),
  tenant_id uuid not null,
  vehicle_id uuid not null,
  vehicle_revision uuid not null,
  slot text not null check (slot in ('front','rear','side','dashboard','seats_interior','left_side','right_side')),
  storage_path text not null unique,
  status text not null default 'pending' check (status in ('pending','approved','rejected','replaced')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  reason text
);
create unique index if not exists driver_inspection_one_current_slot
on public.driver_inspection_photos(vehicle_id,vehicle_revision,slot) where status <> 'replaced';
alter table public.driver_inspection_photos enable row level security;
revoke all on public.driver_inspection_photos from anon, authenticated;
grant select,insert,update on public.driver_inspection_photos to service_role;

insert into storage.buckets (id,name,public)
values ('vehicle-inspection-private','vehicle-inspection-private',false)
on conflict (id) do update set public=false;

create or replace function public.register_driver_inspection_photo(
  p_driver uuid,p_tenant uuid,p_vehicle uuid,p_revision uuid,p_slot text,p_path text
) returns uuid language plpgsql set search_path=public as $$
declare photo uuid;
begin
  perform 1 from public.vehicles where id=p_vehicle and user_id=p_driver and inspection_revision=p_revision for update;
  if not found then raise exception 'Vehicle changed; reload before uploading'; end if;
  update public.driver_inspection_photos set status='replaced'
    where vehicle_id=p_vehicle and vehicle_revision=p_revision and slot=p_slot and status<>'replaced';
  insert into public.driver_inspection_photos(driver_id,tenant_id,vehicle_id,vehicle_revision,slot,storage_path)
    values(p_driver,p_tenant,p_vehicle,p_revision,p_slot,p_path) returning id into photo;
  return photo;
end;
$$;
revoke all on function public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text) to service_role;

create or replace function public.submit_driver_with_current_inspection(
  p_driver uuid,p_tenant uuid,p_vehicle uuid,p_revision uuid,p_slots text[],p_market text,p_services jsonb
) returns boolean language plpgsql set search_path=public as $$
begin
  perform 1 from public.vehicles where id=p_vehicle and user_id=p_driver
    and inspection_revision=p_revision
    and service_eligibility is not distinct from p_services for update;
  if not found then return false; end if;
  if exists (
    select from unnest(p_slots) as required(slot)
    where not exists (
      select from public.driver_inspection_photos photo
      where photo.driver_id=p_driver and photo.tenant_id=p_tenant
        and photo.vehicle_id=p_vehicle and photo.vehicle_revision=p_revision
        and photo.slot=required.slot and photo.status='approved'
    )
  ) then return false; end if;
  update public.profiles set onboarding_completed=true, verification_status='under_review',
    driver_review_status='under_review', verification_notes=null, driver_review_notes=null,
    verification_blockers='[]', driver_review_blockers='[]', is_verified=false
  where id=p_driver and role='driver' and tenant_id=p_tenant and inspection_market_code=p_market and is_verified is not true
    and coalesce(driver_review_status,'') not in ('approved','under_review')
    and coalesce(verification_status,'') not in ('approved','under_review');
  return found;
end;
$$;
revoke all on function public.submit_driver_with_current_inspection(uuid,uuid,uuid,uuid,text[],text,jsonb) from public,anon,authenticated;
grant execute on function public.submit_driver_with_current_inspection(uuid,uuid,uuid,uuid,text[],text,jsonb) to service_role;

create or replace function public.reopen_changed_vehicle_review()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  update public.profiles set is_verified=false,
    verification_status='action_required', driver_review_status='action_required'
  where id=old.user_id and role='driver'
    and (is_verified is true or driver_review_status in ('approved','under_review'));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists reopen_changed_vehicle_review on public.vehicles;
create trigger reopen_changed_vehicle_review after update on public.vehicles
for each row when (old.inspection_revision is distinct from new.inspection_revision
  or old.service_eligibility is distinct from new.service_eligibility)
execute function public.reopen_changed_vehicle_review();

drop trigger if exists reopen_deleted_vehicle_review on public.vehicles;
create trigger reopen_deleted_vehicle_review after delete on public.vehicles
for each row execute function public.reopen_changed_vehicle_review();

create or replace function public.reopen_replaced_photo_review()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  update public.profiles set is_verified=false,
    verification_status='action_required', driver_review_status='action_required'
  where id=new.driver_id and tenant_id=new.tenant_id and role='driver'
    and (is_verified is true or driver_review_status in ('approved','under_review'));
  return new;
end;
$$;
drop trigger if exists reopen_replaced_photo_review on public.driver_inspection_photos;
create trigger reopen_replaced_photo_review after insert on public.driver_inspection_photos
for each row execute function public.reopen_replaced_photo_review();
