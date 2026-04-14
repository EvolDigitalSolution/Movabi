-- ==============================================================================
-- MIGRATION: Supabase Everylogic Safe Migration
-- DESCRIPTION: Safely upgrades existing production database to support 
--              Ride, Errand, and Van Moving domains + Fintech hardening.
-- DATE: 2026-04-14
-- ==============================================================================

-- PART 1 — Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- PART 2 — Safe support for booking/service types
DO $$
BEGIN
    -- Check if service_types table exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'service_types') THEN
        -- Insert missing service types safely
        INSERT INTO service_types (slug, name)
        VALUES 
            ('ride', 'Ride'),
            ('errand', 'Errand'),
            ('van-moving', 'Van Moving')
        ON CONFLICT (slug) DO NOTHING;
    END IF;
END $$;

-- PART 3 — Safe booking detail support for Ride, Errand, and Move
-- We create job_service_details only if no equivalent detail table exists.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'job_service_details') 
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'booking_details') 
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'job_details') THEN
        
        CREATE TABLE job_service_details (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            job_id UUID NOT NULL,
            service_type_slug TEXT,
            passenger_count INTEGER,
            items_list JSONB,
            estimated_budget NUMERIC,
            errand_mode TEXT,
            customer_phone TEXT,
            recipient_phone TEXT,
            recipient_name TEXT,
            substitution_rule TEXT,
            move_size TEXT,
            helper_count INTEGER,
            floor_number INTEGER,
            has_elevator BOOLEAN,
            stairs_involved BOOLEAN,
            fragile_items BOOLEAN,
            packing_assistance BOOLEAN,
            notes TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        -- Add foreign key if jobs table exists
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'jobs') THEN
            ALTER TABLE job_service_details 
            ADD CONSTRAINT fk_job_service_details_job 
            FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
        END IF;
    END IF;
END $$;

-- PART 4 — Audit and event logging
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stripe_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT UNIQUE,
  type TEXT,
  status TEXT,
  error_message TEXT,
  processed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- PART 5 — Wallet hardening
DO $$
BEGIN
    -- Add columns to wallet_transactions if they don't exist
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'wallet_transactions') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wallet_transactions' AND column_name = 'payment_intent_id') THEN
            ALTER TABLE wallet_transactions ADD COLUMN payment_intent_id TEXT;
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wallet_transactions' AND column_name = 'description') THEN
            ALTER TABLE wallet_transactions ADD COLUMN description TEXT;
        END IF;

        -- Add unique constraint safely
        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'unique_payment_intent'
        ) THEN
            ALTER TABLE wallet_transactions
            ADD CONSTRAINT unique_payment_intent UNIQUE (payment_intent_id);
        END IF;
    END IF;
END $$;

-- PART 6 — Driver earnings and payouts
CREATE TABLE IF NOT EXISTS payout_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  total_amount NUMERIC,
  status TEXT DEFAULT 'processing',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  processed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS driver_earnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL,
  booking_id UUID,
  gross_amount NUMERIC NOT NULL,
  platform_fee NUMERIC DEFAULT 0,
  net_amount NUMERIC NOT NULL,
  status TEXT DEFAULT 'pending',
  payout_batch_id UUID REFERENCES payout_batches(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  paid_out_at TIMESTAMP WITH TIME ZONE
);

-- PART 7 — Driver reliability support
DO $$
BEGIN
    -- Add columns to profiles if they exist and columns don't
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'completion_rate') THEN
            ALTER TABLE profiles ADD COLUMN completion_rate NUMERIC DEFAULT 1.0;
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'cancellation_rate') THEN
            ALTER TABLE profiles ADD COLUMN cancellation_rate NUMERIC DEFAULT 0.0;
        END IF;
    END IF;
END $$;

-- PART 8 — Performance indexes
-- Location index
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'lat') THEN
        CREATE INDEX IF NOT EXISTS idx_profiles_location ON profiles (lat, lng);
    END IF;
END $$;

-- Wallet index
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'wallet_transactions') THEN
        CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_transactions (user_id);
    END IF;
END $$;

-- Jobs status index
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'jobs') THEN
        CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
        CREATE INDEX IF NOT EXISTS idx_jobs_service_type ON jobs (service_type_id) WHERE service_type_id IS NOT NULL;
    END IF;
END $$;

-- Earnings index
CREATE INDEX IF NOT EXISTS idx_earnings_driver ON driver_earnings (driver_id);

-- Detail index
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'job_service_details') THEN
        CREATE INDEX IF NOT EXISTS idx_jsd_job_id ON job_service_details (job_id);
    END IF;
END $$;

-- Service type slug index
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'service_types' AND column_name = 'slug') THEN
        CREATE INDEX IF NOT EXISTS idx_service_types_slug ON service_types (slug);
    END IF;
END $$;

-- PART 9 — Atomic wallet finalization
CREATE OR REPLACE FUNCTION finalize_wallet_topup(
  p_user_id UUID,
  p_amount NUMERIC,
  p_payment_intent TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  already_exists BOOLEAN;
BEGIN
  -- 1. Idempotency check
  SELECT EXISTS (
    SELECT 1
    FROM wallet_transactions
    WHERE payment_intent_id = p_payment_intent
  ) INTO already_exists;

  IF already_exists THEN
    RETURN FALSE;
  END IF;

  -- 2. Record transaction
  INSERT INTO wallet_transactions (
    user_id,
    amount,
    type,
    payment_intent_id,
    description
  )
  VALUES (
    p_user_id,
    p_amount,
    'credit',
    p_payment_intent,
    'Wallet top-up'
  );

  -- 3. Update balance
  UPDATE wallets
  SET
    balance = balance + p_amount,
    available_balance = available_balance + p_amount,
    updated_at = NOW()
  WHERE wallets.user_id = p_user_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- PART 10 — Race-safe assignment for driver search
CREATE OR REPLACE FUNCTION assign_driver_to_job(
  p_job_id UUID,
  p_driver_id UUID
)
RETURNS BOOLEAN AS $$
BEGIN
  UPDATE jobs
  SET driver_id = p_driver_id,
      status = 'assigned',
      updated_at = NOW()
  WHERE id = p_job_id
    AND status = 'searching'
    AND driver_id IS NULL; -- Extra safety

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- PART 11 — Safe cancellation
CREATE OR REPLACE FUNCTION cancel_job_safely(
  p_job_id UUID
)
RETURNS BOOLEAN AS $$
BEGIN
  UPDATE jobs
  SET status = 'cancelled',
      updated_at = NOW()
  WHERE id = p_job_id
    AND status IN ('requested', 'searching', 'assigned');

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- PART 12 — Payout processing
CREATE OR REPLACE FUNCTION process_payout_batch()
RETURNS UUID AS $$
DECLARE
  v_batch_id UUID := gen_random_uuid();
BEGIN
  -- 1. Create batch
  INSERT INTO payout_batches (id, status, created_at)
  VALUES (v_batch_id, 'processing', NOW());

  -- 2. Update earnings status
  UPDATE driver_earnings
  SET
    status = 'paid',
    payout_batch_id = v_batch_id,
    paid_out_at = NOW()
  WHERE status = 'payable';

  -- 3. Finalize batch
  UPDATE payout_batches
  SET
    status = 'completed',
    processed_at = NOW()
  WHERE id = v_batch_id;

  RETURN v_batch_id;
END;
$$ LANGUAGE plpgsql;

-- PART 14 — Validation and safety checks
-- These queries can be run by an operator to verify the migration state.
/*
-- Verify Service Types
SELECT * FROM service_types WHERE slug IN ('ride', 'errand', 'van-moving');

-- Verify New Tables
SELECT table_name FROM information_schema.tables 
WHERE table_name IN ('job_service_details', 'audit_logs', 'stripe_events', 'driver_earnings', 'payout_batches');

-- Verify Functions
SELECT routine_name FROM information_schema.routines 
WHERE routine_name IN ('finalize_wallet_topup', 'assign_driver_to_job', 'cancel_job_safely', 'process_payout_batch');
*/
