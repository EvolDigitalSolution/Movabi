-- Rollback of 20261270100000_completion_pin_effective.sql.
-- Removes the two triggers and their functions. Keeps every job's frozen metadata and every
-- minted secret (customers may already have been shown a PIN). The pre-release API keeps working:
-- it reads completion_pin_required and the driver override exactly as before.
DROP TRIGGER IF EXISTS zz_mint_completion_pin_on_assignment ON public.jobs;
DROP TRIGGER IF EXISTS zz_stamp_completion_pin_policy ON public.jobs;
DROP FUNCTION IF EXISTS public.mint_completion_pin_on_assignment();
DROP FUNCTION IF EXISTS public.stamp_completion_pin_policy();
DROP FUNCTION IF EXISTS public.completion_pin_market_policy(jsonb);
