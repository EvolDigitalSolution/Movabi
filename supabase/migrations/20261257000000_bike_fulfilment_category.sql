do $$ begin
    if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='jobs' and column_name='fulfilment_category') then
        alter table jobs add column fulfilment_category text;
    end if;
    if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='jobs' and column_name='fulfilment_subtype') then
        alter table jobs add column fulfilment_subtype text;
    end if;
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name='vehicles')
       and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='vehicles' and column_name='vehicle_subtype') then
        alter table vehicles add column vehicle_subtype text;
    end if;
end $$;

comment on column jobs.fulfilment_category is 'Customer-selected fulfilment category: bike, car, small_van. NULL for pre-category history.';
comment on column jobs.fulfilment_subtype is 'Internal bike subtype: pedal_bicycle, e_bike, motorcycle, moped. NULL for non-bike or unknown.';
comment on column vehicles.vehicle_subtype is 'Driver approved vehicle subtype: pedal_bicycle, e_bike, motorcycle, moped.';
