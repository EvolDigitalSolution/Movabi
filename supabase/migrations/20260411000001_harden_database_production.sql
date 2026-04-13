-- Migration: Production Hardening Pass
-- Date: 2026-04-11
-- Description: Audit and safely complete database structures for Errand, Wallet, Notification, Driver, and Settlement flows.

BEGIN;

-- ==================================================
-- STEP 1 — TABLES & BASIC STRUCTURE
-- ==================================================

-- 1.1 Wallet Transactions
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    job_id UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
    amount DECIMAL(12, 2) NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('topup', 'reservation', 'release', 'settlement', 'refund', 'adjustment')),
    description TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Enable RLS
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own transactions" ON public.wallet_transactions FOR SELECT USING (auth.uid() = user_id);

-- 1.2 System Configs
CREATE TABLE IF NOT EXISTS public.system_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    config_key TEXT UNIQUE NOT NULL,
    config_value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Seed Defaults
INSERT INTO public.system_configs (config_key, config_value)
VALUES 
    ('default_country', '"GB"'::jsonb),
    ('default_currency', '"GBP"'::jsonb),
    ('default_map_center', '{"lat": 53.5409, "lng": -2.1114}'::jsonb),
    ('default_map_zoom', '12'::jsonb)
ON CONFLICT (config_key) DO NOTHING;

-- 1.3 Email Logs
CREATE TABLE IF NOT EXISTS public.email_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    job_id UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
    email_type TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- ==================================================
-- STEP 2 — HARDEN ERRAND FUNDING
-- ==================================================

ALTER TABLE public.errand_funding 
ADD COLUMN IF NOT EXISTS receipt_url TEXT,
ADD COLUMN IF NOT EXISTS actual_item_spend DECIMAL(12, 2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS settlement_data JSONB DEFAULT '{}'::jsonb;

-- Add constraints if they don't exist
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'errand_funding_amount_reserved_check') THEN
        ALTER TABLE public.errand_funding ADD CONSTRAINT errand_funding_amount_reserved_check CHECK (amount_reserved >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'errand_funding_actual_item_spend_check') THEN
        ALTER TABLE public.errand_funding ADD CONSTRAINT errand_funding_actual_item_spend_check CHECK (actual_item_spend >= 0);
    END IF;
END $$;

-- ==================================================
-- STEP 3 — HARDEN WALLET SYSTEM
-- ==================================================

-- Constraints for wallets
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallets_available_balance_check') THEN
        ALTER TABLE public.wallets ADD CONSTRAINT wallets_available_balance_check CHECK (available_balance >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallets_reserved_balance_check') THEN
        ALTER TABLE public.wallets ADD CONSTRAINT wallets_reserved_balance_check CHECK (reserved_balance >= 0);
    END IF;
END $$;

-- Trigger to prevent negative total wallet state (redundant but safe)
CREATE OR REPLACE FUNCTION public.check_wallet_integrity()
RETURNS TRIGGER AS $$
BEGIN
    IF (NEW.available_balance + NEW.reserved_balance) < 0 THEN
        RAISE EXCEPTION 'Wallet total balance cannot be negative';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_check_wallet_integrity ON public.wallets;
CREATE TRIGGER tr_check_wallet_integrity
    BEFORE UPDATE ON public.wallets
    FOR EACH ROW EXECUTE FUNCTION public.check_wallet_integrity();

-- Optional function: validate_wallet_integrity
CREATE OR REPLACE FUNCTION public.validate_wallet_integrity(p_user_id UUID)
RETURNS TABLE(is_valid BOOLEAN, message TEXT) AS $$
DECLARE
    v_available DECIMAL(12, 2);
    v_reserved DECIMAL(12, 2);
BEGIN
    SELECT available_balance, reserved_balance INTO v_available, v_reserved
    FROM public.wallets
    WHERE user_id = p_user_id;
    
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Wallet not found'::TEXT;
    ELSIF (v_available + v_reserved) < 0 THEN
        RETURN QUERY SELECT FALSE, 'Negative total balance'::TEXT;
    ELSE
        RETURN QUERY SELECT TRUE, 'Wallet is healthy'::TEXT;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==================================================
-- STEP 4 — JOBS TABLE EXTENSION
-- ==================================================

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Update payment_status constraint
DO $$ 
BEGIN 
    -- Drop old constraint if it exists
    ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_payment_status_check;
    -- Add new one
    ALTER TABLE public.jobs ADD CONSTRAINT jobs_payment_status_check 
    CHECK (payment_status IN ('pending', 'paid', 'failed', 'wallet_pending', 'wallet_funded', 'wallet_settled', 'wallet_refunded'));
END $$;

-- ==================================================
-- STEP 5 — RPC FUNCTIONS FOR ERRAND FLOW
-- ==================================================

-- 4.1 Request Over Budget
CREATE OR REPLACE FUNCTION public.request_errand_over_budget(
    p_job_id UUID,
    p_amount DECIMAL(12, 2),
    p_reason TEXT
)
RETURNS VOID AS $$
BEGIN
    UPDATE public.errand_funding
    SET 
        over_budget_status = 'requested',
        over_budget_amount = p_amount,
        metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{over_budget_reason}', to_jsonb(p_reason)),
        updated_at = NOW()
    WHERE job_id = p_job_id AND status = 'reserved';
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No active reservation found for this job';
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4.2 Approve Over Budget
CREATE OR REPLACE FUNCTION public.approve_errand_over_budget(p_job_id UUID)
RETURNS VOID AS $$
DECLARE
    v_customer_id UUID;
    v_extra_amount DECIMAL(12, 2);
    v_available DECIMAL(12, 2);
BEGIN
    -- Get request details
    SELECT customer_id, over_budget_amount INTO v_customer_id, v_extra_amount
    FROM public.errand_funding
    WHERE job_id = p_job_id AND over_budget_status = 'requested'
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No pending over-budget request found';
    END IF;

    -- Check balance
    SELECT available_balance INTO v_available
    FROM public.wallets
    WHERE user_id = v_customer_id
    FOR UPDATE;

    IF v_available < v_extra_amount THEN
        RAISE EXCEPTION 'Insufficient funds in wallet to approve budget increase';
    END IF;

    -- Update Wallet
    UPDATE public.wallets
    SET 
        available_balance = available_balance - v_extra_amount,
        reserved_balance = reserved_balance + v_extra_amount,
        updated_at = NOW()
    WHERE user_id = v_customer_id;

    -- Update Funding
    UPDATE public.errand_funding
    SET 
        amount_reserved = amount_reserved + v_extra_amount,
        over_budget_status = 'approved',
        updated_at = NOW()
    WHERE job_id = p_job_id;

    -- Log transaction
    INSERT INTO public.wallet_transactions (user_id, job_id, amount, type, description)
    VALUES (v_customer_id, p_job_id, -v_extra_amount, 'reservation', 'Additional errand budget approved');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4.3 Reject Over Budget
CREATE OR REPLACE FUNCTION public.reject_errand_over_budget(p_job_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE public.errand_funding
    SET 
        over_budget_status = 'rejected',
        updated_at = NOW()
    WHERE job_id = p_job_id AND over_budget_status = 'requested';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==================================================
-- STEP 5 — PERFORMANCE INDEXES
-- ==================================================

CREATE INDEX IF NOT EXISTS idx_errand_funding_job_id ON public.errand_funding(job_id);
CREATE INDEX IF NOT EXISTS idx_errand_funding_customer_id ON public.errand_funding(customer_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_id ON public.wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_job_id ON public.wallet_transactions(job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON public.jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_customer_id ON public.jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_driver_id ON public.jobs(driver_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON public.notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_driver_accounts_onboarding_status ON public.driver_accounts(onboarding_status);

-- ==================================================
-- STEP 6 — SAFETY TRIGGERS & GUARDS
-- ==================================================

-- 6.1 Prevent Errand Completion if Over Budget Pending
CREATE OR REPLACE FUNCTION public.check_errand_completion_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'completed' THEN
        -- Check if there's a pending over-budget request
        IF EXISTS (
            SELECT 1 FROM public.errand_funding 
            WHERE job_id = NEW.id 
            AND over_budget_status = 'requested'
        ) THEN
            RAISE EXCEPTION 'Cannot complete job with pending over-budget request';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_check_errand_completion_guard ON public.jobs;
CREATE TRIGGER tr_check_errand_completion_guard
    BEFORE UPDATE OF status ON public.jobs
    FOR EACH ROW EXECUTE FUNCTION public.check_errand_completion_guard();

-- 6.2 Prevent Double Settlement
CREATE UNIQUE INDEX IF NOT EXISTS idx_errand_funding_settled_unique ON public.errand_funding(job_id) WHERE status = 'settled';

COMMIT;
