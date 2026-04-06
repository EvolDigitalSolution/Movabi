-- Migration: Harden Pricing Logic & Audit Trail
-- Date: 2026-04-06

-- 1. Add commission_rate_used to jobs table for audit trail
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS commission_rate_used DECIMAL(5,2);

-- 2. Update calculate_job_payouts function with hardening and documentation
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
    -- SOURCE OF TRUTH RULE: Pricing is snapshotted at the moment of COMPLETION.
    -- This ensures that the driver's active plan at the time the service is finalized
    -- determines the payout, which is the standard for gig platforms.
    
    -- Only run when job status changes to 'completed'
    IF (NEW.status = 'completed' AND (OLD.status IS NULL OR OLD.status != 'completed')) THEN
        
        -- Defensive check: Ensure we have a driver and a price
        IF NEW.driver_id IS NULL OR NEW.price IS NULL OR NEW.price <= 0 THEN
            -- If no driver or price, we can't calculate payout. 
            -- We set defaults to avoid breaking the update.
            NEW.pricing_plan_used := 'starter';
            NEW.commission_rate_used := 15.00;
            NEW.base_fare := COALESCE(NEW.price, 0);
            NEW.service_fee := 0;
            NEW.commission_fee := 0;
            NEW.platform_fee := 0;
            NEW.driver_payout := COALESCE(NEW.price, 0);
            RETURN NEW;
        END IF;

        -- Get driver's current plan and commission rate from profile
        SELECT pricing_plan, commission_rate INTO v_pricing_plan, v_commission_rate
        FROM profiles
        WHERE id = NEW.driver_id;

        -- Safe defaults for legacy or incomplete profiles
        v_pricing_plan := COALESCE(v_pricing_plan, 'starter');
        v_commission_rate := COALESCE(v_commission_rate, 15.00);
        
        -- CALCULATION LOGIC (Must match LogisticsService.calculatePayout in backend)
        -- 1. Customer pays TOTAL price (NEW.price)
        -- 2. Platform takes 10% service fee from customer
        v_service_fee := ROUND(NEW.price * 0.10, 2); 
        v_base_fare := NEW.price - v_service_fee;

        -- 3. Platform takes commission from driver if on Starter plan
        IF v_pricing_plan = 'pro' THEN
            -- Pro Plan: 0% commission from driver (they keep 100% of base fare)
            v_commission_fee := 0.00;
            v_driver_payout := v_base_fare;
        ELSE
            -- Starter Plan: Pay as you earn (commission applies to base fare)
            v_commission_fee := ROUND(v_base_fare * (v_commission_rate / 100), 2);
            v_driver_payout := v_base_fare - v_commission_fee;
        END IF;

        -- 4. Total Platform Revenue = Service Fee + Commission Fee
        v_platform_total := v_service_fee + v_commission_fee;

        -- SNAPSHOT VALUES TO JOB (Audit Trail)
        NEW.pricing_plan_used := v_pricing_plan;
        NEW.commission_rate_used := v_commission_rate;
        NEW.base_fare := v_base_fare;
        NEW.service_fee := v_service_fee;
        NEW.commission_fee := v_commission_fee;
        NEW.platform_fee := v_platform_total;
        NEW.driver_payout := v_driver_payout;

        -- UPSERT INTO DRIVER EARNINGS (Idempotency)
        -- This ensures that even if the trigger runs multiple times or webhooks retry,
        -- we only have one earnings record per job.
        INSERT INTO driver_earnings (driver_id, job_id, amount, status)
        VALUES (NEW.driver_id, NEW.id, v_driver_payout, 'pending')
        ON CONFLICT (job_id) DO UPDATE
        SET amount = EXCLUDED.amount,
            driver_id = EXCLUDED.driver_id,
            status = CASE 
                WHEN driver_earnings.status = 'paid' THEN 'paid' 
                ELSE 'pending' 
            END;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Update operations_metrics_v3 for better admin visibility
CREATE OR REPLACE VIEW operations_metrics_v3 AS
SELECT 
  tenant_id,
  COUNT(*) FILTER (WHERE status IN ('accepted', 'in_progress')) as active_jobs_count,
  SUM(price) FILTER (WHERE status = 'completed' AND created_at >= CURRENT_DATE) as revenue_today,
  SUM(platform_fee) FILTER (WHERE status = 'completed' AND created_at >= CURRENT_DATE) as platform_earnings_today,
  SUM(driver_payout) FILTER (WHERE status = 'completed' AND created_at >= CURRENT_DATE) as driver_payouts_today,
  COUNT(*) FILTER (WHERE pricing_plan_used = 'pro') as pro_jobs_count,
  COUNT(*) FILTER (WHERE pricing_plan_used = 'starter') as starter_jobs_count,
  (SELECT COUNT(*) FROM profiles WHERE is_online = true AND tenant_id = jobs.tenant_id) as online_drivers_count,
  (SELECT COUNT(*) FROM profiles WHERE pricing_plan = 'pro' AND tenant_id = jobs.tenant_id) as total_pro_drivers
FROM jobs
GROUP BY tenant_id;
