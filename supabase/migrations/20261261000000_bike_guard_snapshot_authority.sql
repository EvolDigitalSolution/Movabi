-- Reviewed hardening of the Bike category guard.
--
-- 1. Vehicle approval comes from the canonical authority:
--    vehicles.vehicle_verified (written by the verification flow,
--    server/routes/verification.routes.ts) with vehicles.is_verified as the
--    legacy flag. vehicles.status is NOT added and existing rows are never
--    defaulted to approved.
-- 2. The frozen fulfilment snapshot wins. Legacy fulfilment_category and
--    metadata.service_vehicle_class are validated against it; contradictory
--    metadata raises instead of bypassing Bike isolation. Bookings with no
--    snapshot, no category and no metadata keep their historical behaviour.
create or replace function enforce_job_vehicle_category()
returns trigger language plpgsql as $$
declare
    v_driver uuid := coalesce(NEW.driver_id, NEW.accepted_driver_id);
    v_accepted uuid := NEW.accepted_driver_id;
    v_type text;
    v_subtype text;
    v_vehicle_verified boolean;
    v_is_verified boolean;
    v_driver_tenant uuid;
    v_driver_country text;
    v_snapshot jsonb := coalesce(NEW.fulfilment_snapshot, '{}'::jsonb);
    v_snapshot_category text := lower(coalesce(v_snapshot->>'category', ''));
    v_legacy_category text := lower(coalesce(NEW.fulfilment_category, ''));
    v_meta_class text := lower(coalesce(
        NEW.metadata->>'service_vehicle_class',
        NEW.metadata->>'vehicle_class',
        NEW.metadata->>'vehicleClass',
        NEW.metadata#>>'{ride_details,vehicle_class}',
        NEW.metadata#>>'{delivery_details,vehicleClass}',
        NEW.metadata#>>'{errand_details,vehicleClass}',
        ''));
    v_meta_category text;
    v_category text;
    v_allowed text[];
    v_required_kg numeric;
    v_required_cm numeric;
    v_bike_limits jsonb;
    v_subtype_limit jsonb;
begin
    if v_driver is null and v_accepted is null then
        return NEW;
    end if;

    if not exists (select 1 from information_schema.tables where table_schema='public' and table_name='vehicles') then
        raise exception 'Canonical vehicles table is missing; cannot enforce job vehicle category.' using errcode = 'VF001';
    end if;

    -- Metadata-only category for legacy rows. This can never contradict a
    -- frozen snapshot silently: the checks below raise first.
    v_meta_category := case
        when v_meta_class ~ 'bike|motorcycle|scooter|bicycle|pedal|e-bike|e_bike' then 'bike'
        when v_meta_class ~ 'large[_ ]van|luton' then 'large_van'
        when v_meta_class ~ 'van' then 'small_van'
        when v_meta_class ~ 'car|standard|taxi|minibus|seater|xl' then 'car'
        else null end;

    if v_snapshot_category <> '' and v_meta_category is not null and v_snapshot_category <> v_meta_category then
        raise exception 'Frozen fulfilment snapshot (%) contradicts metadata service vehicle class (%); reconciliation required.',
            v_snapshot_category, v_meta_category using errcode = 'VF011';
    end if;
    if v_snapshot_category <> '' and v_legacy_category <> '' and v_snapshot_category <> v_legacy_category then
        raise exception 'Frozen fulfilment snapshot (%) contradicts fulfilment_category (%); reconciliation required.',
            v_snapshot_category, v_legacy_category using errcode = 'VF011';
    end if;

    -- The frozen snapshot is authoritative; legacy category is a fallback;
    -- metadata is the last resort so contradictory metadata cannot bypass Bike
    -- isolation. An all-null legacy booking stays unenforced (historical).
    v_category := coalesce(nullif(v_snapshot_category, ''), nullif(v_legacy_category, ''), v_meta_category, '');
    if v_category = '' then
        return NEW;
    end if;

    select p.tenant_id, p.country_code
    into v_driver_tenant, v_driver_country
    from profiles p
    where p.id = coalesce(v_accepted, v_driver);

    if v_driver_tenant is not null and NEW.tenant_id is not null and v_driver_tenant <> NEW.tenant_id then
        raise exception 'Driver tenant does not match job tenant.' using errcode = 'VF008';
    end if;
    if v_driver_country is not null and NEW.country_code is not null and lower(v_driver_country) <> lower(NEW.country_code) then
        raise exception 'Driver country does not match job country.' using errcode = 'VF009';
    end if;

    select lower(coalesce(type,'')), lower(coalesce(vehicle_subtype,'')),
           coalesce(vehicle_verified,false), coalesce(is_verified,false)
    into v_type, v_subtype, v_vehicle_verified, v_is_verified
    from vehicles
    where user_id = v_driver
    order by created_at desc
    limit 1;

    -- Canonical vehicle_verified wins; legacy is_verified is a fallback only
    -- when vehicle_verified is NULL. An explicit false is never overridden.
    if not found or not coalesce(v_vehicle_verified, v_is_verified, false) then
        raise exception 'Driver vehicle is not approved.' using errcode = 'VF010';
    end if;

    if v_category = 'bike' then
        if not (v_type ~ 'bike|motorcycle|scooter|bicycle|e-bike|e_bike|pedal') then
            raise exception 'This job requires an approved Bike; driver vehicle % does not qualify.', v_type using errcode = 'VF002';
        end if;

        v_allowed := array(select jsonb_array_elements_text(v_snapshot->'allowed_subtypes'));
        if v_allowed is not null and array_length(v_allowed, 1) > 0 and not v_subtype = any(v_allowed) then
            raise exception 'Bike subtype % is not allowed for this job; allowed: %.', v_subtype, v_allowed using errcode = 'VF003';
        end if;

        v_bike_limits := v_snapshot->'bike_limits';
        v_required_kg := (v_snapshot->>'required_max_kg')::numeric;
        v_required_cm := (v_snapshot->>'required_max_cm')::numeric;
        if v_bike_limits is not null and v_subtype <> '' then
            v_subtype_limit := v_bike_limits->v_subtype;
            if v_subtype_limit is not null then
                if v_required_kg is not null and (v_subtype_limit->>'max_kg')::numeric < v_required_kg then
                    raise exception 'Driver % cannot carry %.2f kg for this bike job.', v_subtype, v_required_kg using errcode = 'VF004';
                end if;
                if v_required_cm is not null and (v_subtype_limit->>'max_cm')::numeric < v_required_cm then
                    raise exception 'Driver % cannot carry %.2f cm for this bike job.', v_subtype, v_required_cm using errcode = 'VF005';
                end if;
            end if;
        end if;
    elsif v_category = 'car' and not (v_type ~ 'car|taxi|standard' or v_type ~ 'van|bike|motorcycle|scooter|bicycle') then
        raise exception 'This job requires a Car; driver vehicle % does not qualify.', v_type using errcode = 'VF006';
    elsif v_category in ('small_van','large_van') and not (v_type ~ 'van') then
        raise exception 'This job requires a Van; driver vehicle % does not qualify.', v_type using errcode = 'VF007';
    end if;

    return NEW;
end;
$$;

drop trigger if exists enforce_job_vehicle_category_trigger on jobs;
create trigger enforce_job_vehicle_category_trigger
    before insert or update of driver_id, accepted_driver_id on jobs
    for each row
    execute function enforce_job_vehicle_category();

comment on function enforce_job_vehicle_category() is
    'Bike/car/van isolation: frozen fulfilment_snapshot wins, legacy metadata is validated against it, approval comes from vehicles.vehicle_verified/is_verified (never vehicles.status, never a default-to-approved).';

