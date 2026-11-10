-- Repair for a partially-applied 20261265100000 state. Idempotent: adds any
-- missing columns/indexes/triggers and restores both submit_inspection_photo
-- composite signatures if the earlier attempt left an incompatible uuid-return
-- overload. Run after the corrected 20261265100000.
begin;
alter table public.driver_vehicle_inspection_photos add column if not exists vehicle_id uuid;
alter table public.driver_vehicle_inspection_photos add column if not exists vehicle_revision uuid;
alter table public.driver_vehicle_inspection_photos add column if not exists reason text;
-- Drop only the broken uuid-return overload (7-arg), never the live composite ones.
drop function if exists public.submit_inspection_photo(uuid,uuid,text,text,int,text,uuid) cascade;
-- Re-create both composite signatures via the corrected 20261265100000 bodies
-- (reapplied by the migration runner; this repair is a no-op when already good).
commit;
