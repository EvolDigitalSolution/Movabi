create or replace function enforce_job_vehicle_category()
returns trigger language plpgsql as $$
declare
    v_driver uuid := coalesce(NEW.driver_id, NEW.accepted_driver_id);
    v_accepted uuid := NEW.accepted_driver_id;
    v_type text;
    v_subtype text;
    v_status text;
    v_driver_tenant uuid;
    v_driver_country text;
    v_snapshot jsonb := coalesce(NEW.fulfilment_snapshot, '{}'::jsonb);
    v_category text := lower(coalesce(v_snapshot->>'category', NEW.fulfilment_category, ''));
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

    select lower(coalesce(type,'')), lower(coalesce(vehicle_subtype,'')), lower(coalesce(status,''))
    into v_type, v_subtype, v_status
    from vehicles
    where user_id = v_driver
    order by created_at desc
    limit 1;

    if v_status is null or v_status not in ('approved','active') then
        raise exception 'Driver vehicle is not approved (status=%).', v_status using errcode = 'VF010';
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
