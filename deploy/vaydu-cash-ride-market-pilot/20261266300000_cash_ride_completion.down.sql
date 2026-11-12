-- Rollback of 20261266300000_cash_ride_completion: drops the cash completion function.
-- Completed cash rides and their earnings rows are kept.
BEGIN;
DROP FUNCTION public.complete_cash_ride_v1e(uuid, uuid, jsonb);
COMMIT;
