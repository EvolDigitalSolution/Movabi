-- ==========================================
-- SUPABASE HARDENING & CONSISTENCY
-- ==========================================

-- 1. Stripe Idempotency Table
CREATE TABLE IF NOT EXISTS stripe_events (
  id text PRIMARY KEY, -- Stripe Event ID
  type text NOT NULL,
  status text DEFAULT 'pending', -- pending, processed, failed
  error_message text,
  processed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- 2. Driver Payout Ledger (Update existing table)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'driver_earnings' AND COLUMN_NAME = 'gross_amount') THEN
        ALTER TABLE driver_earnings ADD COLUMN gross_amount numeric;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'driver_earnings' AND COLUMN_NAME = 'platform_fee') THEN
        ALTER TABLE driver_earnings ADD COLUMN platform_fee numeric;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'driver_earnings' AND COLUMN_NAME = 'net_amount') THEN
        ALTER TABLE driver_earnings ADD COLUMN net_amount numeric;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'driver_earnings' AND COLUMN_NAME = 'paid_out_at') THEN
        ALTER TABLE driver_earnings ADD COLUMN paid_out_at timestamptz;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'driver_earnings' AND COLUMN_NAME = 'metadata') THEN
        ALTER TABLE driver_earnings ADD COLUMN metadata jsonb DEFAULT '{}';
    END IF;
END $$;

-- Update status check if needed
ALTER TABLE driver_earnings DROP CONSTRAINT IF EXISTS driver_earnings_status_check;
ALTER TABLE driver_earnings ADD CONSTRAINT driver_earnings_status_check CHECK (status IN ('pending', 'paid', 'failed', 'paid_out', 'pending_payout'));

CREATE INDEX IF NOT EXISTS driver_earnings_driver_idx ON driver_earnings (driver_id);
CREATE INDEX IF NOT EXISTS driver_earnings_job_idx ON driver_earnings (job_id);
CREATE INDEX IF NOT EXISTS driver_earnings_status_idx ON driver_earnings (status);

-- 3. Atomic Wallet Top-up RPC
CREATE OR REPLACE FUNCTION finalize_wallet_topup(
  p_user_id uuid,
  p_amount numeric,
  p_payment_intent_id text,
  p_description text
)
RETURNS boolean AS $$
DECLARE
  v_exists boolean;
BEGIN
  -- 1. Check if already processed
  SELECT EXISTS (
    SELECT 1 FROM wallet_transactions 
    WHERE payment_intent_id = p_payment_intent_id
  ) INTO v_exists;

  IF v_exists THEN
    RETURN false;
  END IF;

  -- 2. Insert transaction
  INSERT INTO wallet_transactions (
    user_id,
    amount,
    type,
    payment_intent_id,
    description,
    created_at
  ) VALUES (
    p_user_id,
    p_amount,
    'credit',
    p_payment_intent_id,
    p_description,
    now()
  );

  -- 3. Update wallet balance
  UPDATE wallets
  SET 
    balance = balance + p_amount,
    available_balance = available_balance + p_amount,
    updated_at = now()
  WHERE user_id = p_user_id;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Failed to finalize wallet top-up: %', SQLERRM;
END;
$$ LANGUAGE plpgsql;

-- 4. Atomic Job Assignment Guard
CREATE OR REPLACE FUNCTION assign_driver_to_job(
  p_job_id uuid,
  p_driver_id uuid
)
RETURNS boolean AS $$
DECLARE
  v_updated boolean;
BEGIN
  UPDATE jobs
  SET 
    driver_id = p_driver_id,
    status = 'assigned',
    updated_at = now()
  WHERE id = p_job_id 
    AND status = 'searching'
    AND driver_id IS NULL;
    
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$ LANGUAGE plpgsql;

-- 5. Atomic Job Cancellation Guard
CREATE OR REPLACE FUNCTION cancel_job_safely(
  p_job_id uuid,
  p_reason text
)
RETURNS boolean AS $$
DECLARE
  v_updated boolean;
BEGIN
  UPDATE jobs
  SET 
    status = 'cancelled',
    cancellation_reason = p_reason,
    updated_at = now()
  WHERE id = p_job_id 
    AND status IN ('requested', 'searching', 'assigned');
    
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$ LANGUAGE plpgsql;
