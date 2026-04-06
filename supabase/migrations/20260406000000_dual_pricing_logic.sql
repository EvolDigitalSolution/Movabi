-- Migration: Dual Driver Pricing Model
-- Date: 2026-04-06

-- 1. Update profiles table
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pricing_plan TEXT DEFAULT 'starter' CHECK (pricing_plan IN ('starter', 'pro'));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS commission_rate DECIMAL(5,2) DEFAULT 15.00; -- Default 15% for starter

-- 2. Update jobs table to snapshot pricing details
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pricing_plan_used TEXT CHECK (pricing_plan_used IN ('starter', 'pro'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS commission_fee DECIMAL(10,2) DEFAULT 0.00;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS base_fare DECIMAL(10,2) DEFAULT 0.00;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS service_fee DECIMAL(10,2) DEFAULT 0.00; -- Platform fee paid by customer

-- 3. Add unique constraint to driver_earnings
ALTER TABLE driver_earnings DROP CONSTRAINT IF EXISTS driver_earnings_job_id_key;
ALTER TABLE driver_earnings ADD CONSTRAINT driver_earnings_job_id_key UNIQUE (job_id);

-- 4. Create a function to calculate job payouts based on driver plan
CREATE OR REPLACE FUNCTION calculate_job_payouts()
RETURNS TRIGGER AS $$
DECLARE
    v_pricing_plan TEXT;
    v_commission_rate DECIMAL;
    v_base_fare DECIMAL;
    v_service_fee DECIMAL; -- Fee charged to customer (platform revenue)
    v_commission_fee DECIMAL; -- Fee charged to driver (platform revenue)
    v_driver_payout DECIMAL;
    v_platform_total DECIMAL;
BEGIN
    -- Only run when job is completed
    IF (NEW.status = 'completed' AND OLD.status != 'completed') THEN
        -- Get driver's current plan
        SELECT pricing_plan, commission_rate INTO v_pricing_plan, v_commission_rate
        FROM profiles
        WHERE id = NEW.driver_id;

        -- Default values if not set
        v_pricing_plan := COALESCE(v_pricing_plan, 'starter');
        v_commission_rate := COALESCE(v_commission_rate, 15.00);
        
        -- Assume NEW.price is the TOTAL price paid by customer
        v_service_fee := ROUND(NEW.price * 0.10, 2); -- 10% platform fee from customer
        v_base_fare := NEW.price - v_service_fee;

        IF v_pricing_plan = 'pro' THEN
            -- Pro Plan: 0% commission from driver
            v_commission_fee := 0.00;
            v_driver_payout := v_base_fare;
        ELSE
            -- Starter Plan: Pay as you earn (commission applies)
            v_commission_fee := ROUND(v_base_fare * (v_commission_rate / 100), 2);
            v_driver_payout := v_base_fare - v_commission_fee;
        END IF;

        v_platform_total := v_service_fee + v_commission_fee;

        -- Update the job record with calculated values
        NEW.pricing_plan_used := v_pricing_plan;
        NEW.base_fare := v_base_fare;
        NEW.service_fee := v_service_fee;
        NEW.commission_fee := v_commission_fee;
        NEW.platform_fee := v_platform_total;
        NEW.driver_payout := v_driver_payout;

        -- Upsert into driver_earnings
        INSERT INTO driver_earnings (driver_id, job_id, amount, status)
        VALUES (NEW.driver_id, NEW.id, v_driver_payout, 'pending')
        ON CONFLICT (job_id) DO UPDATE
        SET amount = EXCLUDED.amount,
            driver_id = EXCLUDED.driver_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Attach trigger to jobs table
DROP TRIGGER IF EXISTS tr_calculate_job_payouts ON jobs;
CREATE TRIGGER tr_calculate_job_payouts
    BEFORE UPDATE ON jobs
    FOR EACH ROW
    EXECUTE FUNCTION calculate_job_payouts();

-- 5. Update operations_metrics view to include plan breakdown
CREATE OR REPLACE VIEW operations_metrics_v2 AS
SELECT 
  tenant_id,
  COUNT(*) FILTER (WHERE status IN ('accepted', 'in_progress')) as active_jobs_count,
  SUM(price) FILTER (WHERE status = 'completed' AND created_at >= CURRENT_DATE) as revenue_today,
  SUM(platform_fee) FILTER (WHERE status = 'completed' AND created_at >= CURRENT_DATE) as platform_earnings_today,
  COUNT(*) FILTER (WHERE pricing_plan_used = 'pro') as pro_jobs_count,
  COUNT(*) FILTER (WHERE pricing_plan_used = 'starter') as starter_jobs_count,
  (SELECT COUNT(*) FROM profiles WHERE is_online = true AND tenant_id = jobs.tenant_id) as online_drivers_count
FROM jobs
GROUP BY tenant_id;
