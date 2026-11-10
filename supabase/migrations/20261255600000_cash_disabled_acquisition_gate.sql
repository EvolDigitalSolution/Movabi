-- Disabled-pilot acquisition gate: enforce_ride_cash_credit_v1e previously
-- returned early when the pilot was off, so a cash ride could acquire a
-- driver with no credit reservation via direct INSERT/UPDATE. The reserve
-- RPC already raises CE001; align the trigger boundary identically.
--
-- Blocked: a cash ride gaining a driver in an assignable status while the
-- pilot is off (INSERT with driver set, or UPDATE driver none->some).
-- Preserved: creation in requested/searching, non-acquisition updates,
-- cancellation/expiry, and continuation of jobs that already had a driver
-- (e.g. legacy rows, recovery work) — no blanket block on lifecycle.
CREATE OR REPLACE FUNCTION public.enforce_ride_cash_credit_v1e() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h public.driver_cash_credit_holds_v1e%ROWTYPE; driver uuid; slug text;
BEGIN
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=NEW.id;
 IF FOUND THEN
  IF NOT public.cash_credit_service_writer_v1e() THEN RAISE EXCEPTION 'Cash transitions require the server role' USING ERRCODE='CE002'; END IF;
  IF NEW.status IS NULL THEN RAISE EXCEPTION 'Cash booking status missing' USING ERRCODE='CE006'; END IF;
  IF NEW.status IN ('cancelled','canceled','expired','failed','no_driver_found') THEN
   IF h.status='settled' THEN RAISE EXCEPTION 'Settled cash ride requires refund review' USING ERRCODE='CE005'; END IF;
   IF h.status='held' THEN PERFORM public.resolve_cash_job_credit_v1e(NEW.id,'released'); END IF;
   RETURN NEW;
  END IF;
  IF NEW.driver_id IS NOT NULL AND NEW.accepted_driver_id IS NOT NULL AND NEW.driver_id<>NEW.accepted_driver_id THEN RAISE EXCEPTION 'Conflicting accepted drivers' USING ERRCODE='CE005'; END IF;
  IF NEW.metadata->>'cash_collection_mode' IS DISTINCT FROM 'full_customer_charge' OR NEW.payment_intent_id IS NOT NULL THEN RAISE EXCEPTION 'Cash custody/payment mode changed' USING ERRCODE='CE005'; END IF;
  IF NEW.payment_method IS DISTINCT FROM 'cash' OR NEW.fare_breakdown IS DISTINCT FROM h.fare_snapshot
     OR NEW.tenant_id IS DISTINCT FROM h.tenant_id OR NEW.currency_code IS DISTINCT FROM h.currency_code
     OR NEW.country_code IS DISTINCT FROM h.country_code OR coalesce(NEW.driver_id,NEW.accepted_driver_id) IS DISTINCT FROM h.driver_id THEN
   RAISE EXCEPTION 'Cash reservation requires explicit reconciliation before changing terms' USING ERRCODE='CE005'; END IF;
  IF NEW.status IN ('completed','delivered','settled') AND h.status='held' THEN PERFORM public.resolve_cash_job_credit_v1e(NEW.id,'settled'); END IF;
  RETURN NEW;
 END IF;
 IF NEW.payment_method IS DISTINCT FROM 'cash' THEN RETURN NEW; END IF;
 IF NOT public.driver_cash_credit_enabled_v1e() THEN
  -- Acquisition while disabled must fail, not silently skip the reservation.
  driver:=coalesce(NEW.driver_id,NEW.accepted_driver_id);
  IF driver IS NOT NULL AND coalesce(OLD.driver_id,OLD.accepted_driver_id) IS NULL
     AND NEW.status IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived','in_progress','completed','delivered','settled') THEN
   RAISE EXCEPTION 'Cash credit pilot disabled' USING ERRCODE='CE001';
  END IF;
  RETURN NEW;
 END IF;
 SELECT st.slug INTO slug FROM public.service_types st WHERE st.id=NEW.service_type_id;
 IF slug IS DISTINCT FROM 'ride' THEN RETURN NEW; END IF;
 IF NOT public.cash_credit_service_writer_v1e() THEN RAISE EXCEPTION 'Cash acceptance requires the server role' USING ERRCODE='CE002'; END IF;
 driver:=coalesce(NEW.driver_id,NEW.accepted_driver_id);
 IF driver IS NOT NULL AND NEW.status IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived','in_progress','completed','delivered','settled') THEN
  PERFORM public.reserve_cash_job_credit_v1e(NEW.id,driver);
 END IF;
 RETURN NEW;
END $$;
