-- Migration: Van Moving Feature (Jobs & Locations)
-- Date: 2026-04-03

-- 1. Create jobs table
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  customer_id UUID NOT NULL REFERENCES auth.users(id),
  driver_id UUID REFERENCES auth.users(id),
  pickup_address TEXT NOT NULL,
  dropoff_address TEXT NOT NULL,
  price DECIMAL(10,2),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'in_progress', 'completed', 'cancelled')),
  scheduled_time TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create job_locations table
CREATE TABLE IF NOT EXISTS job_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES auth.users(id),
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Add indexes
CREATE INDEX IF NOT EXISTS idx_jobs_tenant_id ON jobs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_jobs_customer_id ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_driver_id ON jobs(driver_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_job_locations_job_id ON job_locations(job_id);

-- 4. Updated at trigger for jobs
CREATE OR REPLACE FUNCTION update_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE TRIGGER tr_update_jobs_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_jobs_updated_at();

-- 5. RLS Policies

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_locations ENABLE ROW LEVEL SECURITY;

-- Jobs Policies

-- SELECT
CREATE POLICY "Users can view relevant jobs"
  ON jobs FOR SELECT
  USING (
    auth.uid() = customer_id OR 
    auth.uid() = driver_id OR
    status = 'pending' OR
    EXISTS (
      SELECT 1 FROM tenant_users 
      WHERE user_id = auth.uid() AND role = 'admin' AND tenant_id = jobs.tenant_id
    )
  );

-- INSERT
CREATE POLICY "Customers can create jobs"
  ON jobs FOR INSERT
  WITH CHECK (auth.uid() = customer_id);

-- UPDATE
CREATE POLICY "Authorized users can update jobs"
  ON jobs FOR UPDATE
  USING (
    auth.uid() = customer_id OR -- Customer can cancel
    auth.uid() = driver_id OR -- Assigned driver can update status
    status = 'pending' OR -- Any driver can accept
    EXISTS (
      SELECT 1 FROM tenant_users 
      WHERE user_id = auth.uid() AND role = 'admin' AND tenant_id = jobs.tenant_id
    )
  )
  WITH CHECK (
    auth.uid() = customer_id OR 
    auth.uid() = driver_id OR
    (status = 'accepted' AND driver_id = auth.uid()) OR -- Accepting a job
    EXISTS (
      SELECT 1 FROM tenant_users 
      WHERE user_id = auth.uid() AND role = 'admin' AND tenant_id = jobs.tenant_id
    )
  );

-- Job Locations Policies

CREATE POLICY "Users can view job locations"
  ON job_locations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM jobs 
      WHERE jobs.id = job_locations.job_id AND (
        jobs.customer_id = auth.uid() OR 
        jobs.driver_id = auth.uid() OR
        EXISTS (
          SELECT 1 FROM tenant_users 
          WHERE user_id = auth.uid() AND role = 'admin' AND tenant_id = jobs.tenant_id
        )
      )
    )
  );

CREATE POLICY "Drivers can insert job locations"
  ON job_locations FOR INSERT
  WITH CHECK (
    auth.uid() = driver_id AND
    EXISTS (
      SELECT 1 FROM jobs 
      WHERE jobs.id = job_locations.job_id AND jobs.driver_id = auth.uid()
    )
  );
