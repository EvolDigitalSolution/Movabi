-- ==============================================================================
-- MIGRATION: Supabase Incremental Schema Reconcile
-- DESCRIPTION: Reconciles existing production database with codebase expectations.
--              Idempotent, non-destructive, and backward-compatible.
-- DATE: 2026-04-15
-- ==============================================================================

-- PART 1 — Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- PART 2 — Service Types
CREATE TABLE IF NOT EXISTS service_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    base_price NUMERIC DEFAULT 0,
    price_per_km NUMERIC DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

INSERT INTO service_types (slug, name)
VALUES 
    ('ride', 'Ride'),
    ('errand', 'Errand'),
    ('van-moving', 'Van Moving'),
    ('delivery', 'Package Delivery')
ON CONFLICT (slug) DO NOTHING;

-- PART 3 — Cities (Fixing missing is_active error)
CREATE TABLE IF NOT EXISTS cities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    lat NUMERIC,
    lng NUMERIC,
    radius_km NUMERIC DEFAULT 50,
    is_active BOOLEAN DEFAULT TRUE,
    base_surge_multiplier NUMERIC DEFAULT 1.0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cities' AND column_name = 'is_active') THEN
        ALTER TABLE cities ADD COLUMN is_active BOOLEAN DEFAULT TRUE;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cities' AND column_name = 'radius_km') THEN
        ALTER TABLE cities ADD COLUMN radius_km NUMERIC DEFAULT 50;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cities' AND column_name = 'base_surge_multiplier') THEN
        ALTER TABLE cities ADD COLUMN base_surge_multiplier NUMERIC DEFAULT 1.0;
    END IF;
END $$;

-- PART 4 — Pricing Rules & Fixed Fare Bands
CREATE TABLE IF NOT EXISTS pricing_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_type_id UUID REFERENCES service_types(id),
    currency_code TEXT NOT NULL DEFAULT 'GBP',
    country_code TEXT NOT NULL DEFAULT 'GB',
    base_fare NUMERIC DEFAULT 0,
    per_km_rate NUMERIC DEFAULT 0,
    minimum_fare NUMERIC DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(service_type_id, currency_code, country_code)
);

CREATE TABLE IF NOT EXISTS fixed_fare_bands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_type_id UUID REFERENCES service_types(id),
    currency_code TEXT NOT NULL DEFAULT 'GBP',
    country_code TEXT NOT NULL DEFAULT 'GB',
    min_distance_km NUMERIC NOT NULL,
    max_distance_km NUMERIC NOT NULL,
    flat_rate NUMERIC NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- PART 5 — Profiles Hardening
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'completion_rate') THEN
            ALTER TABLE profiles ADD COLUMN completion_rate NUMERIC DEFAULT 1.0;
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'cancellation_rate') THEN
            ALTER TABLE profiles ADD COLUMN cancellation_rate NUMERIC DEFAULT 0.0;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'lat') THEN
            ALTER TABLE profiles ADD COLUMN lat NUMERIC;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'lng') THEN
            ALTER TABLE profiles ADD COLUMN lng NUMERIC;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'account_status') THEN
            ALTER TABLE profiles ADD COLUMN account_status TEXT DEFAULT 'active';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'tenant_id') THEN
            ALTER TABLE profiles ADD COLUMN tenant_id UUID;
        END IF;
    END IF;
END $$;

-- PART 6 — Wallets & Transactions
CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL,
    balance NUMERIC DEFAULT 0,
    available_balance NUMERIC DEFAULT 0,
    reserved_balance NUMERIC DEFAULT 0,
    currency_code TEXT DEFAULT 'GBP',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wallets' AND column_name = 'reserved_balance') THEN
        ALTER TABLE wallets ADD COLUMN reserved_balance NUMERIC DEFAULT 0;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    amount NUMERIC NOT NULL,
    type TEXT NOT NULL, -- 'credit', 'debit', 'refund'
    status TEXT DEFAULT 'completed',
    payment_intent_id TEXT UNIQUE,
    description TEXT,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- PART 7 — Jobs & Service Details
CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID,
    customer_id UUID NOT NULL,
    driver_id UUID,
    service_type_id UUID REFERENCES service_types(id),
    status TEXT DEFAULT 'requested',
    pickup_address TEXT,
    pickup_lat NUMERIC,
    pickup_lng NUMERIC,
    dropoff_address TEXT,
    dropoff_lat NUMERIC,
    dropoff_lng NUMERIC,
    total_price NUMERIC DEFAULT 0,
    payment_status TEXT DEFAULT 'pending',
    payment_intent_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'jobs' AND column_name = 'tenant_id') THEN
        ALTER TABLE jobs ADD COLUMN tenant_id UUID;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS job_service_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    service_type_slug TEXT,
    passenger_count INTEGER,
    items_list JSONB,
    estimated_budget NUMERIC,
    move_size TEXT,
    helper_count INTEGER,
    has_elevator BOOLEAN,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- PART 8 — Driver Earnings & Payouts
CREATE TABLE IF NOT EXISTS payout_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    total_amount NUMERIC DEFAULT 0,
    status TEXT DEFAULT 'processing',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS driver_earnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID NOT NULL,
    booking_id UUID REFERENCES jobs(id),
    gross_amount NUMERIC NOT NULL,
    platform_fee NUMERIC DEFAULT 0,
    net_amount NUMERIC NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending', 'payable', 'paid'
    payout_batch_id UUID REFERENCES payout_batches(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    paid_out_at TIMESTAMP WITH TIME ZONE
);

-- PART 9 — Audit & Events
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
    id TEXT PRIMARY KEY, -- Use Stripe's event ID
    type TEXT,
    status TEXT DEFAULT 'received',
    error_message TEXT,
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- PART 10 — Errand Funding
CREATE TABLE IF NOT EXISTS errand_funding (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID UNIQUE NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL,
    amount_reserved NUMERIC DEFAULT 0,
    status TEXT DEFAULT 'pending', -- 'pending', 'reserved', 'approved', 'settled', 'cancelled'
    over_budget_status TEXT DEFAULT 'none', -- 'none', 'requested', 'approved', 'rejected'
    over_budget_amount NUMERIC DEFAULT 0,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- PART 11 — RPC Functions (Idempotent)

-- Finalize Wallet Top-up
CREATE OR REPLACE FUNCTION finalize_wallet_topup(
  p_user_id UUID,
  p_amount NUMERIC,
  p_payment_intent_id TEXT,
  p_description TEXT DEFAULT 'Wallet top-up'
)
RETURNS BOOLEAN AS $$
DECLARE
  already_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM wallet_transactions WHERE payment_intent_id = p_payment_intent_id
  ) INTO already_exists;

  IF already_exists THEN
    RETURN FALSE;
  END IF;

  INSERT INTO wallet_transactions (user_id, amount, type, payment_intent_id, description)
  VALUES (p_user_id, p_amount, 'credit', p_payment_intent_id, p_description);

  INSERT INTO wallets (user_id, balance, available_balance)
  VALUES (p_user_id, p_amount, p_amount)
  ON CONFLICT (user_id) DO UPDATE
  SET balance = wallets.balance + p_amount,
      available_balance = wallets.available_balance + p_amount,
      updated_at = NOW();

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Errand Funding RPCs
CREATE OR REPLACE FUNCTION reserve_errand_funds(
  p_job_id UUID,
  p_customer_id UUID,
  p_item_budget NUMERIC,
  p_service_estimate NUMERIC
)
RETURNS BOOLEAN AS $$
DECLARE
  v_total_needed NUMERIC := p_item_budget + p_service_estimate;
  v_available NUMERIC;
BEGIN
  SELECT available_balance INTO v_available FROM wallets WHERE user_id = p_customer_id;
  
  IF v_available < v_total_needed THEN
    RAISE EXCEPTION 'Insufficient funds';
  END IF;

  -- Reserve in wallet
  UPDATE wallets
  SET available_balance = available_balance - v_total_needed,
      reserved_balance = reserved_balance + v_total_needed,
      updated_at = NOW()
  WHERE user_id = p_customer_id;

  -- Record in errand_funding
  INSERT INTO errand_funding (job_id, customer_id, amount_reserved, status)
  VALUES (p_job_id, p_customer_id, v_total_needed, 'reserved')
  ON CONFLICT (job_id) DO UPDATE
  SET amount_reserved = v_total_needed,
      status = 'reserved',
      updated_at = NOW();

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Assign Driver Safely
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
    AND driver_id IS NULL;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Cancel Job Safely
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

-- Process Payout Batch
CREATE OR REPLACE FUNCTION process_payout_batch()
RETURNS UUID AS $$
DECLARE
  v_batch_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO payout_batches (id, status, created_at)
  VALUES (v_batch_id, 'processing', NOW());

  UPDATE driver_earnings
  SET status = 'paid',
      payout_batch_id = v_batch_id,
      paid_out_at = NOW()
  WHERE status = 'payable';

  UPDATE payout_batches
  SET status = 'completed',
      processed_at = NOW(),
      total_amount = COALESCE((SELECT SUM(net_amount) FROM driver_earnings WHERE payout_batch_id = v_batch_id), 0)
  WHERE id = v_batch_id;

  RETURN v_batch_id;
END;
$$ LANGUAGE plpgsql;

-- PART 12 — Indexes
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_driver ON jobs(driver_id);
CREATE INDEX IF NOT EXISTS idx_profiles_location ON profiles(lat, lng) WHERE lat IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_driver_earnings_status ON driver_earnings(status);
CREATE INDEX IF NOT EXISTS idx_cities_active ON cities(is_active) WHERE is_active = TRUE;
