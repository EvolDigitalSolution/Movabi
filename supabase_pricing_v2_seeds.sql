-- ==============================================================================
-- SEED: Pricing V2 Seeds (Conversion & Promos)
-- DESCRIPTION: Inserts baseline conversion rules and promo fares.
-- DATE: 2026-04-15
-- ==============================================================================

-- 1. Conversion Rules (Base Market: GB/GBP)
-- GB to NG (Nigeria)
-- Approx FX: 1 GBP = 1500 NGN (Example)
-- Multiplier: 0.6 (Lower cost of living adjustment)
INSERT INTO pricing_conversion_rules (base_country_code, target_country_code, base_currency_code, target_currency_code, exchange_rate, pricing_multiplier, minimum_fare_multiplier, rounding_increment)
SELECT 'GB', 'NG', 'GBP', 'NGN', 1500.0, 0.6, 0.5, 100.0
WHERE NOT EXISTS (SELECT 1 FROM pricing_conversion_rules WHERE target_country_code = 'NG');

-- GB to AE (UAE)
-- Approx FX: 1 GBP = 4.6 AED
-- Multiplier: 1.1 (Higher cost market)
INSERT INTO pricing_conversion_rules (base_country_code, target_country_code, base_currency_code, target_currency_code, exchange_rate, pricing_multiplier, minimum_fare_multiplier, rounding_increment)
SELECT 'GB', 'AE', 'GBP', 'AED', 4.6, 1.1, 1.2, 1.0
WHERE NOT EXISTS (SELECT 1 FROM pricing_conversion_rules WHERE target_country_code = 'AE');


-- 2. Promo Fares
-- GB: Lower minimum fare for 30 days
DO $$
DECLARE
    v_ride_id UUID;
BEGIN
    SELECT id INTO v_ride_id FROM service_types WHERE slug = 'ride' LIMIT 1;

    IF v_ride_id IS NOT NULL THEN
        INSERT INTO pricing_rules (service_type_id, country_code, currency_code, base_fare, per_km_rate, minimum_fare, is_promo, promo_ends_at)
        VALUES (v_ride_id, 'GB', 'GBP', 3.00, 1.50, 3.50, TRUE, NOW() + INTERVAL '30 days')
        ON CONFLICT DO NOTHING;
    END IF;
END $$;

-- NG: Onboarding launch fares for Lagos
DO $$
DECLARE
    v_ride_id UUID;
    v_lagos_id UUID;
BEGIN
    SELECT id INTO v_ride_id FROM service_types WHERE slug = 'ride' LIMIT 1;
    SELECT id INTO v_lagos_id FROM cities WHERE name = 'Lagos' LIMIT 1;

    -- Create Lagos if missing for seed
    IF v_lagos_id IS NULL THEN
        INSERT INTO cities (name, lat, lng, radius_km, is_active)
        VALUES ('Lagos', 6.5244, 3.3792, 40, TRUE)
        RETURNING id INTO v_lagos_id;
    END IF;

    IF v_ride_id IS NOT NULL AND v_lagos_id IS NOT NULL THEN
        INSERT INTO pricing_rules (service_type_id, city_id, country_code, currency_code, base_fare, per_km_rate, minimum_fare, is_promo, promo_ends_at)
        VALUES (v_ride_id, v_lagos_id, 'NG', 'NGN', 500.0, 200.0, 800.0, TRUE, NOW() + INTERVAL '60 days')
        ON CONFLICT DO NOTHING;
    END IF;
END $$;
