-- Rollback for 20261267000000_driver_cancellation_attribution. Drops only the added functions.
-- Recorded actor fields and recorded offer events stay (history is never erased).
-- Order: roll the API back to a version that calls cancel_job_safely FIRST; an API that calls
-- cancel_job_with_actor fails closed (cancel refused, job unchanged) once this has run.
drop function if exists public.driver_offer_metrics_v2(uuid, timestamptz);
drop function if exists public.record_negotiated_assignment(uuid, uuid);
drop function if exists public.cancel_job_with_actor(uuid, text, uuid, text);
