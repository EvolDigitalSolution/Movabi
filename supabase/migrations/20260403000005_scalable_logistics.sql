-- Migration: Scalable Logistics Infrastructure
-- Date: 2026-04-03

-- 1. Create cities table
CREATE TABLE IF NOT EXISTS cities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  radius_km INTEGER NOT NULL DEFAULT 50,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Update jobs table
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS city_id UUID REFERENCES cities(id);

-- 3. Update driver_locations table
ALTER TABLE driver_locations ADD COLUMN IF NOT EXISTS city_id UUID REFERENCES cities(id);

-- 4. Update profiles for driver availability
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_available BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ DEFAULT NOW();

-- 5. Create job_queue table
CREATE TABLE IF NOT EXISTS job_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  city_id UUID REFERENCES cities(id),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'assigned', 'expired')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- 6. Add indexes
CREATE INDEX IF NOT EXISTS idx_jobs_city_id ON jobs(city_id);
CREATE INDEX IF NOT EXISTS idx_driver_locations_city_id ON driver_locations(city_id);
CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status);
CREATE INDEX IF NOT EXISTS idx_job_queue_city_id ON job_queue(city_id);
CREATE INDEX IF NOT EXISTS idx_profiles_is_online ON profiles(is_online);
CREATE INDEX IF NOT EXISTS idx_profiles_is_available ON profiles(is_available);

-- 7. RLS Updates

-- Cities: Publicly readable
ALTER TABLE cities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Cities are publicly readable" ON cities FOR SELECT USING (true);

-- Job Queue: Admin only
ALTER TABLE job_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view job queue"
  ON job_queue FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tenant_users 
      WHERE user_id = auth.uid() AND role = 'admin' AND tenant_id = job_queue.tenant_id
    )
  );

-- Update Jobs RLS to be city-aware for drivers
DROP POLICY IF EXISTS "Users can view relevant jobs" ON jobs;
CREATE POLICY "Users can view relevant jobs"
  ON jobs FOR SELECT
  USING (
    auth.uid() = customer_id OR 
    auth.uid() = driver_id OR
    (
      status = 'pending' AND 
      (
        city_id IS NULL OR 
        city_id IN (
          SELECT city_id FROM driver_locations WHERE driver_id = auth.uid()
        )
      )
    ) OR
    EXISTS (
      SELECT 1 FROM tenant_users 
      WHERE user_id = auth.uid() AND role = 'admin' AND tenant_id = jobs.tenant_id
    )
  );

-- 8. Helper function for dispatch load balancing
-- Finds the least recently assigned driver
CREATE OR REPLACE FUNCTION get_least_recently_assigned_driver(p_city_id UUID, p_tenant_id UUID)
RETURNS UUID AS $$
DECLARE
    v_driver_id UUID;
BEGIN
    SELECT p.id INTO v_driver_id
    FROM profiles p
    JOIN tenant_users tu ON tu.user_id = p.id
    WHERE tu.tenant_id = p_tenant_id 
      AND tu.role = 'driver'
      AND p.is_online = true 
      AND p.is_available = true
      AND EXISTS (
          SELECT 1 FROM driver_locations dl 
          WHERE dl.driver_id = p.id AND dl.city_id = p_city_id
      )
    ORDER BY p.last_active_at ASC
    LIMIT 1;
    
    RETURN v_driver_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
