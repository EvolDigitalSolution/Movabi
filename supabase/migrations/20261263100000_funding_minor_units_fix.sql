-- ============================================================================
-- FUNDING MINOR-UNIT CONVERSION FIX
-- Defect: 20261255900000 cast major-unit money strings straight to bigint:
--   (NEW.fare_breakdown->>'customerCharge')::bigint   -- 6.66 -> 22P02
--   (NEW.agreed_fare*100)::bigint                     -- implicit float/scale
-- Canonical conversion uses the currency minor exponent, rejects excess
-- precision, and never truncates or uses floating-point arithmetic.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.funding_amount_to_minor(p_amount text, p_currency text)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE v_exp integer; v_num numeric;
BEGIN
  IF p_amount IS NULL OR btrim(p_amount)='' THEN RETURN NULL; END IF;
  v_exp := public.wallet_currency_minor_exponent(p_currency);
  IF v_exp IS NULL THEN
    RAISE EXCEPTION 'funding_amount_to_minor: unsupported currency %', p_currency USING ERRCODE='22023';
  END IF;
  v_num := p_amount::numeric;                    -- 22P02 on malformed input
  IF v_num <> round(v_num, v_exp) THEN
    RAISE EXCEPTION 'funding_amount_to_minor: excess precision for % (%)', p_currency, p_amount USING ERRCODE='22003';
  END IF;
  RETURN round(v_num * power(10::numeric, v_exp))::bigint;
END $$;
REVOKE ALL ON FUNCTION public.funding_amount_to_minor(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.funding_amount_to_minor(text,text) TO service_role;

-- 1) Credit reservation at booking creation.
CREATE OR REPLACE FUNCTION public.reserve_job_reward_credit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_credit uuid; v_discount bigint; v_charge bigint; v_payable bigint;
        v_currency text := coalesce(NEW.currency_code,'GBP');
BEGIN
  IF NEW.metadata->>'reward_credit_id' IS NULL THEN RETURN NEW; END IF;
  v_credit := (NEW.metadata->>'reward_credit_id')::uuid;
  v_charge := coalesce(public.funding_amount_to_minor(
                coalesce(NEW.fare_breakdown->>'customerCharge', NEW.agreed_fare::text), v_currency),0);
  v_discount := coalesce((NEW.metadata->>'discount_minor')::bigint,0);
  v_payable := greatest(v_charge - v_discount,0);
  PERFORM apply_reward_credit(v_credit,NEW.id,v_payable);
  RETURN NEW;
END $$;

-- 2) Authoritative remaining payable.
CREATE OR REPLACE FUNCTION public.job_remaining_payable_minor(p_job uuid)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE j jobs; charge bigint; discount bigint; credit bigint;
BEGIN
  SELECT * INTO j FROM jobs WHERE id=p_job;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_missing'; END IF;
  charge := coalesce(public.funding_amount_to_minor(
              coalesce(j.fare_breakdown->>'customerCharge', j.agreed_fare::text),
              coalesce(j.currency_code,'GBP')),0);
  discount := coalesce((j.metadata->>'discount_minor')::bigint,0);
  SELECT coalesce(sum(amount_minor),0) INTO credit
    FROM reward_credit_spends WHERE job_id=p_job AND status='reserved';
  RETURN greatest(charge - discount - credit,0);
END $$;

-- 3) Persisted accepted breakdown.
CREATE OR REPLACE FUNCTION public.record_job_funding_breakdown() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_charge bigint; v_disc bigint; v_credit bigint;
        v_currency text := coalesce(NEW.currency_code,'GBP');
BEGIN
  v_charge := coalesce(public.funding_amount_to_minor(
                coalesce(NEW.fare_breakdown->>'customerCharge', NEW.agreed_fare::text), v_currency),0);
  v_disc := coalesce((NEW.metadata->>'discount_minor')::bigint,0);
  SELECT coalesce(sum(amount_minor),0) INTO v_credit
    FROM reward_credit_spends WHERE job_id=NEW.id AND status='reserved';
  IF v_disc>0 OR v_credit>0 THEN
    INSERT INTO job_funding_breakdown(job_id,tenant_id,currency_code,
      customer_charge_minor,discount_minor,reward_credit_minor,external_due_minor)
    VALUES(NEW.id,NEW.tenant_id,v_currency,v_charge,v_disc,v_credit,
      greatest(v_charge-v_disc-v_credit,0));
  END IF;
  RETURN NEW;
END $$;
