-- Rollback for 20261269000000_merge_cash_pilot_with_roadmap_cash (GENERATED). Restores the roadmap-final bodies verbatim and removes the merge
-- helpers and the courier_enabled column. Roll back the roadmap chain too (see header of the up migration).
BEGIN;
CREATE OR REPLACE FUNCTION public.enforce_job_payment_eligibility()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
    IF NEW.driver_id IS NOT NULL
       AND OLD.driver_id IS DISTINCT FROM NEW.driver_id
       AND NEW.status IN ('assigned', 'accepted') THEN
        -- Cash custody is verified by enforce_ride_cash_credit_v1e; exempt it
        -- from the electronic-payment status gate.
        IF NEW.payment_method IS DISTINCT FROM 'cash'
           AND NEW.payment_status NOT IN (
               'paid', 'wallet_funded', 'authorized', 'requires_capture', 'succeeded', 'captured'
           ) THEN
            RAISE EXCEPTION 'Job is not payment-eligible for driver acquisition'
                USING ERRCODE = 'MB003',
                      DETAIL = 'payment_eligibility';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_ride_cash_credit_v1e() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h public.driver_cash_credit_holds_v1e%ROWTYPE; driver uuid; slug text;
BEGIN
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=NEW.id AND status='held' ORDER BY created_at DESC LIMIT 1;
 IF FOUND THEN
  IF NOT public.cash_credit_service_writer_v1e() THEN RAISE EXCEPTION 'Cash transitions require the server role' USING ERRCODE='CE002'; END IF;
  IF NEW.status IS NULL THEN RAISE EXCEPTION 'Cash booking status missing' USING ERRCODE='CE006'; END IF;
  IF NEW.status IN ('cancelled','canceled','expired','failed','no_driver_found') THEN
   IF h.status='settled' THEN RAISE EXCEPTION 'Settled cash ride requires refund review' USING ERRCODE='CE005'; END IF;
   IF h.status='held' THEN PERFORM public.resolve_cash_job_credit_v1e(NEW.id,'released'); END IF;
   RETURN NEW;
  END IF;
  IF h.status='released' OR (h.status='settled' AND NEW.status NOT IN ('completed','delivered','settled')) THEN RAISE EXCEPTION 'Resolved cash ride cannot reopen' USING ERRCODE='CE005'; END IF;
  IF NEW.driver_id IS NOT NULL AND NEW.accepted_driver_id IS NOT NULL AND NEW.driver_id<>NEW.accepted_driver_id THEN RAISE EXCEPTION 'Conflicting accepted drivers' USING ERRCODE='CE005'; END IF;
  IF NEW.metadata->>'cash_collection_mode' IS DISTINCT FROM 'full_customer_charge' OR NEW.payment_intent_id IS NOT NULL THEN RAISE EXCEPTION 'Cash custody/payment mode changed' USING ERRCODE='CE005'; END IF;
  IF NEW.payment_method IS DISTINCT FROM 'cash' OR NEW.fare_breakdown IS DISTINCT FROM h.fare_snapshot
     OR NEW.tenant_id IS DISTINCT FROM h.tenant_id OR NEW.currency_code IS DISTINCT FROM h.currency_code
     OR NEW.country_code IS DISTINCT FROM h.country_code OR coalesce(NEW.driver_id,NEW.accepted_driver_id) IS DISTINCT FROM h.driver_id THEN
   RAISE EXCEPTION 'Cash reservation requires explicit reconciliation before changing terms' USING ERRCODE='CE005'; END IF;
  IF NEW.status IN ('completed','delivered','settled') AND h.status='held' THEN PERFORM public.resolve_cash_job_credit_v1e(NEW.id,'settled'); END IF;
  RETURN NEW;
 END IF;
 -- Reopen guard for a resolved (released/settled) hold whose row is no longer live.
 IF EXISTS(SELECT 1 FROM public.driver_cash_credit_holds_v1e WHERE job_id=NEW.id AND status IN ('released','settled')) THEN
  IF EXISTS(SELECT 1 FROM public.driver_cash_credit_holds_v1e WHERE job_id=NEW.id AND status='released')
     AND NEW.status IN ('completed','delivered','settled') THEN
   RAISE EXCEPTION 'Released cash ride cannot complete' USING ERRCODE='CE005'; END IF;
  IF EXISTS(SELECT 1 FROM public.driver_cash_credit_holds_v1e WHERE job_id=NEW.id AND status='settled')
     AND NEW.status IN ('cancelled','canceled','expired','failed','no_driver_found') THEN
   RAISE EXCEPTION 'Settled cash ride cannot be cancelled' USING ERRCODE='CE005'; END IF;
  RETURN NEW;
 END IF;
 IF NOT public.driver_cash_credit_enabled_v1e() OR NEW.payment_method IS DISTINCT FROM 'cash' THEN RETURN NEW; END IF;
 SELECT st.slug INTO slug FROM public.service_types st WHERE st.id=NEW.service_type_id;
 IF slug IS NULL OR slug NOT IN ('ride','delivery','errand') THEN RETURN NEW; END IF;
 IF NOT public.cash_credit_service_writer_v1e() THEN RAISE EXCEPTION 'Cash acceptance requires the server role' USING ERRCODE='CE002'; END IF;
 driver:=coalesce(NEW.driver_id,NEW.accepted_driver_id);
 IF driver IS NOT NULL AND NEW.status IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived','in_progress','completed','delivered','settled') THEN
  PERFORM public.reserve_cash_job_credit_v1e(NEW.id,driver);
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.reserve_cash_job_credit_v1e(p_job_id uuid,p_driver_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.jobs%ROWTYPE; enrol public.driver_cash_credit_enrolments_v1e%ROWTYPE; p jsonb; terms jsonb; balance jsonb; h public.driver_cash_credit_holds_v1e%ROWTYPE; v_id uuid; event uuid; need bigint; driver uuid;
BEGIN
 IF NOT public.driver_cash_credit_enabled_v1e() THEN RAISE EXCEPTION 'Cash credit pilot disabled' USING ERRCODE='CE001'; END IF;
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 driver:=coalesce(j.driver_id,j.accepted_driver_id);
 IF driver IS DISTINCT FROM p_driver_id OR p_driver_id IS NULL OR (j.driver_id IS NOT NULL AND j.accepted_driver_id IS NOT NULL AND j.driver_id<>j.accepted_driver_id)
 OR j.payment_method IS DISTINCT FROM 'cash' OR j.status IS NULL OR j.status NOT IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived','in_progress','completed','delivered','settled') THEN
  RAISE EXCEPTION 'Cash booking/driver is not eligible' USING ERRCODE='CE002'; END IF;
 -- Passenger Ride keeps its branch; verified courier services are delivery/errand.
 IF NOT EXISTS(SELECT 1 FROM public.service_types WHERE id=j.service_type_id AND slug IN ('ride','delivery','errand')) THEN
  RAISE EXCEPTION 'Cash credit supports Ride, delivery and errand only' USING ERRCODE='CE002'; END IF;
 PERFORM public.driver_cash_credit_lock_v1e(j.tenant_id,p_driver_id,j.currency_code);
 SELECT to_jsonb(x) INTO p FROM public.profiles x WHERE id=p_driver_id;
 SELECT * INTO enrol FROM public.driver_cash_credit_enrolments_v1e WHERE tenant_id=j.tenant_id AND driver_id=p_driver_id AND country_code=j.country_code AND currency_code=j.currency_code FOR SHARE;
 IF p IS NULL OR p->>'role' IS DISTINCT FROM 'driver' OR NULLIF(p->>'registration_activated_at','') IS NULL
 OR NOT public.driver_job_market_matches_v23(p,to_jsonb(j))
 OR NOT EXISTS(SELECT 1 FROM public.market_availability m WHERE m.country_code=j.country_code AND upper(m.supported_currency)=j.currency_code)
 OR enrol.driver_id IS NULL OR NOT enrol.enabled OR enrol.consented_at>now() THEN
  RAISE EXCEPTION 'Driver cash credit is not approved for this tenant/market' USING ERRCODE='CE002'; END IF;
 terms:=public.cash_credit_terms_v1e(j.fare_breakdown,j.currency_code);need:=(terms->>'required')::bigint;
 IF j.fare_breakdown ? 'driverCommissionPolicy' AND j.fare_breakdown->'driverCommissionPolicy'->>'driverId' IS DISTINCT FROM p_driver_id::text THEN
  RAISE EXCEPTION 'Frozen commission belongs to another driver' USING ERRCODE='CE003'; END IF;
 IF j.agreed_fare IS NOT NULL AND public.cash_credit_minor_v1e(to_jsonb(j.agreed_fare),j.currency_code)<>(terms->>'charge')::bigint THEN
  RAISE EXCEPTION 'Agreed fare does not match frozen cash terms' USING ERRCODE='CE003'; END IF;
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=j.id AND status='held' FOR UPDATE;
 IF FOUND THEN
  IF h.driver_id<>p_driver_id OR h.tenant_id<>j.tenant_id OR h.currency_code<>j.currency_code OR h.country_code<>j.country_code OR h.fare_snapshot IS DISTINCT FROM j.fare_breakdown THEN
   RAISE EXCEPTION 'Cash reservation replay terms changed' USING ERRCODE='CE005'; END IF;
  RETURN h.id;
 END IF;
 IF j.metadata->>'cash_collection_mode' IS DISTINCT FROM 'full_customer_charge' OR j.payment_intent_id IS NOT NULL OR j.payment_status IS NULL OR j.payment_status NOT IN ('pending','cash_due','cash_pending') THEN
  RAISE EXCEPTION 'Explicit full-cash custody and no digital payment required' USING ERRCODE='CE002'; END IF;
 IF j.status IN ('completed','delivered','settled') THEN RAISE EXCEPTION 'Cannot create a new cash hold after completion' USING ERRCODE='CE006'; END IF;
 balance:=public.driver_cash_credit_balance_v1e(j.tenant_id,p_driver_id,j.currency_code);
 IF NOT (balance->>'consistent')::boolean OR (balance->>'deficitMinor')::numeric>0 THEN RAISE EXCEPTION 'Cash credit requires reconciliation' USING ERRCODE='CE006'; END IF;
 IF (balance->>'availableMinor')::numeric<need THEN RAISE EXCEPTION 'Top up driver cash credit before accepting this cash ride' USING ERRCODE='CE004'; END IF;
 v_id:=gen_random_uuid();
 IF need>0 THEN
  event:=public.post_wallet_event('cash-hold:'||v_id::text,'cash_credit_reserve',j.tenant_id,p_driver_id,j.currency_code,
   jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit','amountMinor',-need),jsonb_build_object('accountPurpose','driver_cash_credit_reserved','amountMinor',need)));
 END IF;
 INSERT INTO public.driver_cash_credit_holds_v1e(id,job_id,tenant_id,driver_id,country_code,currency_code,fare_snapshot,enrolment_terms_version,enrolment_consented_at,customer_charge_minor,commission_minor,platform_fee_minor,driver_entitlement_minor,required_credit_minor,reserve_event_id)
 VALUES(v_id,j.id,j.tenant_id,p_driver_id,j.country_code,j.currency_code,j.fare_breakdown,enrol.terms_version,enrol.consented_at,(terms->>'charge')::bigint,(terms->>'commission')::bigint,(terms->>'fee')::bigint,(terms->>'net')::bigint,need,event);
 RETURN v_id;
END $$;

DROP FUNCTION IF EXISTS public.cash_acquisition_allowed_v1e(public.jobs);
DROP FUNCTION IF EXISTS public.cash_service_enabled_v1e(text,text,text);
ALTER TABLE public.driver_cash_credit_markets_v1e DROP COLUMN IF EXISTS courier_enabled;
COMMIT;
