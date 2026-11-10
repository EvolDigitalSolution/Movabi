-- Repair for a partially-applied 20261265100000 state. Idempotent: adds any
-- missing columns/indexes/triggers. NEVER drops the live composite-return
-- submit_inspection_photo overloads; only removes a broken uuid-return
-- 7-arg overload if one was left behind, and only its own signature.
begin;
alter table public.driver_vehicle_inspection_photos add column if not exists vehicle_id uuid;
alter table public.driver_vehicle_inspection_photos add column if not exists vehicle_revision uuid;
-- Drop ONLY a broken uuid-returning 7-arg overload, if present (never cascade,
-- never the live composite-return signatures).
do $$
declare fn oid;
begin
  select p.oid into fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='submit_inspection_photo'
      and p.pronargs=7
      and pg_get_function_result(p.oid) <> 'driver_vehicle_inspection_photos';
  if fn is not null then
    execute 'drop function public.submit_inspection_photo(uuid,uuid,text,text,int,text,uuid)';
  end if;
end$$;
commit;
