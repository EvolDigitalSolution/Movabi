-- Migration: Stripe Connect Hardening & Errand Contact Fields
-- Date: 2026-04-10

-- 1. Extend driver_accounts for better status tracking
ALTER TABLE public.driver_accounts 
ADD COLUMN IF NOT EXISTS onboarding_status TEXT DEFAULT 'not_started' 
CHECK (onboarding_status IN ('not_started', 'pending', 'restricted', 'enabled')),
ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN DEFAULT false;

-- 2. Add contact fields to errand_details
ALTER TABLE public.errand_details 
ADD COLUMN IF NOT EXISTS customer_phone TEXT,
ADD COLUMN IF NOT EXISTS recipient_phone TEXT,
ADD COLUMN IF NOT EXISTS recipient_name TEXT,
ADD COLUMN IF NOT EXISTS substitution_rule TEXT DEFAULT 'contact_me' 
CHECK (substitution_rule IN ('contact_me', 'best_match', 'do_not_substitute'));

-- 3. Extend errand_funding for over-budget flow
ALTER TABLE public.errand_funding 
ADD COLUMN IF NOT EXISTS over_budget_status TEXT DEFAULT 'none' 
CHECK (over_budget_status IN ('none', 'requested', 'approved', 'rejected')),
ADD COLUMN IF NOT EXISTS over_budget_amount DECIMAL(12, 2) DEFAULT 0.00;

-- 4. Add feature flags to tenant_configs (if it exists) or just profiles for now
-- Assuming we might want a global config later, but for MVP we'll use a simple config table if needed.
-- For now, we'll use a new table for global app config.
CREATE TABLE IF NOT EXISTS public.app_features (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feature_name TEXT UNIQUE NOT NULL,
    is_enabled BOOLEAN DEFAULT false,
    metadata JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO public.app_features (feature_name, is_enabled)
VALUES 
    ('stripe_connect_enabled', true),
    ('stripe_issuing_enabled', false),
    ('driver_wallet_spend_enabled', false)
ON CONFLICT (feature_name) DO NOTHING;

-- 5. RLS for app_features
ALTER TABLE public.app_features ENABLE ROW LEVEL SECURITY;
CREATE POLICY "App features are publicly readable" ON public.app_features FOR SELECT USING (true);
