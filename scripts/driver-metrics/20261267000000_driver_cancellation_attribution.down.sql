-- Rollback for 20261267000000_driver_cancellation_attribution. Drops only the two added functions.
-- Recorded actor fields stay in jobs.metadata (history is never erased). The API must be on a
-- version that calls cancel_job_safely before this runs.
drop function if exists public.driver_offer_metrics_v2(uuid, timestamptz);
drop function if exists public.cancel_job_with_actor(uuid, text, uuid, text);
