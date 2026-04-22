-- ==============================================================================
-- MIGRATION: Add City Overrides to Pricing
-- DESCRIPTION: Adds city_id to pricing tables to support localized pricing.
-- DATE: 2026-04-15
-- ==============================================================================

DO $$
BEGIN
    -- Add city_id to pricing_rules
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pricing_rules' AND column_name = 'city_id') THEN
        ALTER TABLE pricing_rules ADD COLUMN city_id UUID REFERENCES cities(id);
        -- Update unique constraint to include city_id (handling NULL for country-level)
        ALTER TABLE pricing_rules DROP CONSTRAINT IF EXISTS pricing_rules_service_type_id_currency_code_country_code_key;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_rules_unique_city ON pricing_rules (service_type_id, currency_code, country_code, city_id) WHERE city_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_rules_unique_country ON pricing_rules (service_type_id, currency_code, country_code) WHERE city_id IS NULL;
    END IF;

    -- Add city_id to fixed_fare_bands
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'fixed_fare_bands' AND column_name = 'city_id') THEN
        ALTER TABLE fixed_fare_bands ADD COLUMN city_id UUID REFERENCES cities(id);
    END IF;
END $$;

-- PART 2 — Example Seeds for City Overrides
-- London Ride Overrides (Higher base fare)
DO $$
DECLARE
    v_london_id UUID;
    v_ride_id UUID;
BEGIN
    SELECT id INTO v_london_id FROM cities WHERE name = 'London' LIMIT 1;
    SELECT id INTO v_ride_id FROM service_types WHERE slug = 'ride' LIMIT 1;

    IF v_london_id IS NOT NULL AND v_ride_id IS NOT NULL THEN
        -- London Pricing Rule
        INSERT INTO pricing_rules (service_type_id, city_id, currency_code, country_code, base_fare, per_km_rate, minimum_fare)
        VALUES (v_ride_id, v_london_id, 'GBP', 'GB', 5.00, 2.00, 10.00)
        ON CONFLICT DO NOTHING;

        -- London Fixed Band (Short trip)
        INSERT INTO fixed_fare_bands (service_type_id, city_id, currency_code, country_code, min_distance_km, max_distance_km, flat_rate)
        VALUES (v_ride_id, v_london_id, 'GBP', 'GB', 0, 3, 15.00)
        ON CONFLICT DO NOTHING;
    END IF;
END $$;
