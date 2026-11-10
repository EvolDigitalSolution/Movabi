-- Additive candidate: courier cash acquisition + atomic reassignment.
--
-- Slugs verified from booking/create canonicalisation: delivery and errand are
-- the courier services (shop/shopping/errands -> errand; deliver/courier/parcel
-- -> delivery). ride remains the passenger branch, unchanged.
--
-- Reassignment keeps financial history: the original hold becomes 'reassigned'
-- (never deleted), its reservation is reversed once, and the replacement hold is
-- created by the canonical reserve function inside the same transaction. Any
-- failure (insufficient credit, market/eligibility, fare) rolls back the whole
-- transaction, restoring the original assignment and hold.
BEGIN;

-- 1) Multiple holds per job, but only one live hold.
DO $$ DECLARE c text; BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid='public.driver_cash_credit_holds_v1e'::regclass AND contype='u'
     AND pg_get_constraintdef(oid) LIKE '%(job_id)%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE public.driver_cash_credit_holds_v1e DROP CONSTRAINT %I', c); END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS driver_cash_credit_holds_one_held_v1e
  ON public.driver_cash_credit_holds_v1e(job_id) WHERE status='held';

-- 2) Explicit reassigned status.
DO $$ DECLARE c text; BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid='public.driver_cash_credit_holds_v1e'::regclass AND contype='c'
     AND pg_get_constraintdef(oid) LIKE '%status%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE public.driver_cash_credit_holds_v1e DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE public.driver_cash_credit_holds_v1e
  ADD CONSTRAINT driver_cash_credit_holds_v1e_status_check
  CHECK (status IN ('held','released','settled','reassigned'));

-- 3) Reserve authority: courier slugs, and replay checks the live hold only.
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

-- 4) Lifecycle trigger: live hold only; reassigned history never blocks or reopens.
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

-- 5) Atomic reassignment: retire old hold, reverse once, let the trigger reserve
--    canonically for the replacement; any failure aborts the whole transaction.
CREATE OR REPLACE FUNCTION public.reassign_cash_job_credit_v1f(p_job uuid, p_new_driver uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.jobs%ROWTYPE; h public.driver_cash_credit_holds_v1e%ROWTYPE;
        old_driver uuid; reserved numeric; v_event uuid; v_hold uuid;
BEGIN
 IF NOT public.cash_credit_service_writer_v1e() THEN
  RAISE EXCEPTION 'Cash reassignment requires the server role' USING ERRCODE='CE002'; END IF;
 SELECT * INTO j FROM public.jobs WHERE id=p_job FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Job not found' USING ERRCODE='CE002'; END IF;
 IF j.payment_method IS DISTINCT FROM 'cash' THEN RAISE EXCEPTION 'Not a cash job' USING ERRCODE='CE002'; END IF;
 IF j.status NOT IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived') THEN
  RAISE EXCEPTION 'Cash reassignment only before service starts' USING ERRCODE='CE006'; END IF;
 IF j.metadata->>'cash_collected_at' IS NOT NULL THEN
  RAISE EXCEPTION 'Cash already collected - reassignment not allowed' USING ERRCODE='CE005'; END IF;
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=p_job AND status='held' FOR UPDATE;
 IF NOT FOUND THEN
  IF j.driver_id=p_new_driver AND j.accepted_driver_id=p_new_driver THEN
   SELECT id INTO v_hold FROM public.driver_cash_credit_holds_v1e WHERE job_id=p_job AND status='held';
   IF v_hold IS NOT NULL THEN RETURN v_hold; END IF;
  END IF;
  RAISE EXCEPTION 'No held cash credit to reassign' USING ERRCODE='CE006';
 END IF;
 IF h.driver_id=p_new_driver THEN RETURN h.id; END IF;
 old_driver:=h.driver_id;
 PERFORM public.driver_cash_credit_lock_v1e(h.tenant_id, least(old_driver,p_new_driver), h.currency_code);
 PERFORM public.driver_cash_credit_lock_v1e(h.tenant_id, greatest(old_driver,p_new_driver), h.currency_code);
 SELECT coalesce(sum(m.amount_minor::numeric),0) INTO reserved
   FROM public.wallet_accounts a JOIN public.wallet_movements m ON m.account_id=a.id
  WHERE a.tenant_id=h.tenant_id AND a.owner_id=h.driver_id AND a.currency_code=h.currency_code
    AND a.balance_purpose='driver_cash_credit_reserved';
 IF reserved < h.required_credit_minor THEN
  RAISE EXCEPTION 'Cash reserved ledger requires reconciliation' USING ERRCODE='CE006'; END IF;
 v_event:=public.post_wallet_reversal('cash-hold:'||h.id::text,'cash-hold:'||h.id::text||':reassign');
 UPDATE public.driver_cash_credit_holds_v1e
    SET status='reassigned', resolution_event_id=v_event, resolved_at=now()
  WHERE id=h.id;
 -- The replacement reservation is created by the lifecycle trigger; if it fails
 -- (CE004/CE002/CE003/CE006) the reversal and status change roll back with it.
 UPDATE public.jobs SET driver_id=p_new_driver, accepted_driver_id=p_new_driver WHERE id=p_job;
 SELECT id INTO v_hold FROM public.driver_cash_credit_holds_v1e WHERE job_id=p_job AND status='held';
 IF v_hold IS NULL THEN RAISE EXCEPTION 'Replacement cash hold was not created' USING ERRCODE='CE006'; END IF;
 RETURN v_hold;
END $$;

-- 5b) Freeze guard must accept the server-only reassigned transition.
CREATE OR REPLACE FUNCTION public.guard_cash_credit_hold_v1e()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cash credit history cannot be deleted' USING ERRCODE='CE005'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','resolution_event_id','resolved_at','review_required','disputed_minor','review_due_at','escalated']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','resolution_event_id','resolved_at','review_required','disputed_minor','review_due_at','escalated'])
 OR OLD.status<>'held' OR NEW.status NOT IN ('held','released','settled','reassigned') THEN
  RAISE EXCEPTION 'Cash credit terms/history are frozen' USING ERRCODE='CE005'; END IF;
 RETURN NEW;
END $$;
-- 6) Multi-hold safety: every lifecycle lookup must target the live hold.
--    Without this, a reassigned job has two historical rows and cancellation/
--    completion would fail with "query returned more than one row".
CREATE OR REPLACE FUNCTION public.resolve_cash_job_credit_v1e(p_job_id uuid,p_outcome text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.jobs%ROWTYPE; h public.driver_cash_credit_holds_v1e%ROWTYPE; event uuid; reserved numeric;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=p_job_id AND status='held' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cash hold missing' USING ERRCODE='CE006'; END IF;
 PERFORM public.driver_cash_credit_lock_v1e(h.tenant_id,h.driver_id,h.currency_code);
 IF p_outcome IS NULL OR p_outcome NOT IN ('released','settled') THEN RAISE EXCEPTION 'Invalid cash resolution' USING ERRCODE='CE003'; END IF;
 IF p_outcome='released' AND (j.status IS NULL OR j.status NOT IN ('cancelled','canceled','expired','failed','no_driver_found')) THEN RAISE EXCEPTION 'Only cancelled/failed cash rides release credit' USING ERRCODE='CE006'; END IF;
 IF p_outcome='settled' AND (j.status IS NULL OR j.status NOT IN ('completed','delivered','settled') OR coalesce(j.driver_id,j.accepted_driver_id) IS DISTINCT FROM h.driver_id OR j.payment_method IS DISTINCT FROM 'cash' OR j.fare_breakdown IS DISTINCT FROM h.fare_snapshot OR j.tenant_id<>h.tenant_id OR j.currency_code<>h.currency_code OR j.country_code<>h.country_code) THEN
  RAISE EXCEPTION 'Cash completion terms/state mismatch' USING ERRCODE='CE006'; END IF;
 IF h.status=p_outcome THEN RETURN h.id; END IF;
 IF h.status<>'held' THEN RAISE EXCEPTION 'Cash hold already resolved differently' USING ERRCODE='CE005'; END IF;
 SELECT coalesce(sum(m.amount_minor::numeric),0) INTO reserved FROM public.wallet_accounts a JOIN public.wallet_movements m ON m.account_id=a.id
 WHERE a.tenant_id=h.tenant_id AND a.owner_id=h.driver_id AND a.currency_code=h.currency_code AND a.balance_purpose='driver_cash_credit_reserved';
 IF reserved IS DISTINCT FROM (SELECT coalesce(sum(required_credit_minor::numeric),0) FROM public.driver_cash_credit_holds_v1e WHERE tenant_id=h.tenant_id AND driver_id=h.driver_id AND currency_code=h.currency_code AND status='held') OR reserved<h.required_credit_minor THEN RAISE EXCEPTION 'Cash reserved ledger requires reconciliation' USING ERRCODE='CE006'; END IF;
 IF h.required_credit_minor>0 THEN
  IF p_outcome='released' THEN event:=public.post_wallet_reversal('cash-hold:'||h.id::text,'cash-hold:'||h.id::text||':release');
  ELSE event:=public.post_wallet_event('cash-hold:'||h.id::text||':settle','cash_credit_settle',h.tenant_id,h.driver_id,h.currency_code,
    jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit_reserved','amountMinor',-h.required_credit_minor),jsonb_build_object('accountPurpose','cash_fee_clearing','amountMinor',h.required_credit_minor)));
  END IF;
 END IF;
 UPDATE public.driver_cash_credit_holds_v1e SET status=p_outcome,resolution_event_id=event,resolved_at=now() WHERE id=h.id;
 RETURN h.id;
END $$;
REVOKE ALL ON FUNCTION public.reassign_cash_job_credit_v1f(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reassign_cash_job_credit_v1f(uuid,uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;



