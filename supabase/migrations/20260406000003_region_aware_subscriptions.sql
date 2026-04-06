-- Migration: Add region-specific subscription plans and enhance subscriptions table
-- Date: 2026-04-06

-- 1. Create subscription_plans table to manage available plans per region
CREATE TABLE IF NOT EXISTS public.subscription_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_code TEXT NOT NULL, -- e.g., 'pro'
    country_code TEXT NOT NULL, -- e.g., 'GB', 'US', 'NG'
    currency_code TEXT NOT NULL, -- e.g., 'GBP', 'USD', 'NGN'
    stripe_price_id TEXT NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    interval TEXT NOT NULL DEFAULT 'month', -- 'month', 'week'
    display_name TEXT NOT NULL,
    features JSONB DEFAULT '[]'::jsonb,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(plan_code, country_code, currency_code)
);

-- 2. Add region-specific columns to the subscriptions table for tracking
ALTER TABLE public.subscriptions
ADD COLUMN IF NOT EXISTS billing_currency_code TEXT,
ADD COLUMN IF NOT EXISTS billing_country_code TEXT,
ADD COLUMN IF NOT EXISTS billing_interval TEXT,
ADD COLUMN IF NOT EXISTS billing_amount_display TEXT;

-- 3. Insert default UK Pro plan
INSERT INTO public.subscription_plans (plan_code, country_code, currency_code, stripe_price_id, amount, interval, display_name, features)
VALUES (
    'pro', 
    'GB', 
    'GBP', 
    'price_mock_weekly_pro', 
    25.00, 
    'week', 
    'Weekly Pro', 
    '["Priority job matching", "Keep 100% of your fares (0% Fee)", "24/7 Premium support"]'::jsonb
)
ON CONFLICT (plan_code, country_code, currency_code) DO NOTHING;

-- 4. Update existing subscriptions with defaults
UPDATE public.subscriptions
SET
    billing_currency_code = 'GBP',
    billing_country_code = 'GB',
    billing_interval = 'week',
    billing_amount_display = '£25.00/week'
WHERE billing_currency_code IS NULL;

-- 5. RLS for subscription_plans (readable by all authenticated users)
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow authenticated users to view active plans"
ON public.subscription_plans FOR SELECT
TO authenticated
USING (is_active = TRUE);

-- 6. Add updated_at trigger for subscription_plans
CREATE TRIGGER update_subscription_plans_updated_at
    BEFORE UPDATE ON public.subscription_plans
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
