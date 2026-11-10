-- Six-slot vehicle inspection photos; private driver-docs storage paths.
-- One active record per (driver, slot); replacement supersedes the prior row.
create table if not exists driver_vehicle_inspection_photos (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null,
  tenant_id uuid not null,
  slot text not null check (slot in ('front','rear','dashboard','seats_interior','left_side','right_side')),
  storage_path text not null,
  status text not null default 'uploaded' check (status in ('uploaded','under_review','approved','rejected','replaced')),
  byte_size integer not null,
  content_type text not null,
  reviewed_by uuid,
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now(),
  unique (driver_id, slot, storage_path)
);
create index if not exists dvip_driver on driver_vehicle_inspection_photos(driver_id, slot, status);
alter table driver_vehicle_inspection_photos enable row level security;
drop policy if exists dvip_owner_read on driver_vehicle_inspection_photos;
create policy dvip_owner_read on driver_vehicle_inspection_photos for select
  using (driver_id = auth.uid() or (auth.jwt() ->> 'role') = 'service_role');
drop policy if exists dvip_owner_insert on driver_vehicle_inspection_photos;
create policy dvip_owner_insert on driver_vehicle_inspection_photos for insert
  with check (driver_id = auth.uid());

-- Replacement: mark prior active photo for the slot 'replaced' atomically.
create or replace function submit_inspection_photo(
  p_driver uuid, p_tenant uuid, p_slot text, p_path text, p_bytes int, p_ctype text)
returns driver_vehicle_inspection_photos language plpgsql security definer set search_path=public as $$
declare v driver_vehicle_inspection_photos;
begin
  update driver_vehicle_inspection_photos set status='replaced'
    where driver_id=p_driver and slot=p_slot and status in ('uploaded','under_review','approved','rejected');
  insert into driver_vehicle_inspection_photos(driver_id,tenant_id,slot,storage_path,byte_size,content_type,status)
    values(p_driver,p_tenant,p_slot,p_path,p_bytes,p_ctype,'under_review') returning * into v;
  return v;
end$$;
revoke all on function submit_inspection_photo(uuid,uuid,text,text,int,text) from public, anon, authenticated;
grant execute on function submit_inspection_photo(uuid,uuid,text,text,int,text) to service_role;

-- Service-role table grants for server-side reads (BYPASSRLS covers prod).
grant select, insert, update on driver_vehicle_inspection_photos to service_role;

-- Scope photos to the canonical vehicle: approvals never carry to a new
-- vehicle. replacement_required marks photos needing resubmission.
alter table driver_vehicle_inspection_photos add column if not exists vehicle_id uuid;
alter table driver_vehicle_inspection_photos drop constraint if exists driver_vehicle_inspection_photos_status_check;
alter table driver_vehicle_inspection_photos add constraint driver_vehicle_inspection_photos_status_check
  check (status in ('uploaded','under_review','approved','rejected','replaced','replacement_required'));
create index if not exists dvip_vehicle on driver_vehicle_inspection_photos(driver_id, vehicle_id, slot, status);

-- submit now requires the vehicle; approval/under_review rows for OTHER
-- vehicles are untouched — a vehicle change starts a fresh review state.
create or replace function submit_inspection_photo(
  p_driver uuid, p_tenant uuid, p_slot text, p_path text, p_bytes int, p_ctype text, p_vehicle uuid default null)
returns driver_vehicle_inspection_photos language plpgsql security definer set search_path=public as $$
declare v driver_vehicle_inspection_photos;
begin
  update driver_vehicle_inspection_photos set status='replaced'
    where driver_id=p_driver and slot=p_slot and vehicle_id is not distinct from p_vehicle
      and status in ('uploaded','under_review','approved','rejected','replacement_required');
  insert into driver_vehicle_inspection_photos(driver_id,tenant_id,slot,storage_path,byte_size,content_type,status,vehicle_id)
    values(p_driver,p_tenant,p_slot,p_path,p_bytes,p_ctype,'under_review',p_vehicle) returning * into v;
  return v;
end$$;
revoke all on function submit_inspection_photo(uuid,uuid,text,text,int,text,uuid) from public, anon, authenticated;
grant execute on function submit_inspection_photo(uuid,uuid,text,text,int,text,uuid) to service_role;

-- Storage-object ownership: a driver may only upload/read inside their own
-- documents/ or inspection/ prefix in the private driver-docs bucket.
do $wrap$ begin
  if not exists (select 1 from information_schema.schemata where schema_name='storage') then return; end if;
  drop policy if exists driver_docs_owner_insert on storage.objects;
  create policy driver_docs_owner_insert on storage.objects for insert to authenticated
    with check (bucket_id='driver-docs' and (name like 'documents/'||auth.uid()::text||'/%' or name like 'inspection/'||auth.uid()::text||'/%'));
  drop policy if exists driver_docs_owner_update on storage.objects;
  create policy driver_docs_owner_update on storage.objects for update to authenticated
    using (bucket_id='driver-docs' and (name like 'documents/'||auth.uid()::text||'/%' or name like 'inspection/'||auth.uid()::text||'/%'));
  drop policy if exists driver_docs_owner_select on storage.objects;
  create policy driver_docs_owner_select on storage.objects for select to authenticated
    using (bucket_id='driver-docs' and (name like 'documents/'||auth.uid()::text||'/%' or name like 'inspection/'||auth.uid()::text||'/%'));
end $wrap$;
