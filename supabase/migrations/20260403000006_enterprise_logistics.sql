-- Migration: Enterprise Logistics & Fintech
-- Date: 2026-04-03

-- 1. Create driver_accounts table for Stripe Connect
CREATE TABLE IF NOT EXISTS driver_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  stripe_account_id TEXT NOT NULL UNIQUE,
  charges_enabled BOOLEAN DEFAULT false,
  payouts_enabled BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create events table for event-driven architecture
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  tenant_id UUID,
  user_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create driver_earnings table
CREATE TABLE IF NOT EXISTS driver_earnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES auth.users(id),
  job_id UUID NOT NULL REFERENCES jobs(id),
  amount DECIMAL(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Create dispatch_logs table for AI/ML foundation
CREATE TABLE IF NOT EXISTS dispatch_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id),
  driver_id UUID REFERENCES auth.users(id),
  distance DOUBLE PRECISION,
  accepted BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Extend jobs table with payment fields
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payment_intent_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS platform_fee DECIMAL(10,2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS driver_payout DECIMAL(10,2);

-- 6. Add indexes
CREATE INDEX IF NOT EXISTS idx_driver_accounts_user_id ON driver_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_driver_accounts_tenant_id ON driver_accounts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_driver_earnings_driver_id ON driver_earnings(driver_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_logs_job_id ON dispatch_logs(job_id);

-- 7. RLS Policies

-- Driver Accounts: Only owner can view
ALTER TABLE driver_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Drivers can view their own connect account"
  ON driver_accounts FOR SELECT
  USING (auth.uid() = user_id);

-- Events: Admin only
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view tenant events"
  ON events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tenant_users 
      WHERE user_id = auth.uid() AND role = 'admin' AND tenant_id = events.tenant_id
    )
  );

-- Driver Earnings: Only driver can view
ALTER TABLE driver_earnings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Drivers can view their own earnings"
  ON driver_earnings FOR SELECT
  USING (auth.uid() = driver_id);

-- Dispatch Logs: Admin only
ALTER TABLE dispatch_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view dispatch logs"
  ON dispatch_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tenant_users 
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- 8. Updated at trigger for driver_accounts
CREATE OR REPLACE TRIGGER tr_update_driver_accounts_updated_at
    BEFORE UPDATE ON driver_accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_jobs_updated_at(); -- Reusing existing function

-- 9. View for Operations Dashboard (Aggregated Metrics)
CREATE OR REPLACE VIEW operations_metrics AS
SELECT 
  tenant_id,
  COUNT(*) FILTER (WHERE status IN ('accepted', 'in_progress')) as active_jobs_count,
  SUM(price) FILTER (WHERE status = 'completed' AND created_at >= CURRENT_DATE) as revenue_today,
  (SELECT COUNT(*) FROM profiles WHERE is_online = true AND tenant_id = jobs.tenant_id) as online_drivers_count
FROM jobs
GROUP BY tenant_id;
