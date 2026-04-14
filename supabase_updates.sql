-- ==========================================
-- SUPABASE UPDATES FOR PRODUCTION HARDENING
-- ==========================================

-- 1. Fix SQL function for wallet balance increment
-- This function ensures both balance and available_balance are updated atomically.
CREATE OR REPLACE FUNCTION increment_wallet_balance(p_user_id uuid, p_amount numeric)
RETURNS void AS $$
BEGIN
  UPDATE wallets
  SET 
    balance = balance + p_amount,
    available_balance = available_balance + p_amount,
    updated_at = now()
  WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- 2. Add unique constraint to wallet_transactions
-- This prevents duplicate credits from multiple confirm calls or webhook retries.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'unique_payment_intent'
    ) THEN
        ALTER TABLE wallet_transactions
        ADD CONSTRAINT unique_payment_intent UNIQUE (payment_intent_id);
    END IF;
END $$;

-- 3. Ensure wallet_transactions has a description column
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = 'wallet_transactions' AND COLUMN_NAME = 'description'
    ) THEN
        ALTER TABLE wallet_transactions ADD COLUMN description text;
    END IF;
END $$;
