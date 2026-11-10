-- Server-side driver-feed visibility by canonical vehicle category.
--
-- The app fetches searching jobs through PostgREST and filters vehicle
-- compatibility only client-side (driver.service.ts fetchAvailableJobs ->
-- vehicleCompatibility). This RESTRICTIVE policy enforces the same canonical
-- category/subtype match in the database without widening any existing policy:
-- permissive policies still decide the rows, and this one only removes rows a
-- driver's vehicle cannot serve.
--
-- Unaffected: customers (own jobs), assigned-driver history (driver_id set),
-- admins (profiles.role='admin' or tenant_users admin), service_role
-- (BYPASSRLS) and legacy free jobs with no category/snapshot.
create or replace function public.driver_vehicle_matches_job(
    p_driver uuid,
    p_category text,
    p_subtype text,
    p_snapshot jsonb,
    p_tenant uuid
) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
    with v as (
        select lower(coalesce(type,'')) as vtype,
               lower(coalesce(vehicle_subtype,'')) as vsubtype,
               coalesce(vehicle_verified, is_verified, false) as approved
        from public.vehicles
        where user_id = p_driver
        order by created_at desc
        limit 1
    )
    select case
        when p_driver is null then false
        when p_category is null or btrim(p_category) = '' then true
        when not coalesce((select approved from v), false) then false
        when p_tenant is not null and not exists (select 1 from public.profiles dp where dp.id = p_driver and dp.tenant_id = p_tenant) then false
        when lower(p_category) = 'bike' then
            coalesce((select vtype from v) ~ 'bike|motorcycle|scooter|bicycle|e-bike|e_bike|pedal', false)
            and (
                p_subtype is null or btrim(p_subtype) = ''
                or (select vsubtype from v) = lower(p_subtype)
            )
            and (
                p_snapshot is null
                or p_snapshot->'allowedSubtypes' is null
                or jsonb_array_length(p_snapshot->'allowedSubtypes') = 0
                or (select vsubtype from v) = any (
                    array(select jsonb_array_elements_text(p_snapshot->'allowedSubtypes'))
                )
            )
        when lower(p_category) = 'car' then
            coalesce((select vtype from v) ~ 'car|taxi|standard|van|bike|motorcycle|scooter|bicycle', false)
        when lower(p_category) in ('small_van','large_van') then
            coalesce((select vtype from v) ~ 'van', false)
        else false
    end;
$$;

revoke all on function public.driver_vehicle_matches_job(uuid,text,text,jsonb,uuid) from public, anon;
grant execute on function public.driver_vehicle_matches_job(uuid,text,text,jsonb,uuid) to authenticated, service_role;

drop policy if exists jobs_driver_feed_category_match on public.jobs;
create policy jobs_driver_feed_category_match on public.jobs
    as restrictive for select to authenticated
    using (
        driver_id is not null
        or customer_id = auth.uid()
        or exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role = 'admin'
        )
        or exists (
            select 1 from public.tenant_users tu
            where tu.user_id = auth.uid() and tu.role = 'admin' and tu.tenant_id = jobs.tenant_id
        )
        or public.driver_vehicle_matches_job(
            auth.uid(), jobs.fulfilment_category, jobs.fulfilment_subtype, jobs.fulfilment_snapshot, jobs.tenant_id
        )
    );

