-- Migration: Wallet Top-Up Support and Idempotency
-- Issue: Securely credit wallet after Stripe payment and prevent double-crediting

-- 1. Add stripe_payment_intent_id to wallet_transactions if missing
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wallet_transactions' AND column_name = 'stripe_payment_intent_id') THEN
        ALTER TABLE public.wallet_transactions ADD COLUMN stripe_payment_intent_id TEXT;
    END IF;
END $$;

-- 2. Create unique partial index for idempotency on topups
-- This prevents the same PaymentIntent from being credited twice
DROP INDEX IF EXISTS idx_wallet_transactions_stripe_pi_topup;
CREATE UNIQUE INDEX idx_wallet_transactions_stripe_pi_topup 
ON public.wallet_transactions (stripe_payment_intent_id) 
WHERE type = 'topup' AND stripe_payment_intent_id IS NOT NULL;

-- 3. Create trusted SECURITY DEFINER function to credit wallet
CREATE OR REPLACE FUNCTION public.credit_wallet_topup(
    p_user_id UUID,
    p_amount DECIMAL,
    p_currency_code TEXT,
    p_stripe_payment_intent_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_wallet_id UUID;
BEGIN
    -- 1. Get or create wallet
    INSERT INTO wallets (user_id, available_balance, currency_code)
    VALUES (p_user_id, 0, p_currency_code)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT id INTO v_wallet_id FROM wallets WHERE user_id = p_user_id;

    -- 2. Record transaction (unique index will catch duplicates)
    INSERT INTO wallet_transactions (
        wallet_id,
        amount,
        type,
        status,
        description,
        stripe_payment_intent_id
    ) VALUES (
        v_wallet_id,
        p_amount,
        'topup',
        'completed',
        'Wallet top-up via Stripe',
        p_stripe_payment_intent_id
    );

    -- 3. Update wallet balance
    UPDATE wallets 
    SET available_balance = available_balance + p_amount,
        updated_at = NOW()
    WHERE id = v_wallet_id;

END;
$$;
