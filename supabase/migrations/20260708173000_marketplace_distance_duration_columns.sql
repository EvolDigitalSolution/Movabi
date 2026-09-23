-- Marketplace distance/duration columns for root-level reads
-- Apply this migration so the jobs table can store these values directly,
-- while metadata remains the safe fallback for older clients/environments.

ALTER TABLE public.jobs
    ADD COLUMN IF NOT EXISTS distance_km NUMERIC,
    ADD COLUMN IF NOT EXISTS estimated_distance_km NUMERIC,
    ADD COLUMN IF NOT EXISTS distance_meters INTEGER,
    ADD COLUMN IF NOT EXISTS duration_seconds INTEGER,
    ADD COLUMN IF NOT EXISTS estimated_duration INTEGER;

-- Add comments for clarity
COMMENT ON COLUMN public.jobs.distance_km IS 'Computed route distance in kilometres';
COMMENT ON COLUMN public.jobs.estimated_distance_km IS 'Estimated route distance in kilometres';
COMMENT ON COLUMN public.jobs.distance_meters IS 'Computed route distance in metres';
COMMENT ON COLUMN public.jobs.duration_seconds IS 'Estimated route duration in seconds';
COMMENT ON COLUMN public.jobs.estimated_duration IS 'Estimated route duration in seconds';
