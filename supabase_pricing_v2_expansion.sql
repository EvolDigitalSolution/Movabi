-- ==============================================================================
-- MIGRATION: Pricing Conversion and Promo Support
-- DESCRIPTION: Adds tables and columns for price conversion and promo fares.
-- DATE: 2026-04-15
-- ==============================================================================

DO $$
BEGIN
    -- 1. Add Promo support to pricing_rules
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pricing_rules' AND column_name = 'is_promo') THEN
        ALTER TABLE pricing_rules ADD COLUMN is_promo BOOLEAN DEFAULT FALSE;
        ALTER TABLE pricing_rules ADD COLUMN promo_ends_at TIMESTAMP WITH TIME ZONE;
    END IF;

    -- 2. Create pricing_conversion_rules table
    CREATE TABLE IF NOT EXISTS pricing_conversion_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        base_country_code TEXT NOT NULL,
        target_country_code TEXT NOT NULL,
        base_currency_code TEXT NOT NULL,
        target_currency_code TEXT NOT NULL,
        service_type_slug TEXT, -- NULL means applies to all services unless specific rule exists
        exchange_rate NUMERIC NOT NULL DEFAULT 1.0,
        pricing_multiplier NUMERIC NOT NULL DEFAULT 1.0, -- Market adjustment (e.g. 0.8 for lower cost of living)
        minimum_fare_multiplier NUMERIC NOT NULL DEFAULT 1.0,
        rounding_increment NUMERIC DEFAULT 0.5, -- Round to nearest 0.50, 1.00, etc.
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(base_country_code, target_country_code, service_type_slug)
    );

    -- 3. Add indexes for performance
    CREATE INDEX IF NOT EXISTS idx_pricing_conversion_target ON pricing_conversion_rules (target_country_code, is_active);
    CREATE INDEX IF NOT EXISTS idx_pricing_rules_promo ON pricing_rules (is_promo) WHERE is_promo = TRUE;

END $$;
