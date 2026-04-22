-- ==============================================================================
-- SEED: Supabase Safe Baseline Seed
-- DESCRIPTION: Inserts missing baseline configuration and reference data.
--              Idempotent, additive-only, and production-safe.
-- DATE: 2026-04-15
-- ==============================================================================

-- PART 1 — Service Types
-- These are the core business domains supported by the platform.
INSERT INTO service_types (slug, name, base_price, price_per_km)
SELECT 'ride', 'Ride', 2.50, 1.20
WHERE NOT EXISTS (SELECT 1 FROM service_types WHERE slug = 'ride');

INSERT INTO service_types (slug, name, base_price, price_per_km)
SELECT 'errand', 'Errand', 5.00, 0.80
WHERE NOT EXISTS (SELECT 1 FROM service_types WHERE slug = 'errand');

INSERT INTO service_types (slug, name, base_price, price_per_km)
SELECT 'delivery', 'Package Delivery', 3.50, 1.00
WHERE NOT EXISTS (SELECT 1 FROM service_types WHERE slug = 'delivery');

INSERT INTO service_types (slug, name, base_price, price_per_km)
SELECT 'van-moving', 'Van Moving', 15.00, 2.50
WHERE NOT EXISTS (SELECT 1 FROM service_types WHERE slug = 'van-moving');


-- PART 2 — Cities
-- Baseline active cities for the UK market.
INSERT INTO cities (name, lat, lng, radius_km, is_active, base_surge_multiplier)
SELECT 'London', 51.5074, -0.1278, 50, TRUE, 1.0
WHERE NOT EXISTS (SELECT 1 FROM cities WHERE name = 'London');

INSERT INTO cities (name, lat, lng, radius_km, is_active, base_surge_multiplier)
SELECT 'Manchester', 53.4808, -2.2426, 30, TRUE, 1.0
WHERE NOT EXISTS (SELECT 1 FROM cities WHERE name = 'Manchester');

INSERT INTO cities (name, lat, lng, radius_km, is_active, base_surge_multiplier)
SELECT 'Birmingham', 52.4862, -1.8904, 35, TRUE, 1.0
WHERE NOT EXISTS (SELECT 1 FROM cities WHERE name = 'Birmingham');


-- PART 3 — Pricing Rules
-- Baseline active pricing config for common service types in GBP.
INSERT INTO pricing_rules (service_type_id, currency_code, country_code, base_fare, per_km_rate, minimum_fare)
SELECT id, 'GBP', 'GB', 3.00, 1.50, 5.00
FROM service_types WHERE slug = 'ride'
AND NOT EXISTS (SELECT 1 FROM pricing_rules pr JOIN service_types st ON pr.service_type_id = st.id WHERE st.slug = 'ride' AND pr.currency_code = 'GBP' AND pr.country_code = 'GB');

INSERT INTO pricing_rules (service_type_id, currency_code, country_code, base_fare, per_km_rate, minimum_fare)
SELECT id, 'GBP', 'GB', 7.50, 1.00, 10.00
FROM service_types WHERE slug = 'errand'
AND NOT EXISTS (SELECT 1 FROM pricing_rules pr JOIN service_types st ON pr.service_type_id = st.id WHERE st.slug = 'errand' AND pr.currency_code = 'GBP' AND pr.country_code = 'GB');

INSERT INTO pricing_rules (service_type_id, currency_code, country_code, base_fare, per_km_rate, minimum_fare)
SELECT id, 'GBP', 'GB', 5.00, 1.20, 7.00
FROM service_types WHERE slug = 'delivery'
AND NOT EXISTS (SELECT 1 FROM pricing_rules pr JOIN service_types st ON pr.service_type_id = st.id WHERE st.slug = 'delivery' AND pr.currency_code = 'GBP' AND pr.country_code = 'GB');

INSERT INTO pricing_rules (service_type_id, currency_code, country_code, base_fare, per_km_rate, minimum_fare)
SELECT id, 'GBP', 'GB', 20.00, 3.00, 30.00
FROM service_types WHERE slug = 'van-moving'
AND NOT EXISTS (SELECT 1 FROM pricing_rules pr JOIN service_types st ON pr.service_type_id = st.id WHERE st.slug = 'van-moving' AND pr.currency_code = 'GBP' AND pr.country_code = 'GB');


-- PART 4 — Fixed Fare Bands
-- Sensible default fare bands for short/medium/long distances (Ride only).
INSERT INTO fixed_fare_bands (service_type_id, currency_code, country_code, min_distance_km, max_distance_km, flat_rate)
SELECT id, 'GBP', 'GB', 0, 2, 6.00
FROM service_types WHERE slug = 'ride'
AND NOT EXISTS (SELECT 1 FROM fixed_fare_bands ffb JOIN service_types st ON ffb.service_type_id = st.id WHERE st.slug = 'ride' AND ffb.currency_code = 'GBP' AND ffb.country_code = 'GB' AND ffb.min_distance_km = 0);

INSERT INTO fixed_fare_bands (service_type_id, currency_code, country_code, min_distance_km, max_distance_km, flat_rate)
SELECT id, 'GBP', 'GB', 2, 5, 12.00
FROM service_types WHERE slug = 'ride'
AND NOT EXISTS (SELECT 1 FROM fixed_fare_bands ffb JOIN service_types st ON ffb.service_type_id = st.id WHERE st.slug = 'ride' AND ffb.currency_code = 'GBP' AND ffb.country_code = 'GB' AND ffb.min_distance_km = 2);

INSERT INTO fixed_fare_bands (service_type_id, currency_code, country_code, min_distance_km, max_distance_km, flat_rate)
SELECT id, 'GBP', 'GB', 5, 10, 20.00
FROM service_types WHERE slug = 'ride'
AND NOT EXISTS (SELECT 1 FROM fixed_fare_bands ffb JOIN service_types st ON ffb.service_type_id = st.id WHERE st.slug = 'ride' AND ffb.currency_code = 'GBP' AND ffb.country_code = 'GB' AND ffb.min_distance_km = 5);


-- PART 5 — Subscription Plans
-- Baseline active plans for drivers.
INSERT INTO subscription_plans (plan_code, country_code, currency_code, stripe_price_id, amount, interval, display_name, features)
SELECT 'starter', 'GB', 'GBP', 'price_mock_weekly_starter', 10.00, 'week', 'Weekly Starter', '["Basic job matching", "15% Platform fee", "Standard support"]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE plan_code = 'starter' AND country_code = 'GB');

INSERT INTO subscription_plans (plan_code, country_code, currency_code, stripe_price_id, amount, interval, display_name, features)
SELECT 'pro', 'GB', 'GBP', 'price_mock_weekly_pro', 25.00, 'week', 'Weekly Pro', '["Priority job matching", "Keep 100% of your fares (0% Fee)", "24/7 Premium support"]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE plan_code = 'pro' AND country_code = 'GB');


-- PART 6 — Verification Queries
-- Run these to verify the seed data was inserted correctly.
-- SELECT * FROM service_types;
-- SELECT * FROM cities;
-- SELECT * FROM pricing_rules;
-- SELECT * FROM fixed_fare_bands;
-- SELECT * FROM subscription_plans;
