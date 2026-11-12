-- Cash-ride booking phase 3: atomic completion of a cash Ride.
-- One transaction, with the job locked: proves it is this driver's in-progress cash Ride with
-- full cash custody and no PaymentIntent, re-validates the frozen canonical fare
-- (cash_credit_terms_v1e), marks it completed / cash_collected, and records the driver's earnings
-- as a cash ride (status paid: the driver already holds the cash; no transfer, no payout queue).
-- The deployed cash-credit trigger (enforce_ride_cash_credit_v1e) settles the commission + fee
-- hold in the same transaction. Idempotent: a repeat returns the completed job unchanged.
-- New function only; no deployed object is replaced.
BEGIN;

CREATE FUNCTION public.complete_cash_ride_v1e(p_job_id uuid, p_driver_id uuid, p_metadata jsonb) RETURNS SETOF public.jobs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE j public.jobs%ROWTYPE; b jsonb; t jsonb;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id = p_job_id FOR UPDATE;
 IF coalesce(j.driver_id, j.accepted_driver_id) IS DISTINCT FROM p_driver_id THEN
  RAISE EXCEPTION 'Only the assigned driver can complete this request'; END IF;
 IF j.payment_method IS DISTINCT FROM 'cash' OR j.payment_intent_id IS NOT NULL
    OR j.metadata->>'cash_collection_mode' IS DISTINCT FROM 'full_customer_charge' THEN
  RAISE EXCEPTION 'Not a cash ride'; END IF;
 IF j.status = 'completed' AND j.payment_status = 'cash_collected' THEN
  IF EXISTS (SELECT 1 FROM public.driver_earnings e WHERE e.job_id = p_job_id AND e.settlement_purpose = 'cash_ride' AND e.driver_id = p_driver_id) THEN
   RETURN QUERY SELECT * FROM public.jobs WHERE id = p_job_id; RETURN;
  END IF;
  RAISE EXCEPTION 'Completed cash ride requires reconciliation';
 END IF;
 IF j.payment_status IS DISTINCT FROM 'cash_due' THEN RAISE EXCEPTION 'Cash ride payment state requires reconciliation'; END IF;
 IF j.status NOT IN ('in_progress','en_route_to_customer','arrived_at_customer','on_trip') THEN
  RAISE EXCEPTION 'Request is not ready for completion'; END IF;
 IF coalesce(p_metadata->>'completion_pin_verified_at','') = '' THEN RAISE EXCEPTION 'Verified completion evidence missing'; END IF;
 IF EXISTS (SELECT 1 FROM public.job_payout_queue q WHERE q.job_id = p_job_id) THEN
  RAISE EXCEPTION 'A payout entry for a cash ride requires reconciliation'; END IF;
 b := j.fare_breakdown;
 t := public.cash_credit_terms_v1e(b, j.currency_code);   -- canonical frozen fare or CE003
 UPDATE public.jobs SET status = 'completed', payment_status = 'cash_collected', completed_at = coalesce(completed_at, now()),
   driver_payout = (b->>'driverEntitlement')::numeric, platform_fee = (b->>'platformFeeAmount')::numeric,
   commission_fee = (b->>'driverCommissionAmount')::numeric, commission_rate_used = (b->>'commissionPercent')::numeric,
   metadata = coalesce(j.metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb)
     || jsonb_build_object('cash_collected', true, 'cash_collected_minor', (t->>'charge')::bigint), updated_at = now()
 WHERE id = p_job_id;
 INSERT INTO public.driver_earnings(driver_id, job_id, amount, platform_fee, gross_amount, status, currency_code, country_code, settled_at, settlement_purpose)
 VALUES (p_driver_id, p_job_id, (b->>'driverEntitlement')::numeric, (b->>'platformFeeAmount')::numeric, (b->>'customerCharge')::numeric,
   'paid', j.currency_code, j.country_code, now(), 'cash_ride')
 ON CONFLICT (job_id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Existing earnings for this job require reconciliation'; END IF;
 RETURN QUERY SELECT * FROM public.jobs WHERE id = p_job_id;
END $$;
REVOKE ALL ON FUNCTION public.complete_cash_ride_v1e(uuid, uuid, jsonb) FROM PUBLIC;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON FUNCTION public.complete_cash_ride_v1e(uuid, uuid, jsonb) FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON FUNCTION public.complete_cash_ride_v1e(uuid, uuid, jsonb) FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public.complete_cash_ride_v1e(uuid, uuid, jsonb) TO service_role; END IF;
END $g$;

COMMIT;
