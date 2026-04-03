-- Migration: Smart Logistics (Driver Tracking, Pricing, Dispatch)
-- Date: 2026-04-03

-- 1. Create driver_locations table
CREATE TABLE IF NOT EXISTS driver_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  heading DOUBLE PRECISION,
  speed DOUBLE PRECISION,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Add indexes to driver_locations
CREATE INDEX IF NOT EXISTS idx_driver_locations_driver_id ON driver_locations(driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_locations_tenant_id ON driver_locations(tenant_id);

-- 3. Update jobs table with smart fields
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS estimated_distance DECIMAL(10,2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS estimated_price DECIMAL(10,2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pickup_lat DOUBLE PRECISION;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pickup_lng DOUBLE PRECISION;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dropoff_lat DOUBLE PRECISION;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dropoff_lng DOUBLE PRECISION;

-- 4. Updated at trigger for driver_locations
CREATE OR REPLACE FUNCTION update_driver_locations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE TRIGGER tr_update_driver_locations_updated_at
    BEFORE UPDATE ON driver_locations
    FOR EACH ROW
    EXECUTE FUNCTION update_driver_locations_updated_at();

-- 5. RLS Policies for driver_locations

ALTER TABLE driver_locations ENABLE ROW LEVEL SECURITY;

-- Driver can INSERT/UPDATE their own location
CREATE POLICY "Drivers can manage their own location"
  ON driver_locations FOR ALL
  USING (auth.uid() = driver_id)
  WITH CHECK (auth.uid() = driver_id);

-- Customer can SELECT location only for their active job driver
CREATE POLICY "Customers can view their active driver location"
  ON driver_locations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM jobs 
      WHERE jobs.driver_id = driver_locations.driver_id 
      AND jobs.customer_id = auth.uid()
      AND jobs.status IN ('accepted', 'in_progress')
    )
  );

-- Admin can see all tenant locations
CREATE POLICY "Admins can see all tenant locations"
  ON driver_locations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tenant_users 
      WHERE user_id = auth.uid() AND role = 'admin' AND tenant_id = driver_locations.tenant_id
    )
  );
