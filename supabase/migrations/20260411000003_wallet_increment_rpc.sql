-- Migration: Add increment_wallet_balance RPC
-- Date: 2026-04-11

BEGIN;

-- RPC for atomic wallet balance increment
CREATE OR REPLACE FUNCTION public.increment_wallet_balance(
    p_user_id UUID,
    p_amount DECIMAL(12, 2)
)
RETURNS VOID AS $$
BEGIN
    UPDATE public.wallets
    SET available_balance = available_balance + p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMIT;
