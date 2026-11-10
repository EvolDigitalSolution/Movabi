do $$ begin
    if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='market_availability' and column_name='bike_limits') then
        alter table market_availability add column bike_limits jsonb default null;
    end if;
    if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='jobs' and column_name='fulfilment_snapshot') then
        alter table jobs add column fulfilment_snapshot jsonb default null;
    end if;
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name='quote_market_adjustments')
       and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='quote_market_adjustments' and column_name='fulfilment_snapshot') then
        alter table quote_market_adjustments add column fulfilment_snapshot jsonb default null;
    end if;
end $$;

comment on column market_availability.bike_limits is 'Market-configured per-subtype parcel limits: {pedal_bicycle:{max_kg, max_cm}, e_bike:{...}, motorcycle:{...}, moped:{...}}. NULL means not configured (fail closed).';
comment on column jobs.fulfilment_snapshot is 'Frozen quote-time fulfilment category, allowed subtypes and parcel limits; source of truth for assignment.';
