-- ==========================================
-- SUPABASE ENTERPRISE UPGRADE
-- ==========================================

-- 1. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_user_idx ON audit_logs (user_id);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

-- 2. Payout Batches Table
CREATE TABLE IF NOT EXISTS payout_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text DEFAULT 'pending', -- pending, processing, completed, failed
  total_amount numeric NOT NULL,
  driver_count integer NOT NULL,
  stripe_transfer_id text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

-- 3. Update Driver Earnings
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'driver_earnings' AND COLUMN_NAME = 'payout_batch_id') THEN
        ALTER TABLE driver_earnings ADD COLUMN payout_batch_id uuid REFERENCES payout_batches(id);
    END IF;
END $$;

-- Update status check to include 'payable'
ALTER TABLE driver_earnings DROP CONSTRAINT IF EXISTS driver_earnings_status_check;
ALTER TABLE driver_earnings ADD CONSTRAINT driver_earnings_status_check CHECK (status IN ('pending', 'payable', 'paid', 'failed', 'paid_out', 'pending_payout'));

-- 4. Driver Reliability Stats
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'profiles' AND COLUMN_NAME = 'acceptance_rate') THEN
        ALTER TABLE profiles ADD COLUMN acceptance_rate numeric DEFAULT 100;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'profiles' AND COLUMN_NAME = 'cancellation_rate') THEN
        ALTER TABLE profiles ADD COLUMN cancellation_rate numeric DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'profiles' AND COLUMN_NAME = 'completion_rate') THEN
        ALTER TABLE profiles ADD COLUMN completion_rate numeric DEFAULT 100;
    END IF;
END $$;

-- 5. RPC for atomic payout processing
CREATE OR REPLACE FUNCTION process_payout_batch(
  p_batch_id uuid,
  p_driver_ids uuid[]
)
RETURNS boolean AS $$
BEGIN
  -- Mark earnings as paid for this batch
  UPDATE driver_earnings
  SET 
    status = 'paid_out',
    payout_batch_id = p_batch_id,
    paid_out_at = now()
  WHERE driver_id = ANY(p_driver_ids)
    AND status = 'payable';

  -- Update batch status
  UPDATE payout_batches
  SET 
    status = 'completed',
    completed_at = now()
  WHERE id = p_batch_id;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Failed to process payout batch: %', SQLERRM;
END;
$$ LANGUAGE plpgsql;
