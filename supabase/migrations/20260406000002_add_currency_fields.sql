-- Migration: Add Currency and Country Fields for Multi-Country Readiness
-- Date: 2026-04-06

-- 1. Add currency_code and country_code to jobs table
ALTER TABLE public.jobs
ADD COLUMN IF NOT EXISTS currency_code TEXT DEFAULT 'GBP',
ADD COLUMN IF NOT EXISTS country_code TEXT DEFAULT 'GB';

-- 2. Add currency_code and country_code to driver_earnings table
ALTER TABLE public.driver_earnings
ADD COLUMN IF NOT EXISTS currency_code TEXT DEFAULT 'GBP',
ADD COLUMN IF NOT EXISTS country_code TEXT DEFAULT 'GB';

-- 3. Add currency_code and country_code to subscriptions table
ALTER TABLE public.subscriptions
ADD COLUMN IF NOT EXISTS currency_code TEXT DEFAULT 'GBP',
ADD COLUMN IF NOT EXISTS country_code TEXT DEFAULT 'GB';

-- 4. Add currency_code and country_code to profiles table
-- This allows us to know the driver's home country/currency
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS currency_code TEXT DEFAULT 'GBP',
ADD COLUMN IF NOT EXISTS country_code TEXT DEFAULT 'GB';

-- 5. Update existing rows to ensure defaults are applied
UPDATE public.jobs SET currency_code = 'GBP', country_code = 'GB' WHERE currency_code IS NULL;
UPDATE public.driver_earnings SET currency_code = 'GBP', country_code = 'GB' WHERE currency_code IS NULL;
UPDATE public.subscriptions SET currency_code = 'GBP', country_code = 'GB' WHERE currency_code IS NULL;
UPDATE public.profiles SET currency_code = 'GBP', country_code = 'GB' WHERE currency_code IS NULL;

-- 6. Ensure NOT NULL constraints
ALTER TABLE public.jobs ALTER COLUMN currency_code SET NOT NULL;
ALTER TABLE public.jobs ALTER COLUMN country_code SET NOT NULL;
ALTER TABLE public.driver_earnings ALTER COLUMN currency_code SET NOT NULL;
ALTER TABLE public.driver_earnings ALTER COLUMN country_code SET NOT NULL;
ALTER TABLE public.subscriptions ALTER COLUMN currency_code SET NOT NULL;
ALTER TABLE public.subscriptions ALTER COLUMN country_code SET NOT NULL;
ALTER TABLE public.profiles ALTER COLUMN currency_code SET NOT NULL;
ALTER TABLE public.profiles ALTER COLUMN country_code SET NOT NULL;

-- 8. Add currency_code and country_code to pricing_rules table
ALTER TABLE public.pricing_rules
ADD COLUMN IF NOT EXISTS currency_code TEXT DEFAULT 'GBP',
ADD COLUMN IF NOT EXISTS country_code TEXT DEFAULT 'GB';

-- 9. Add currency_code and country_code to fixed_fare_bands table
ALTER TABLE public.fixed_fare_bands
ADD COLUMN IF NOT EXISTS currency_code TEXT DEFAULT 'GBP',
ADD COLUMN IF NOT EXISTS country_code TEXT DEFAULT 'GB';

-- 10. Update existing rows for pricing tables
UPDATE public.pricing_rules SET currency_code = 'GBP', country_code = 'GB' WHERE currency_code IS NULL;
UPDATE public.fixed_fare_bands SET currency_code = 'GBP', country_code = 'GB' WHERE currency_code IS NULL;

-- 11. Ensure NOT NULL constraints for pricing tables
ALTER TABLE public.pricing_rules ALTER COLUMN currency_code SET NOT NULL;
ALTER TABLE public.pricing_rules ALTER COLUMN country_code SET NOT NULL;
ALTER TABLE public.fixed_fare_bands ALTER COLUMN currency_code SET NOT NULL;
ALTER TABLE public.fixed_fare_bands ALTER COLUMN country_code SET NOT NULL;
CREATE OR REPLACE FUNCTION calculate_job_payouts()
RETURNS TRIGGER AS $$
DECLARE
    v_pricing_plan TEXT;
    v_commission_rate DECIMAL;
    v_currency_code TEXT;
    v_country_code TEXT;
    v_base_fare DECIMAL;
    v_service_fee DECIMAL; -- Fee charged to customer (platform revenue)
    v_commission_fee DECIMAL; -- Fee charged to driver (platform revenue)
    v_driver_payout DECIMAL;
    v_platform_total DECIMAL;
BEGIN
    -- SOURCE OF TRUTH RULE: Pricing is snapshotted at the moment of COMPLETION.
    
    -- Only run when job status changes to 'completed'
    IF (NEW.status = 'completed' AND (OLD.status IS NULL OR OLD.status != 'completed')) THEN
        
        -- Defensive check: Ensure we have a driver and a price
        IF NEW.driver_id IS NULL OR NEW.price IS NULL OR NEW.price <= 0 THEN
            NEW.pricing_plan_used := 'starter';
            NEW.commission_rate_used := 15.00;
            NEW.base_fare := COALESCE(NEW.price, 0);
            NEW.service_fee := 0;
            NEW.commission_fee := 0;
            NEW.platform_fee := 0;
            NEW.driver_payout := COALESCE(NEW.price, 0);
            NEW.currency_code := 'GBP';
            NEW.country_code := 'GB';
            RETURN NEW;
        END IF;

        -- Get driver's current plan, commission rate, and currency info from profile
        SELECT pricing_plan, commission_rate, currency_code, country_code 
        INTO v_pricing_plan, v_commission_rate, v_currency_code, v_country_code
        FROM profiles
        WHERE id = NEW.driver_id;

        -- Safe defaults
        v_pricing_plan := COALESCE(v_pricing_plan, 'starter');
        v_commission_rate := COALESCE(v_commission_rate, 15.00);
        v_currency_code := COALESCE(v_currency_code, 'GBP');
        v_country_code := COALESCE(v_country_code, 'GB');
        
        -- CALCULATION LOGIC
        v_service_fee := ROUND(NEW.price * 0.10, 2); 
        v_base_fare := NEW.price - v_service_fee;

        IF v_pricing_plan = 'pro' THEN
            v_commission_fee := 0.00;
            v_driver_payout := v_base_fare;
        ELSE
            v_commission_fee := ROUND(v_base_fare * (v_commission_rate / 100), 2);
            v_driver_payout := v_base_fare - v_commission_fee;
        END IF;

        v_platform_total := v_service_fee + v_commission_fee;

        -- SNAPSHOT VALUES TO JOB
        NEW.pricing_plan_used := v_pricing_plan;
        NEW.commission_rate_used := v_commission_rate;
        NEW.base_fare := v_base_fare;
        NEW.service_fee := v_service_fee;
        NEW.commission_fee := v_commission_fee;
        NEW.platform_fee := v_platform_total;
        NEW.driver_payout := v_driver_payout;
        NEW.currency_code := v_currency_code;
        NEW.country_code := v_country_code;

        -- UPSERT INTO DRIVER EARNINGS
        INSERT INTO driver_earnings (driver_id, job_id, amount, status, currency_code, country_code)
        VALUES (NEW.driver_id, NEW.id, v_driver_payout, 'pending', v_currency_code, v_country_code)
        ON CONFLICT (job_id) DO UPDATE
        SET amount = EXCLUDED.amount,
            driver_id = EXCLUDED.driver_id,
            currency_code = EXCLUDED.currency_code,
            country_code = EXCLUDED.country_code,
            status = CASE 
                WHEN driver_earnings.status = 'paid' THEN 'paid' 
                ELSE 'pending' 
            END;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
