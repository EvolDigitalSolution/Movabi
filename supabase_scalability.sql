-- ==========================================
-- SUPABASE UPDATES FOR SCALABILITY & SURGE
-- ==========================================

-- 1. Add cities table
CREATE TABLE IF NOT EXISTS cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  radius_km double precision DEFAULT 50,
  base_surge_multiplier numeric DEFAULT 1.0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- 2. Add city_id to drivers and jobs
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'profiles' AND COLUMN_NAME = 'city_id') THEN
        ALTER TABLE profiles ADD COLUMN city_id uuid REFERENCES cities(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'jobs' AND COLUMN_NAME = 'city_id') THEN
        ALTER TABLE jobs ADD COLUMN city_id uuid REFERENCES cities(id);
    END IF;
END $$;

-- 3. Add surge_multiplier to jobs
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'jobs' AND COLUMN_NAME = 'surge_multiplier') THEN
        ALTER TABLE jobs ADD COLUMN surge_multiplier numeric DEFAULT 1.0;
    END IF;
END $$;

-- 4. Add cancel_count to profiles (Fraud protection)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'profiles' AND COLUMN_NAME = 'cancel_count') THEN
        ALTER TABLE profiles ADD COLUMN cancel_count int DEFAULT 0;
    END IF;
END $$;

-- 5. CRITICAL INDEXES for performance
CREATE INDEX IF NOT EXISTS drivers_location_idx ON profiles (lat, lng) WHERE role = 'driver';
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);
CREATE INDEX IF NOT EXISTS jobs_city_idx ON jobs (city_id);
CREATE INDEX IF NOT EXISTS wallet_transactions_user_idx ON wallet_transactions (user_id);
CREATE INDEX IF NOT EXISTS profiles_city_idx ON profiles (city_id);
CREATE INDEX IF NOT EXISTS jobs_customer_idx ON jobs (customer_id);
CREATE INDEX IF NOT EXISTS jobs_driver_idx ON jobs (driver_id);
CREATE INDEX IF NOT EXISTS events_type_idx ON events (type);
CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at DESC);

-- 6. Notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id),
  title text NOT NULL,
  body text NOT NULL,
  data jsonb DEFAULT '{}',
  type text NOT NULL,
  is_read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id);
CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON notifications (created_at DESC);
