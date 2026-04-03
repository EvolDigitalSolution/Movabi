-- Migration: Job Communication System
-- Date: 2026-04-03

-- 1. Create job_messages table
CREATE TABLE IF NOT EXISTS job_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id),
  receiver_id UUID NOT NULL REFERENCES auth.users(id),
  message TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('quick', 'text', 'system')),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_job_messages_job_id ON job_messages(job_id);
CREATE INDEX IF NOT EXISTS idx_job_messages_tenant_id ON job_messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_job_messages_sender_id ON job_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_job_messages_receiver_id ON job_messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_job_messages_created_at ON job_messages(created_at);

-- 3. Enable RLS
ALTER TABLE job_messages ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies

-- Customer: can read messages for their own jobs
CREATE POLICY "Customers can read messages for their own jobs"
  ON job_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM jobs 
      WHERE id = job_messages.job_id AND customer_id = auth.uid()
    )
  );

-- Customer: can insert messages only for their own active jobs
CREATE POLICY "Customers can send messages for their own active jobs"
  ON job_messages FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM jobs 
      WHERE id = job_messages.job_id 
      AND customer_id = auth.uid() 
      AND status IN ('accepted', 'in_progress')
    )
    AND auth.uid() = sender_id
  );

-- Driver: can read messages for jobs assigned to them
CREATE POLICY "Drivers can read messages for jobs assigned to them"
  ON job_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM jobs 
      WHERE id = job_messages.job_id AND driver_id = auth.uid()
    )
  );

-- Driver: can insert messages only for jobs assigned to them and only when active
CREATE POLICY "Drivers can send messages for jobs assigned to them when active"
  ON job_messages FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM jobs 
      WHERE id = job_messages.job_id 
      AND driver_id = auth.uid() 
      AND status IN ('accepted', 'in_progress')
    )
    AND auth.uid() = sender_id
  );

-- Admin: can read messages for jobs in their tenant
CREATE POLICY "Admins can read messages for jobs in their tenant"
  ON job_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tenant_users 
      WHERE user_id = auth.uid() AND role = 'admin' AND tenant_id = job_messages.tenant_id
    )
  );

-- 5. Enable Realtime
-- Note: This assumes the publication 'supabase_realtime' exists.
-- If it doesn't, it will be created automatically by Supabase when enabled in the dashboard.
-- In a migration, we can try to add it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE job_messages;
  END IF;
END $$;
