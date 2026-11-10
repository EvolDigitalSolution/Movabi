--
-- PostgreSQL database dump
--

\restrict jyfKPWrrQfo1Vlx8QQ4yHEMb3rtYOlqvIiCtpOMNxad7DZkqWhj9I77gE3ImPmk

-- Dumped from database version 16.15 (Debian 16.15-1.pgdg13+2)
-- Dumped by pg_dump version 16.15 (Debian 16.15-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: driver_vehicle_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.driver_vehicle_status AS ENUM (
    'pending',
    'approved',
    'rejected',
    'active'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: cancellation_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cancellation_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    market_code text NOT NULL,
    version integer NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    grace_seconds integer DEFAULT 300 NOT NULL,
    fee_minor bigint DEFAULT 0 NOT NULL,
    fee_cap_minor bigint,
    responsibility_rules jsonb DEFAULT '{}'::jsonb NOT NULL,
    driver_compensation_percent numeric DEFAULT 0 NOT NULL,
    compensation_funding text DEFAULT 'on_collection'::text NOT NULL,
    debt_threshold_minor bigint DEFAULT 0 NOT NULL,
    exempt_reasons text[] DEFAULT '{}'::text[] NOT NULL,
    effective_from timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reference_fare_minor bigint,
    debt_threshold_bps integer,
    CONSTRAINT cancellation_policies_compensation_funding_check CHECK ((compensation_funding = ANY (ARRAY['on_collection'::text, 'advanced'::text]))),
    CONSTRAINT cancellation_policies_debt_threshold_bps_check CHECK (((debt_threshold_bps >= 0) AND (debt_threshold_bps <= 10000))),
    CONSTRAINT cancellation_policies_driver_compensation_percent_check CHECK (((driver_compensation_percent >= (0)::numeric) AND (driver_compensation_percent <= (100)::numeric))),
    CONSTRAINT cancellation_policies_fee_cap_minor_check CHECK (((fee_cap_minor IS NULL) OR (fee_cap_minor >= 0))),
    CONSTRAINT cancellation_policies_fee_minor_check CHECK ((fee_minor >= 0)),
    CONSTRAINT cancellation_policies_grace_seconds_check CHECK ((grace_seconds >= 0)),
    CONSTRAINT cancellation_policies_reference_fare_minor_check CHECK ((reference_fare_minor >= 0))
);


--
-- Name: active_cancellation_policy(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.active_cancellation_policy(p_tenant uuid, p_market text) RETURNS public.cancellation_policies
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v cancellation_policies;
begin
  select * into v from cancellation_policies
   where tenant_id=p_tenant and market_code=p_market and enabled and effective_from<=now()
   order by version desc limit 1;
  return v;
end$$;


--
-- Name: campaign_discount_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_discount_applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    quote_reference text,
    discount_minor bigint NOT NULL,
    status text DEFAULT 'applied'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaign_discount_applications_discount_minor_check CHECK ((discount_minor >= 0)),
    CONSTRAINT campaign_discount_applications_status_check CHECK ((status = ANY (ARRAY['applied'::text, 'consumed'::text, 'reversed'::text, 'expired'::text])))
);


--
-- Name: apply_campaign_discount(uuid, uuid, text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_campaign_discount(p_campaign uuid, p_customer uuid, p_quote text, p_fare_minor bigint) RETURNS public.campaign_discount_applications
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare c campaigns; v campaign_discount_applications; used int; discount bigint;
begin
  select * into c from campaigns where id=p_campaign for update;
  if not found or not c.enabled or c.kind<>'customer_discount' then raise exception 'campaign_unavailable'; end if;
  if c.valid_from is not null and c.valid_from>now() then raise exception 'campaign_not_started'; end if;
  if c.valid_until is not null and c.valid_until<=now() then raise exception 'campaign_expired'; end if;

  -- First-booking-only: reject if the customer has any prior completed/paid job.
  if coalesce((c.qualification->>'firstBookingOnly')::boolean,false) then
    if exists(select 1 from jobs where customer_id=p_customer
              and status in ('completed','delivered','settled')
              and payment_status in ('paid','succeeded','cash_due','cash_pending')) then
      raise exception 'campaign_first_booking_only';
    end if;
  end if;
  -- Market-configured minimum eligible fare.
  if c.qualification->>'min_qualifying_fare_minor' is not null
     and p_fare_minor < (c.qualification->>'min_qualifying_fare_minor')::bigint then
    raise exception 'campaign_fare_below_minimum';
  end if;

  select count(*) into used from campaign_discount_applications
   where campaign_id=p_campaign and customer_id=p_customer and status in ('applied','consumed');
  if used>=c.per_user_cap then raise exception 'campaign_cap_reached'; end if;
  select * into v from campaign_discount_applications
   where campaign_id=p_campaign and customer_id=p_customer and quote_reference=p_quote;
  if found then return v; end if;

  discount := case when c.value_type='percent' then least(floor(p_fare_minor * c.value / 100), p_fare_minor)
                   when c.value_type='fixed_minor' then least(c.value::bigint, p_fare_minor)
                   else 0 end;
  -- Market-configured maximum discount cap.
  if c.qualification->>'max_discount_minor' is not null
     and discount > (c.qualification->>'max_discount_minor')::bigint then
    discount := (c.qualification->>'max_discount_minor')::bigint;
  end if;
  if discount <= 0 then raise exception 'campaign_no_discount'; end if;
  if c.budget_minor>0 and not campaign_spend(c.id, discount) then raise exception 'campaign_budget_exhausted'; end if;
  insert into campaign_discount_applications(tenant_id,campaign_id,customer_id,quote_reference,discount_minor)
    values(c.tenant_id,p_campaign,p_customer,p_quote,discount) returning * into v;
  return v;
end$$;


--
-- Name: apply_job_refund(uuid, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_job_refund(p_job uuid, p_external_minor bigint, p_ref text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE fb job_funding_breakdown;
        v_external bigint; v_credit_target bigint; v_credit bigint;
        v_already bigint;
BEGIN
  -- Idempotent replay: same provider ref returns the recorded allocation.
  SELECT external_minor+credit_minor INTO v_already
    FROM job_refund_allocations WHERE provider_ref=p_ref;
  IF FOUND THEN
    RETURN jsonb_build_object('external',v_already,'credit',0,'replayed',true);
  END IF;

  SELECT * INTO fb FROM job_funding_breakdown WHERE job_id=p_job FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'breakdown_missing'; END IF;

  v_external := least(greatest(p_external_minor,0), fb.captured_minor - fb.refunded_minor);
  v_credit := 0;
  IF v_external>0 AND fb.customer_charge_minor>0 THEN
    -- Proportional share of the refund that maps to the funded credit.
    v_credit_target := floor(v_external * fb.reward_credit_minor::numeric
                             / fb.customer_charge_minor)::bigint;
    v_credit := least(v_credit_target,
      coalesce((SELECT sum(amount_minor-restored_minor) FROM reward_credit_spends
                 WHERE job_id=p_job AND status IN ('reserved','spent')),0));
    -- Partial refund can never restore the full credit when external<charge.
    IF v_external < (fb.captured_minor - fb.refunded_minor) THEN
      v_credit := least(v_credit, fb.reward_credit_minor - 1);
    END IF;
  END IF;

  UPDATE job_funding_breakdown SET refunded_minor=refunded_minor+v_external
   WHERE job_id=p_job;
  IF v_credit>0 THEN
    -- Restores walk spends newest-first; each takes at most its remainder.
    DECLARE s record; v_left bigint := v_credit;
    BEGIN
      FOR s IN SELECT id,amount_minor,restored_minor FROM reward_credit_spends
                WHERE job_id=p_job AND status IN ('reserved','spent')
                ORDER BY created_at DESC FOR UPDATE LOOP
        EXIT WHEN v_left<=0;
        UPDATE reward_credit_spends
           SET restored_minor = restored_minor + least(amount_minor - restored_minor, v_left)
         WHERE id = s.id;
        v_left := v_left - least(s.amount_minor - s.restored_minor, v_left);
      END LOOP;
    END;
  END IF;
  INSERT INTO job_refund_allocations(job_id,provider_ref,external_minor,credit_minor)
   VALUES(p_job,p_ref,v_external,v_credit);
  RETURN jsonb_build_object('external',v_external,'credit',v_credit,'replayed',false);
END $$;


--
-- Name: apply_job_refund(uuid, bigint, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_job_refund(p_job uuid, p_service_minor bigint, p_external_minor bigint, p_ref text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE fb job_funding_breakdown;
        v_external bigint; v_credit bigint; v_discrepancy bigint;
        v_service_prior bigint; v_restored_prior bigint;
        v_final boolean; v_row job_refund_allocations;
BEGIN
  -- Idempotent replay: the recorded allocation is returned verbatim.
  SELECT * INTO v_row FROM job_refund_allocations WHERE provider_ref=p_ref;
  IF FOUND THEN
    RETURN jsonb_build_object('service',v_row.service_minor,'external',v_row.external_minor,
      'credit',v_row.credit_minor,'discrepancy',v_row.discrepancy_minor,'replayed',true);
  END IF;

  SELECT * INTO fb FROM job_funding_breakdown WHERE job_id=p_job FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'breakdown_missing'; END IF;

  -- External: bounded by captured-minus-refunded; overage is a discrepancy.
  -- p_external_minor is the PROVIDER-CONFIRMED amount; it is retained
  -- verbatim (provider_confirmed_minor), while external_minor records what
  -- was allocated against the remaining captured balance. The difference
  -- is a reconciliation discrepancy — never silently dropped, never used
  -- to issue money.
  v_discrepancy := greatest(p_external_minor - (fb.captured_minor - fb.refunded_minor),0);
  v_external := least(greatest(p_external_minor,0), fb.captured_minor - fb.refunded_minor);

  -- Final when cumulative external refund reaches captured OR the service
  -- refund covers the remaining charge share.
  SELECT coalesce(sum(service_minor),0) INTO v_service_prior
    FROM job_refund_allocations WHERE job_id=p_job;
  v_final := (fb.refunded_minor + v_external) >= fb.captured_minor
          OR (v_service_prior + p_service_minor) >= fb.customer_charge_minor;

  -- Credit share: proportional service-value refund -> funded-credit slice.
  -- Denominator is the CHARGE (discount is inside it, never refunded as cash).
  SELECT coalesce(sum(restored_minor),0) INTO v_restored_prior
    FROM reward_credit_spends WHERE job_id=p_job AND status IN ('reserved','spent');
  IF v_final THEN
    -- Final allocation absorbs the rounding remainder: restore everything
    -- still eligible, once.
    v_credit := greatest(fb.reward_credit_minor - v_restored_prior,0);
  ELSE
    v_credit := floor(greatest(p_service_minor,0) * fb.reward_credit_minor::numeric
                      / greatest(fb.customer_charge_minor,1))::bigint;
    -- Cumulative cap: never exceed unreversed spend balance.
    v_credit := least(v_credit, greatest(fb.reward_credit_minor - v_restored_prior,0));
  END IF;

  UPDATE job_funding_breakdown SET refunded_minor=refunded_minor+v_external
   WHERE job_id=p_job;
  IF v_credit>0 THEN
    DECLARE s record; v_left bigint := v_credit;
    BEGIN
      FOR s IN SELECT id,amount_minor,restored_minor FROM reward_credit_spends
                WHERE job_id=p_job AND status IN ('reserved','spent')
                ORDER BY created_at DESC FOR UPDATE LOOP
        EXIT WHEN v_left<=0;
        UPDATE reward_credit_spends
           SET restored_minor = restored_minor + least(amount_minor - restored_minor, v_left)
         WHERE id = s.id;
        v_left := v_left - least(s.amount_minor - s.restored_minor, v_left);
      END LOOP;
    END;
  END IF;

  INSERT INTO job_refund_allocations(job_id,provider_ref,service_minor,external_minor,
    credit_minor,provider_confirmed_minor,discrepancy_minor,kind)
   VALUES(p_job,p_ref,greatest(p_service_minor,0),v_external,v_credit,
     greatest(p_external_minor,0),v_discrepancy,
     CASE WHEN v_final THEN 'final' ELSE 'partial' END);
  RETURN jsonb_build_object('service',greatest(p_service_minor,0),'external',v_external,
    'credit',v_credit,'discrepancy',v_discrepancy,'final',v_final,'replayed',false);
END $$;


--
-- Name: reward_credit_spends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reward_credit_spends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    credit_id uuid NOT NULL,
    job_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    amount_minor bigint NOT NULL,
    status text DEFAULT 'reserved'::text NOT NULL,
    reserve_event_id uuid,
    resolution_event_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    restored_minor bigint DEFAULT 0 NOT NULL,
    CONSTRAINT reward_credit_spends_amount_minor_check CHECK ((amount_minor > 0)),
    CONSTRAINT reward_credit_spends_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'spent'::text, 'released'::text, 'reversed'::text])))
);


--
-- Name: apply_reward_credit(uuid, uuid, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_reward_credit(p_credit uuid, p_job uuid, p_amount_minor bigint) RETURNS public.reward_credit_spends
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE c reward_credits; j jobs; v reward_credit_spends; avail bigint; amt bigint; ev uuid;
BEGIN
  SELECT * INTO c FROM reward_credits WHERE id=p_credit FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit_missing'; END IF;
  IF c.status<>'active' THEN RAISE EXCEPTION 'credit_not_active'; END IF;
  IF c.expires_at IS NOT NULL AND c.expires_at<=now() THEN
    UPDATE reward_credits SET status='expired' WHERE id=p_credit;
    RAISE EXCEPTION 'credit_expired';
  END IF;
  -- Retry-safe: a repeat apply for the same credit+job returns the existing
  -- reservation rather than violating the partial unique index.
  SELECT * INTO v FROM reward_credit_spends WHERE credit_id=p_credit AND job_id=p_job AND status='reserved';
  IF FOUND THEN RETURN v; END IF;
  SELECT * INTO j FROM jobs WHERE id=p_job FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_missing'; END IF;
  -- Owner/tenant/currency isolation.
  IF j.customer_id IS DISTINCT FROM c.owner_id THEN RAISE EXCEPTION 'credit_owner_mismatch'; END IF;
  IF j.tenant_id IS DISTINCT FROM c.tenant_id THEN RAISE EXCEPTION 'credit_tenant_mismatch'; END IF;
  IF j.currency_code IS DISTINCT FROM c.currency_code THEN RAISE EXCEPTION 'credit_currency_mismatch'; END IF;
  -- Bound to available balance — concurrent applies can't double-spend.
  SELECT reward_credit_available(p_credit) INTO avail;
  amt := least(greatest(coalesce(p_amount_minor,0),0), avail);
  IF amt<=0 THEN RAISE EXCEPTION 'credit_exhausted'; END IF;
  INSERT INTO reward_credit_spends(credit_id,job_id,tenant_id,amount_minor)
   VALUES(p_credit,p_job,c.tenant_id,amt) RETURNING * INTO v;
  RETURN v;
END $$;


--
-- Name: approve_errand_over_budget(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approve_errand_over_budget(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs%ROWTYPE; w public.wallets%ROWTYPE; f public.errand_funding%ROWTYPE; delta numeric;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF auth.uid() IS DISTINCT FROM j.customer_id AND coalesce(auth.role(),'')<>'service_role' AND session_user NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION 'Only the customer can approve a budget increase'; END IF;
 IF j.payment_status<>'wallet_funded' OR j.status IN ('cancelled','canceled','expired','failed','no_driver_found','completed','settled','delivered') THEN RAISE EXCEPTION 'Booking is not eligible for budget approval'; END IF;
 SELECT * INTO STRICT w FROM public.wallets WHERE user_id=j.customer_id FOR UPDATE;
 SELECT * INTO STRICT f FROM public.errand_funding WHERE job_id=j.id FOR UPDATE;
 IF f.over_budget_status='approved' AND f.status='reserved' THEN RETURN TRUE; END IF;
 IF f.status<>'over_budget_requested' OR f.over_budget_status<>'requested' THEN RAISE EXCEPTION 'No pending budget increase'; END IF;
 delta:=round(f.requested_over_budget_amount-f.item_budget,2);
 IF delta IS NULL OR delta<=0 OR w.available_balance<delta THEN RAISE EXCEPTION 'Invalid budget increase or insufficient wallet balance'; END IF;
 UPDATE public.wallets SET available_balance=w.available_balance-delta,reserved_balance=w.reserved_balance+delta,updated_at=now() WHERE id=w.id;
 INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,description,metadata,balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
 VALUES(w.id,j.customer_id,j.id,'reservation',delta,'Additional errand budget approved',jsonb_build_object('payment_method','wallet','reason','budget_increase'),w.available_balance,w.available_balance-delta,w.reserved_balance,w.reserved_balance+delta);
 UPDATE public.errand_funding SET status='reserved',over_budget_status='approved',item_budget=f.requested_over_budget_amount,amount_reserved=f.amount_reserved+delta,metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('item_budget',f.requested_over_budget_amount),updated_at=now() WHERE job_id=j.id;
 UPDATE public.jobs SET metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('wallet_payment',coalesce(metadata->'wallet_payment','{}'::jsonb)||jsonb_build_object('item_budget',f.requested_over_budget_amount,'total_reserved',f.amount_reserved+delta)),updated_at=now() WHERE id=j.id;
 RETURN TRUE;
END $$;


--
-- Name: audit_market_payment_route_v23(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_market_payment_route_v23() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
 INSERT INTO public.market_payment_route_audit(route_id,actor,old_values,new_values)
 VALUES(NEW.id,session_user,CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,to_jsonb(NEW));
 RETURN NEW;
END
$$;


--
-- Name: campaign_spend(uuid, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.campaign_spend(p_campaign uuid, p_amount bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v campaigns;
begin
  update campaigns set spent_minor=spent_minor+p_amount
   where id=p_campaign and enabled and spent_minor+p_amount<=budget_minor
  returning * into v;
  return found;
end$$;


--
-- Name: cancel_campaign_application(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_campaign_application(p_campaign uuid, p_customer uuid, p_quote text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v campaign_discount_applications;
begin
  delete from campaign_discount_applications
   where campaign_id=p_campaign and customer_id=p_customer
     and quote_reference=p_quote and status='applied'
  returning * into v;
  if not found then return false; end if;
  update campaigns set spent_minor=greatest(0,spent_minor-v.discount_minor)
   where id=p_campaign;
  return true;
end$$;


--
-- Name: cancel_job_safely(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_job_safely(p_job_id uuid, p_reason text DEFAULT 'User cancelled'::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF j.status IN ('cancelled','canceled') THEN
  IF j.payment_method='wallet' OR j.payment_status='wallet_funded' THEN PERFORM public.release_job_wallet_reservation(j.id,p_reason); END IF;
  RETURN true;
 END IF;
 IF j.status NOT IN ('pending','requested','pending_fare_confirmation','negotiating','fare_agreed','searching','assigned','accepted','heading_to_pickup','driver_en_route') THEN RETURN false; END IF;
 IF j.payment_status IN ('paid','captured','succeeded') THEN RAISE EXCEPTION 'Captured payment requires refund review'; END IF;
 UPDATE public.jobs SET status='cancelled',metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('cancellation_reason',p_reason,'cancelled_at',now()),updated_at=now() WHERE id=j.id;
 IF j.payment_method='wallet' OR j.payment_status='wallet_funded' THEN PERFORM public.release_job_wallet_reservation(j.id,p_reason); END IF;
 RETURN true;
END $$;


--
-- Name: cash_credit_minor_v1e(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cash_credit_minor_v1e(v jsonb, c text) RETURNS bigint
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE n numeric; factor numeric;
BEGIN
 IF v IS NULL OR jsonb_typeof(v) NOT IN ('number','string') OR (v#>>'{}') !~ '^[0-9]+(\.[0-9]+)?$' THEN
  RAISE EXCEPTION 'Invalid frozen money value' USING ERRCODE='CE003'; END IF;
 factor:=power(10::numeric,public.wallet_currency_minor_exponent(c));
 n:=(v#>>'{}')::numeric*factor;
 IF n IS NULL OR n<>trunc(n) OR n<0 OR n>9223372036854775807 THEN
  RAISE EXCEPTION 'Frozen money is not representable in currency minor units' USING ERRCODE='CE003'; END IF;
 RETURN n::bigint;
END $_$;


--
-- Name: cash_credit_service_writer_v1e(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cash_credit_service_writer_v1e() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog'
    AS $$
 SELECT current_setting('role',true)='service_role' OR
  (session_user IN ('postgres','supabase_admin') AND current_setting('role',true) IN ('none','postgres','supabase_admin')) $$;


--
-- Name: cash_credit_terms_v1e(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cash_credit_terms_v1e(b jsonb, c text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE base bigint; charge bigint; fee bigint; commission bigint; net bigint; rate numeric;
BEGIN
 IF b->>'policyVersion' IS DISTINCT FROM 'fare-split-v1' OR b->>'currency' IS DISTINCT FROM c
 OR b->>'platformFeeType' IS DISTINCT FROM 'percentage' THEN
  RAISE EXCEPTION 'Canonical percentage-mode frozen fare required' USING ERRCODE='CE003'; END IF;
 base:=public.cash_credit_minor_v1e(b->'driverBase',c);
 charge:=public.cash_credit_minor_v1e(b->'customerCharge',c);
 fee:=public.cash_credit_minor_v1e(b->'platformFeeAmount',c);
 commission:=public.cash_credit_minor_v1e(b->'driverCommissionAmount',c);
 net:=public.cash_credit_minor_v1e(b->'driverEntitlement',c);
 IF base<=0 OR net<=0 OR charge::numeric<>base::numeric+fee::numeric OR net::numeric+commission::numeric<>base::numeric THEN
  RAISE EXCEPTION 'Unbalanced frozen cash fare' USING ERRCODE='CE003'; END IF;
 IF b->>'commissionPercent' IS NULL OR b->>'platformFeePercent' IS NULL
 OR b->>'commissionPercent' !~ '^[0-9]+(\.[0-9]+)?$' OR b->>'platformFeePercent' !~ '^[0-9]+(\.[0-9]+)?$' THEN
  RAISE EXCEPTION 'Frozen fee percentages missing' USING ERRCODE='CE003'; END IF;
 IF (b->>'commissionPercent')::numeric>=100 OR (b->>'platformFeePercent')::numeric>=100
 OR public.cash_credit_minor_v1e(b->'platformFeeFixed',c)<>0 THEN
  RAISE EXCEPTION 'Invalid percentage fee policy' USING ERRCODE='CE003'; END IF;
 IF b ? 'driverCommissionPolicy' AND b->'driverCommissionPolicy'->>'frozen' IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'Driver-specific commission must be frozen before cash acceptance' USING ERRCODE='CE003'; END IF;
 RETURN jsonb_build_object('charge',charge,'commission',commission,'fee',fee,'net',net,'required',commission::numeric+fee::numeric);
END $_$;


--
-- Name: claim_wallet_topup_submission(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_wallet_topup_submission(p_attempt_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NOT public.wallet_collection_enabled() THEN RAISE EXCEPTION 'Batch 1C: collection disabled at submission' USING ERRCODE='BP008'; END IF;
  UPDATE public.wallet_topup_attempts SET status = 'submitting'
  WHERE id = p_attempt_id AND status = 'initiated';
  RETURN FOUND;
END
$$;


--
-- Name: confirm_wallet_topup(uuid, text, text, text, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_wallet_topup(p_attempt_id uuid, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  a public.wallet_topup_attempts%ROWTYPE; v_event_id uuid; v_legs jsonb;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;

  IF p_final_status IS NULL OR p_final_status NOT IN ('succeeded','completed') THEN
    RAISE EXCEPTION 'Batch 1C: final status % is not a confirmed success', p_final_status USING ERRCODE = 'BP008';
  END IF;

  IF a.status = 'credited' AND a.credited_event_id IS NOT NULL THEN
    IF p_verified_provider_reference IS DISTINCT FROM a.provider_reference
       OR p_verified_merchant_account_ref IS DISTINCT FROM a.merchant_account_ref
       OR p_verified_currency IS DISTINCT FROM a.currency_code
       OR p_verified_amount_minor IS DISTINCT FROM a.amount_minor THEN
      RAISE EXCEPTION 'Batch 1C: replay terms do not match the credited attempt' USING ERRCODE = 'BP002';
    END IF;
    RETURN a.credited_event_id;
  END IF;
  IF a.status IN ('failed','refunded') THEN
    RAISE EXCEPTION 'Batch 1C: attempt is terminal (%)', a.status USING ERRCODE = 'BP008';
  END IF;
  -- 'uncertain' is recoverable: same-provider reconciliation proceeds below.
  IF a.provider_reference IS NULL THEN
    RAISE EXCEPTION 'Batch 1C: no provider reference bound yet (webhook-before-reference race)' USING ERRCODE = 'BP008';
  END IF;
  IF p_verified_provider_reference IS DISTINCT FROM a.provider_reference
     OR p_verified_merchant_account_ref IS DISTINCT FROM a.merchant_account_ref
     OR p_verified_currency IS DISTINCT FROM a.currency_code
     OR p_verified_amount_minor IS DISTINCT FROM a.amount_minor THEN
    RAISE EXCEPTION 'Batch 1C: verified terms do not match the frozen attempt' USING ERRCODE = 'BP008';
  END IF;

  v_legs := jsonb_build_array(
    jsonb_build_object('accountPurpose', a.destination_account_purpose, 'amountMinor', a.amount_minor),
    jsonb_build_object('accountPurpose', 'platform_funding', 'amountMinor', -a.amount_minor));
  v_event_id := public.post_wallet_event(
    'wallet-topup:' || a.id::text, 'topup', a.tenant_id, a.owner_id, a.currency_code,
    v_legs, a.payment_provider, a.merchant_account_ref, a.provider_reference);

  UPDATE public.wallet_topup_attempts SET status = 'credited', credited_event_id = v_event_id WHERE id = p_attempt_id;
  RETURN v_event_id;
END
$$;


--
-- Name: credit_wallet_topup(uuid, numeric, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.credit_wallet_topup(p_user_id uuid, p_amount numeric, p_currency_code text, p_stripe_payment_intent_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_wallet_id UUID;
BEGIN
    -- 1. Get or create wallet
    INSERT INTO wallets (user_id, available_balance, currency_code)
    VALUES (p_user_id, 0, p_currency_code)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT id INTO v_wallet_id FROM wallets WHERE user_id = p_user_id;

    -- 2. Record transaction (unique index will catch duplicates)
    INSERT INTO wallet_transactions (
        wallet_id,
        amount,
        type,
        status,
        description,
        stripe_payment_intent_id
    ) VALUES (
        v_wallet_id,
        p_amount,
        'topup',
        'completed',
        'Wallet top-up via Stripe',
        p_stripe_payment_intent_id
    );

    -- 3. Update wallet balance
    UPDATE wallets
    SET available_balance = available_balance + p_amount,
        updated_at = NOW()
    WHERE id = v_wallet_id;

END;
$$;


--
-- Name: credit_wallet_topup(uuid, numeric, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.credit_wallet_topup(p_user_id uuid, p_amount numeric, p_payment_intent_id text, p_currency_code text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_wallet_id UUID;
    v_before_available NUMERIC(12,2);
    v_before_reserved NUMERIC(12,2);
    v_currency_code TEXT;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'p_user_id is required';
    END IF;

    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'p_amount must be greater than zero';
    END IF;

    IF p_payment_intent_id IS NULL OR btrim(p_payment_intent_id) = '' THEN
        RAISE EXCEPTION 'p_payment_intent_id is required';
    END IF;

    v_currency_code := COALESCE(NULLIF(btrim(p_currency_code), ''), 'GBP');

    INSERT INTO public.wallets (
        user_id,
        available_balance,
        reserved_balance,
        currency_code
    )
    VALUES (
        p_user_id,
        0,
        0,
        v_currency_code
    )
    ON CONFLICT (user_id) DO NOTHING;

    IF EXISTS (
        SELECT 1
        FROM public.wallet_transactions
        WHERE stripe_payment_intent_id = p_payment_intent_id
          AND transaction_type = 'topup'
    ) THEN
        RETURN;
    END IF;

    SELECT
        id,
        available_balance,
        reserved_balance
    INTO
        v_wallet_id,
        v_before_available,
        v_before_reserved
    FROM public.wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Wallet not found after bootstrap';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.wallet_transactions
        WHERE stripe_payment_intent_id = p_payment_intent_id
          AND transaction_type = 'topup'
    ) THEN
        RETURN;
    END IF;

    UPDATE public.wallets
    SET
        available_balance = available_balance + p_amount,
        updated_at = NOW()
    WHERE id = v_wallet_id;

    INSERT INTO public.wallet_transactions (
        wallet_id,
        user_id,
        transaction_type,
        amount,
        balance_before_available,
        balance_after_available,
        balance_before_reserved,
        balance_after_reserved,
        stripe_payment_intent_id,
        metadata
    )
    VALUES (
        v_wallet_id,
        p_user_id,
        'topup',
        p_amount,
        v_before_available,
        v_before_available + p_amount,
        v_before_reserved,
        v_before_reserved,
        p_payment_intent_id,
        COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
            'currency_code', v_currency_code,
            'source', 'stripe_wallet_topup'
        )
    );

END;
$$;


--
-- Name: marketplace_negotiation_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_negotiation_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid,
    customer_id uuid,
    active_driver_id uuid,
    agreed_fare numeric,
    customer_offer numeric,
    driver_counter_offer numeric,
    expires_at timestamp with time zone,
    payment_deadline timestamp with time zone,
    round_count integer DEFAULT 0,
    status text
);


--
-- Name: customer_accept_driver_counter(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_accept_driver_counter(p_session_id uuid) RETURNS public.marketplace_negotiation_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_session public.marketplace_negotiation_sessions;
  v_agreed NUMERIC;
  v_job public.jobs;
  v_pay_window INTEGER;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Negotiation session not found';
  END IF;

  IF v_session.customer_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the customer can accept this counter-offer';
  END IF;

  IF v_session.active_driver_id IS NULL THEN
    RAISE EXCEPTION 'No driver is currently negotiating';
  END IF;

  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating') THEN
    RAISE EXCEPTION 'Negotiation is not open';
  END IF;

  IF v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'Negotiation has expired';
  END IF;

  IF v_session.driver_counter_offer IS NULL
     OR public.negotiation_live_proposal_role(v_session.id) IS DISTINCT FROM 'driver' THEN
    RAISE EXCEPTION 'There is no driver counter-offer to accept';
  END IF;

  v_agreed := v_session.driver_counter_offer;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  v_pay_window := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'paymentDeadlineAfterFareAgreement')::INTEGER,
    300
  );

  UPDATE public.marketplace_negotiation_sessions
  SET agreed_fare = v_agreed,
      status = 'fare_agreed',
      payment_deadline = public.negotiation_lease_expiry(v_session.job_id, v_pay_window),
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_pay_window),
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.jobs
  SET agreed_fare = v_agreed,
      status = 'fare_agreed',
      driver_id = v_session.active_driver_id,
      updated_at = now()
  WHERE id = v_session.job_id;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, amount, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'customer',
    'customer_accept', v_agreed, v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;


--
-- Name: customer_cancel_offer(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_cancel_offer(p_session_id uuid) RETURNS public.marketplace_negotiation_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_session public.marketplace_negotiation_sessions;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Negotiation session not found';
  END IF;

  IF v_session.customer_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the customer can cancel this negotiation';
  END IF;

  -- EXPIRY INTENT: a terminal customer WITHDRAWAL is not a stale fare response.
  -- It is deliberately allowed for open/driver_claimed/negotiating/released even
  -- when expires_at has already elapsed: the customer is withdrawing the
  -- outstanding negotiation/request, not attempting a timed-out counter/accept.
  -- Therefore NO expires_at check is applied here.
  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating', 'released') THEN
    RAISE EXCEPTION 'Negotiation can no longer be cancelled';
  END IF;

  UPDATE public.marketplace_negotiation_sessions
  SET status = 'customer_declined',
      active_driver_id = NULL,      -- the previous driver cannot accept/counter
      driver_counter_offer = NULL,
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  -- CANCELLATION AUTHORITY (added by this migration): the customer's "Cancel
  -- Request" is a terminal withdrawal of the WHOLE request, not just the session.
  -- Terminalise the owning job so the Activity bucket and the Marketplace Fare
  -- page can no longer treat it as a live actionable fare. Scoped to the
  -- negotiable statuses this RPC already permits; a fare_agreed/paid job is never
  -- reached here (the session guard above rejects those), so no payment is touched.
  UPDATE public.jobs
  SET status = 'cancelled',
      updated_at = now()
  WHERE id = v_session.job_id
    AND status IN ('pending_fare_confirmation', 'negotiating', 'open');

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, message, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'customer',
    'customer_decline', 'Customer cancelled request', v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;


--
-- Name: customer_expire_unpaid_agreement(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_expire_unpaid_agreement(p_session_id uuid) RETURNS public.marketplace_negotiation_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_session public.marketplace_negotiation_sessions;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Negotiation session not found';
  END IF;

  IF v_session.customer_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the customer can expire this agreement';
  END IF;

  -- Delegate to the single authoritative expiry transition. It is a no-op unless
  -- the agreement is unpaid AND its deadline has actually elapsed.
  IF v_session.status = 'fare_agreed' THEN
    PERFORM public.expire_unpaid_fare_agreement(p_session_id);
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id;

  RETURN v_session;
END;
$$;


--
-- Name: customer_open_debt_minor(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_open_debt_minor(p_customer uuid) RETURNS bigint
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  return coalesce((select sum(amount_minor) from customer_receivables
    where customer_id=p_customer and status in ('open','disputed')),0);
end$$;


--
-- Name: driver_accept_customer_offer(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_accept_customer_offer(p_session_id uuid) RETURNS public.marketplace_negotiation_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_session public.marketplace_negotiation_sessions;
  v_agreed NUMERIC;
  v_job public.jobs;
  v_pay_window INTEGER;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Negotiation session not found';
  END IF;

  IF v_session.active_driver_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the active driver can accept this offer';
  END IF;

  IF NOT public.driver_vehicle_can_accept_job(v_session.job_id, v_actor) THEN
    RAISE EXCEPTION 'You are not eligible for this service';
  END IF;

  IF v_session.status NOT IN ('open', 'driver_claimed', 'negotiating') THEN
    RAISE EXCEPTION 'Negotiation is not open';
  END IF;

  IF v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'Negotiation has expired';
  END IF;

  IF v_session.customer_offer IS NULL
     OR public.negotiation_live_proposal_role(v_session.id) IS DISTINCT FROM 'customer' THEN
    RAISE EXCEPTION 'There is no customer offer to accept';
  END IF;

  v_agreed := v_session.customer_offer;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  v_pay_window := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'paymentDeadlineAfterFareAgreement')::INTEGER,
    300
  );

  UPDATE public.marketplace_negotiation_sessions
  SET agreed_fare = v_agreed,
      driver_counter_offer = NULL,
      status = 'fare_agreed',
      payment_deadline = public.negotiation_lease_expiry(v_session.job_id, v_pay_window),
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_pay_window),
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.jobs
  SET agreed_fare = v_agreed,
      status = 'fare_agreed',
      driver_id = v_actor,
      updated_at = now()
  WHERE id = v_session.job_id;

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, amount, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_actor, 'driver',
    'driver_accept', v_agreed, v_session.round_count, now()
  );

  RETURN v_session;
END;
$$;


--
-- Name: driver_can_read_earnings_v23(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_can_read_earnings_v23(driver uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET row_security TO 'off'
    AS $$
 SELECT driver=auth.uid() OR EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.role IN ('admin','super_admin'))
$$;


--
-- Name: driver_can_read_job_market_v23(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_can_read_job_market_v23(j jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET row_security TO 'off'
    AS $$
DECLARE p jsonb;
BEGIN
 SELECT to_jsonb(profile) INTO p FROM public.profiles profile WHERE profile.id=auth.uid();
 IF p->>'role' IS DISTINCT FROM 'driver' THEN RETURN true; END IF;
 IF (j->>'driver_id'=auth.uid()::text OR j->>'accepted_driver_id'=auth.uid()::text) AND j->>'status' IN ('completed','settled','cancelled','canceled','expired','failed') THEN RETURN true; END IF;
 RETURN j->>'customer_id'=auth.uid()::text OR public.driver_job_market_matches_v23(p,j);
END $$;


--
-- Name: driver_cash_credit_balance_v1e(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_cash_credit_balance_v1e(t uuid, d uuid, c text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE eligible numeric; used numeric; held numeric; ledger_available numeric; ledger_reserved numeric; available numeric; deficit numeric;
BEGIN
 PERFORM public.driver_cash_credit_lock_v1e(t,d,c);
 SELECT coalesce(sum(a.amount_minor::numeric),0) INTO eligible
 FROM public.wallet_topup_attempts a JOIN public.wallet_business_events e ON e.id=a.credited_event_id
 WHERE a.tenant_id=t AND a.owner_id=d AND a.currency_code=c AND a.status='credited'
 AND a.destination_account_purpose='driver_cash_credit' AND e.operation='topup'
 AND e.event_key='wallet-topup:'||a.id::text AND e.tenant_id=t AND e.owner_id=d AND e.currency_code=c
 AND e.payment_provider=a.payment_provider AND e.merchant_account_ref=a.merchant_account_ref AND e.provider_reference=a.provider_reference
 AND e.entries=jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit','amountMinor',a.amount_minor),jsonb_build_object('accountPurpose','platform_funding','amountMinor',-a.amount_minor))
 AND NOT EXISTS(SELECT 1 FROM public.wallet_business_events r WHERE r.reverses_event_id=e.id);
 SELECT coalesce(sum(required_credit_minor::numeric) FILTER(WHERE status IN ('held','settled')),0),
        coalesce(sum(required_credit_minor::numeric) FILTER(WHERE status='held'),0)
 INTO used,held FROM public.driver_cash_credit_holds_v1e WHERE tenant_id=t AND driver_id=d AND currency_code=c;
 SELECT coalesce(sum(m.amount_minor::numeric) FILTER(WHERE a.balance_purpose='driver_cash_credit'),0),
        coalesce(sum(m.amount_minor::numeric) FILTER(WHERE a.balance_purpose='driver_cash_credit_reserved'),0)
 INTO ledger_available,ledger_reserved FROM public.wallet_accounts a JOIN public.wallet_movements m ON m.account_id=a.id
 WHERE a.tenant_id=t AND a.owner_id=d AND a.currency_code=c;
 available:=greatest(least(eligible-used,ledger_available),0);
 deficit:=greatest(used-eligible,-ledger_available,0);
 RETURN jsonb_build_object('eligibleDepositsMinor',eligible::text,'availableMinor',available::text,'heldMinor',held::text,
 'deficitMinor',deficit::text,'consistent',held=ledger_reserved,'currency',c);
END $$;


--
-- Name: driver_cash_credit_enabled_v1e(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_cash_credit_enabled_v1e() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
 SELECT coalesce((SELECT enabled FROM public.driver_cash_credit_config_v1e WHERE key='ride_cash_credit'),false) $$;


--
-- Name: driver_cash_credit_lock_v1e(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_cash_credit_lock_v1e(t uuid, d uuid, c text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
BEGIN
 IF t IS NULL OR d IS NULL OR c IS NULL OR c!~'^[A-Z]{3}$' THEN RAISE EXCEPTION 'Invalid credit scope' USING ERRCODE='CE003'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('cash-credit-v1e:'||t::text||':'||d::text||':'||c,0));
END $_$;


--
-- Name: driver_cash_credit_status_v1f(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_cash_credit_status_v1f(p_driver_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE p public.profiles%ROWTYPE; v_country text; v_currency text; currencies integer; approved boolean; b jsonb;
BEGIN
 SELECT * INTO p FROM public.profiles WHERE id=p_driver_id;
 IF NOT FOUND OR p.role IS DISTINCT FROM 'driver' THEN RAISE EXCEPTION 'Driver access required' USING ERRCODE='CE002'; END IF;
 v_country:=upper(btrim(coalesce(nullif(p.registration_country_code,''),p.country_code,'')));
 IF p.tenant_id IS NULL OR v_country !~ '^[A-Z]{2}$' THEN RAISE EXCEPTION 'Driver market unresolved' USING ERRCODE='CE002'; END IF;
 SELECT count(DISTINCT upper(supported_currency)),min(upper(supported_currency)) INTO currencies,v_currency
 FROM public.market_availability WHERE country_code=v_country;
 IF currencies<>1 OR v_currency IS NULL OR v_currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'Driver currency unresolved' USING ERRCODE='CE002'; END IF;
 approved:=p.registration_activated_at IS NOT NULL AND EXISTS(
  SELECT 1 FROM public.driver_cash_credit_enrolments_v1e e WHERE e.tenant_id=p.tenant_id AND e.driver_id=p.id
   AND e.country_code=v_country AND e.currency_code=v_currency AND e.enabled AND e.consented_at<=now());
 b:=public.driver_cash_credit_balance_v1e(p.tenant_id,p.id,v_currency);
 RETURN jsonb_build_object('tenantId',p.tenant_id,'driverId',p.id,'country',v_country,'currency',v_currency,
  'pilotEnabled',public.driver_cash_credit_enabled_v1e(),'enrolled',approved,'balance',b,
  'topupAvailable',false,'payoutAvailable',false,'acceptanceAuthority','database');
END $_$;


--
-- Name: driver_job_market_matches_v23(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.driver_job_market_matches_v23(p jsonb, j jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $_$
 SELECT COALESCE(
  upper(btrim(COALESCE(NULLIF(p->>'registration_country_code',''),p->>'country_code',''))) ~ '^[A-Z]{2}$'
  AND upper(btrim(COALESCE(NULLIF(p->>'registration_country_code',''),p->>'country_code',''))) =
      upper(btrim(COALESCE(NULLIF(j->>'country_code',''),j->'metadata'->>'country_code','')))
  AND NULLIF(p->>'tenant_id','') IS NOT NULL AND p->>'tenant_id'=j->>'tenant_id'
  AND (NULLIF(j->'metadata'->>'country_code','') IS NULL OR
       upper(btrim(j->'metadata'->>'country_code'))=upper(btrim(j->>'country_code'))),false)
$_$;


--
-- Name: referrals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referrals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    campaign_id uuid,
    referrer_id uuid NOT NULL,
    referee_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    qualifying_job_id uuid,
    reward_minor bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    referral_kind text DEFAULT 'customer'::text NOT NULL,
    reward_rate_bps integer,
    reward_cap_minor bigint,
    qualifying_fare_minor bigint,
    qualifying_jobs_required integer DEFAULT 1,
    qualifying_window_days integer,
    review_days integer DEFAULT 0,
    qualified_at timestamp with time zone,
    release_at timestamp with time zone,
    credit_expires_at timestamp with time zone,
    activated_at timestamp with time zone,
    CONSTRAINT referrals_check CHECK ((referrer_id <> referee_id)),
    CONSTRAINT referrals_referral_kind_check CHECK ((referral_kind = ANY (ARRAY['customer'::text, 'driver'::text]))),
    CONSTRAINT referrals_reward_cap_minor_check CHECK ((reward_cap_minor >= 0)),
    CONSTRAINT referrals_reward_rate_bps_check CHECK (((reward_rate_bps >= 0) AND (reward_rate_bps <= 10000))),
    CONSTRAINT referrals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'earned'::text, 'released'::text, 'reversed'::text, 'rejected'::text])))
);


--
-- Name: earn_referral(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.earn_referral(p_referral uuid, p_job uuid) RETURNS public.referrals
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE r referrals; j jobs; c campaigns;
        v_fare bigint; v_reward bigint; v_max int; v_progress int;
BEGIN
  SELECT * INTO r FROM referrals WHERE id=p_referral FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'referral_missing'; END IF;
  IF r.status IN ('released','reversed','rejected') THEN RETURN r; END IF;
  IF r.status='earned' AND r.referral_kind='customer' THEN RETURN r; END IF;
  SELECT * INTO j FROM jobs WHERE id=p_job;
  IF NOT FOUND OR j.status NOT IN ('completed','settled','delivered')
     OR coalesce(j.payment_status,'') NOT IN ('paid','succeeded','refunded','cash_due','cash_pending') THEN
    RAISE EXCEPTION 'qualifying_activity_incomplete';
  END IF;
  SELECT * INTO c FROM campaigns WHERE id=r.campaign_id;
  IF NOT FOUND OR NOT c.enabled THEN RAISE EXCEPTION 'campaign_inactive'; END IF;
  v_fare := coalesce(j.agreed_fare, j.total_price, j.price, 0)::bigint;

  IF r.referral_kind='customer' THEN
    v_reward := (v_fare * coalesce(r.reward_rate_bps,500) / 10000)::bigint;
    IF r.reward_cap_minor IS NOT NULL THEN v_reward := least(v_reward, r.reward_cap_minor); END IF;
    IF r.qualifying_fare_minor IS NOT NULL AND v_fare < r.qualifying_fare_minor THEN
      RAISE EXCEPTION 'qualifying_fare_below_minimum';
    END IF;
    v_max := coalesce((c.qualification->>'max_rewards_per_month')::int, 5);
    IF referral_monthly_count(r.referrer_id,'customer') >= v_max THEN
      RAISE EXCEPTION 'monthly_cap_reached';
    END IF;
    IF c.budget_minor>0 AND NOT campaign_spend(c.id, v_reward) THEN
      RAISE EXCEPTION 'campaign_budget_exhausted';
    END IF;
    UPDATE referrals SET status='earned', qualifying_job_id=p_job,
      qualifying_fare_minor=v_fare, reward_minor=v_reward,
      qualified_at=now(), resolved_at=now(),
      credit_expires_at=now()+interval '90 days'
     WHERE id=p_referral RETURNING * INTO r;
    INSERT INTO reward_credits(tenant_id,owner_id,currency_code,amount_minor,source,source_id,withdrawable,expires_at)
      SELECT c.tenant_id, r.referrer_id, c.currency_code, v_reward, 'customer_referral', r.id, false, r.credit_expires_at;
    RETURN r;
  END IF;

  -- Driver referral: cumulative fares across first N qualifying jobs inside
  -- the activation window; released only after the review period.
  IF r.activated_at IS NULL THEN
    UPDATE referrals SET activated_at=j.created_at WHERE id=p_referral RETURNING * INTO r;
  END IF;
  IF r.qualifying_window_days IS NOT NULL AND j.created_at > r.activated_at + (r.qualifying_window_days||' days')::interval THEN
    UPDATE referrals SET status='rejected', resolved_at=now() WHERE id=p_referral RETURNING * INTO r;
    RETURN r;
  END IF;
  INSERT INTO referral_driver_progress(referral_id,job_id,fare_minor)
    VALUES(p_referral,p_job,v_fare) ON CONFLICT (job_id) DO NOTHING;
  SELECT count(*) INTO v_progress FROM referral_driver_progress WHERE referral_id=p_referral;
  IF v_progress < coalesce(r.qualifying_jobs_required,20) THEN RETURN r; END IF;
  IF r.status='earned' THEN RETURN r; END IF;
  v_max := coalesce((c.qualification->>'max_rewards_per_month')::int, 3);
  IF referral_monthly_count(r.referrer_id,'driver') >= v_max THEN
    RAISE EXCEPTION 'monthly_cap_reached';
  END IF;
  SELECT sum(fare_minor) INTO v_fare FROM referral_driver_progress WHERE referral_id=p_referral;
  v_reward := (v_fare * coalesce(r.reward_rate_bps,500) / 10000)::bigint;
  IF r.reward_cap_minor IS NOT NULL THEN v_reward := least(v_reward, r.reward_cap_minor); END IF;
  IF c.budget_minor>0 AND NOT campaign_spend(c.id, v_reward) THEN
    RAISE EXCEPTION 'campaign_budget_exhausted';
  END IF;
  UPDATE referrals SET status='earned', qualifying_job_id=p_job,
    qualifying_fare_minor=v_fare, reward_minor=v_reward,
    qualified_at=now(), resolved_at=now(),
    release_at=now()+(coalesce(r.review_days,7)||' days')::interval
   WHERE id=p_referral RETURNING * INTO r;
  RETURN r;
END $$;


--
-- Name: end_job_driver_search(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.end_job_driver_search(p_job_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF j.status<>'searching' OR j.driver_id IS NOT NULL THEN RETURN NULL; END IF;
 IF j.driver_search_expires_at IS NOT NULL THEN
  IF j.driver_search_expires_at>now() OR coalesce(j.dispatch_attempts,0)<3 THEN RETURN NULL; END IF;
 ELSIF coalesce(j.dispatch_started_at,j.created_at)+interval '5 minutes'>now() THEN RETURN NULL;
 END IF;
 UPDATE public.jobs SET status='no_driver_found',no_driver_reason='No available driver after dispatch attempts',last_dispatch_check_at=now(),updated_at=now() WHERE id=j.id;
 IF j.payment_method='wallet' OR j.payment_status='wallet_funded' THEN PERFORM public.release_job_wallet_reservation(j.id,'No driver found before completion'); END IF;
 SELECT * INTO j FROM public.jobs WHERE id=j.id;
 RETURN to_jsonb(j);
END $$;


--
-- Name: enforce_driver_job_market_v23(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_driver_job_market_v23() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET row_security TO 'off'
    AS $$
DECLARE j jsonb; p jsonb; driver_text text; field_name text;
BEGIN
 IF TG_TABLE_NAME='jobs' THEN
  IF TG_OP='UPDATE' AND NEW.status IN ('cancelled','canceled','expired','failed','requires_review') AND NEW.driver_id IS NOT DISTINCT FROM OLD.driver_id AND NEW.accepted_driver_id IS NOT DISTINCT FROM OLD.accepted_driver_id THEN RETURN NEW; END IF;
  j:=to_jsonb(NEW);
 ELSE
  SELECT to_jsonb(job) INTO j FROM public.jobs job WHERE job.id=(to_jsonb(NEW)->>'job_id')::uuid FOR UPDATE;
  IF j IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='DRIVER_MARKET_JOB_MISSING'; END IF;
 END IF;
 FOREACH field_name IN ARRAY TG_ARGV LOOP
  driver_text:=NULLIF(to_jsonb(NEW)->>field_name,'');
  IF driver_text IS NULL THEN CONTINUE; END IF;
  SELECT to_jsonb(profile) INTO p FROM public.profiles profile WHERE profile.id=driver_text::uuid;
  IF p IS NULL OR p->>'role' IS DISTINCT FROM 'driver' OR NOT public.driver_job_market_matches_v23(p,j) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='DRIVER_MARKET_MISMATCH';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;


--
-- Name: enforce_job_payment_eligibility(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_job_payment_eligibility() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: enforce_job_vehicle_category(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_job_vehicle_category() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
    v_driver uuid := coalesce(NEW.driver_id, NEW.accepted_driver_id);
    v_accepted uuid := NEW.accepted_driver_id;
    v_type text;
    v_subtype text;
    v_status text;
    v_driver_tenant uuid;
    v_driver_country text;
    v_snapshot jsonb := coalesce(NEW.fulfilment_snapshot, '{}'::jsonb);
    v_category text := lower(coalesce(v_snapshot->>'category', NEW.fulfilment_category, ''));
    v_allowed text[];
    v_required_kg numeric;
    v_required_cm numeric;
    v_bike_limits jsonb;
    v_subtype_limit jsonb;
begin
    if v_driver is null and v_accepted is null then
        return NEW;
    end if;

    if not exists (select 1 from information_schema.tables where table_schema='public' and table_name='vehicles') then
        raise exception 'Canonical vehicles table is missing; cannot enforce job vehicle category.' using errcode = 'VF001';
    end if;

    select p.tenant_id, p.country_code
    into v_driver_tenant, v_driver_country
    from profiles p
    where p.id = coalesce(v_accepted, v_driver);

    if v_driver_tenant is not null and NEW.tenant_id is not null and v_driver_tenant <> NEW.tenant_id then
        raise exception 'Driver tenant does not match job tenant.' using errcode = 'VF008';
    end if;
    if v_driver_country is not null and NEW.country_code is not null and lower(v_driver_country) <> lower(NEW.country_code) then
        raise exception 'Driver country does not match job country.' using errcode = 'VF009';
    end if;

    select lower(coalesce(type,'')), lower(coalesce(vehicle_subtype,'')), lower(coalesce(status,''))
    into v_type, v_subtype, v_status
    from vehicles
    where user_id = v_driver
    order by created_at desc
    limit 1;

    if v_status is null or v_status not in ('approved','active') then
        raise exception 'Driver vehicle is not approved (status=%).', v_status using errcode = 'VF010';
    end if;

    if v_category = 'bike' then
        if not (v_type ~ 'bike|motorcycle|scooter|bicycle|e-bike|e_bike|pedal') then
            raise exception 'This job requires an approved Bike; driver vehicle % does not qualify.', v_type using errcode = 'VF002';
        end if;

        v_allowed := array(select jsonb_array_elements_text(v_snapshot->'allowed_subtypes'));
        if v_allowed is not null and array_length(v_allowed, 1) > 0 and not v_subtype = any(v_allowed) then
            raise exception 'Bike subtype % is not allowed for this job; allowed: %.', v_subtype, v_allowed using errcode = 'VF003';
        end if;

        v_bike_limits := v_snapshot->'bike_limits';
        v_required_kg := (v_snapshot->>'required_max_kg')::numeric;
        v_required_cm := (v_snapshot->>'required_max_cm')::numeric;
        if v_bike_limits is not null and v_subtype <> '' then
            v_subtype_limit := v_bike_limits->v_subtype;
            if v_subtype_limit is not null then
                if v_required_kg is not null and (v_subtype_limit->>'max_kg')::numeric < v_required_kg then
                    raise exception 'Driver % cannot carry %.2f kg for this bike job.', v_subtype, v_required_kg using errcode = 'VF004';
                end if;
                if v_required_cm is not null and (v_subtype_limit->>'max_cm')::numeric < v_required_cm then
                    raise exception 'Driver % cannot carry %.2f cm for this bike job.', v_subtype, v_required_cm using errcode = 'VF005';
                end if;
            end if;
        end if;
    elsif v_category = 'car' and not (v_type ~ 'car|taxi|standard' or v_type ~ 'van|bike|motorcycle|scooter|bicycle') then
        raise exception 'This job requires a Car; driver vehicle % does not qualify.', v_type using errcode = 'VF006';
    elsif v_category in ('small_van','large_van') and not (v_type ~ 'van') then
        raise exception 'This job requires a Van; driver vehicle % does not qualify.', v_type using errcode = 'VF007';
    end if;

    return NEW;
end;
$$;


--
-- Name: enforce_receivable_reference_binding(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_receivable_reference_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.payment_reference IS NULL THEN RETURN NEW; END IF;
  -- On UPDATE, allow touching an existing reference's row only when the
  -- binding columns themselves are not being changed (handled below via
  -- NEW carrying a complete triple) — the check is on the NEW row state,
  -- but only fires when the binding columns changed OR a reference is set.
  IF TG_OP='INSERT'
     OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference
     OR NEW.payment_provider IS DISTINCT FROM OLD.payment_provider
     OR NEW.merchant_account_ref IS DISTINCT FROM OLD.merchant_account_ref THEN
    IF NEW.payment_provider IS NULL OR NEW.merchant_account_ref IS NULL THEN
      RAISE EXCEPTION 'A payment reference requires provider + merchant binding' USING ERRCODE='RBD01';
    END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: enforce_reward_credit_lifecycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_reward_credit_lifecycle() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.status IN ('completed','delivered','settled') AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM settle_reward_credit_spend(NEW.id);
  ELSIF NEW.status IN ('cancelled','canceled','expired','failed','no_driver_found')
        AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM release_reward_credit_spend(NEW.id);
  END IF;
  -- Refund reversal: spent credit reverses and reactivates (unless expired).
  IF NEW.payment_status='refunded' AND OLD.payment_status IS DISTINCT FROM 'refunded' THEN
    PERFORM reverse_reward_credit_spend(NEW.id);
  END IF;
  RETURN NEW;
END $$;


--
-- Name: enforce_ride_cash_credit_v1e(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_ride_cash_credit_v1e() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE h public.driver_cash_credit_holds_v1e%ROWTYPE; driver uuid; slug text;
BEGIN
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e
  WHERE job_id=NEW.id AND status IN ('held','settled') ORDER BY created_at DESC LIMIT 1;
 IF FOUND THEN
  IF NOT public.cash_credit_service_writer_v1e() THEN RAISE EXCEPTION 'Cash transitions require the server role' USING ERRCODE='CE002'; END IF;
  IF NEW.status IS NULL THEN RAISE EXCEPTION 'Cash booking status missing' USING ERRCODE='CE006'; END IF;
  IF NEW.status IN ('cancelled','canceled','expired','failed','no_driver_found') THEN
   IF h.status='settled' THEN RAISE EXCEPTION 'Settled cash ride requires refund review' USING ERRCODE='CE005'; END IF;
   IF h.status='held' AND NOT h.review_required THEN PERFORM public.resolve_cash_job_credit_v1e(NEW.id,'released'); END IF;
   RETURN NEW;
  END IF;
  IF NEW.driver_id IS NOT NULL AND NEW.accepted_driver_id IS NOT NULL AND NEW.driver_id<>NEW.accepted_driver_id THEN RAISE EXCEPTION 'Conflicting accepted drivers' USING ERRCODE='CE005'; END IF;
  IF NEW.metadata->>'cash_collection_mode' IS DISTINCT FROM 'full_customer_charge' OR NEW.payment_intent_id IS NOT NULL THEN RAISE EXCEPTION 'Cash custody/payment mode changed' USING ERRCODE='CE005'; END IF;
  IF NEW.payment_method IS DISTINCT FROM 'cash' OR NEW.fare_breakdown IS DISTINCT FROM h.fare_snapshot
     OR NEW.tenant_id IS DISTINCT FROM h.tenant_id OR NEW.currency_code IS DISTINCT FROM h.currency_code
     OR NEW.country_code IS DISTINCT FROM h.country_code OR coalesce(NEW.driver_id,NEW.accepted_driver_id) IS DISTINCT FROM h.driver_id THEN
   RAISE EXCEPTION 'Cash reservation requires explicit reconciliation before changing terms' USING ERRCODE='CE005'; END IF;
  IF NEW.status IN ('completed','delivered','settled') AND h.status='held' AND NOT h.review_required THEN PERFORM public.resolve_cash_job_credit_v1e(NEW.id,'settled'); END IF;
  RETURN NEW;
 END IF;
 IF NEW.payment_method IS DISTINCT FROM 'cash' THEN RETURN NEW; END IF;
 IF NOT public.driver_cash_credit_enabled_v1e() THEN
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


--
-- Name: expire_reward_credits(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expire_reward_credits() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE n int;
BEGIN
  UPDATE reward_credits SET status='expired'
   WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;


--
-- Name: expire_unpaid_fare_agreement(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expire_unpaid_fare_agreement(p_session_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_session public.marketplace_negotiation_sessions;
  v_job public.jobs;
  v_deadline TIMESTAMPTZ;
  v_lease INTEGER;
  v_payment TEXT;
BEGIN
  IF p_session_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Only an unpaid, agreed negotiation can lapse here.
  IF v_session.status <> 'fare_agreed' THEN
    RETURN FALSE;
  END IF;

  v_deadline := COALESCE(v_session.payment_deadline, v_session.expires_at);
  IF v_deadline IS NULL OR v_deadline > now() THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO v_job FROM public.jobs WHERE id = v_session.job_id;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- NEVER release money already taken.
  v_payment := LOWER(COALESCE(v_job.payment_status, 'pending'));
  IF v_payment IN ('authorized', 'requires_capture', 'succeeded', 'captured', 'paid', 'wallet_funded') THEN
    RETURN FALSE;
  END IF;

  -- OVERALL marketplace deadline passed -> terminalise, do NOT recycle.
  IF v_job.expires_at IS NOT NULL AND v_job.expires_at <= now() THEN
    UPDATE public.marketplace_negotiation_sessions
    SET status = 'expired',
        active_driver_id = NULL,
        driver_counter_offer = NULL,
        agreed_fare = NULL,
        payment_deadline = NULL,
        updated_at = now()
    WHERE id = v_session.id;

    UPDATE public.jobs
    SET status = 'expired',
        agreed_fare = NULL,
        driver_id = NULL,
        updated_at = now()
    WHERE id = v_session.job_id
      AND status IN ('fare_agreed', 'pending_fare_confirmation', 'negotiating', 'open');

    INSERT INTO public.marketplace_negotiation_events (
      session_id, job_id, proposed_by, proposed_by_role,
      event_type, message, round_number, created_at
    ) VALUES (
      v_session.id, v_session.job_id, v_session.customer_id, 'customer',
      'session_expired', 'Payment window closed after the request deadline', v_session.round_count, now()
    );

    RETURN TRUE;
  END IF;

  -- Request still live -> invalidate the agreement and return the SAME request to
  -- the discoverable pool with the customer's proposal retained.
  v_lease := COALESCE(
    (public.get_marketplace_setting('hybrid_negotiation', v_job.tenant_id)->>'timeoutSeconds')::INTEGER,
    120
  );

  UPDATE public.marketplace_negotiation_sessions
  SET status = 'released',
      active_driver_id = NULL,
      driver_counter_offer = NULL,
      agreed_fare = NULL,
      payment_deadline = NULL,
      claimed_at = NULL,
      attempt_count = attempt_count + 1,
      expires_at = public.negotiation_lease_expiry(v_session.job_id, v_lease),
      updated_at = now()
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.jobs
  SET status = 'pending_fare_confirmation',
      agreed_fare = NULL,
      driver_id = NULL,
      updated_at = now()
  WHERE id = v_session.job_id
    AND status = 'fare_agreed';

  INSERT INTO public.marketplace_negotiation_events (
    session_id, job_id, proposed_by, proposed_by_role,
    event_type, message, round_number, created_at
  ) VALUES (
    v_session.id, v_session.job_id, v_session.customer_id, 'customer',
    'session_released', 'Payment window expired; agreement released', v_session.round_count, now()
  );

  -- Re-assert the retained customer proposal so the canonical turn is the
  -- customer's again for the next eligible driver.
  IF v_session.customer_offer IS NOT NULL AND v_session.customer_offer > 0 THEN
    INSERT INTO public.marketplace_negotiation_events (
      session_id, job_id, proposed_by, proposed_by_role,
      event_type, amount, round_number, created_at
    ) VALUES (
      v_session.id, v_session.job_id, v_session.customer_id, 'customer',
      'customer_offer', v_session.customer_offer, v_session.round_count, now()
    );
  END IF;

  RETURN TRUE;
END;
$$;


--
-- Name: fetch_hybrid_opportunities(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fetch_hybrid_opportunities(p_driver_id uuid) RETURNS TABLE(session_id uuid, job_id uuid, customer_id uuid, suggested_fare numeric, customer_offer numeric, distance_km numeric, eta_seconds integer, service_name text, service_slug text, pickup_address text, dropoff_address text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_driver_id THEN
    RAISE EXCEPTION 'You can only fetch your own opportunities';
  END IF;

  -- Lapsed unpaid agreements release back to the market (or terminalise).
  PERFORM public.expire_unpaid_fare_agreement(s.id)
  FROM public.marketplace_negotiation_sessions s
  WHERE s.status = 'fare_agreed'
    AND COALESCE(s.payment_deadline, s.expires_at) IS NOT NULL
    AND COALESCE(s.payment_deadline, s.expires_at) <= now();

  -- Lapsed claimed leases release back to the market.
  PERFORM public.release_stale_negotiation_lease(s.id)
  FROM public.marketplace_negotiation_sessions s
  WHERE s.active_driver_id IS NOT NULL
    AND s.status IN ('open', 'driver_claimed', 'negotiating')
    AND s.expires_at IS NOT NULL
    AND s.expires_at <= now();

  RETURN QUERY
  SELECT
    s.id AS session_id,
    s.job_id,
    s.customer_id,
    s.suggested_fare,
    s.customer_offer,
    CASE
      WHEN BTRIM(j.metadata->>'distance_km') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN (BTRIM(j.metadata->>'distance_km'))::NUMERIC
      ELSE NULL
    END AS distance_km,
    CASE
      WHEN BTRIM(j.metadata->>'duration_seconds') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN LEAST(2147483647::NUMERIC, ROUND((BTRIM(j.metadata->>'duration_seconds'))::NUMERIC))::INTEGER
      ELSE NULL
    END AS eta_seconds,
    COALESCE(st.name, 'Request') AS service_name,
    COALESCE(st.slug, '') AS service_slug,
    j.pickup_address,
    j.dropoff_address
  FROM public.marketplace_negotiation_sessions s
  JOIN public.jobs j ON j.id = s.job_id
  LEFT JOIN public.service_types st ON st.id = j.service_type_id
  WHERE s.status IN ('open', 'released')
    AND s.active_driver_id IS NULL
    AND public.driver_vehicle_can_accept_job(s.job_id, p_driver_id)
    AND s.expires_at > now()
    AND NOT EXISTS (
      SELECT 1 FROM public.driver_job_declines d
      WHERE d.driver_id = p_driver_id AND d.job_id = s.job_id
    );
END;
$_$;


--
-- Name: finalize_job_payment(uuid, text, text, text, numeric, boolean, timestamp with time zone, timestamp with time zone, integer, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_job_payment(p_job_id uuid, p_payment_intent_id text, p_payment_status text, p_job_status text, p_expected_service_fare numeric DEFAULT NULL::numeric, p_require_unowned boolean DEFAULT false, p_dispatch_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_driver_search_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_dispatch_attempts integer DEFAULT 0, p_intent_amount_minor bigint DEFAULT NULL::bigint, p_currency text DEFAULT NULL::text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_job public.jobs;
  v_session public.marketplace_negotiation_sessions;
  v_status TEXT;
  v_deadline TIMESTAMPTZ;
  v_item_budget NUMERIC;
  v_expected_minor NUMERIC;
BEGIN
  IF p_job_id IS NULL THEN
    RETURN 'job_not_found';
  END IF;

  -- DETERMINISTIC LOCK ORDER: job, then session. Every authority in this
  -- migration takes them in this order, so no deadlock is possible.
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'job_not_found';
  END IF;

  -- IDEMPOTENCY FIRST. A repeat of an already-successful finalization must be
  -- reported as such (NOT as a lost agreement) — otherwise a legitimate retry or
  -- duplicate webhook would be misread as a conflict and would wrongly enter the
  -- Stripe compensation path for an already-paid booking. Terminal/expired/
  -- cancelled agreements still have payment_status='pending', so they fall
  -- through to the agreement checks below.
  IF LOWER(COALESCE(v_job.payment_status, '')) <> 'pending' THEN
    RETURN 'already_finalized';
  END IF;

  SELECT * INTO v_session
  FROM public.marketplace_negotiation_sessions
  WHERE job_id = p_job_id
  ORDER BY created_at DESC NULLS LAST
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    -- NEGOTIATED: the fare agreement must STILL be authoritative. This is the
    -- check the old finalizers were missing.
    IF v_session.status IS DISTINCT FROM 'fare_agreed' THEN
      RETURN 'agreement_lost';
    END IF;

    -- The JOB must still be the live negotiated agreement — not released back to
    -- the pool, superseded, cancelled or expired.
    IF LOWER(COALESCE(v_job.status, '')) <> 'fare_agreed' THEN
      RETURN 'agreement_lost';
    END IF;

    IF v_session.agreed_fare IS NULL OR v_session.agreed_fare <= 0 THEN
      RETURN 'agreement_lost';
    END IF;

    IF v_job.agreed_fare IS NULL THEN
      RETURN 'agreement_lost';
    END IF;

    -- AUTHORITATIVE DEADLINE. Effective deadline = persisted payment_deadline,
    -- falling back to expires_at for agreements accepted BEFORE 360 started
    -- writing payment_deadline (310 set expires_at = now() + 300s). It must
    -- EXIST and must NOT have elapsed.
    v_deadline := COALESCE(v_session.payment_deadline, v_session.expires_at);
    IF v_deadline IS NULL THEN
      RETURN 'agreement_lost';
    END IF;
    IF v_deadline <= now() THEN
      RETURN 'agreement_expired';
    END IF;

    IF p_expected_service_fare IS NOT NULL
       AND ROUND(p_expected_service_fare, 2) IS DISTINCT FROM ROUND(v_session.agreed_fare, 2) THEN
      RETURN 'agreed_fare_mismatch';
    END IF;

    IF v_job.driver_id IS DISTINCT FROM v_session.active_driver_id THEN
      RETURN 'driver_mismatch';
    END IF;

    -- AUTHORITATIVE AMOUNT. For a negotiated job the customer charge is exactly
    -- agreed_fare + item budget. The item budget is READ from its persisted home
    -- (public.errand_funding is a TABLE, not a job column) using the same
    -- precedence the client uses; NO pricing/fee formula is duplicated here — this
    -- only proves the intent amount against the persisted authority, which is what
    -- stops a stale £9.06 quote from finalising a £9.00 agreement.
    IF p_intent_amount_minor IS NOT NULL THEN
      SELECT COALESCE(NULLIF(ef.amount_reserved, 0), NULLIF(ef.item_budget, 0), 0)
        INTO v_item_budget
        FROM public.errand_funding ef
       WHERE ef.job_id = p_job_id
       LIMIT 1;

      v_item_budget := COALESCE(v_item_budget, 0);
      v_expected_minor := ROUND((v_session.agreed_fare + v_item_budget) * 100);
      IF v_expected_minor IS DISTINCT FROM p_intent_amount_minor THEN
        RETURN 'amount_mismatch';
      END IF;
    END IF;
  ELSE
    -- NON-NEGOTIATED: preserve the pre-existing semantics exactly. The webhook
    -- only advances an UNPAID, UNOWNED job; /confirm may advance a locked-driver
    -- (assigned) job.
    IF p_require_unowned AND v_job.driver_id IS NOT NULL THEN
      RETURN 'driver_mismatch';
    END IF;
  END IF;

  -- CURRENCY: the money must be in the job's own currency.
  IF p_currency IS NOT NULL
     AND LOWER(p_currency) IS DISTINCT FROM LOWER(COALESCE(v_job.currency_code, 'gbp')) THEN
    RETURN 'currency_mismatch';
  END IF;

  v_status := LOWER(COALESCE(v_job.status, ''));
  IF v_status IN ('cancelled', 'canceled', 'expired', 'completed', 'settled') THEN
    RETURN 'job_terminal';
  END IF;

  IF p_payment_intent_id IS NOT NULL
     AND v_job.payment_intent_id IS NOT NULL
     AND v_job.payment_intent_id IS DISTINCT FROM p_payment_intent_id THEN
    RETURN 'intent_mismatch';
  END IF;

  UPDATE public.jobs
  SET payment_status = p_payment_status,
      status = p_job_status,
      dispatch_started_at = p_dispatch_started_at,
      driver_search_expires_at = p_driver_search_expires_at,
      dispatch_attempts = COALESCE(p_dispatch_attempts, 0),
      no_driver_reason = NULL,
      updated_at = now()
  WHERE id = p_job_id;

  RETURN 'finalized';
END;
$$;


--
-- Name: finalize_wallet_topup(numeric, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_wallet_topup(p_amount numeric, p_description text, p_payment_intent_id text, p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_wallet_id uuid;
  v_tx_id uuid;
  v_balance_before_available numeric(12,2);
  v_balance_after_available numeric(12,2);
begin
  -- Find wallet
  select id, available_balance
  into v_wallet_id, v_balance_before_available
  from public.wallets
  where user_id = p_user_id
  limit 1;

  -- Create wallet if missing
  if v_wallet_id is null then
    insert into public.wallets (
      user_id,
      available_balance,
      reserved_balance,
      currency_code
    )
    values (
      p_user_id,
      0.00,
      0.00,
      'GBP'
    )
    returning id, available_balance
    into v_wallet_id, v_balance_before_available;
  end if;

  -- Prevent duplicate processing
  if exists (
    select 1
    from public.wallet_transactions
    where payment_intent_id = p_payment_intent_id
       or stripe_payment_intent_id = p_payment_intent_id
  ) then
    return jsonb_build_object(
      'success', true,
      'message', 'Top-up already finalized',
      'walletId', v_wallet_id,
      'paymentIntentId', p_payment_intent_id
    );
  end if;

  -- Update wallet balance
  v_balance_after_available := coalesce(v_balance_before_available, 0.00) + p_amount;

  update public.wallets
  set
    available_balance = v_balance_after_available,
    updated_at = now()
  where id = v_wallet_id;

  -- Record wallet transaction
  insert into public.wallet_transactions (
    wallet_id,
    user_id,
    transaction_type,
    amount,
    balance_before_available,
    balance_after_available,
    balance_before_reserved,
    balance_after_reserved,
    metadata,
    created_at,
    stripe_payment_intent_id,
    payment_intent_id,
    description
  )
  values (
    v_wallet_id,
    p_user_id,
    'topup',
    p_amount,
    v_balance_before_available,
    v_balance_after_available,
    0.00,
    0.00,
    jsonb_build_object(
      'source', 'stripe',
      'kind', 'wallet_topup'
    ),
    now(),
    p_payment_intent_id,
    p_payment_intent_id,
    coalesce(p_description, 'Wallet top-up')
  )
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true,
    'walletId', v_wallet_id,
    'transactionId', v_tx_id,
    'paymentIntentId', p_payment_intent_id,
    'amount', p_amount,
    'balanceBefore', v_balance_before_available,
    'balanceAfter', v_balance_after_available
  );
end;
$$;


--
-- Name: finalize_wallet_topup_legacy_incompatible(uuid, numeric, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_wallet_topup_legacy_incompatible(p_user_id uuid, p_amount numeric, p_payment_intent_id text, p_description text DEFAULT 'Wallet top-up'::text) RETURNS boolean
    LANGUAGE plpgsql
    AS $_$
DECLARE
  already_exists BOOLEAN;
  v_wallet_id UUID;
  v_tx_type_col TEXT;
  v_has_wallet_id BOOLEAN;
  v_has_stripe_payment_intent_id BOOLEAN;
  v_amount NUMERIC := ROUND(COALESCE(p_amount, 0)::NUMERIC, 2);
BEGIN
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Wallet top-up amount must be greater than zero';
  END IF;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'wallet_transactions'
        AND column_name = 'transaction_type'
    ) THEN 'transaction_type'
    ELSE 'type'
  END INTO v_tx_type_col;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'wallet_transactions'
      AND column_name = 'wallet_id'
  ) INTO v_has_wallet_id;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'wallet_transactions'
      AND column_name = 'stripe_payment_intent_id'
  ) INTO v_has_stripe_payment_intent_id;

  IF v_has_stripe_payment_intent_id THEN
    EXECUTE
      'SELECT EXISTS (
         SELECT 1
         FROM wallet_transactions
         WHERE payment_intent_id = $1 OR stripe_payment_intent_id = $1
       )'
    INTO already_exists
    USING p_payment_intent_id;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM wallet_transactions WHERE payment_intent_id = p_payment_intent_id
    ) INTO already_exists;
  END IF;

  IF already_exists THEN
    RETURN FALSE;
  END IF;

  INSERT INTO wallets (user_id, balance, available_balance)
  VALUES (p_user_id, v_amount, v_amount)
  ON CONFLICT (user_id) DO UPDATE
  SET balance = COALESCE(wallets.balance, 0) + v_amount,
      available_balance = COALESCE(wallets.available_balance, 0) + v_amount,
      updated_at = NOW();

  SELECT id
  INTO v_wallet_id
  FROM wallets
  WHERE user_id = p_user_id;

  IF v_has_wallet_id AND v_has_stripe_payment_intent_id THEN
    EXECUTE format(
      'INSERT INTO wallet_transactions (wallet_id, user_id, amount, %I, payment_intent_id, stripe_payment_intent_id, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)',
      v_tx_type_col
    )
    USING v_wallet_id, p_user_id, v_amount, 'topup', p_payment_intent_id, p_payment_intent_id, p_description;
  ELSIF v_has_wallet_id THEN
    EXECUTE format(
      'INSERT INTO wallet_transactions (wallet_id, user_id, amount, %I, payment_intent_id, description)
       VALUES ($1, $2, $3, $4, $5, $6)',
      v_tx_type_col
    )
    USING v_wallet_id, p_user_id, v_amount, 'topup', p_payment_intent_id, p_description;
  ELSIF v_has_stripe_payment_intent_id THEN
    EXECUTE format(
      'INSERT INTO wallet_transactions (user_id, amount, %I, payment_intent_id, stripe_payment_intent_id, description)
       VALUES ($1, $2, $3, $4, $5, $6)',
      v_tx_type_col
    )
    USING p_user_id, v_amount, 'topup', p_payment_intent_id, p_payment_intent_id, p_description;
  ELSE
    EXECUTE format(
      'INSERT INTO wallet_transactions (user_id, amount, %I, payment_intent_id, description)
       VALUES ($1, $2, $3, $4, $5)',
      v_tx_type_col
    )
    USING p_user_id, v_amount, 'topup', p_payment_intent_id, p_description;
  END IF;

  RETURN TRUE;
END;
$_$;


--
-- Name: driver_cash_credit_holds_v1e; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_cash_credit_holds_v1e (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    country_code text NOT NULL,
    currency_code text NOT NULL,
    fare_snapshot jsonb NOT NULL,
    enrolment_terms_version text NOT NULL,
    enrolment_consented_at timestamp with time zone NOT NULL,
    customer_charge_minor bigint NOT NULL,
    commission_minor bigint NOT NULL,
    platform_fee_minor bigint NOT NULL,
    driver_entitlement_minor bigint NOT NULL,
    required_credit_minor bigint NOT NULL,
    status text DEFAULT 'held'::text NOT NULL,
    reserve_event_id uuid,
    resolution_event_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    review_required boolean DEFAULT false NOT NULL,
    disputed_minor bigint,
    review_due_at timestamp with time zone,
    escalated boolean DEFAULT false NOT NULL,
    CONSTRAINT driver_cash_credit_holds_v1e_check CHECK (((required_credit_minor)::numeric = ((commission_minor)::numeric + (platform_fee_minor)::numeric))),
    CONSTRAINT driver_cash_credit_holds_v1e_check1 CHECK (((customer_charge_minor)::numeric = ((driver_entitlement_minor)::numeric + (required_credit_minor)::numeric))),
    CONSTRAINT driver_cash_credit_holds_v1e_check2 CHECK ((((required_credit_minor = 0) AND (reserve_event_id IS NULL)) OR ((required_credit_minor > 0) AND (reserve_event_id IS NOT NULL)))),
    CONSTRAINT driver_cash_credit_holds_v1e_commission_minor_check CHECK ((commission_minor >= 0)),
    CONSTRAINT driver_cash_credit_holds_v1e_customer_charge_minor_check CHECK ((customer_charge_minor > 0)),
    CONSTRAINT driver_cash_credit_holds_v1e_disputed_minor_check CHECK ((disputed_minor >= 0)),
    CONSTRAINT driver_cash_credit_holds_v1e_driver_entitlement_minor_check CHECK ((driver_entitlement_minor > 0)),
    CONSTRAINT driver_cash_credit_holds_v1e_platform_fee_minor_check CHECK ((platform_fee_minor >= 0)),
    CONSTRAINT driver_cash_credit_holds_v1e_required_credit_minor_check CHECK ((required_credit_minor >= 0)),
    CONSTRAINT driver_cash_credit_holds_v1e_status_check CHECK ((status = ANY (ARRAY['held'::text, 'released'::text, 'settled'::text])))
);


--
-- Name: flag_cash_hold_review_v1f(uuid, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.flag_cash_hold_review_v1f(p_job uuid, p_disputed_minor bigint) RETURNS public.driver_cash_credit_holds_v1e
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE h driver_cash_credit_holds_v1e;
BEGIN
  IF NOT public.cash_credit_service_writer_v1e() THEN
    RAISE EXCEPTION 'Cash review requires the server role' USING ERRCODE='CE002';
  END IF;
  UPDATE driver_cash_credit_holds_v1e
     SET review_required=true,
         disputed_minor=p_disputed_minor,
         review_due_at=now()+interval '24 hours'
   WHERE job_id=p_job AND status='held'
   RETURNING * INTO h;
  IF NOT FOUND THEN RAISE EXCEPTION 'No held cash credit for this job' USING ERRCODE='CE006'; END IF;
  RETURN h;
END $$;


--
-- Name: guard_cash_credit_hold_v1e(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_cash_credit_hold_v1e() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$                                                                                                                                               
 BEGIN                                                                                                                                                       
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cash credit history cannot be deleted' USING ERRCODE='CE005'; END IF;                                              
  IF (to_jsonb(NEW)-ARRAY['status','resolution_event_id','resolved_at','review_required','disputed_minor','review_due_at','escalated']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','resolution_event_id','resolved_at','review_required','disputed_minor','review_due_at','escalated'])
  OR OLD.status<>'held' OR NEW.status NOT IN ('held','released','settled') THEN                                                                                     
   RAISE EXCEPTION 'Cash credit terms/history are frozen' USING ERRCODE='CE005'; END IF;                                                                     
  RETURN NEW;                                                                                                                                                
 END $$;


--
-- Name: guard_market_payment_route_v23(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_market_payment_route_v23() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payment route history must be retained; retire a route instead'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.market_availability m WHERE m.country_code=NEW.country_code AND m.supported_currency=NEW.currency_code) THEN
  RAISE EXCEPTION 'Payment route must reference an existing market country and currency';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.country_code IS DISTINCT FROM OLD.country_code OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
   OR NEW.method IS DISTINCT FROM OLD.method OR NEW.provider IS DISTINCT FROM OLD.provider
   OR (OLD.merchant_account_ref IS NOT NULL AND NEW.merchant_account_ref IS DISTINCT FROM OLD.merchant_account_ref)
  THEN RAISE EXCEPTION 'Route identity cannot change; retain the original route and add a new one'; END IF;
 END IF;
 NEW.updated_at:=clock_timestamp();RETURN NEW;
END
$$;


--
-- Name: handle_new_user_wallet(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user_wallet() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    INSERT INTO public.wallets (user_id, currency_code)
    VALUES (NEW.id, NEW.currency_code);
    RETURN NEW;
END;
$$;


--
-- Name: initiate_wallet_topup(text, uuid, uuid, text, text, bigint, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.initiate_wallet_topup(p_attempt_key text, p_tenant_id uuid, p_owner_id uuid, p_country_code text, p_currency_code text, p_amount_minor bigint, p_destination_account_purpose text, p_payment_provider text, p_merchant_account_ref text, p_provider_idempotency_identity text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE
  v_id uuid; v_route public.market_payment_routes%ROWTYPE; v_n integer; v_max bigint;
BEGIN
  IF p_attempt_key IS NULL OR btrim(p_attempt_key) = '' OR length(p_attempt_key) > 200 THEN
    RAISE EXCEPTION 'Batch 1C: invalid attempt_key' USING ERRCODE = 'BP003';
  END IF;
  IF p_tenant_id IS NULL OR p_owner_id IS NULL THEN
    RAISE EXCEPTION 'Batch 1C: tenant_id and owner_id are required' USING ERRCODE = 'BP003';
  END IF;
  IF p_country_code IS NULL OR p_country_code !~ '^[A-Z]{2}$' OR p_currency_code IS NULL OR p_currency_code !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Batch 1C: invalid country/currency' USING ERRCODE = 'BP003';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR p_amount_minor > 9223372036854775807 THEN
    RAISE EXCEPTION 'Batch 1C: invalid amount' USING ERRCODE = 'BP003';
  END IF;
  IF p_destination_account_purpose IS NULL OR p_destination_account_purpose NOT IN ('customer_credit','driver_cash_credit') THEN
    RAISE EXCEPTION 'Batch 1C: destination account % is not an approved collectible destination', p_destination_account_purpose USING ERRCODE = 'BP008';
  END IF;
  IF p_payment_provider IS NULL OR p_payment_provider NOT IN ('stripe','kora') THEN
    RAISE EXCEPTION 'Batch 1C: unknown payment_provider %', p_payment_provider USING ERRCODE = 'BP004';
  END IF;
  IF p_merchant_account_ref IS NULL OR btrim(p_merchant_account_ref) = '' THEN
    RAISE EXCEPTION 'Batch 1C: merchant_account_ref is required' USING ERRCODE = 'BP004';
  END IF;
  IF p_provider_idempotency_identity IS NULL OR btrim(p_provider_idempotency_identity) = '' THEN
    RAISE EXCEPTION 'Batch 1C: provider_idempotency_identity is required' USING ERRCODE = 'BP004';
  END IF;
  IF NOT public.wallet_collection_enabled() THEN
    RAISE EXCEPTION 'Batch 1C: wallet collection is disabled (no approved usable destination)' USING ERRCODE = 'BP008';
  END IF;

  -- Market-specific limit is REQUIRED for each collectible currency.
  SELECT NULLIF((SELECT value FROM public.wallet_collection_config WHERE key='max_amount_minor_' || p_currency_code), '')::bigint INTO v_max;
  IF v_max IS NULL OR v_max <= 0 THEN
    RAISE EXCEPTION 'Batch 1C: no configured collection limit for %', p_currency_code USING ERRCODE = 'BP008';
  END IF;
  IF p_amount_minor > v_max THEN
    RAISE EXCEPTION 'Batch 1C: amount exceeds market limit for %', p_currency_code USING ERRCODE = 'BP008';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.market_availability WHERE country_code=p_country_code AND upper(supported_currency)=p_currency_code) THEN
    RAISE EXCEPTION 'Batch 1C: unsupported country/currency pair' USING ERRCODE='BP008';
  END IF;

  -- Resolve exactly one eligible route.
  SELECT count(*) INTO v_n FROM public.market_payment_routes
  WHERE country_code = p_country_code AND currency_code = p_currency_code
    AND method = 'card' AND preferred AND enabled AND merchant_approved AND adapter_ready
    AND capabilities @> ARRAY['collect']::text[];
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Batch 1C: expected exactly one eligible collection route for %/%, found %', p_country_code, p_currency_code, v_n USING ERRCODE = 'BP008';
  END IF;
  SELECT * INTO v_route FROM public.market_payment_routes
  WHERE country_code = p_country_code AND currency_code = p_currency_code
    AND method = 'card' AND preferred AND enabled AND merchant_approved AND adapter_ready
    AND capabilities @> ARRAY['collect']::text[];
  IF v_route.provider IS DISTINCT FROM p_payment_provider OR v_route.merchant_account_ref IS DISTINCT FROM p_merchant_account_ref THEN
    RAISE EXCEPTION 'Batch 1C: requested provider/account does not match the eligible route' USING ERRCODE = 'BP008';
  END IF;

  -- Concurrent-safe replay: identical terms return the same attempt; a conflicting
  -- attempt_key reuse raises BP002 (never silently returns a mismatched row).
  INSERT INTO public.wallet_topup_attempts
    (attempt_key, tenant_id, owner_id, country_code, currency_code, amount_minor,
     destination_account_purpose, payment_provider, merchant_account_ref, provider_idempotency_identity)
  VALUES
    (p_attempt_key, p_tenant_id, p_owner_id, p_country_code, p_currency_code, p_amount_minor,
     p_destination_account_purpose, p_payment_provider, p_merchant_account_ref, p_provider_idempotency_identity)
  ON CONFLICT (attempt_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.wallet_topup_attempts WHERE attempt_key = p_attempt_key
               AND tenant_id = p_tenant_id AND owner_id = p_owner_id
               AND country_code = p_country_code AND currency_code = p_currency_code
               AND amount_minor = p_amount_minor AND destination_account_purpose = p_destination_account_purpose
               AND payment_provider = p_payment_provider AND merchant_account_ref = p_merchant_account_ref
               AND provider_idempotency_identity = p_provider_idempotency_identity) THEN
      SELECT id INTO v_id FROM public.wallet_topup_attempts WHERE attempt_key = p_attempt_key;
    ELSE
      RAISE EXCEPTION 'Batch 1C: attempt_key % reused with different terms', p_attempt_key USING ERRCODE = 'BP002';
    END IF;
  END IF;
  RETURN v_id;
END
$_$;


--
-- Name: job_remaining_payable_minor(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.job_remaining_payable_minor(p_job uuid) RETURNS bigint
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE b job_funding_breakdown; j jobs; charge bigint; discount bigint; credit bigint;
BEGIN
  SELECT * INTO b FROM job_funding_breakdown WHERE job_id=p_job;
  IF FOUND THEN RETURN b.external_due_minor; END IF;
  SELECT * INTO j FROM jobs WHERE id=p_job;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_missing'; END IF;
  charge := coalesce((j.fare_breakdown->>'customerCharge')::bigint,(j.agreed_fare*100)::bigint,0);
  discount := coalesce((j.metadata->>'discount_minor')::bigint,0);
  SELECT coalesce(sum(amount_minor),0) INTO credit
    FROM reward_credit_spends WHERE job_id=p_job AND status='reserved';
  RETURN greatest(charge - discount - credit,0);
END $$;


--
-- Name: mark_wallet_topup_failed(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_wallet_topup_failed(p_attempt_id uuid, p_reason text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF a.status IN ('credited','refunded') THEN
    RAISE EXCEPTION 'Batch 1C: credited/refunded attempt cannot be downgraded to failed' USING ERRCODE = 'BP008';
  END IF;
  UPDATE public.wallet_topup_attempts SET status='failed', failure_reason=COALESCE(p_reason,failure_reason) WHERE id=p_attempt_id;
END $$;


--
-- Name: mark_wallet_topup_refunded(uuid, text, text, text, text, bigint, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_wallet_topup_refunded(p_attempt_id uuid, p_evidence_reference text, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text, p_reason text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  a public.wallet_topup_attempts%ROWTYPE; v_reversal uuid;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF p_evidence_reference IS NULL OR btrim(p_evidence_reference) = '' THEN
    RAISE EXCEPTION 'Batch 1C: refund/chargeback evidence reference is required' USING ERRCODE = 'BP004';
  END IF;
  IF p_final_status IS NULL OR p_final_status NOT IN ('refunded','reversed') THEN
    RAISE EXCEPTION 'Batch 1C: refund final status % is not confirmed', p_final_status USING ERRCODE = 'BP008';
  END IF;
  IF a.status = 'refunded' THEN
    -- Replay: validate ALL evidence terms before returning the existing reversal.
    IF a.refund_evidence_reference IS DISTINCT FROM p_evidence_reference
       OR a.provider_reference IS DISTINCT FROM p_verified_provider_reference
       OR a.merchant_account_ref IS DISTINCT FROM p_verified_merchant_account_ref
       OR a.currency_code IS DISTINCT FROM p_verified_currency
       OR a.amount_minor IS DISTINCT FROM p_verified_amount_minor THEN
      RAISE EXCEPTION 'Batch 1C: replay refund terms do not match' USING ERRCODE = 'BP002';
    END IF;
    SELECT e.id INTO v_reversal FROM public.wallet_business_events e
    WHERE e.event_key = 'wallet-topup:' || a.id::text || ':refund';
    RETURN v_reversal;
  END IF;
  IF a.status <> 'credited' OR a.credited_event_id IS NULL THEN
    RAISE EXCEPTION 'Batch 1C: only a credited attempt can be refunded' USING ERRCODE = 'BP008';
  END IF;
  -- Evidence must match provider, merchant, original payment, currency, full amount.
  IF a.provider_reference IS DISTINCT FROM p_verified_provider_reference
     OR a.merchant_account_ref IS DISTINCT FROM p_verified_merchant_account_ref
     OR a.currency_code IS DISTINCT FROM p_verified_currency THEN
    RAISE EXCEPTION 'Batch 1C: refund evidence does not match the original payment' USING ERRCODE = 'BP008';
  END IF;
  IF p_verified_amount_minor IS DISTINCT FROM a.amount_minor THEN
    RAISE EXCEPTION 'Batch 1C: partial refunds are unsupported (evidence %, attempt %)', p_verified_amount_minor, a.amount_minor USING ERRCODE = 'BP008';
  END IF;
  v_reversal := public.post_wallet_reversal('wallet-topup:' || a.id::text, 'wallet-topup:' || a.id::text || ':refund');
  UPDATE public.wallet_topup_attempts SET status='refunded', refund_evidence_reference=p_evidence_reference, failure_reason=COALESCE(p_reason,failure_reason) WHERE id=p_attempt_id;
  RETURN v_reversal;
END $$;


--
-- Name: mark_wallet_topup_uncertain(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_wallet_topup_uncertain(p_attempt_id uuid, p_reason text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF a.status IN ('credited','refunded') THEN
    RAISE EXCEPTION 'Batch 1C: credited/refunded attempt cannot be downgraded to uncertain' USING ERRCODE = 'BP008';
  END IF;
  UPDATE public.wallet_topup_attempts SET status='uncertain', failure_reason=COALESCE(p_reason,failure_reason) WHERE id=p_attempt_id;
END $$;


--
-- Name: pay_job_from_wallet(uuid, uuid, numeric, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pay_job_from_wallet(p_job_id uuid, p_customer_id uuid, p_amount numeric, p_currency_code text DEFAULT 'GBP'::text, p_tenant_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
 j public.jobs%ROWTYPE; w public.wallets%ROWTYPE; f public.errand_funding%ROWTYPE;
 fare numeric; budget numeric:=0; total numeric; net numeric; result text; next_status text;
 slug text; deferred boolean; quote_expiry text; quote_ref text; quote_version text;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id AND customer_id=p_customer_id FOR UPDATE;
 -- Terminal state wins before any idempotency check. Never reopen or re-debit.
 IF lower(j.status) IN ('cancelled','canceled','expired','failed','no_driver_found','completed','settled','delivered') THEN
  RAISE EXCEPTION 'Wallet payment is not available for this job status';
 END IF;
 IF upper(coalesce(p_currency_code,''))<>upper(coalesce(j.currency_code,'GBP')) THEN RAISE EXCEPTION 'Wallet currency mismatch'; END IF;
 IF p_tenant_id IS NOT NULL AND p_tenant_id IS DISTINCT FROM j.tenant_id THEN RAISE EXCEPTION 'Wallet tenant mismatch'; END IF;
 SELECT * INTO STRICT w FROM public.wallets WHERE user_id=p_customer_id FOR UPDATE;
 IF upper(w.currency_code)<>upper(coalesce(j.currency_code,'GBP')) THEN RAISE EXCEPTION 'Wallet currency mismatch'; END IF;
 SELECT coalesce(sum(CASE WHEN transaction_type='reservation' THEN amount WHEN transaction_type IN ('release','settlement') THEN -amount ELSE 0 END),0)
 INTO net FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id;
 IF j.payment_method='wallet' AND j.payment_status='wallet_funded' THEN
  IF j.status IN ('requested','searching','assigned','accepted','heading_to_pickup','driver_en_route','arrived','in_progress','shopping_in_progress','collected','en_route_to_customer') AND net>0 THEN
   RETURN jsonb_build_object('status','already_paid','job_id',j.id,'payment_method','wallet');
  END IF;
  RAISE EXCEPTION 'Stalled wallet reservation requires reconciliation';
 END IF;
 IF j.payment_status IS DISTINCT FROM 'pending' OR net<>0 THEN RAISE EXCEPTION 'Job already has payment or reservation'; END IF;
 IF j.status NOT IN ('pending','pending_payment','requested','pending_fare_confirmation','negotiating','fare_agreed') THEN RAISE EXCEPTION 'Job is not payable'; END IF;
 SELECT * INTO f FROM public.errand_funding WHERE job_id=j.id FOR UPDATE;
 IF FOUND AND f.status IN ('reserved','approved','over_budget_requested','settled') THEN RAISE EXCEPTION 'Existing errand reservation requires reconciliation'; END IF;
 IF j.status='fare_agreed' AND j.driver_id IS NOT NULL AND j.agreed_fare>0 THEN fare:=round(j.agreed_fare,2);
 ELSE
  fare:=coalesce(nullif(round(j.total_price,2),0),nullif(round(j.estimated_price,2),0),nullif(round(j.price,2),0));
  quote_ref:=coalesce(nullif(j.quote_id::text,''),nullif(j.metadata->>'quote_id',''),nullif(j.fare_breakdown->>'quoteId',''));
  quote_version:=coalesce(nullif(j.fare_breakdown->>'calculationVersion',''),nullif(j.fare_breakdown->>'marketPricingVersion',''));
  quote_expiry:=coalesce(nullif(j.metadata->>'quote_expires_at',''),nullif(j.fare_breakdown->>'quoteExpiresAt',''));
  IF quote_ref IS NULL OR quote_version IS NULL OR quote_expiry IS NULL OR quote_expiry::timestamptz<=now() THEN RAISE EXCEPTION 'Fare quote is missing or expired'; END IF;
 END IF;
 IF fare IS NULL OR fare<=0 THEN RAISE EXCEPTION 'Invalid service fare'; END IF;
 SELECT st.slug INTO slug FROM public.service_types st WHERE st.id=j.service_type_id;
 IF lower(coalesce(slug,j.metadata->>'service_slug','')) IN ('errand','errands','shop','shopping') THEN
  PERFORM 1 FROM public.errand_details WHERE job_id=j.id FOR UPDATE;
  SELECT coalesce(nullif(f.item_budget,0),nullif(ed.estimated_budget,0),CASE WHEN f.status='pending' THEN nullif(f.amount_reserved,0) END,0)
  INTO budget FROM (SELECT 1) anchor LEFT JOIN public.errand_details ed ON ed.job_id=j.id;
  budget:=round(coalesce(budget,0),2);
 END IF;
 IF budget<0 THEN RAISE EXCEPTION 'Invalid item budget'; END IF;
 total:=round(fare+budget,2);
 IF p_amount IS NULL OR round(p_amount,2) IS DISTINCT FROM total THEN RAISE EXCEPTION 'Wallet amount changed; refresh the fare'; END IF;
 IF w.available_balance<total THEN RAISE EXCEPTION 'Insufficient wallet balance'; END IF;
 deferred:=j.scheduled_time IS NOT NULL AND j.scheduled_time>now() AND j.driver_id IS NULL;
 next_status:=CASE WHEN j.driver_id IS NOT NULL THEN 'assigned' WHEN deferred THEN 'requested' ELSE 'searching' END;
 -- Finalize while payment is still pending. All agreement/driver checks remain
 -- inside the canonical finalizer. Any error below rolls this transition back.
 result:=public.finalize_job_payment(j.id,NULL,'wallet_funded',next_status,fare,false,
  CASE WHEN next_status='searching' THEN now() ELSE NULL END,
  CASE WHEN next_status='searching' THEN now()+interval '5 minutes' ELSE NULL END,
  CASE WHEN next_status='searching' THEN 1 ELSE 0 END,NULL,lower(j.currency_code));
 IF result IS DISTINCT FROM 'finalized' THEN RAISE EXCEPTION 'Wallet activation rejected: %',result; END IF;
 UPDATE public.wallets SET available_balance=w.available_balance-total,reserved_balance=w.reserved_balance+total,updated_at=now() WHERE id=w.id;
 INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,description,metadata,
  balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
 VALUES(w.id,j.customer_id,j.id,'reservation',total,'Job payment reserved from wallet',
  jsonb_build_object('payment_method','wallet','service_fare',fare,'item_budget',budget,'currency_code',j.currency_code),
  w.available_balance,w.available_balance-total,w.reserved_balance,w.reserved_balance+total);
 IF lower(coalesce(slug,'')) IN ('errand','errands','shop','shopping') THEN
  INSERT INTO public.errand_funding(job_id,customer_id,item_budget,service_estimate,amount_reserved,status)
  VALUES(j.id,j.customer_id,budget,fare,total,'reserved')
  ON CONFLICT(job_id) DO UPDATE SET item_budget=excluded.item_budget,service_estimate=excluded.service_estimate,amount_reserved=excluded.amount_reserved,status='reserved',updated_at=now();
 END IF;
 UPDATE public.jobs SET payment_method='wallet',payment_intent_id=NULL,confirmed_at=now(),price=fare,total_price=fare,
  metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('wallet_payment',jsonb_build_object('service_fare',fare,'item_budget',budget,'total_reserved',total)),updated_at=now()
 WHERE id=j.id;
 RETURN jsonb_build_object('status','paid','job_id',j.id,'amount',total,'payment_method','wallet','job_status',next_status);
END $$;


--
-- Name: post_wallet_event(text, text, uuid, uuid, text, jsonb, text, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.post_wallet_event(p_event_key text, p_operation text, p_tenant_id uuid, p_owner_id uuid, p_currency_code text, p_entries jsonb, p_payment_provider text DEFAULT NULL::text, p_merchant_account_ref text DEFAULT NULL::text, p_provider_reference text DEFAULT NULL::text, p_reverses_event_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_event_id uuid;
  v_account_id uuid;
  v_sum numeric := 0;
  v_entries jsonb;
  v_expected jsonb;
  v_original public.wallet_business_events%ROWTYPE;
  v_constraint_name text;
  entry record;
  leg jsonb;
BEGIN
  -- Input validation (BP003).
  IF p_event_key IS NULL OR btrim(p_event_key) = '' OR length(p_event_key) > 200 THEN
    RAISE EXCEPTION 'Batch 1B: invalid event_key' USING ERRCODE = 'BP003';
  END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' OR length(p_operation) > 64 THEN
    RAISE EXCEPTION 'Batch 1B: invalid operation' USING ERRCODE = 'BP003';
  END IF;
  IF p_tenant_id IS NULL OR p_owner_id IS NULL THEN
    RAISE EXCEPTION 'Batch 1B: tenant_id and owner_id are required' USING ERRCODE = 'BP003';
  END IF;
  IF public.wallet_currency_minor_exponent(p_currency_code) IS NULL THEN
    RAISE EXCEPTION 'Batch 1B: invalid currency format %', p_currency_code USING ERRCODE = 'BP003';
  END IF;
  -- Canonical supported-currency authority (no divergent list).
  IF NOT EXISTS (SELECT 1 FROM public.market_availability WHERE upper(supported_currency) = p_currency_code) THEN
    RAISE EXCEPTION 'Batch 1B: unsupported currency %', p_currency_code USING ERRCODE = 'BP003';
  END IF;
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array'
     OR jsonb_array_length(p_entries) < 2 OR jsonb_array_length(p_entries) > 20 THEN
    RAISE EXCEPTION 'Batch 1B: entries must be an array of 2..20 legs' USING ERRCODE = 'BP003';
  END IF;

  -- Provider identity (BP004).
  IF p_payment_provider IS NOT NULL THEN
    IF p_payment_provider NOT IN ('stripe','kora','fincra') THEN
      RAISE EXCEPTION 'Batch 1B: unknown payment_provider %', p_payment_provider USING ERRCODE = 'BP004';
    END IF;
    IF p_merchant_account_ref IS NULL OR btrim(p_merchant_account_ref) = ''
       OR p_provider_reference IS NULL OR btrim(p_provider_reference) = '' THEN
      RAISE EXCEPTION 'Batch 1B: external event requires merchant_account_ref and provider_reference' USING ERRCODE = 'BP004';
    END IF;
  ELSIF p_merchant_account_ref IS NOT NULL OR p_provider_reference IS NOT NULL THEN
    RAISE EXCEPTION 'Batch 1B: internal event must not carry merchant/provider identity' USING ERRCODE = 'BP004';
  END IF;

  -- Per-leg validation (BP003): exact keys, valid purpose, whole-number, reversible range, nonzero.
  FOR entry IN SELECT e.value AS leg FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e(value, ord) LOOP
    leg := entry.leg;
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(leg) AS k)
       IS DISTINCT FROM ARRAY['accountPurpose','amountMinor'] THEN
      RAISE EXCEPTION 'Batch 1B: leg has unexpected fields' USING ERRCODE = 'BP003';
    END IF;
    IF leg->>'accountPurpose' IS NULL OR btrim(leg->>'accountPurpose') = ''
       OR length(leg->>'accountPurpose') > 64 THEN
      RAISE EXCEPTION 'Batch 1B: invalid accountPurpose' USING ERRCODE = 'BP003';
    END IF;
    IF jsonb_typeof(leg->'amountMinor') <> 'number' THEN
      RAISE EXCEPTION 'Batch 1B: amountMinor must be a number' USING ERRCODE = 'BP003';
    END IF;
    IF (leg->>'amountMinor')::numeric <> round((leg->>'amountMinor')::numeric) THEN
      RAISE EXCEPTION 'Batch 1B: amountMinor must be a whole number' USING ERRCODE = 'BP003';
    END IF;
    IF (leg->>'amountMinor')::numeric NOT BETWEEN -9223372036854775807::numeric AND 9223372036854775807::numeric THEN
      RAISE EXCEPTION 'Batch 1B: amountMinor out of reversible bigint range' USING ERRCODE = 'BP003';
    END IF;
    IF (leg->>'amountMinor')::bigint = 0 THEN
      RAISE EXCEPTION 'Batch 1B: amountMinor must be non-zero' USING ERRCODE = 'BP003';
    END IF;
  END LOOP;

  -- Server-side canonicalization: merge duplicate account purposes (sum), sort
  -- by purpose, drop zero nets. Deterministic for storage, comparison, locking.
  SELECT jsonb_agg(jsonb_build_object('accountPurpose', purpose, 'amountMinor', total) ORDER BY purpose)
  INTO v_entries
  FROM (
    SELECT e.value->>'accountPurpose' AS purpose, sum((e.value->>'amountMinor')::bigint) AS total
    FROM jsonb_array_elements(p_entries) AS e(value)
    GROUP BY e.value->>'accountPurpose'
    HAVING sum((e.value->>'amountMinor')::bigint) <> 0
  ) g;

  IF v_entries IS NULL OR jsonb_array_length(v_entries) < 2 THEN
    RAISE EXCEPTION 'Batch 1B: canonicalized entries require at least 2 non-zero legs' USING ERRCODE = 'BP003';
  END IF;

  -- Post-canonicalization range validation: a merged total can overflow the
  -- reversible bigint range even when each individual leg is valid.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_entries) e
    WHERE (e.value->>'amountMinor')::numeric NOT BETWEEN -9223372036854775807::numeric AND 9223372036854775807::numeric
  ) THEN
    RAISE EXCEPTION 'Batch 1B: merged amountMinor out of reversible bigint range' USING ERRCODE = 'BP003';
  END IF;

  SELECT COALESCE(sum((e->>'amountMinor')::numeric), 0) INTO v_sum FROM jsonb_array_elements(v_entries) e;
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'Batch 1B: unbalanced event % (net=%)', p_event_key, v_sum USING ERRCODE = 'BP001';
  END IF;

  -- Replay (BP002) BEFORE reversal check so a same-key reversal retry is idempotent.
  SELECT id INTO v_event_id FROM public.wallet_business_events WHERE event_key = p_event_key;
  IF FOUND THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.wallet_business_events
      WHERE id = v_event_id
        AND operation = p_operation
        AND tenant_id = p_tenant_id AND owner_id = p_owner_id
        AND currency_code = p_currency_code
        AND payment_provider IS NOT DISTINCT FROM p_payment_provider
        AND merchant_account_ref IS NOT DISTINCT FROM p_merchant_account_ref
        AND provider_reference IS NOT DISTINCT FROM p_provider_reference
        AND entries = v_entries
        AND reverses_event_id IS NOT DISTINCT FROM p_reverses_event_id
    ) THEN
      RAISE EXCEPTION 'Batch 1B: event_key % reused with different terms', p_event_key USING ERRCODE = 'BP002';
    END IF;
    RETURN v_event_id;
  END IF;

  -- Controlled reversal (BP005).
  IF p_reverses_event_id IS NOT NULL THEN
    SELECT * INTO v_original FROM public.wallet_business_events WHERE id = p_reverses_event_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Batch 1B: reversal original event not found' USING ERRCODE = 'BP005';
    END IF;
    IF v_original.tenant_id <> p_tenant_id OR v_original.owner_id <> p_owner_id
       OR v_original.currency_code <> p_currency_code THEN
      RAISE EXCEPTION 'Batch 1B: reversal scope mismatch' USING ERRCODE = 'BP005';
    END IF;
    IF EXISTS (SELECT 1 FROM public.wallet_business_events WHERE reverses_event_id = p_reverses_event_id) THEN
      RAISE EXCEPTION 'Batch 1B: event already reversed' USING ERRCODE = 'BP005';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('accountPurpose', a.balance_purpose, 'amountMinor', -m.amount_minor)
                     ORDER BY a.balance_purpose)
    INTO v_expected
    FROM public.wallet_movements m
    JOIN public.wallet_accounts a ON a.id = m.account_id
    WHERE m.event_id = p_reverses_event_id;
    IF v_entries IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'Batch 1B: reversal legs do not exactly negate the original' USING ERRCODE = 'BP005';
    END IF;
  END IF;

  -- Insert the event; distinguish event-key vs reversal-uniqueness conflicts.
  BEGIN
    INSERT INTO public.wallet_business_events
      (event_key, operation, payment_provider, merchant_account_ref, provider_reference,
       tenant_id, owner_id, currency_code, entries, reverses_event_id)
    VALUES
      (p_event_key, p_operation, p_payment_provider, p_merchant_account_ref, p_provider_reference,
       p_tenant_id, p_owner_id, p_currency_code, v_entries, p_reverses_event_id)
    RETURNING id INTO v_event_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name = 'wallet_business_events_event_key_key' THEN
      SELECT id INTO v_event_id FROM public.wallet_business_events WHERE event_key = p_event_key;
      IF NOT EXISTS (
        SELECT 1 FROM public.wallet_business_events
        WHERE id = v_event_id
          AND operation = p_operation
          AND tenant_id = p_tenant_id AND owner_id = p_owner_id
          AND currency_code = p_currency_code
          AND payment_provider IS NOT DISTINCT FROM p_payment_provider
          AND merchant_account_ref IS NOT DISTINCT FROM p_merchant_account_ref
          AND provider_reference IS NOT DISTINCT FROM p_provider_reference
          AND entries = v_entries
          AND reverses_event_id IS NOT DISTINCT FROM p_reverses_event_id
      ) THEN
        RAISE EXCEPTION 'Batch 1B: event_key % reused with different terms', p_event_key USING ERRCODE = 'BP002';
      END IF;
      RETURN v_event_id;
    ELSIF v_constraint_name = 'wallet_business_events_reversal_unique' THEN
      RAISE EXCEPTION 'Batch 1B: event already reversed' USING ERRCODE = 'BP005';
    ELSE
      RAISE;
    END IF;
  END;

  -- Post the canonical legs (sorted; accounts locked in deterministic order).
  FOR entry IN SELECT e.value AS leg, e.ord AS seq FROM jsonb_array_elements(v_entries) WITH ORDINALITY AS e(value, ord) LOOP
    INSERT INTO public.wallet_accounts (tenant_id, owner_id, currency_code, balance_purpose)
    VALUES (p_tenant_id, p_owner_id, p_currency_code, entry.leg->>'accountPurpose')
    ON CONFLICT (tenant_id, owner_id, currency_code, balance_purpose) DO NOTHING;
    SELECT id INTO v_account_id FROM public.wallet_accounts
    WHERE tenant_id = p_tenant_id AND owner_id = p_owner_id
      AND currency_code = p_currency_code AND balance_purpose = entry.leg->>'accountPurpose'
    FOR UPDATE;

    INSERT INTO public.wallet_movements (event_id, account_id, amount_minor, entry_seq)
    VALUES (v_event_id, v_account_id, (entry.leg->>'amountMinor')::bigint, entry.seq::smallint);
  END LOOP;

  RETURN v_event_id;
END
$$;


--
-- Name: post_wallet_reversal(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.post_wallet_reversal(p_original_event_key text, p_event_key text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_original public.wallet_business_events%ROWTYPE;
  v_legs jsonb;
BEGIN
  SELECT * INTO STRICT v_original FROM public.wallet_business_events WHERE event_key = p_original_event_key;

  SELECT jsonb_agg(jsonb_build_object('accountPurpose', a.balance_purpose, 'amountMinor', -m.amount_minor)
                   ORDER BY a.balance_purpose)
  INTO v_legs
  FROM public.wallet_movements m
  JOIN public.wallet_accounts a ON a.id = m.account_id
  WHERE m.event_id = v_original.id;

  RETURN public.post_wallet_event(
    p_event_key, 'reversal', v_original.tenant_id, v_original.owner_id, v_original.currency_code,
    v_legs, NULL, NULL, NULL, v_original.id);
END
$$;


--
-- Name: preview_vaydu_margin(jsonb, bigint, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preview_vaydu_margin(p_fare_snapshot jsonb, p_discount_minor bigint DEFAULT 0, p_referral_liability_minor bigint DEFAULT 0, p_processing_minor bigint DEFAULT 0) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare commission bigint; fee bigint; charge bigint; net bigint; margin bigint;
begin
  commission := (p_fare_snapshot->>'driverCommissionAmount')::bigint;
  fee := (p_fare_snapshot->>'platformFeeAmount')::bigint;
  charge := (p_fare_snapshot->>'customerCharge')::bigint;
  net := (p_fare_snapshot->>'driverEntitlement')::bigint;
  -- Vaydu's gross take is commission + platform fee; costs are the platform-
  -- funded discount, referral liability and payment processing.
  margin := commission + fee
          - coalesce(p_discount_minor,0)
          - coalesce(p_referral_liability_minor,0)
          - coalesce(p_processing_minor,0);
  return jsonb_build_object(
    'customerChargeMinor', charge,
    'driverEntitlementMinor', net,
    'grossRevenueMinor', commission + fee,
    'discountMinor', coalesce(p_discount_minor,0),
    'referralLiabilityMinor', coalesce(p_referral_liability_minor,0),
    'processingMinor', coalesce(p_processing_minor,0),
    'vayduMarginMinor', margin,
    'marginBps', case when charge>0 then (margin::numeric * 10000 / charge)::int else null end);
end$$;


--
-- Name: protect_driver_operating_market_v23(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_driver_operating_market_v23() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
 IF auth.role() IN ('anon','authenticated') AND (
   (OLD.role='driver' AND (
     OLD.registration_country_code IS DISTINCT FROM NEW.registration_country_code OR OLD.country_code IS DISTINCT FROM NEW.country_code
     OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.role IS DISTINCT FROM NEW.role))
   OR (NEW.role IN ('admin','super_admin') AND OLD.role IS DISTINCT FROM NEW.role)
   OR OLD.registration_activated_at IS DISTINCT FROM NEW.registration_activated_at
   OR to_jsonb(OLD)->>'stripe_account_id' IS DISTINCT FROM to_jsonb(NEW)->>'stripe_account_id'
   OR to_jsonb(OLD)->>'stripe_connect_account_id' IS DISTINCT FROM to_jsonb(NEW)->>'stripe_connect_account_id'
   OR to_jsonb(OLD)->>'stripe_connected_account_id' IS DISTINCT FROM to_jsonb(NEW)->>'stripe_connected_account_id'
   OR to_jsonb(OLD)->>'stripe_connect_id' IS DISTINCT FROM to_jsonb(NEW)->>'stripe_connect_id'
   OR to_jsonb(OLD)->>'stripe_connect_status' IS DISTINCT FROM to_jsonb(NEW)->>'stripe_connect_status'
   OR to_jsonb(OLD)->>'charges_enabled' IS DISTINCT FROM to_jsonb(NEW)->>'charges_enabled'
   OR to_jsonb(OLD)->>'payouts_enabled' IS DISTINCT FROM to_jsonb(NEW)->>'payouts_enabled') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='DRIVER_MARKET_CHANGE_REQUIRES_REVIEW';
 END IF;
 RETURN NEW;
END $$;


--
-- Name: publish_cancellation_policy(uuid, text, bigint, integer, integer, bigint, bigint, numeric, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publish_cancellation_policy(p_tenant uuid, p_market text, p_reference_fare_minor bigint, p_debt_threshold_bps integer, p_grace_seconds integer, p_fee_minor bigint, p_fee_cap_minor bigint, p_compensation_percent numeric, p_created_by uuid) RETURNS public.cancellation_policies
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v cancellation_policies;
BEGIN
  INSERT INTO cancellation_policies(
    tenant_id, market_code, version, enabled,
    grace_seconds, fee_minor, fee_cap_minor,
    driver_compensation_percent, compensation_funding,
    reference_fare_minor, debt_threshold_bps, debt_threshold_minor,
    created_by)
  VALUES(
    p_tenant, p_market,
    (SELECT coalesce(max(version),0)+1 FROM cancellation_policies WHERE tenant_id=p_tenant AND market_code=p_market),
    false,
    p_grace_seconds, p_fee_minor, p_fee_cap_minor,
    p_compensation_percent, 'on_collection',
    p_reference_fare_minor, p_debt_threshold_bps,
    (p_reference_fare_minor * p_debt_threshold_bps / 10000)::bigint,
    p_created_by)
  RETURNING * INTO v;
  RETURN v;
END $$;


--
-- Name: reassign_cash_job_credit_v1f(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reassign_cash_job_credit_v1f(p_job uuid, p_new_driver uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE j public.jobs%ROWTYPE; h public.driver_cash_credit_holds_v1e%ROWTYPE;
        reserved numeric; v_event uuid;
BEGIN
 IF NOT public.cash_credit_service_writer_v1e() THEN
  RAISE EXCEPTION 'Cash reassignment requires the server role' USING ERRCODE='CE002';
 END IF;
 SELECT * INTO j FROM public.jobs WHERE id=p_job FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Job not found' USING ERRCODE='CE002'; END IF;
 IF j.payment_method IS DISTINCT FROM 'cash' THEN RAISE EXCEPTION 'Not a cash job' USING ERRCODE='CE002'; END IF;
 IF j.status NOT IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived') THEN
  RAISE EXCEPTION 'Cash reassignment only before service starts' USING ERRCODE='CE006';
 END IF;
 IF j.metadata->>'cash_collected_at' IS NOT NULL THEN
  RAISE EXCEPTION 'Cash already collected - reassignment not allowed' USING ERRCODE='CE005';
 END IF;
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=p_job AND status='held' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'No held cash credit to reassign' USING ERRCODE='CE006'; END IF;
 -- Release path mirrors resolve_'released': serialise on the old driver's
 -- credit lock, verify reserved-ledger consistency, post the reversal.
 PERFORM public.driver_cash_credit_lock_v1e(h.tenant_id,h.driver_id,h.currency_code);
 SELECT coalesce(sum(m.amount_minor::numeric),0) INTO reserved
   FROM public.wallet_accounts a JOIN public.wallet_movements m ON m.account_id=a.id
  WHERE a.tenant_id=h.tenant_id AND a.owner_id=h.driver_id AND a.currency_code=h.currency_code
    AND a.balance_purpose='driver_cash_credit_reserved';
 IF reserved < h.required_credit_minor THEN
  RAISE EXCEPTION 'Cash reserved ledger requires reconciliation' USING ERRCODE='CE006';
 END IF;
 IF h.required_credit_minor>0 THEN
  v_event:=public.post_wallet_reversal('cash-hold:'||h.id::text,'cash-hold:'||h.id::text||':release');
 END IF;
 UPDATE public.driver_cash_credit_holds_v1e SET status='released',resolution_event_id=v_event,resolved_at=now() WHERE id=h.id;
 -- Transfer assignment: the trigger reserves for the replacement driver. If
 -- reserve fails (insufficient credit, market mismatch, unenrolled) the whole
 -- transaction rolls back — original hold returns to 'held', driver unchanged.
 UPDATE public.jobs SET driver_id=p_new_driver, accepted_driver_id=p_new_driver WHERE id=p_job;
 RETURN (SELECT id FROM public.driver_cash_credit_holds_v1e WHERE job_id=p_job AND status='held');
END $$;


--
-- Name: reconcile_wallet_topup(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reconcile_wallet_topup(p_attempt_id uuid, p_evidence_key text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE v public.wallet_topup_verifications%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.wallet_topup_verifications WHERE attempt_id = p_attempt_id AND evidence_key = p_evidence_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: verification evidence not found' USING ERRCODE = 'BP003'; END IF;
  RETURN public.confirm_wallet_topup(p_attempt_id, v.provider_reference, v.merchant_account_ref, v.currency_code, v.amount_minor, v.final_status);
END
$$;


--
-- Name: customer_receivables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_receivables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    job_id uuid,
    currency_code text NOT NULL,
    amount_minor bigint NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    policy_version integer,
    payment_reference text,
    dispute_reason text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    payment_provider text,
    merchant_account_ref text,
    CONSTRAINT customer_receivables_amount_minor_check CHECK ((amount_minor > 0)),
    CONSTRAINT customer_receivables_currency_code_check CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT customer_receivables_payment_provider_check CHECK ((payment_provider = ANY (ARRAY['stripe'::text, 'flutterwave'::text, 'paystack'::text]))),
    CONSTRAINT customer_receivables_reason_check CHECK ((reason = ANY (ARRAY['cancellation_fee'::text, 'no_show_fee'::text, 'fare_adjustment'::text, 'manual'::text]))),
    CONSTRAINT customer_receivables_status_check CHECK ((status = ANY (ARRAY['open'::text, 'disputed'::text, 'paid'::text, 'waived'::text, 'written_off'::text])))
);


--
-- Name: record_customer_receivable(uuid, uuid, uuid, text, bigint, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_customer_receivable(p_tenant uuid, p_customer uuid, p_job uuid, p_currency text, p_amount bigint, p_reason text, p_policy_version integer DEFAULT NULL::integer) RETURNS public.customer_receivables
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v customer_receivables;
begin
  select * into v from customer_receivables
   where job_id=p_job and customer_id=p_customer and reason=p_reason and status in ('open','disputed','paid')
   order by created_at desc limit 1;
  if found then return v; end if;
  insert into customer_receivables(tenant_id,customer_id,job_id,currency_code,amount_minor,reason,policy_version)
    values(p_tenant,p_customer,p_job,p_currency,p_amount,p_reason,p_policy_version) returning * into v;
  return v;
end$$;


--
-- Name: record_job_funding_breakdown(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_job_funding_breakdown() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_charge bigint; v_disc bigint; v_credit bigint;
BEGIN
  v_charge := coalesce((NEW.fare_breakdown->>'customerCharge')::bigint,(NEW.agreed_fare*100)::bigint,0);
  v_disc := coalesce((NEW.metadata->>'discount_minor')::bigint,0);
  SELECT coalesce(sum(amount_minor),0) INTO v_credit
    FROM reward_credit_spends WHERE job_id=NEW.id AND status='reserved';
  IF v_disc>0 OR v_credit>0 THEN
    INSERT INTO job_funding_breakdown(job_id,tenant_id,currency_code,
      customer_charge_minor,discount_minor,reward_credit_minor,external_due_minor)
    VALUES(NEW.id,NEW.tenant_id,NEW.currency_code,v_charge,v_disc,v_credit,
      greatest(v_charge-v_disc-v_credit,0));
  END IF;
  RETURN NEW;
END $$;


--
-- Name: record_wallet_topup_provider_reference(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_wallet_topup_provider_reference(p_attempt_id uuid, p_provider_reference text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF p_provider_reference IS NULL OR btrim(p_provider_reference) = '' THEN
    RAISE EXCEPTION 'Batch 1C: provider_reference is required' USING ERRCODE = 'BP004';
  END IF;
  IF a.provider_reference IS NOT NULL THEN
    IF a.provider_reference = p_provider_reference THEN RETURN true; END IF;
    RAISE EXCEPTION 'Batch 1C: provider reference already bound; never switch providers' USING ERRCODE = 'BP008';
  END IF;
  IF a.status NOT IN ('initiated','submitting','uncertain') THEN
    RAISE EXCEPTION 'Batch 1C: attempt is not awaiting provider reference' USING ERRCODE = 'BP008';
  END IF;
  UPDATE public.wallet_topup_attempts SET provider_reference = p_provider_reference, status = 'provider_pending'
  WHERE id = p_attempt_id;
  RETURN true;
END
$$;


--
-- Name: record_wallet_topup_verification(uuid, text, text, text, text, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_wallet_topup_verification(p_attempt_id uuid, p_evidence_key text, p_provider_reference text, p_merchant_account_ref text, p_currency_code text, p_amount_minor bigint, p_final_status text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF p_evidence_key IS NULL OR btrim(p_evidence_key) = '' THEN
    RAISE EXCEPTION 'Batch 1C: evidence_key is required' USING ERRCODE = 'BP004';
  END IF;
  IF p_final_status IS NULL OR p_final_status NOT IN ('succeeded','completed','failed','pending','unknown') THEN
    RAISE EXCEPTION 'Batch 1C: invalid final status %', p_final_status USING ERRCODE = 'BP008';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wallet-topup-evidence:' || p_evidence_key, 0));
  -- Idempotent only for identical evidence; conflicting reuse is rejected.
  IF EXISTS (SELECT 1 FROM public.wallet_topup_verifications WHERE evidence_key = p_evidence_key) THEN
    IF EXISTS (SELECT 1 FROM public.wallet_topup_verifications WHERE evidence_key = p_evidence_key
               AND attempt_id = p_attempt_id AND provider_reference IS NOT DISTINCT FROM p_provider_reference
               AND merchant_account_ref IS NOT DISTINCT FROM p_merchant_account_ref
               AND currency_code IS NOT DISTINCT FROM p_currency_code
               AND amount_minor IS NOT DISTINCT FROM p_amount_minor
               AND final_status = p_final_status) THEN
      RETURN true;
    END IF;
    RAISE EXCEPTION 'Batch 1C: evidence_key % reused with conflicting evidence', p_evidence_key USING ERRCODE = 'BP002';
  END IF;
  INSERT INTO public.wallet_topup_verifications
    (attempt_id, evidence_key, provider_reference, merchant_account_ref, currency_code, amount_minor, final_status)
  VALUES
    (p_attempt_id, p_evidence_key, p_provider_reference, p_merchant_account_ref, p_currency_code, p_amount_minor, p_final_status);
  RETURN true;
END
$$;


--
-- Name: referral_monthly_count(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.referral_monthly_count(p_referrer uuid, p_kind text) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT count(*)::int FROM referrals
   WHERE referrer_id=p_referrer AND referral_kind=p_kind
     AND status IN ('earned','released')
     AND resolved_at >= date_trunc('month', now());
$$;


--
-- Name: reject_errand_over_budget(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_errand_over_budget(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF auth.uid() IS DISTINCT FROM j.customer_id AND coalesce(auth.role(),'')<>'service_role' AND session_user NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION 'Only the customer can reject a budget increase'; END IF;
 IF j.status IN ('cancelled','canceled','expired','failed','no_driver_found','completed','settled','delivered') THEN RAISE EXCEPTION 'Booking is no longer active'; END IF;
 UPDATE public.errand_funding SET status='reserved',over_budget_status='rejected',requested_over_budget_amount=0,updated_at=now() WHERE job_id=j.id AND status='over_budget_requested';
 RETURN TRUE;
END $$;


--
-- Name: release_job_wallet_reservation(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_job_wallet_reservation(p_job_id uuid, p_reason text DEFAULT 'Wallet reservation released'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs%ROWTYPE; w public.wallets%ROWTYPE; f public.errand_funding%ROWTYPE; net numeric; reserved_count integer;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF j.payment_method IS DISTINCT FROM 'wallet' AND j.payment_status IS DISTINCT FROM 'wallet_funded' THEN RETURN jsonb_build_object('released',false,'reason','Job is not wallet-funded'); END IF;
 IF j.status NOT IN ('cancelled','canceled','expired','failed','no_driver_found') THEN RAISE EXCEPTION 'Wallet release requires a terminal cancelled booking'; END IF;
 IF j.payment_status IN ('paid','captured','succeeded') THEN RAISE EXCEPTION 'Captured funds require refund review'; END IF;
 SELECT * INTO STRICT w FROM public.wallets WHERE user_id=j.customer_id FOR UPDATE;
 SELECT * INTO f FROM public.errand_funding WHERE job_id=j.id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id AND transaction_type='settlement') OR f.status='settled' THEN
  RAISE EXCEPTION 'Settled reservation cannot be released as cancellation';
 END IF;
 SELECT coalesce(sum(CASE WHEN transaction_type='reservation' THEN amount WHEN transaction_type='release' THEN -amount ELSE 0 END),0),count(*) FILTER(WHERE transaction_type='reservation')
 INTO net,reserved_count FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id;
 -- Legacy errand reservations had no ledger row; their locked funding marker
 -- is the evidence. Never combine or double-count the two representations.
 IF reserved_count=0 AND f.status IN ('reserved','approved','over_budget_requested') THEN net:=f.amount_reserved; END IF;
 IF net<0 THEN RAISE EXCEPTION 'Wallet ledger requires reconciliation'; END IF;
 IF net=0 THEN
  UPDATE public.jobs SET payment_status='cancelled',updated_at=now() WHERE id=j.id;
  RETURN jsonb_build_object('released',false,'reason','No active wallet reservation');
 END IF;
 IF w.reserved_balance<net THEN RAISE EXCEPTION 'Reserved balance is inconsistent with this booking'; END IF;
 UPDATE public.wallets SET available_balance=w.available_balance+net,reserved_balance=w.reserved_balance-net,updated_at=now() WHERE id=w.id;
 INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,description,metadata,
  balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
 VALUES(w.id,j.customer_id,j.id,'release',net,p_reason,jsonb_build_object('payment_method','wallet','legacy_funding',reserved_count=0),
  w.available_balance,w.available_balance+net,w.reserved_balance,w.reserved_balance-net);
 UPDATE public.errand_funding SET status='cancelled',metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('released_amount',net,'release_reason',p_reason),updated_at=now()
 WHERE job_id=j.id AND status IN ('reserved','approved','over_budget_requested');
 UPDATE public.jobs SET payment_status='cancelled',updated_at=now() WHERE id=j.id;
 RETURN jsonb_build_object('released',true,'amount',net,'job_id',j.id);
END $$;


--
-- Name: release_referral_rewards(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_referral_rewards() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE n int := 0; r referrals;
BEGIN
  FOR r IN SELECT * FROM referrals
            WHERE status='earned' AND referral_kind='driver'
              AND release_at IS NOT NULL AND release_at<=now()
            FOR UPDATE SKIP LOCKED LOOP
    UPDATE referrals SET status='released' WHERE id=r.id;
    INSERT INTO reward_credits(tenant_id,owner_id,currency_code,amount_minor,source,source_id,withdrawable)
      SELECT r.tenant_id, r.referrer_id,
        (SELECT currency_code FROM campaigns WHERE id=r.campaign_id),
        r.reward_minor, 'driver_referral', r.id, false;
    n := n+1;
  END LOOP;
  RETURN n;
END $$;


--
-- Name: release_reward_credit_spend(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_reward_credit_spend(p_job uuid) RETURNS public.reward_credit_spends
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE s reward_credit_spends;
BEGIN
  UPDATE reward_credit_spends SET status='released',resolved_at=now()
   WHERE id=(SELECT id FROM reward_credit_spends
             WHERE job_id=p_job AND status='reserved'
             ORDER BY created_at DESC LIMIT 1) RETURNING * INTO s;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN s;
END $$;


--
-- Name: request_errand_over_budget(uuid, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_errand_over_budget(p_job_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs%ROWTYPE; f public.errand_funding%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF auth.uid() IS DISTINCT FROM j.driver_id AND coalesce(auth.role(),'')<>'service_role' AND session_user NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION 'Only the assigned driver can request a budget increase'; END IF;
 IF j.payment_status<>'wallet_funded' OR j.status NOT IN ('assigned','accepted','heading_to_pickup','arrived','arrived_at_store','shopping_in_progress','in_progress') THEN RAISE EXCEPTION 'Booking is not eligible for a budget increase'; END IF;
 SELECT * INTO STRICT f FROM public.errand_funding WHERE job_id=j.id FOR UPDATE;
 IF f.status NOT IN ('reserved','approved','over_budget_requested') OR p_amount IS NULL OR round(p_amount,2)<=f.item_budget OR length(trim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'Invalid budget increase'; END IF;
 UPDATE public.errand_funding SET status='over_budget_requested',over_budget_status='requested',requested_over_budget_amount=round(p_amount,2),over_budget_amount=round(p_amount-f.item_budget,2),over_budget_reason=p_reason,updated_at=now() WHERE job_id=j.id;
 RETURN TRUE;
END $$;


--
-- Name: reserve_cash_job_credit_v1e(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_cash_job_credit_v1e(p_job_id uuid, p_driver_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$                                                                                                                                                                                                                                                                                    
 DECLARE j public.jobs%ROWTYPE; enrol public.driver_cash_credit_enrolments_v1e%ROWTYPE; p jsonb; terms jsonb; balance jsonb; h public.driver_cash_credit_holds_v1e%ROWTYPE; v_id uuid; event uuid; need bigint; driver uuid;                                                                      
 BEGIN                                                                                                                                                                                                                                                                                            
  IF NOT public.driver_cash_credit_enabled_v1e() THEN RAISE EXCEPTION 'Cash credit pilot disabled' USING ERRCODE='CE001'; END IF;                                                                                                                                                                 
  SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;                                                                                                                                                                                                                           
  driver:=coalesce(j.driver_id,j.accepted_driver_id);                                                                                                                                                                                                                                             
  IF driver IS DISTINCT FROM p_driver_id OR p_driver_id IS NULL OR (j.driver_id IS NOT NULL AND j.accepted_driver_id IS NOT NULL AND j.driver_id<>j.accepted_driver_id)                                                                                                                           
  OR j.payment_method IS DISTINCT FROM 'cash' OR j.status IS NULL OR j.status NOT IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived','in_progress','completed','delivered','settled') THEN                                                                                 
   RAISE EXCEPTION 'Cash booking/driver is not eligible' USING ERRCODE='CE002'; END IF;                                                                                                                                                                                                           
  IF NOT EXISTS(SELECT 1 FROM public.service_types WHERE id=j.service_type_id AND slug='ride') THEN                                                                                                                                                                                               
   RAISE EXCEPTION 'Cash credit pilot supports Ride only' USING ERRCODE='CE002'; END IF;                                                                                                                                                                                                          
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
  SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=j.id AND status IN ('held','settled') FOR UPDATE;                                                                                                                                                                                                          
  IF FOUND THEN                                                                                                                                                                                                                                                                                   
   IF h.driver_id<>p_driver_id OR h.tenant_id<>j.tenant_id OR h.currency_code<>j.currency_code OR h.country_code<>j.country_code OR h.fare_snapshot IS DISTINCT FROM j.fare_breakdown OR h.status='released' THEN                                                                                 
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


--
-- Name: reserve_errand_funds(uuid, uuid, numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_errand_funds(p_job_id uuid, p_customer_id uuid, p_item_budget numeric, p_service_estimate numeric) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id;
 PERFORM public.pay_job_from_wallet(p_job_id,p_customer_id,p_item_budget+p_service_estimate,j.currency_code,j.tenant_id);
 RETURN true;
END $$;


--
-- Name: reserve_job_reward_credit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_job_reward_credit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_credit uuid; v_discount bigint; v_charge bigint; v_payable bigint;
BEGIN
  IF NEW.metadata->>'reward_credit_id' IS NULL THEN RETURN NEW; END IF;
  v_credit := (NEW.metadata->>'reward_credit_id')::uuid;
  v_charge := coalesce((NEW.fare_breakdown->>'customerCharge')::bigint,
               (NEW.agreed_fare*100)::bigint,0);
  v_discount := coalesce((NEW.metadata->>'discount_minor')::bigint,0);
  v_payable := greatest(v_charge - v_discount,0);
  PERFORM apply_reward_credit(v_credit,NEW.id,v_payable);
  RETURN NEW;
END $$;


--
-- Name: resolve_cash_job_credit_v1e(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_cash_job_credit_v1e(p_job_id uuid, p_outcome text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$                                                                                                                                                                                                                                                                                                                                                                           
 DECLARE j public.jobs%ROWTYPE; h public.driver_cash_credit_holds_v1e%ROWTYPE; event uuid; reserved numeric;                                                                                                                                                                                                                                                                             
 BEGIN                                                                                                                                                                                                                                                                                                                                                                                   
  SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;                                                                                                                                                                                                                                                                                                                  
  SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=p_job_id ORDER BY CASE WHEN status='held' THEN 0 ELSE 1 END, created_at DESC LIMIT 1 FOR UPDATE;                                                                                                                                                                                                                                                                                             
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


--
-- Name: reverse_reward_credit_spend(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reverse_reward_credit_spend(p_job uuid) RETURNS public.reward_credit_spends
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE s reward_credit_spends;
BEGIN
  UPDATE reward_credit_spends SET status='reversed',resolved_at=now()
   WHERE id=(SELECT id FROM reward_credit_spends
             WHERE job_id=p_job AND status='spent'
             ORDER BY created_at DESC LIMIT 1) RETURNING * INTO s;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE reward_credits SET status='active'
   WHERE id=s.credit_id AND (expires_at IS NULL OR expires_at>now());
  RETURN s;
END $$;


--
-- Name: reward_credit_available(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reward_credit_available(p_credit uuid) RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT greatest(c.amount_minor - coalesce(sum(s.amount_minor - s.restored_minor)
       FILTER(WHERE s.status IN ('reserved','spent')),0),0)::bigint
    FROM reward_credits c
    LEFT JOIN reward_credit_spends s ON s.credit_id=c.id
   WHERE c.id=p_credit GROUP BY c.amount_minor;
$$;


--
-- Name: secure_zero_payable_funding(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.secure_zero_payable_funding(p_job uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE j jobs; fb job_funding_breakdown;
        v_reserved bigint; v_bad int;
        v_app boolean;
BEGIN
  SELECT * INTO j FROM jobs WHERE id=p_job FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_missing'; END IF;

  -- Idempotent: already funded returns the existing state — never requires
  -- a possibly-expired/changed credit to re-validate, never double-funds.
  IF j.payment_status='wallet_funded' THEN
    RETURN jsonb_build_object('funded',true,'already',true,'externalDueMinor',0);
  END IF;

  SELECT * INTO fb FROM job_funding_breakdown WHERE job_id=p_job;
  IF NOT FOUND OR fb.external_due_minor<>0 THEN
    RETURN jsonb_build_object('funded',false,'reason','no_zero_payable_breakdown');
  END IF;

  -- Credit side: reserved spends for THIS job whose credits are active,
  -- unexpired and scoped to the job owner/tenant/currency.
  SELECT coalesce(sum(s.amount_minor),0),
         count(*) FILTER(WHERE c.id IS NULL OR c.status<>'active'
            OR c.owner_id IS DISTINCT FROM j.customer_id
            OR c.tenant_id IS DISTINCT FROM j.tenant_id
            OR c.currency_code IS DISTINCT FROM j.currency_code
            OR (c.expires_at IS NOT NULL AND c.expires_at<=now()))
    INTO v_reserved, v_bad
    FROM reward_credit_spends s
    LEFT JOIN reward_credits c ON c.id=s.credit_id
   WHERE s.job_id=p_job AND s.status='reserved';

  -- Discount side: a campaign application must exist when discount>0.
  SELECT fb.discount_minor=0 OR EXISTS(
    SELECT 1 FROM campaign_discount_applications a
     WHERE a.customer_id=j.customer_id AND a.status IN ('applied','consumed')
       AND a.discount_minor=fb.discount_minor)
    INTO v_app;

  IF v_bad>0 OR NOT v_app
     OR (fb.discount_minor + v_reserved) < fb.customer_charge_minor THEN
    RETURN jsonb_build_object('funded',false,'reason','insecure_allocation');
  END IF;

  UPDATE jobs SET payment_status='wallet_funded' WHERE id=p_job;
  RETURN jsonb_build_object('funded',true,'already',false,'externalDueMinor',0);
END $$;


--
-- Name: serialize_cash_credit_ledger_v1e(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.serialize_cash_credit_ledger_v1e() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN PERFORM public.driver_cash_credit_lock_v1e(NEW.tenant_id,NEW.owner_id,NEW.currency_code); RETURN NEW; END $$;


--
-- Name: settle_errand_funds(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.settle_errand_funds(p_booking_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs%ROWTYPE; fare numeric;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_booking_id;
 SELECT (metadata->>'service_fare')::numeric INTO fare FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id AND transaction_type='reservation' AND metadata ? 'service_fare' ORDER BY created_at,id LIMIT 1;
 fare:=coalesce(fare,j.total_price,j.price);
 PERFORM public.settle_job_wallet_reservation(p_booking_id,fare);
END $$;


--
-- Name: settle_job_wallet_reservation(uuid, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.settle_job_wallet_reservation(p_job_id uuid, p_amount numeric) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE j public.jobs%ROWTYPE; w public.wallets%ROWTYPE; f public.errand_funding%ROWTYPE;
 net numeric; fare numeric; spend numeric:=0; budget numeric:=0; charge numeric; refund numeric; prior public.wallet_transactions%ROWTYPE; reserved_count integer;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF j.status IN ('cancelled','canceled','expired','failed','no_driver_found') THEN RAISE EXCEPTION 'Cancelled booking cannot settle'; END IF;
 IF j.payment_method IS DISTINCT FROM 'wallet' AND j.payment_status IS DISTINCT FROM 'wallet_funded' THEN RAISE EXCEPTION 'Not a wallet booking'; END IF;
 SELECT * INTO prior FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id AND transaction_type='settlement';
 IF FOUND THEN RETURN jsonb_build_object('status','already_settled','job_id',j.id,'amount_settled',prior.amount); END IF;
 SELECT * INTO STRICT w FROM public.wallets WHERE user_id=j.customer_id FOR UPDATE;
 SELECT * INTO f FROM public.errand_funding WHERE job_id=j.id FOR UPDATE;
 IF f.status='settled' THEN RETURN jsonb_build_object('status','already_settled','job_id',j.id); END IF;
 SELECT coalesce(sum(CASE WHEN transaction_type='reservation' THEN amount WHEN transaction_type IN ('release','settlement') THEN -amount ELSE 0 END),0),count(*) FILTER(WHERE transaction_type='reservation')
 INTO net,reserved_count FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id;
 IF reserved_count=0 AND f.status IN ('reserved','approved','over_budget_requested') THEN net:=f.amount_reserved; END IF;
 IF net<=0 OR w.reserved_balance<net THEN RAISE EXCEPTION 'Wallet reservation is missing or inconsistent'; END IF;
 SELECT (metadata->>'service_fare')::numeric INTO fare FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id AND transaction_type='reservation' AND metadata ? 'service_fare' ORDER BY created_at,id LIMIT 1;
 fare:=coalesce(fare,round(p_amount,2));
 IF fare IS NULL OR fare<=0 OR fare IS DISTINCT FROM round(p_amount,2) OR fare>net THEN RAISE EXCEPTION 'Wallet settlement fare mismatch'; END IF;
 budget:=net-fare;
 SELECT coalesce(actual_spending,0) INTO spend FROM public.errand_details WHERE job_id=j.id FOR UPDATE;
 spend:=round(coalesce(spend,0),2);
 -- Never hide overspending by clamping it. Approval/funding must happen first.
 IF spend<0 OR spend>budget THEN RAISE EXCEPTION 'Shopping spend exceeds the funded budget; review required'; END IF;
 charge:=fare+spend; refund:=net-charge;
 UPDATE public.wallets SET available_balance=w.available_balance+refund,reserved_balance=w.reserved_balance-net,updated_at=now() WHERE id=w.id;
 INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,description,metadata,
  balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
 VALUES(w.id,j.customer_id,j.id,'settlement',charge,'Job payment settled from wallet reservation',
  jsonb_build_object('payment_method','wallet','service_fare',fare,'actual_item_spend',spend),
  w.available_balance,w.available_balance,w.reserved_balance,w.reserved_balance-charge);
 IF refund>0 THEN
  INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,description,metadata,
   balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
  VALUES(w.id,j.customer_id,j.id,'release',refund,'Unused shopping budget returned',jsonb_build_object('payment_method','wallet','reason','unused_budget'),
   w.available_balance,w.available_balance+refund,w.reserved_balance-charge,w.reserved_balance-net);
 END IF;
 UPDATE public.errand_funding SET status='settled',actual_item_spend=spend,refund_amount=refund,
  metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('settlement',jsonb_build_object('amount_settled',charge,'amount_released',refund)),updated_at=now() WHERE job_id=j.id;
 UPDATE public.jobs SET payment_status='paid',updated_at=now() WHERE id=j.id;
 RETURN jsonb_build_object('status','settled','job_id',j.id,'amount_settled',charge,'amount_released',refund);
END $$;


--
-- Name: settle_reward_credit_spend(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.settle_reward_credit_spend(p_job uuid) RETURNS public.reward_credit_spends
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE s reward_credit_spends;
BEGIN
  UPDATE reward_credit_spends SET status='spent',resolved_at=now()
   WHERE id=(SELECT id FROM reward_credit_spends
             WHERE job_id=p_job AND status='reserved'
             ORDER BY created_at DESC LIMIT 1) RETURNING * INTO s;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE reward_credits SET status='used'
   WHERE id=s.credit_id
     AND reward_credit_available(s.credit_id)=0;
  RETURN s;
END $$;


--
-- Name: validate_wallet_integrity(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_wallet_integrity(p_user_id uuid) RETURNS TABLE(is_valid boolean, message text)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_available DECIMAL(12,2);
    v_reserved DECIMAL(12,2);
BEGIN
    SELECT available_balance, reserved_balance
    INTO v_available, v_reserved
    FROM public.wallets
    WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Wallet not found'::TEXT;
    ELSIF v_available < 0 THEN
        RETURN QUERY SELECT FALSE, 'Available balance is negative'::TEXT;
    ELSIF v_reserved < 0 THEN
        RETURN QUERY SELECT FALSE, 'Reserved balance is negative'::TEXT;
    ELSIF (v_available + v_reserved) < 0 THEN
        RETURN QUERY SELECT FALSE, 'Negative total balance'::TEXT;
    ELSE
        RETURN QUERY SELECT TRUE, 'Wallet is healthy'::TEXT;
    END IF;
END;
$$;


--
-- Name: wallet_collection_enabled(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_collection_enabled() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$ SELECT COALESCE((SELECT value = 'true' FROM public.wallet_collection_config WHERE key='enabled'), false) $$;


--
-- Name: wallet_currency_minor_exponent(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_currency_minor_exponent(p_currency_code text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $_$ SELECT CASE
  WHEN p_currency_code IN ('BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF') THEN 0
  WHEN p_currency_code IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND') THEN 3
  WHEN p_currency_code ~ '^[A-Z]{3}$' THEN 2
  ELSE NULL END $_$;


--
-- Name: wallet_ledger_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_ledger_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  RAISE EXCEPTION 'Batch 1B: % is append-only', TG_TABLE_NAME USING ERRCODE = 'BP006';
END $$;


--
-- Name: wallet_topup_attempt_freeze(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_topup_attempt_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NEW.attempt_key IS DISTINCT FROM OLD.attempt_key
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.country_code IS DISTINCT FROM OLD.country_code
     OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.destination_account_purpose IS DISTINCT FROM OLD.destination_account_purpose
     OR NEW.payment_provider IS DISTINCT FROM OLD.payment_provider
     OR NEW.merchant_account_ref IS DISTINCT FROM OLD.merchant_account_ref
     OR NEW.provider_idempotency_identity IS DISTINCT FROM OLD.provider_idempotency_identity THEN
    RAISE EXCEPTION 'Batch 1C: top-up attempt terms are frozen' USING ERRCODE = 'BP007';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;


--
-- Name: campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    code text NOT NULL,
    kind text NOT NULL,
    market_code text NOT NULL,
    currency_code text NOT NULL,
    service_slug text NOT NULL,
    audience text DEFAULT 'customer'::text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    valid_from timestamp with time zone,
    valid_until timestamp with time zone,
    budget_minor bigint DEFAULT 0 NOT NULL,
    spent_minor bigint DEFAULT 0 NOT NULL,
    funding_party text DEFAULT 'platform'::text NOT NULL,
    qualification jsonb DEFAULT '{}'::jsonb NOT NULL,
    per_user_cap integer DEFAULT 1 NOT NULL,
    stacking text DEFAULT 'exclusive'::text NOT NULL,
    value_type text,
    value numeric,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaigns_audience_check CHECK ((audience = ANY (ARRAY['customer'::text, 'driver'::text, 'both'::text]))),
    CONSTRAINT campaigns_budget_minor_check CHECK ((budget_minor >= 0)),
    CONSTRAINT campaigns_currency_code_check CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT campaigns_funding_party_check CHECK ((funding_party = ANY (ARRAY['platform'::text, 'merchant'::text, 'partner'::text]))),
    CONSTRAINT campaigns_kind_check CHECK ((kind = ANY (ARRAY['customer_discount'::text, 'driver_incentive'::text, 'referral'::text]))),
    CONSTRAINT campaigns_per_user_cap_check CHECK ((per_user_cap > 0)),
    CONSTRAINT campaigns_spent_minor_check CHECK ((spent_minor >= 0)),
    CONSTRAINT campaigns_stacking_check CHECK ((stacking = ANY (ARRAY['exclusive'::text, 'stackable'::text]))),
    CONSTRAINT campaigns_value_check CHECK (((value IS NULL) OR (value >= (0)::numeric))),
    CONSTRAINT campaigns_value_type_check CHECK ((value_type = ANY (ARRAY['percent'::text, 'fixed_minor'::text])))
);


--
-- Name: driver_cash_credit_config_v1e; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_cash_credit_config_v1e (
    key text NOT NULL,
    enabled boolean NOT NULL
);


--
-- Name: driver_cash_credit_enrolments_v1e; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_cash_credit_enrolments_v1e (
    tenant_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    country_code text NOT NULL,
    currency_code text NOT NULL,
    terms_version text NOT NULL,
    consented_at timestamp with time zone NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT driver_cash_credit_enrolments_v1e_country_code_check CHECK ((country_code ~ '^[A-Z]{2}$'::text)),
    CONSTRAINT driver_cash_credit_enrolments_v1e_currency_code_check CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT driver_cash_credit_enrolments_v1e_terms_version_check CHECK (((length(btrim(terms_version)) >= 1) AND (length(btrim(terms_version)) <= 100)))
);


--
-- Name: driver_earnings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_earnings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid,
    driver_id uuid,
    amount numeric
);


--
-- Name: errand_funding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.errand_funding (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    amount_reserved numeric(12,2) NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT errand_funding_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'reserved'::text, 'approved'::text, 'settled'::text, 'cancelled'::text])))
);


--
-- Name: job_completion_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_completion_secrets (
    job_id uuid NOT NULL,
    completion_pin text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: job_funding_breakdown; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_funding_breakdown (
    job_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    currency_code text NOT NULL,
    customer_charge_minor bigint NOT NULL,
    discount_minor bigint DEFAULT 0 NOT NULL,
    reward_credit_minor bigint DEFAULT 0 NOT NULL,
    external_due_minor bigint NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    captured_minor bigint DEFAULT 0 NOT NULL,
    refunded_minor bigint DEFAULT 0 NOT NULL,
    CONSTRAINT job_funding_breakdown_check CHECK ((external_due_minor = GREATEST(((customer_charge_minor - discount_minor) - reward_credit_minor), (0)::bigint))),
    CONSTRAINT job_funding_breakdown_check1 CHECK (((discount_minor >= 0) AND (reward_credit_minor >= 0)))
);


--
-- Name: job_payment_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_payment_bindings (
    job_id uuid NOT NULL,
    provider text NOT NULL,
    merchant_account_ref text NOT NULL,
    country text NOT NULL,
    currency text NOT NULL,
    payment_reference text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT job_payment_bindings_country_check CHECK ((country ~ '^[A-Z]{2}$'::text)),
    CONSTRAINT job_payment_bindings_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT job_payment_bindings_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'flutterwave'::text, 'paystack'::text])))
);


--
-- Name: job_refund_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_refund_allocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    provider_ref text NOT NULL,
    external_minor bigint NOT NULL,
    credit_minor bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    service_minor bigint DEFAULT 0 NOT NULL,
    discrepancy_minor bigint DEFAULT 0 NOT NULL,
    kind text DEFAULT 'partial'::text NOT NULL,
    provider_confirmed_minor bigint DEFAULT 0 NOT NULL,
    CONSTRAINT job_refund_allocations_credit_minor_check CHECK ((credit_minor >= 0)),
    CONSTRAINT job_refund_allocations_external_minor_check CHECK ((external_minor >= 0))
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid NOT NULL,
    tenant_id uuid,
    customer_id uuid,
    driver_id uuid,
    accepted_driver_id uuid,
    status text,
    payment_method text,
    payment_status text,
    payment_intent_id text,
    country_code text,
    currency_code text,
    service_type_id uuid,
    agreed_fare numeric,
    fare_breakdown jsonb,
    metadata jsonb,
    cancellation_fee numeric,
    price numeric,
    total_price numeric,
    created_at timestamp with time zone DEFAULT now(),
    fulfilment_category text,
    fulfilment_subtype text,
    bike_parcel_max_kg numeric,
    bike_parcel_max_cm numeric,
    fulfilment_snapshot jsonb
);


--
-- Name: COLUMN jobs.fulfilment_category; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.jobs.fulfilment_category IS 'Customer-selected fulfilment category: bike, car, small_van. NULL for pre-category history.';


--
-- Name: COLUMN jobs.fulfilment_subtype; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.jobs.fulfilment_subtype IS 'Internal bike subtype: pedal_bicycle, e_bike, motorcycle, moped. NULL for non-bike or unknown.';


--
-- Name: COLUMN jobs.bike_parcel_max_kg; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.jobs.bike_parcel_max_kg IS 'Configured parcel weight limit for bike jobs, in kilograms.';


--
-- Name: COLUMN jobs.bike_parcel_max_cm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.jobs.bike_parcel_max_cm IS 'Configured parcel max linear dimension limit for bike jobs, in centimetres.';


--
-- Name: COLUMN jobs.fulfilment_snapshot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.jobs.fulfilment_snapshot IS 'Frozen quote-time fulfilment category, allowed subtypes and parcel limits; source of truth for assignment.';


--
-- Name: market_availability; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_availability (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code text NOT NULL,
    supported_currency text,
    enabled boolean DEFAULT true,
    bike_limits jsonb
);


--
-- Name: COLUMN market_availability.bike_limits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_availability.bike_limits IS 'Market-configured per-subtype parcel limits: {pedal_bicycle:{max_kg, max_cm}, e_bike:{...}, motorcycle:{...}, moped:{...}}. NULL means not configured (fail closed).';


--
-- Name: market_payment_route_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_payment_route_audit (
    id bigint NOT NULL,
    route_id uuid NOT NULL,
    actor text NOT NULL,
    old_values jsonb,
    new_values jsonb NOT NULL,
    changed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: market_payment_route_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.market_payment_route_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.market_payment_route_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: market_payment_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_payment_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code character varying(2) NOT NULL,
    currency_code character varying(3) NOT NULL,
    method text NOT NULL,
    provider text NOT NULL,
    merchant_account_ref text,
    preferred boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    merchant_approved boolean DEFAULT false NOT NULL,
    adapter_ready boolean DEFAULT false NOT NULL,
    payout_approved boolean DEFAULT false NOT NULL,
    capabilities text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT market_payment_routes_capabilities_check CHECK (((capabilities <@ ARRAY['authorise'::text, 'capture'::text, 'release'::text, 'refund'::text, 'retrieve'::text, 'payout'::text, 'collect'::text]) AND (array_position(capabilities, NULL::text) IS NULL))),
    CONSTRAINT market_payment_routes_check CHECK (((NOT enabled) OR (merchant_approved AND adapter_ready AND (merchant_account_ref IS NOT NULL) AND (cardinality(capabilities) > 0)))),
    CONSTRAINT market_payment_routes_check1 CHECK (((provider <> ALL (ARRAY['kora'::text, 'fincra'::text])) OR ((NOT enabled) AND (NOT adapter_ready) AND (NOT payout_approved) AND (cardinality(capabilities) = 0)))),
    CONSTRAINT market_payment_routes_country_code_check CHECK (((country_code)::text ~ '^[A-Z]{2}$'::text)),
    CONSTRAINT market_payment_routes_currency_code_check CHECK (((currency_code)::text ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT market_payment_routes_merchant_account_ref_check CHECK (((merchant_account_ref IS NULL) OR ((length(btrim(merchant_account_ref)) > 0) AND (merchant_account_ref = btrim(merchant_account_ref))))),
    CONSTRAINT market_payment_routes_method_check CHECK ((method = ANY (ARRAY['card'::text, 'bank_transfer'::text, 'mobile_money'::text]))),
    CONSTRAINT market_payment_routes_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'kora'::text, 'fincra'::text])))
);


--
-- Name: payment_card_consents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_card_consents (
    job_id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    merchant_account_ref text NOT NULL,
    version text NOT NULL,
    accepted_at timestamp with time zone NOT NULL
);


--
-- Name: payment_checkout_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_checkout_attempts (
    reference text NOT NULL,
    request jsonb NOT NULL,
    state text DEFAULT 'started'::text NOT NULL,
    checkout_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_checkout_attempts_state_check CHECK ((state = ANY (ARRAY['started'::text, 'submitted'::text, 'unknown'::text])))
);


--
-- Name: payment_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_customers (
    user_id uuid NOT NULL,
    provider text NOT NULL,
    merchant_account_ref text NOT NULL,
    customer_reference text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_customers_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'flutterwave'::text, 'paystack'::text])))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    role text,
    account_status text,
    tenant_id uuid,
    country_code text,
    currency_code text,
    registration_country_code text,
    registration_market_city text,
    registration_activated_at timestamp with time zone
);


--
-- Name: referral_driver_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_driver_progress (
    referral_id uuid NOT NULL,
    job_id uuid NOT NULL,
    fare_minor bigint NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT referral_driver_progress_fare_minor_check CHECK ((fare_minor >= 0))
);


--
-- Name: reward_credits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reward_credits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    currency_code text NOT NULL,
    amount_minor bigint NOT NULL,
    source text NOT NULL,
    source_id uuid NOT NULL,
    withdrawable boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reversed_at timestamp with time zone,
    CONSTRAINT reward_credits_amount_minor_check CHECK ((amount_minor > 0)),
    CONSTRAINT reward_credits_currency_code_check CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT reward_credits_source_check CHECK ((source = ANY (ARRAY['customer_referral'::text, 'driver_referral'::text, 'campaign'::text]))),
    CONSTRAINT reward_credits_status_check CHECK ((status = ANY (ARRAY['active'::text, 'used'::text, 'expired'::text, 'reversed'::text])))
);


--
-- Name: service_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_types (
    id uuid NOT NULL,
    slug text NOT NULL
);


--
-- Name: vehicles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type text,
    make text,
    model text,
    color text,
    year text,
    license_plate text,
    capacity text,
    service_eligibility text[] DEFAULT '{}'::text[],
    status text DEFAULT 'saved'::text,
    vehicle_subtype text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: COLUMN vehicles.vehicle_subtype; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vehicles.vehicle_subtype IS 'Driver approved vehicle subtype: pedal_bicycle, e_bike, motorcycle, moped.';


--
-- Name: wallet_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    currency_code text NOT NULL,
    balance_purpose text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallet_accounts_currency_code_check CHECK ((currency_code ~ '^[A-Z]{3}$'::text))
);


--
-- Name: wallet_business_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_business_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_key text NOT NULL,
    operation text NOT NULL,
    payment_provider text,
    merchant_account_ref text,
    provider_reference text,
    tenant_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    currency_code text NOT NULL,
    entries jsonb NOT NULL,
    reverses_event_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallet_business_events_currency_code_check CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT wallet_business_events_payment_provider_check CHECK (((payment_provider IS NULL) OR (payment_provider = ANY (ARRAY['stripe'::text, 'kora'::text, 'fincra'::text]))))
);


--
-- Name: wallet_collection_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_collection_config (
    key text NOT NULL,
    value text NOT NULL
);


--
-- Name: wallet_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    account_id uuid NOT NULL,
    amount_minor bigint NOT NULL,
    entry_seq smallint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallet_movements_amount_minor_check CHECK ((amount_minor <> 0))
);


--
-- Name: wallet_reconciliation_projection; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.wallet_reconciliation_projection AS
 SELECT a.tenant_id,
    a.owner_id,
    a.currency_code,
    a.balance_purpose,
    COALESCE(sum(m.amount_minor), (0)::numeric) AS diagnostic_balance_minor,
    count(m.id) AS movement_count
   FROM (public.wallet_accounts a
     LEFT JOIN public.wallet_movements m ON ((m.account_id = a.id)))
  GROUP BY a.tenant_id, a.owner_id, a.currency_code, a.balance_purpose;


--
-- Name: VIEW wallet_reconciliation_projection; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.wallet_reconciliation_projection IS 'DIAGNOSTIC ONLY. Sums signed movements per isolated account. NOT a spendable balance; never feed it into payment or payout authority.';


--
-- Name: wallet_topup_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_topup_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attempt_key text NOT NULL,
    tenant_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    country_code text NOT NULL,
    currency_code text NOT NULL,
    amount_minor bigint NOT NULL,
    destination_account_purpose text NOT NULL,
    payment_provider text NOT NULL,
    merchant_account_ref text NOT NULL,
    provider_idempotency_identity text NOT NULL,
    status text DEFAULT 'initiated'::text NOT NULL,
    provider_reference text,
    failure_reason text,
    credited_event_id uuid,
    refund_evidence_reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallet_topup_attempts_amount_minor_check CHECK ((amount_minor > 0)),
    CONSTRAINT wallet_topup_attempts_currency_code_check CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT wallet_topup_attempts_payment_provider_check CHECK ((payment_provider = ANY (ARRAY['stripe'::text, 'kora'::text]))),
    CONSTRAINT wallet_topup_attempts_status_check CHECK ((status = ANY (ARRAY['initiated'::text, 'submitting'::text, 'provider_pending'::text, 'confirmed'::text, 'credited'::text, 'failed'::text, 'uncertain'::text, 'refunded'::text])))
);


--
-- Name: wallet_topup_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_topup_verifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attempt_id uuid NOT NULL,
    evidence_key text NOT NULL,
    provider_reference text,
    merchant_account_ref text,
    currency_code text,
    amount_minor bigint,
    final_status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wallet_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    wallet_id uuid,
    user_id uuid,
    job_id uuid,
    transaction_type text,
    amount numeric,
    metadata jsonb,
    balance_before_available numeric,
    balance_after_available numeric,
    balance_before_reserved numeric,
    balance_after_reserved numeric,
    stripe_payment_intent_id text,
    payment_intent_id text,
    description text,
    type text,
    status text,
    created_at timestamp with time zone DEFAULT now(),
    tenant_id uuid,
    currency_code text,
    amount_minor bigint,
    balance_purpose text,
    payment_provider text,
    merchant_account_ref text,
    provider_reference text,
    event_key text
);


--
-- Name: COLUMN wallet_transactions.tenant_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.tenant_id IS 'Tenant isolation tag (mirrors jobs.tenant_id). NULL = unresolved/legacy provenance.';


--
-- Name: COLUMN wallet_transactions.currency_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.currency_code IS 'Exact ISO-4217 currency of the entry. NULL = unresolved/legacy provenance; never inferred.';


--
-- Name: COLUMN wallet_transactions.amount_minor; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.amount_minor IS 'Exact integer minor units (bigint) = amount * 10^exp(currency_code), exp in {0,2,3}. NULL unless the conversion is exact; never rounded, never inferred.';


--
-- Name: COLUMN wallet_transactions.balance_purpose; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.balance_purpose IS 'Account/purpose dimension (customer_credit, driver_cash_credit, promotional_credit, commission, bonus, compensation, earnings_payable). NULL = unresolved/legacy. No constraint yet; taxonomy finalised in a later batch.';


--
-- Name: COLUMN wallet_transactions.payment_provider; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.payment_provider IS 'Canonical provider id (stripe | kora | fincra). NULL = unresolved/legacy provenance: this does not by itself prove the entry was an internal-only movement.';


--
-- Name: COLUMN wallet_transactions.merchant_account_ref; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.merchant_account_ref IS 'Merchant-account scope from market_payment_routes. NULL = unresolved/legacy provenance; not proof of an internal-only movement.';


--
-- Name: COLUMN wallet_transactions.provider_reference; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.provider_reference IS 'External provider reference (Stripe PaymentIntent id, Kora checkout/transaction reference). NULL = unresolved/legacy provenance.';


--
-- Name: COLUMN wallet_transactions.event_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.event_key IS 'Provider-scoped idempotency key. Format and durable, coordinated identities are defined in a later batch (no per-retry sequence). Partial unique index deduplicates non-NULL keys only.';


--
-- Name: wallets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallets (
    user_id uuid NOT NULL,
    available_balance numeric(12,2) DEFAULT 0.00 NOT NULL,
    reserved_balance numeric(12,2) DEFAULT 0.00 NOT NULL,
    currency_code text DEFAULT 'GBP'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: campaign_discount_applications campaign_discount_application_campaign_id_customer_id_quote_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_discount_applications
    ADD CONSTRAINT campaign_discount_application_campaign_id_customer_id_quote_key UNIQUE (campaign_id, customer_id, quote_reference);


--
-- Name: campaign_discount_applications campaign_discount_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_discount_applications
    ADD CONSTRAINT campaign_discount_applications_pkey PRIMARY KEY (id);


--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);


--
-- Name: campaigns campaigns_tenant_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_tenant_id_code_key UNIQUE (tenant_id, code);


--
-- Name: cancellation_policies cancellation_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cancellation_policies
    ADD CONSTRAINT cancellation_policies_pkey PRIMARY KEY (id);


--
-- Name: cancellation_policies cancellation_policies_tenant_id_market_code_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cancellation_policies
    ADD CONSTRAINT cancellation_policies_tenant_id_market_code_version_key UNIQUE (tenant_id, market_code, version);


--
-- Name: customer_receivables customer_receivables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_receivables
    ADD CONSTRAINT customer_receivables_pkey PRIMARY KEY (id);


--
-- Name: driver_cash_credit_config_v1e driver_cash_credit_config_v1e_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_config_v1e
    ADD CONSTRAINT driver_cash_credit_config_v1e_pkey PRIMARY KEY (key);


--
-- Name: driver_cash_credit_enrolments_v1e driver_cash_credit_enrolments_v1e_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_enrolments_v1e
    ADD CONSTRAINT driver_cash_credit_enrolments_v1e_pkey PRIMARY KEY (tenant_id, driver_id, country_code, currency_code);


--
-- Name: driver_cash_credit_holds_v1e driver_cash_credit_holds_v1e_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_holds_v1e
    ADD CONSTRAINT driver_cash_credit_holds_v1e_pkey PRIMARY KEY (id);


--
-- Name: driver_cash_credit_holds_v1e driver_cash_credit_holds_v1e_reserve_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_holds_v1e
    ADD CONSTRAINT driver_cash_credit_holds_v1e_reserve_event_id_key UNIQUE (reserve_event_id);


--
-- Name: driver_cash_credit_holds_v1e driver_cash_credit_holds_v1e_resolution_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_holds_v1e
    ADD CONSTRAINT driver_cash_credit_holds_v1e_resolution_event_id_key UNIQUE (resolution_event_id);


--
-- Name: driver_earnings driver_earnings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_earnings
    ADD CONSTRAINT driver_earnings_pkey PRIMARY KEY (id);


--
-- Name: errand_funding errand_funding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.errand_funding
    ADD CONSTRAINT errand_funding_pkey PRIMARY KEY (id);


--
-- Name: job_completion_secrets job_completion_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_completion_secrets
    ADD CONSTRAINT job_completion_secrets_pkey PRIMARY KEY (job_id);


--
-- Name: job_funding_breakdown job_funding_breakdown_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_funding_breakdown
    ADD CONSTRAINT job_funding_breakdown_pkey PRIMARY KEY (job_id);


--
-- Name: job_payment_bindings job_payment_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_payment_bindings
    ADD CONSTRAINT job_payment_bindings_pkey PRIMARY KEY (job_id);


--
-- Name: job_payment_bindings job_payment_bindings_provider_merchant_account_ref_payment__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_payment_bindings
    ADD CONSTRAINT job_payment_bindings_provider_merchant_account_ref_payment__key UNIQUE (provider, merchant_account_ref, payment_reference);


--
-- Name: job_refund_allocations job_refund_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_refund_allocations
    ADD CONSTRAINT job_refund_allocations_pkey PRIMARY KEY (id);


--
-- Name: job_refund_allocations job_refund_allocations_provider_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_refund_allocations
    ADD CONSTRAINT job_refund_allocations_provider_ref_key UNIQUE (provider_ref);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: market_availability market_availability_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_availability
    ADD CONSTRAINT market_availability_pkey PRIMARY KEY (id);


--
-- Name: market_payment_route_audit market_payment_route_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_payment_route_audit
    ADD CONSTRAINT market_payment_route_audit_pkey PRIMARY KEY (id);


--
-- Name: market_payment_routes market_payment_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_payment_routes
    ADD CONSTRAINT market_payment_routes_pkey PRIMARY KEY (id);


--
-- Name: marketplace_negotiation_sessions marketplace_negotiation_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_negotiation_sessions
    ADD CONSTRAINT marketplace_negotiation_sessions_pkey PRIMARY KEY (id);


--
-- Name: payment_card_consents payment_card_consents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_card_consents
    ADD CONSTRAINT payment_card_consents_pkey PRIMARY KEY (job_id);


--
-- Name: payment_checkout_attempts payment_checkout_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_checkout_attempts
    ADD CONSTRAINT payment_checkout_attempts_pkey PRIMARY KEY (reference);


--
-- Name: payment_customers payment_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_customers
    ADD CONSTRAINT payment_customers_pkey PRIMARY KEY (user_id, provider, merchant_account_ref);


--
-- Name: payment_customers payment_customers_provider_merchant_account_ref_customer_re_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_customers
    ADD CONSTRAINT payment_customers_provider_merchant_account_ref_customer_re_key UNIQUE (provider, merchant_account_ref, customer_reference);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: referral_driver_progress referral_driver_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_driver_progress
    ADD CONSTRAINT referral_driver_progress_pkey PRIMARY KEY (job_id);


--
-- Name: referrals referrals_campaign_id_referee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_campaign_id_referee_id_key UNIQUE (campaign_id, referee_id);


--
-- Name: referrals referrals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_pkey PRIMARY KEY (id);


--
-- Name: reward_credit_spends reward_credit_spends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reward_credit_spends
    ADD CONSTRAINT reward_credit_spends_pkey PRIMARY KEY (id);


--
-- Name: reward_credits reward_credits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reward_credits
    ADD CONSTRAINT reward_credits_pkey PRIMARY KEY (id);


--
-- Name: service_types service_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_types
    ADD CONSTRAINT service_types_pkey PRIMARY KEY (id);


--
-- Name: vehicles vehicles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_pkey PRIMARY KEY (id);


--
-- Name: wallet_accounts wallet_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_accounts
    ADD CONSTRAINT wallet_accounts_pkey PRIMARY KEY (id);


--
-- Name: wallet_accounts wallet_accounts_scope_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_accounts
    ADD CONSTRAINT wallet_accounts_scope_unique UNIQUE NULLS NOT DISTINCT (tenant_id, owner_id, currency_code, balance_purpose);


--
-- Name: wallet_business_events wallet_business_events_event_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_business_events
    ADD CONSTRAINT wallet_business_events_event_key_key UNIQUE (event_key);


--
-- Name: wallet_business_events wallet_business_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_business_events
    ADD CONSTRAINT wallet_business_events_pkey PRIMARY KEY (id);


--
-- Name: wallet_collection_config wallet_collection_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_collection_config
    ADD CONSTRAINT wallet_collection_config_pkey PRIMARY KEY (key);


--
-- Name: wallet_movements wallet_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_movements
    ADD CONSTRAINT wallet_movements_pkey PRIMARY KEY (id);


--
-- Name: wallet_topup_attempts wallet_topup_attempts_attempt_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_topup_attempts
    ADD CONSTRAINT wallet_topup_attempts_attempt_key_key UNIQUE (attempt_key);


--
-- Name: wallet_topup_attempts wallet_topup_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_topup_attempts
    ADD CONSTRAINT wallet_topup_attempts_pkey PRIMARY KEY (id);


--
-- Name: wallet_topup_verifications wallet_topup_verifications_evidence_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_topup_verifications
    ADD CONSTRAINT wallet_topup_verifications_evidence_key_key UNIQUE (evidence_key);


--
-- Name: wallet_topup_verifications wallet_topup_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_topup_verifications
    ADD CONSTRAINT wallet_topup_verifications_pkey PRIMARY KEY (id);


--
-- Name: wallet_transactions wallet_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_transactions
    ADD CONSTRAINT wallet_transactions_pkey PRIMARY KEY (id);


--
-- Name: wallets wallets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_pkey PRIMARY KEY (user_id);


--
-- Name: campaigns_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaigns_scope ON public.campaigns USING btree (tenant_id, market_code, service_slug, enabled);


--
-- Name: cda_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cda_customer ON public.campaign_discount_applications USING btree (campaign_id, customer_id, status);


--
-- Name: cp_market; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cp_market ON public.cancellation_policies USING btree (tenant_id, market_code, enabled, version DESC);


--
-- Name: cr_customer_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cr_customer_open ON public.customer_receivables USING btree (customer_id, status) WHERE (status = ANY (ARRAY['open'::text, 'disputed'::text]));


--
-- Name: cr_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cr_tenant ON public.customer_receivables USING btree (tenant_id, status, created_at DESC);


--
-- Name: customer_receivables_ref_binding_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX customer_receivables_ref_binding_uniq ON public.customer_receivables USING btree (COALESCE(payment_provider, ''::text), COALESCE(merchant_account_ref, ''::text), payment_reference) WHERE (payment_reference IS NOT NULL);


--
-- Name: driver_cash_credit_holds_scope_v1e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX driver_cash_credit_holds_scope_v1e ON public.driver_cash_credit_holds_v1e USING btree (tenant_id, driver_id, currency_code, status);


--
-- Name: holds_one_active_per_job; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX holds_one_active_per_job ON public.driver_cash_credit_holds_v1e USING btree (job_id) WHERE (status = 'held'::text);


--
-- Name: idx_wallet_transactions_stripe_pi_topup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_wallet_transactions_stripe_pi_topup ON public.wallet_transactions USING btree (stripe_payment_intent_id) WHERE ((type = 'topup'::text) AND (stripe_payment_intent_id IS NOT NULL));


--
-- Name: market_payment_routes_identity_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX market_payment_routes_identity_unique ON public.market_payment_routes USING btree (country_code, currency_code, method, provider, merchant_account_ref) WHERE (merchant_account_ref IS NOT NULL);


--
-- Name: market_payment_routes_preferred_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX market_payment_routes_preferred_unique ON public.market_payment_routes USING btree (country_code, currency_code, method) WHERE preferred;


--
-- Name: rcs_active_per_credit_job; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX rcs_active_per_credit_job ON public.reward_credit_spends USING btree (credit_id, job_id) WHERE (status = 'reserved'::text);


--
-- Name: rcs_one_active_per_job; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX rcs_one_active_per_job ON public.reward_credit_spends USING btree (job_id) WHERE (status = 'reserved'::text);


--
-- Name: referrals_referrer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX referrals_referrer ON public.referrals USING btree (tenant_id, referrer_id, status);


--
-- Name: wallet_business_events_owner_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_business_events_owner_scope ON public.wallet_business_events USING btree (tenant_id, owner_id, currency_code);


--
-- Name: wallet_business_events_reversal_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallet_business_events_reversal_unique ON public.wallet_business_events USING btree (reverses_event_id) WHERE (reverses_event_id IS NOT NULL);


--
-- Name: wallet_movements_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_movements_account_id ON public.wallet_movements USING btree (account_id);


--
-- Name: wallet_movements_event_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_movements_event_id ON public.wallet_movements USING btree (event_id);


--
-- Name: wallet_one_job_settlement; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallet_one_job_settlement ON public.wallet_transactions USING btree (job_id, user_id) WHERE ((transaction_type = 'settlement'::text) AND (job_id IS NOT NULL));


--
-- Name: wallet_topup_attempts_credit_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallet_topup_attempts_credit_unique ON public.wallet_topup_attempts USING btree (credited_event_id) WHERE (credited_event_id IS NOT NULL);


--
-- Name: wallet_topup_attempts_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_topup_attempts_owner ON public.wallet_topup_attempts USING btree (tenant_id, owner_id, currency_code);


--
-- Name: wallet_topup_attempts_provider_reference_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallet_topup_attempts_provider_reference_unique ON public.wallet_topup_attempts USING btree (payment_provider, merchant_account_ref, provider_reference) WHERE (provider_reference IS NOT NULL);


--
-- Name: wallet_transactions_event_key_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallet_transactions_event_key_uniq ON public.wallet_transactions USING btree (event_key) WHERE (event_key IS NOT NULL);


--
-- Name: market_payment_routes audit_market_payment_route_v23; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_market_payment_route_v23 AFTER INSERT OR UPDATE ON public.market_payment_routes FOR EACH ROW EXECUTE FUNCTION public.audit_market_payment_route_v23();


--
-- Name: jobs enforce_driver_market_jobs_v23; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enforce_driver_market_jobs_v23 BEFORE INSERT OR UPDATE OF driver_id, accepted_driver_id, country_code, tenant_id, status, metadata ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.enforce_driver_job_market_v23('driver_id', 'accepted_driver_id');


--
-- Name: marketplace_negotiation_sessions enforce_driver_market_negotiation_v23; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enforce_driver_market_negotiation_v23 BEFORE INSERT OR UPDATE OF active_driver_id, job_id ON public.marketplace_negotiation_sessions FOR EACH ROW EXECUTE FUNCTION public.enforce_driver_job_market_v23('active_driver_id');


--
-- Name: jobs enforce_job_vehicle_category_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enforce_job_vehicle_category_trigger BEFORE INSERT OR UPDATE OF driver_id, accepted_driver_id ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.enforce_job_vehicle_category();


--
-- Name: jobs enforce_ride_cash_credit_v1e; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enforce_ride_cash_credit_v1e AFTER INSERT OR UPDATE OF driver_id, accepted_driver_id, status, payment_method, payment_intent_id, metadata, fare_breakdown, tenant_id, country_code, currency_code ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.enforce_ride_cash_credit_v1e();


--
-- Name: driver_cash_credit_holds_v1e guard_cash_credit_hold_v1e; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_cash_credit_hold_v1e BEFORE DELETE OR UPDATE ON public.driver_cash_credit_holds_v1e FOR EACH ROW EXECUTE FUNCTION public.guard_cash_credit_hold_v1e();


--
-- Name: market_payment_routes guard_market_payment_route_v23; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_market_payment_route_v23 BEFORE INSERT OR DELETE OR UPDATE ON public.market_payment_routes FOR EACH ROW EXECUTE FUNCTION public.guard_market_payment_route_v23();


--
-- Name: profiles on_profile_created_wallet; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER on_profile_created_wallet AFTER INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_wallet();


--
-- Name: profiles protect_driver_operating_market_v23; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER protect_driver_operating_market_v23 BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.protect_driver_operating_market_v23();


--
-- Name: customer_receivables receivable_reference_binding; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER receivable_reference_binding BEFORE INSERT OR UPDATE OF payment_reference, payment_provider, merchant_account_ref ON public.customer_receivables FOR EACH ROW EXECUTE FUNCTION public.enforce_receivable_reference_binding();


--
-- Name: jobs reward_credit_lifecycle; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reward_credit_lifecycle AFTER UPDATE OF status, payment_status ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.enforce_reward_credit_lifecycle();


--
-- Name: jobs reward_credit_reserve; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reward_credit_reserve AFTER INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.reserve_job_reward_credit();


--
-- Name: wallet_business_events serialize_cash_credit_ledger_v1e; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER serialize_cash_credit_ledger_v1e BEFORE INSERT ON public.wallet_business_events FOR EACH ROW EXECUTE FUNCTION public.serialize_cash_credit_ledger_v1e();


--
-- Name: jobs trg_enforce_job_payment_eligibility; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_enforce_job_payment_eligibility BEFORE UPDATE OF driver_id, status ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.enforce_job_payment_eligibility();


--
-- Name: wallet_accounts wallet_accounts_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_accounts_append_only BEFORE DELETE OR UPDATE ON public.wallet_accounts FOR EACH ROW EXECUTE FUNCTION public.wallet_ledger_append_only();


--
-- Name: wallet_business_events wallet_business_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_business_events_append_only BEFORE DELETE OR UPDATE ON public.wallet_business_events FOR EACH ROW EXECUTE FUNCTION public.wallet_ledger_append_only();


--
-- Name: wallet_movements wallet_movements_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_movements_append_only BEFORE DELETE OR UPDATE ON public.wallet_movements FOR EACH ROW EXECUTE FUNCTION public.wallet_ledger_append_only();


--
-- Name: wallet_topup_attempts wallet_topup_attempt_freeze; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_topup_attempt_freeze BEFORE UPDATE ON public.wallet_topup_attempts FOR EACH ROW EXECUTE FUNCTION public.wallet_topup_attempt_freeze();


--
-- Name: jobs zz_job_funding_breakdown_record; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_job_funding_breakdown_record AFTER INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.record_job_funding_breakdown();


--
-- Name: campaign_discount_applications campaign_discount_applications_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_discount_applications
    ADD CONSTRAINT campaign_discount_applications_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id);


--
-- Name: driver_cash_credit_enrolments_v1e driver_cash_credit_enrolments_v1e_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_enrolments_v1e
    ADD CONSTRAINT driver_cash_credit_enrolments_v1e_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.profiles(id);


--
-- Name: driver_cash_credit_holds_v1e driver_cash_credit_holds_v1e_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_holds_v1e
    ADD CONSTRAINT driver_cash_credit_holds_v1e_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.profiles(id);


--
-- Name: driver_cash_credit_holds_v1e driver_cash_credit_holds_v1e_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_holds_v1e
    ADD CONSTRAINT driver_cash_credit_holds_v1e_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: driver_cash_credit_holds_v1e driver_cash_credit_holds_v1e_reserve_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_holds_v1e
    ADD CONSTRAINT driver_cash_credit_holds_v1e_reserve_event_id_fkey FOREIGN KEY (reserve_event_id) REFERENCES public.wallet_business_events(id);


--
-- Name: driver_cash_credit_holds_v1e driver_cash_credit_holds_v1e_resolution_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_cash_credit_holds_v1e
    ADD CONSTRAINT driver_cash_credit_holds_v1e_resolution_event_id_fkey FOREIGN KEY (resolution_event_id) REFERENCES public.wallet_business_events(id);


--
-- Name: errand_funding errand_funding_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.errand_funding
    ADD CONSTRAINT errand_funding_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: errand_funding errand_funding_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.errand_funding
    ADD CONSTRAINT errand_funding_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: job_completion_secrets job_completion_secrets_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_completion_secrets
    ADD CONSTRAINT job_completion_secrets_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: job_funding_breakdown job_funding_breakdown_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_funding_breakdown
    ADD CONSTRAINT job_funding_breakdown_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: job_payment_bindings job_payment_bindings_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_payment_bindings
    ADD CONSTRAINT job_payment_bindings_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE RESTRICT;


--
-- Name: job_refund_allocations job_refund_allocations_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_refund_allocations
    ADD CONSTRAINT job_refund_allocations_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id);


--
-- Name: market_payment_route_audit market_payment_route_audit_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_payment_route_audit
    ADD CONSTRAINT market_payment_route_audit_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.market_payment_routes(id);


--
-- Name: payment_card_consents payment_card_consents_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_card_consents
    ADD CONSTRAINT payment_card_consents_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: payment_card_consents payment_card_consents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_card_consents
    ADD CONSTRAINT payment_card_consents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: payment_customers payment_customers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_customers
    ADD CONSTRAINT payment_customers_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: referral_driver_progress referral_driver_progress_referral_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_driver_progress
    ADD CONSTRAINT referral_driver_progress_referral_id_fkey FOREIGN KEY (referral_id) REFERENCES public.referrals(id) ON DELETE CASCADE;


--
-- Name: referrals referrals_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id);


--
-- Name: reward_credit_spends reward_credit_spends_credit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reward_credit_spends
    ADD CONSTRAINT reward_credit_spends_credit_id_fkey FOREIGN KEY (credit_id) REFERENCES public.reward_credits(id);


--
-- Name: wallet_business_events wallet_business_events_reverses_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_business_events
    ADD CONSTRAINT wallet_business_events_reverses_event_id_fkey FOREIGN KEY (reverses_event_id) REFERENCES public.wallet_business_events(id);


--
-- Name: wallet_movements wallet_movements_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_movements
    ADD CONSTRAINT wallet_movements_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.wallet_accounts(id);


--
-- Name: wallet_movements wallet_movements_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_movements
    ADD CONSTRAINT wallet_movements_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.wallet_business_events(id) ON DELETE RESTRICT;


--
-- Name: wallet_topup_attempts wallet_topup_attempts_credited_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_topup_attempts
    ADD CONSTRAINT wallet_topup_attempts_credited_event_id_fkey FOREIGN KEY (credited_event_id) REFERENCES public.wallet_business_events(id);


--
-- Name: wallet_topup_verifications wallet_topup_verifications_attempt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_topup_verifications
    ADD CONSTRAINT wallet_topup_verifications_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES public.wallet_topup_attempts(id);


--
-- Name: wallets wallets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: job_completion_secrets Customers can view own completion pin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Customers can view own completion pin" ON public.job_completion_secrets FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = job_completion_secrets.job_id) AND (j.customer_id = auth.uid())))));


--
-- Name: errand_funding Drivers can view funding for assigned jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can view funding for assigned jobs" ON public.errand_funding FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.jobs
  WHERE ((jobs.id = errand_funding.job_id) AND (jobs.driver_id = auth.uid())))));


--
-- Name: errand_funding Users can view their own errand funding; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own errand funding" ON public.errand_funding FOR SELECT USING ((auth.uid() = customer_id));


--
-- Name: wallets Users can view their own wallet; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own wallet" ON public.wallets FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: driver_earnings batch1d_client_no_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_delete ON public.driver_earnings AS RESTRICTIVE FOR DELETE TO anon, authenticated USING (false);


--
-- Name: wallet_transactions batch1d_client_no_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_delete ON public.wallet_transactions AS RESTRICTIVE FOR DELETE TO anon, authenticated USING (false);


--
-- Name: wallets batch1d_client_no_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_delete ON public.wallets AS RESTRICTIVE FOR DELETE TO anon, authenticated USING (false);


--
-- Name: driver_earnings batch1d_client_no_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_insert ON public.driver_earnings AS RESTRICTIVE FOR INSERT TO anon, authenticated WITH CHECK (false);


--
-- Name: wallet_transactions batch1d_client_no_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_insert ON public.wallet_transactions AS RESTRICTIVE FOR INSERT TO anon, authenticated WITH CHECK (false);


--
-- Name: wallets batch1d_client_no_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_insert ON public.wallets AS RESTRICTIVE FOR INSERT TO anon, authenticated WITH CHECK (false);


--
-- Name: driver_earnings batch1d_client_no_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_update ON public.driver_earnings AS RESTRICTIVE FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);


--
-- Name: wallet_transactions batch1d_client_no_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_update ON public.wallet_transactions AS RESTRICTIVE FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);


--
-- Name: wallets batch1d_client_no_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY batch1d_client_no_update ON public.wallets AS RESTRICTIVE FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);


--
-- Name: campaign_discount_applications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaign_discount_applications ENABLE ROW LEVEL SECURITY;

--
-- Name: campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

--
-- Name: campaigns campaigns_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY campaigns_service ON public.campaigns USING (((auth.jwt() ->> 'role'::text) = 'service_role'::text));


--
-- Name: cancellation_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cancellation_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: campaign_discount_applications cda_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cda_owner ON public.campaign_discount_applications FOR SELECT USING (((customer_id = auth.uid()) OR ((auth.jwt() ->> 'role'::text) = 'service_role'::text)));


--
-- Name: campaign_discount_applications cda_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cda_service ON public.campaign_discount_applications USING (((auth.jwt() ->> 'role'::text) = 'service_role'::text));


--
-- Name: cancellation_policies cp_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cp_service ON public.cancellation_policies USING (((auth.jwt() ->> 'role'::text) = 'service_role'::text));


--
-- Name: customer_receivables cr_owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cr_owner_read ON public.customer_receivables FOR SELECT USING (((customer_id = auth.uid()) OR ((auth.jwt() ->> 'role'::text) = 'service_role'::text)));


--
-- Name: customer_receivables; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_receivables ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_cash_credit_config_v1e; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_cash_credit_config_v1e ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_cash_credit_enrolments_v1e; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_cash_credit_enrolments_v1e ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_cash_credit_holds_v1e; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_cash_credit_holds_v1e ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_earnings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_earnings ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_earnings driver_earnings_anonymous_read_v23; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY driver_earnings_anonymous_read_v23 ON public.driver_earnings AS RESTRICTIVE FOR SELECT TO anon USING (false);


--
-- Name: driver_earnings driver_earnings_owner_read_v23; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY driver_earnings_owner_read_v23 ON public.driver_earnings AS RESTRICTIVE FOR SELECT TO authenticated USING (public.driver_can_read_earnings_v23(driver_id));


--
-- Name: jobs driver_jobs_anonymous_read_v23; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY driver_jobs_anonymous_read_v23 ON public.jobs AS RESTRICTIVE FOR SELECT TO anon USING (false);


--
-- Name: jobs driver_market_jobs_read_v23; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY driver_market_jobs_read_v23 ON public.jobs AS RESTRICTIVE FOR SELECT TO authenticated USING (public.driver_can_read_job_market_v23(to_jsonb(jobs.*)));


--
-- Name: errand_funding; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.errand_funding ENABLE ROW LEVEL SECURITY;

--
-- Name: job_completion_secrets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_completion_secrets ENABLE ROW LEVEL SECURITY;

--
-- Name: job_funding_breakdown; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_funding_breakdown ENABLE ROW LEVEL SECURITY;

--
-- Name: job_payment_bindings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_payment_bindings ENABLE ROW LEVEL SECURITY;

--
-- Name: job_refund_allocations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_refund_allocations ENABLE ROW LEVEL SECURITY;

--
-- Name: jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: market_payment_route_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.market_payment_route_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: market_payment_routes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.market_payment_routes ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_card_consents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_card_consents ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_checkout_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_checkout_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_customers ENABLE ROW LEVEL SECURITY;

--
-- Name: referral_driver_progress; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.referral_driver_progress ENABLE ROW LEVEL SECURITY;

--
-- Name: referrals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

--
-- Name: referrals referrals_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY referrals_owner ON public.referrals FOR SELECT USING (((referrer_id = auth.uid()) OR (referee_id = auth.uid()) OR ((auth.jwt() ->> 'role'::text) = 'service_role'::text)));


--
-- Name: referrals referrals_service_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY referrals_service_write ON public.referrals USING (((auth.jwt() ->> 'role'::text) = 'service_role'::text));


--
-- Name: reward_credit_spends; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reward_credit_spends ENABLE ROW LEVEL SECURITY;

--
-- Name: reward_credits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reward_credits ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallet_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_accounts wallet_accounts_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wallet_accounts_select_own ON public.wallet_accounts FOR SELECT TO authenticated USING ((owner_id = auth.uid()));


--
-- Name: wallet_business_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallet_business_events ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_business_events wallet_business_events_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wallet_business_events_select_own ON public.wallet_business_events FOR SELECT TO authenticated USING ((owner_id = auth.uid()));


--
-- Name: wallet_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallet_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_movements wallet_movements_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wallet_movements_select_own ON public.wallet_movements FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.wallet_accounts a
  WHERE ((a.id = wallet_movements.account_id) AND (a.owner_id = auth.uid())))));


--
-- Name: wallet_topup_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallet_topup_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_topup_attempts wallet_topup_attempts_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wallet_topup_attempts_select_own ON public.wallet_topup_attempts FOR SELECT TO authenticated USING ((owner_id = auth.uid()));


--
-- Name: wallet_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: wallets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;

--
-- Name: TABLE cancellation_policies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.cancellation_policies TO service_role;


--
-- Name: FUNCTION active_cancellation_policy(p_tenant uuid, p_market text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.active_cancellation_policy(p_tenant uuid, p_market text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.active_cancellation_policy(p_tenant uuid, p_market text) TO service_role;


--
-- Name: TABLE campaign_discount_applications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.campaign_discount_applications TO service_role;


--
-- Name: FUNCTION apply_campaign_discount(p_campaign uuid, p_customer uuid, p_quote text, p_fare_minor bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_campaign_discount(p_campaign uuid, p_customer uuid, p_quote text, p_fare_minor bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_campaign_discount(p_campaign uuid, p_customer uuid, p_quote text, p_fare_minor bigint) TO service_role;


--
-- Name: FUNCTION apply_job_refund(p_job uuid, p_external_minor bigint, p_ref text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_job_refund(p_job uuid, p_external_minor bigint, p_ref text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_job_refund(p_job uuid, p_external_minor bigint, p_ref text) TO service_role;


--
-- Name: FUNCTION apply_job_refund(p_job uuid, p_service_minor bigint, p_external_minor bigint, p_ref text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_job_refund(p_job uuid, p_service_minor bigint, p_external_minor bigint, p_ref text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_job_refund(p_job uuid, p_service_minor bigint, p_external_minor bigint, p_ref text) TO service_role;


--
-- Name: TABLE reward_credit_spends; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.reward_credit_spends TO service_role;
GRANT SELECT ON TABLE public.reward_credit_spends TO authenticated;


--
-- Name: FUNCTION apply_reward_credit(p_credit uuid, p_job uuid, p_amount_minor bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_reward_credit(p_credit uuid, p_job uuid, p_amount_minor bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_reward_credit(p_credit uuid, p_job uuid, p_amount_minor bigint) TO service_role;


--
-- Name: FUNCTION approve_errand_over_budget(p_job_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.approve_errand_over_budget(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.approve_errand_over_budget(p_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.approve_errand_over_budget(p_job_id uuid) TO service_role;


--
-- Name: FUNCTION audit_market_payment_route_v23(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.audit_market_payment_route_v23() FROM PUBLIC;


--
-- Name: FUNCTION campaign_spend(p_campaign uuid, p_amount bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.campaign_spend(p_campaign uuid, p_amount bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.campaign_spend(p_campaign uuid, p_amount bigint) TO service_role;


--
-- Name: FUNCTION cancel_campaign_application(p_campaign uuid, p_customer uuid, p_quote text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cancel_campaign_application(p_campaign uuid, p_customer uuid, p_quote text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cancel_campaign_application(p_campaign uuid, p_customer uuid, p_quote text) TO service_role;


--
-- Name: FUNCTION cancel_job_safely(p_job_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cancel_job_safely(p_job_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cancel_job_safely(p_job_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION cash_credit_minor_v1e(v jsonb, c text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cash_credit_minor_v1e(v jsonb, c text) FROM PUBLIC;


--
-- Name: FUNCTION cash_credit_service_writer_v1e(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cash_credit_service_writer_v1e() FROM PUBLIC;


--
-- Name: FUNCTION cash_credit_terms_v1e(b jsonb, c text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cash_credit_terms_v1e(b jsonb, c text) FROM PUBLIC;


--
-- Name: FUNCTION claim_wallet_topup_submission(p_attempt_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_wallet_topup_submission(p_attempt_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_wallet_topup_submission(p_attempt_id uuid) TO service_role;


--
-- Name: FUNCTION confirm_wallet_topup(p_attempt_id uuid, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.confirm_wallet_topup(p_attempt_id uuid, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.confirm_wallet_topup(p_attempt_id uuid, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text) TO service_role;


--
-- Name: FUNCTION credit_wallet_topup(p_user_id uuid, p_amount numeric, p_currency_code text, p_stripe_payment_intent_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.credit_wallet_topup(p_user_id uuid, p_amount numeric, p_currency_code text, p_stripe_payment_intent_id text) FROM PUBLIC;


--
-- Name: FUNCTION credit_wallet_topup(p_user_id uuid, p_amount numeric, p_payment_intent_id text, p_currency_code text, p_metadata jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.credit_wallet_topup(p_user_id uuid, p_amount numeric, p_payment_intent_id text, p_currency_code text, p_metadata jsonb) FROM PUBLIC;


--
-- Name: FUNCTION customer_accept_driver_counter(p_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_accept_driver_counter(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_accept_driver_counter(p_session_id uuid) TO authenticated;


--
-- Name: FUNCTION customer_cancel_offer(p_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_cancel_offer(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_cancel_offer(p_session_id uuid) TO authenticated;


--
-- Name: FUNCTION customer_expire_unpaid_agreement(p_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_expire_unpaid_agreement(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_expire_unpaid_agreement(p_session_id uuid) TO authenticated;


--
-- Name: FUNCTION customer_open_debt_minor(p_customer uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.customer_open_debt_minor(p_customer uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.customer_open_debt_minor(p_customer uuid) TO service_role;


--
-- Name: FUNCTION driver_accept_customer_offer(p_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_accept_customer_offer(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_accept_customer_offer(p_session_id uuid) TO authenticated;


--
-- Name: FUNCTION driver_can_read_earnings_v23(driver uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_can_read_earnings_v23(driver uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_can_read_earnings_v23(driver uuid) TO authenticated;
GRANT ALL ON FUNCTION public.driver_can_read_earnings_v23(driver uuid) TO service_role;


--
-- Name: FUNCTION driver_can_read_job_market_v23(j jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_can_read_job_market_v23(j jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_can_read_job_market_v23(j jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.driver_can_read_job_market_v23(j jsonb) TO service_role;


--
-- Name: FUNCTION driver_cash_credit_balance_v1e(t uuid, d uuid, c text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_cash_credit_balance_v1e(t uuid, d uuid, c text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_cash_credit_balance_v1e(t uuid, d uuid, c text) TO service_role;


--
-- Name: FUNCTION driver_cash_credit_enabled_v1e(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_cash_credit_enabled_v1e() FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_cash_credit_enabled_v1e() TO service_role;


--
-- Name: FUNCTION driver_cash_credit_lock_v1e(t uuid, d uuid, c text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_cash_credit_lock_v1e(t uuid, d uuid, c text) FROM PUBLIC;


--
-- Name: FUNCTION driver_cash_credit_status_v1f(p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_cash_credit_status_v1f(p_driver_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_cash_credit_status_v1f(p_driver_id uuid) TO service_role;


--
-- Name: FUNCTION driver_job_market_matches_v23(p jsonb, j jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.driver_job_market_matches_v23(p jsonb, j jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.driver_job_market_matches_v23(p jsonb, j jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.driver_job_market_matches_v23(p jsonb, j jsonb) TO service_role;


--
-- Name: TABLE referrals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.referrals TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.referrals TO service_role;


--
-- Name: FUNCTION earn_referral(p_referral uuid, p_job uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.earn_referral(p_referral uuid, p_job uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.earn_referral(p_referral uuid, p_job uuid) TO service_role;


--
-- Name: FUNCTION end_job_driver_search(p_job_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.end_job_driver_search(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.end_job_driver_search(p_job_id uuid) TO service_role;


--
-- Name: FUNCTION enforce_driver_job_market_v23(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_driver_job_market_v23() FROM PUBLIC;


--
-- Name: FUNCTION enforce_ride_cash_credit_v1e(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_ride_cash_credit_v1e() FROM PUBLIC;


--
-- Name: FUNCTION expire_reward_credits(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.expire_reward_credits() TO service_role;


--
-- Name: FUNCTION expire_unpaid_fare_agreement(p_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.expire_unpaid_fare_agreement(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.expire_unpaid_fare_agreement(p_session_id uuid) TO service_role;


--
-- Name: FUNCTION fetch_hybrid_opportunities(p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.fetch_hybrid_opportunities(p_driver_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.fetch_hybrid_opportunities(p_driver_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.fetch_hybrid_opportunities(p_driver_id uuid) TO service_role;


--
-- Name: FUNCTION finalize_job_payment(p_job_id uuid, p_payment_intent_id text, p_payment_status text, p_job_status text, p_expected_service_fare numeric, p_require_unowned boolean, p_dispatch_started_at timestamp with time zone, p_driver_search_expires_at timestamp with time zone, p_dispatch_attempts integer, p_intent_amount_minor bigint, p_currency text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_job_payment(p_job_id uuid, p_payment_intent_id text, p_payment_status text, p_job_status text, p_expected_service_fare numeric, p_require_unowned boolean, p_dispatch_started_at timestamp with time zone, p_driver_search_expires_at timestamp with time zone, p_dispatch_attempts integer, p_intent_amount_minor bigint, p_currency text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_job_payment(p_job_id uuid, p_payment_intent_id text, p_payment_status text, p_job_status text, p_expected_service_fare numeric, p_require_unowned boolean, p_dispatch_started_at timestamp with time zone, p_driver_search_expires_at timestamp with time zone, p_dispatch_attempts integer, p_intent_amount_minor bigint, p_currency text) TO service_role;


--
-- Name: FUNCTION finalize_wallet_topup(p_amount numeric, p_description text, p_payment_intent_id text, p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_wallet_topup(p_amount numeric, p_description text, p_payment_intent_id text, p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_wallet_topup(p_amount numeric, p_description text, p_payment_intent_id text, p_user_id uuid) TO service_role;


--
-- Name: FUNCTION finalize_wallet_topup_legacy_incompatible(p_user_id uuid, p_amount numeric, p_payment_intent_id text, p_description text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_wallet_topup_legacy_incompatible(p_user_id uuid, p_amount numeric, p_payment_intent_id text, p_description text) FROM PUBLIC;


--
-- Name: TABLE driver_cash_credit_holds_v1e; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.driver_cash_credit_holds_v1e TO service_role;


--
-- Name: FUNCTION flag_cash_hold_review_v1f(p_job uuid, p_disputed_minor bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.flag_cash_hold_review_v1f(p_job uuid, p_disputed_minor bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.flag_cash_hold_review_v1f(p_job uuid, p_disputed_minor bigint) TO service_role;


--
-- Name: FUNCTION guard_cash_credit_hold_v1e(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.guard_cash_credit_hold_v1e() FROM PUBLIC;


--
-- Name: FUNCTION guard_market_payment_route_v23(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.guard_market_payment_route_v23() FROM PUBLIC;


--
-- Name: FUNCTION initiate_wallet_topup(p_attempt_key text, p_tenant_id uuid, p_owner_id uuid, p_country_code text, p_currency_code text, p_amount_minor bigint, p_destination_account_purpose text, p_payment_provider text, p_merchant_account_ref text, p_provider_idempotency_identity text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.initiate_wallet_topup(p_attempt_key text, p_tenant_id uuid, p_owner_id uuid, p_country_code text, p_currency_code text, p_amount_minor bigint, p_destination_account_purpose text, p_payment_provider text, p_merchant_account_ref text, p_provider_idempotency_identity text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.initiate_wallet_topup(p_attempt_key text, p_tenant_id uuid, p_owner_id uuid, p_country_code text, p_currency_code text, p_amount_minor bigint, p_destination_account_purpose text, p_payment_provider text, p_merchant_account_ref text, p_provider_idempotency_identity text) TO service_role;


--
-- Name: FUNCTION job_remaining_payable_minor(p_job uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.job_remaining_payable_minor(p_job uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.job_remaining_payable_minor(p_job uuid) TO service_role;


--
-- Name: FUNCTION mark_wallet_topup_failed(p_attempt_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_wallet_topup_failed(p_attempt_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_wallet_topup_failed(p_attempt_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION mark_wallet_topup_refunded(p_attempt_id uuid, p_evidence_reference text, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_wallet_topup_refunded(p_attempt_id uuid, p_evidence_reference text, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_wallet_topup_refunded(p_attempt_id uuid, p_evidence_reference text, p_verified_provider_reference text, p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint, p_final_status text, p_reason text) TO service_role;


--
-- Name: FUNCTION mark_wallet_topup_uncertain(p_attempt_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_wallet_topup_uncertain(p_attempt_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_wallet_topup_uncertain(p_attempt_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION pay_job_from_wallet(p_job_id uuid, p_customer_id uuid, p_amount numeric, p_currency_code text, p_tenant_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pay_job_from_wallet(p_job_id uuid, p_customer_id uuid, p_amount numeric, p_currency_code text, p_tenant_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.pay_job_from_wallet(p_job_id uuid, p_customer_id uuid, p_amount numeric, p_currency_code text, p_tenant_id uuid) TO service_role;


--
-- Name: FUNCTION post_wallet_event(p_event_key text, p_operation text, p_tenant_id uuid, p_owner_id uuid, p_currency_code text, p_entries jsonb, p_payment_provider text, p_merchant_account_ref text, p_provider_reference text, p_reverses_event_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.post_wallet_event(p_event_key text, p_operation text, p_tenant_id uuid, p_owner_id uuid, p_currency_code text, p_entries jsonb, p_payment_provider text, p_merchant_account_ref text, p_provider_reference text, p_reverses_event_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.post_wallet_event(p_event_key text, p_operation text, p_tenant_id uuid, p_owner_id uuid, p_currency_code text, p_entries jsonb, p_payment_provider text, p_merchant_account_ref text, p_provider_reference text, p_reverses_event_id uuid) TO service_role;


--
-- Name: FUNCTION post_wallet_reversal(p_original_event_key text, p_event_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.post_wallet_reversal(p_original_event_key text, p_event_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.post_wallet_reversal(p_original_event_key text, p_event_key text) TO service_role;


--
-- Name: FUNCTION preview_vaydu_margin(p_fare_snapshot jsonb, p_discount_minor bigint, p_referral_liability_minor bigint, p_processing_minor bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.preview_vaydu_margin(p_fare_snapshot jsonb, p_discount_minor bigint, p_referral_liability_minor bigint, p_processing_minor bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.preview_vaydu_margin(p_fare_snapshot jsonb, p_discount_minor bigint, p_referral_liability_minor bigint, p_processing_minor bigint) TO service_role;


--
-- Name: FUNCTION protect_driver_operating_market_v23(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.protect_driver_operating_market_v23() FROM PUBLIC;


--
-- Name: FUNCTION publish_cancellation_policy(p_tenant uuid, p_market text, p_reference_fare_minor bigint, p_debt_threshold_bps integer, p_grace_seconds integer, p_fee_minor bigint, p_fee_cap_minor bigint, p_compensation_percent numeric, p_created_by uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.publish_cancellation_policy(p_tenant uuid, p_market text, p_reference_fare_minor bigint, p_debt_threshold_bps integer, p_grace_seconds integer, p_fee_minor bigint, p_fee_cap_minor bigint, p_compensation_percent numeric, p_created_by uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.publish_cancellation_policy(p_tenant uuid, p_market text, p_reference_fare_minor bigint, p_debt_threshold_bps integer, p_grace_seconds integer, p_fee_minor bigint, p_fee_cap_minor bigint, p_compensation_percent numeric, p_created_by uuid) TO service_role;


--
-- Name: FUNCTION reassign_cash_job_credit_v1f(p_job uuid, p_new_driver uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reassign_cash_job_credit_v1f(p_job uuid, p_new_driver uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reassign_cash_job_credit_v1f(p_job uuid, p_new_driver uuid) TO service_role;


--
-- Name: FUNCTION reconcile_wallet_topup(p_attempt_id uuid, p_evidence_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reconcile_wallet_topup(p_attempt_id uuid, p_evidence_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reconcile_wallet_topup(p_attempt_id uuid, p_evidence_key text) TO service_role;


--
-- Name: TABLE customer_receivables; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.customer_receivables TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.customer_receivables TO service_role;


--
-- Name: FUNCTION record_customer_receivable(p_tenant uuid, p_customer uuid, p_job uuid, p_currency text, p_amount bigint, p_reason text, p_policy_version integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_customer_receivable(p_tenant uuid, p_customer uuid, p_job uuid, p_currency text, p_amount bigint, p_reason text, p_policy_version integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_customer_receivable(p_tenant uuid, p_customer uuid, p_job uuid, p_currency text, p_amount bigint, p_reason text, p_policy_version integer) TO service_role;


--
-- Name: FUNCTION record_wallet_topup_provider_reference(p_attempt_id uuid, p_provider_reference text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_wallet_topup_provider_reference(p_attempt_id uuid, p_provider_reference text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_wallet_topup_provider_reference(p_attempt_id uuid, p_provider_reference text) TO service_role;


--
-- Name: FUNCTION record_wallet_topup_verification(p_attempt_id uuid, p_evidence_key text, p_provider_reference text, p_merchant_account_ref text, p_currency_code text, p_amount_minor bigint, p_final_status text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_wallet_topup_verification(p_attempt_id uuid, p_evidence_key text, p_provider_reference text, p_merchant_account_ref text, p_currency_code text, p_amount_minor bigint, p_final_status text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_wallet_topup_verification(p_attempt_id uuid, p_evidence_key text, p_provider_reference text, p_merchant_account_ref text, p_currency_code text, p_amount_minor bigint, p_final_status text) TO service_role;


--
-- Name: FUNCTION referral_monthly_count(p_referrer uuid, p_kind text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.referral_monthly_count(p_referrer uuid, p_kind text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.referral_monthly_count(p_referrer uuid, p_kind text) TO service_role;


--
-- Name: FUNCTION reject_errand_over_budget(p_job_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reject_errand_over_budget(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reject_errand_over_budget(p_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.reject_errand_over_budget(p_job_id uuid) TO service_role;


--
-- Name: FUNCTION release_job_wallet_reservation(p_job_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_job_wallet_reservation(p_job_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_job_wallet_reservation(p_job_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION release_referral_rewards(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_referral_rewards() FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_referral_rewards() TO service_role;


--
-- Name: FUNCTION release_reward_credit_spend(p_job uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_reward_credit_spend(p_job uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_reward_credit_spend(p_job uuid) TO service_role;


--
-- Name: FUNCTION request_errand_over_budget(p_job_id uuid, p_amount numeric, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.request_errand_over_budget(p_job_id uuid, p_amount numeric, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_errand_over_budget(p_job_id uuid, p_amount numeric, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.request_errand_over_budget(p_job_id uuid, p_amount numeric, p_reason text) TO service_role;


--
-- Name: FUNCTION reserve_cash_job_credit_v1e(p_job_id uuid, p_driver_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_cash_job_credit_v1e(p_job_id uuid, p_driver_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_cash_job_credit_v1e(p_job_id uuid, p_driver_id uuid) TO service_role;


--
-- Name: FUNCTION reserve_errand_funds(p_job_id uuid, p_customer_id uuid, p_item_budget numeric, p_service_estimate numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_errand_funds(p_job_id uuid, p_customer_id uuid, p_item_budget numeric, p_service_estimate numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_errand_funds(p_job_id uuid, p_customer_id uuid, p_item_budget numeric, p_service_estimate numeric) TO service_role;


--
-- Name: FUNCTION resolve_cash_job_credit_v1e(p_job_id uuid, p_outcome text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.resolve_cash_job_credit_v1e(p_job_id uuid, p_outcome text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.resolve_cash_job_credit_v1e(p_job_id uuid, p_outcome text) TO service_role;


--
-- Name: FUNCTION reverse_reward_credit_spend(p_job uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reverse_reward_credit_spend(p_job uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reverse_reward_credit_spend(p_job uuid) TO service_role;


--
-- Name: FUNCTION reward_credit_available(p_credit uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reward_credit_available(p_credit uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reward_credit_available(p_credit uuid) TO service_role;


--
-- Name: FUNCTION secure_zero_payable_funding(p_job uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.secure_zero_payable_funding(p_job uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.secure_zero_payable_funding(p_job uuid) TO service_role;


--
-- Name: FUNCTION serialize_cash_credit_ledger_v1e(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.serialize_cash_credit_ledger_v1e() FROM PUBLIC;


--
-- Name: FUNCTION settle_errand_funds(p_booking_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.settle_errand_funds(p_booking_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.settle_errand_funds(p_booking_id uuid) TO service_role;


--
-- Name: FUNCTION settle_job_wallet_reservation(p_job_id uuid, p_amount numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.settle_job_wallet_reservation(p_job_id uuid, p_amount numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.settle_job_wallet_reservation(p_job_id uuid, p_amount numeric) TO service_role;


--
-- Name: FUNCTION settle_reward_credit_spend(p_job uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.settle_reward_credit_spend(p_job uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.settle_reward_credit_spend(p_job uuid) TO service_role;


--
-- Name: FUNCTION validate_wallet_integrity(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.validate_wallet_integrity(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.validate_wallet_integrity(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION wallet_collection_enabled(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.wallet_collection_enabled() TO authenticated;
GRANT ALL ON FUNCTION public.wallet_collection_enabled() TO service_role;


--
-- Name: FUNCTION wallet_currency_minor_exponent(p_currency_code text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.wallet_currency_minor_exponent(p_currency_code text) TO authenticated;
GRANT ALL ON FUNCTION public.wallet_currency_minor_exponent(p_currency_code text) TO service_role;


--
-- Name: TABLE campaigns; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.campaigns TO service_role;


--
-- Name: TABLE job_completion_secrets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.job_completion_secrets TO authenticated;


--
-- Name: TABLE job_funding_breakdown; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.job_funding_breakdown TO service_role;


--
-- Name: TABLE job_payment_bindings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.job_payment_bindings TO service_role;


--
-- Name: TABLE job_refund_allocations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.job_refund_allocations TO service_role;


--
-- Name: TABLE market_payment_routes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.market_payment_routes TO service_role;


--
-- Name: TABLE payment_card_consents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payment_card_consents TO service_role;


--
-- Name: TABLE payment_checkout_attempts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.payment_checkout_attempts TO service_role;


--
-- Name: TABLE payment_customers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payment_customers TO service_role;


--
-- Name: TABLE referral_driver_progress; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.referral_driver_progress TO service_role;


--
-- Name: TABLE reward_credits; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.reward_credits TO service_role;
GRANT SELECT ON TABLE public.reward_credits TO authenticated;


--
-- Name: TABLE wallet_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.wallet_accounts TO authenticated;
GRANT SELECT ON TABLE public.wallet_accounts TO service_role;


--
-- Name: TABLE wallet_business_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.wallet_business_events TO authenticated;
GRANT SELECT ON TABLE public.wallet_business_events TO service_role;


--
-- Name: TABLE wallet_collection_config; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.wallet_collection_config TO service_role;


--
-- Name: TABLE wallet_movements; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.wallet_movements TO authenticated;
GRANT SELECT ON TABLE public.wallet_movements TO service_role;


--
-- Name: TABLE wallet_reconciliation_projection; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.wallet_reconciliation_projection TO service_role;


--
-- Name: TABLE wallet_topup_attempts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.wallet_topup_attempts TO authenticated;
GRANT SELECT ON TABLE public.wallet_topup_attempts TO service_role;


--
-- Name: TABLE wallet_topup_verifications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.wallet_topup_verifications TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict jyfKPWrrQfo1Vlx8QQ4yHEMb3rtYOlqvIiCtpOMNxad7DZkqWhj9I77gE3ImPmk

