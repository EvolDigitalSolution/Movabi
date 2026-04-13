-- Migration: Job Lifecycle Events
-- Created: 2026-04-08
-- Description: Adds a job_events table to track key lifecycle events for audit and observability.

-- Create job_events table
CREATE TABLE IF NOT EXISTS job_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    actor_id UUID REFERENCES profiles(id),
    actor_role TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id);
CREATE INDEX IF NOT EXISTS idx_job_events_event_type ON job_events(event_type);

-- Enable RLS
ALTER TABLE job_events ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view events for their own jobs" ON job_events
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM jobs 
            WHERE jobs.id = job_events.job_id 
            AND (jobs.customer_id = auth.uid() OR jobs.driver_id = auth.uid())
        )
    );

CREATE POLICY "Admins can view all events" ON job_events
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM profiles 
            WHERE profiles.id = auth.uid() 
            AND profiles.role = 'admin'
        )
    );

CREATE POLICY "System/Authenticated users can insert events" ON job_events
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Comment for documentation
COMMENT ON TABLE job_events IS 'Audit log for job lifecycle events including payment, dispatch, and status changes.';
