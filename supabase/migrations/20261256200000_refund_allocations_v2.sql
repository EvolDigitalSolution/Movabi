-- ============================================================================
-- JOB REFUND ALLOCATIONS v2 — explicit input semantics.
--   p_service_minor   = service-value being refunded (drives credit share)
--   p_external_minor  = external money the provider CONFIRMED refunded
--   p_ref             = provider refund reference (idempotent)
-- Credit restoration is DERIVED, never taken from a caller amount.
-- A provider amount exceeding capturable remainder is NOT silently clamped:
-- it is clamped AND recorded as a discrepancy for reconciliation.
-- Discount is never refunded as cash; it only affects the credit share
-- denominator (funded vs external split of the charge).
-- ============================================================================
ALTER TABLE job_refund_allocations
  ADD COLUMN IF NOT EXISTS service_minor bigint NOT NULL DEFAULT 0,
  -- provider_confirmed_minor: what the provider event actually refunded.
  -- external_minor: what was allocated against the captured balance.
  -- discrepancy_minor: confirmed-minus-allocated, for reconciliation.
  ADD COLUMN IF NOT EXISTS provider_confirmed_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discrepancy_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'partial';

CREATE OR REPLACE FUNCTION apply_job_refund(
  p_job uuid, p_service_minor bigint, p_external_minor bigint, p_ref text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
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
REVOKE ALL ON FUNCTION apply_job_refund(uuid,bigint,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION apply_job_refund(uuid,bigint,bigint,text) TO service_role;

-- Restored value must actually be re-spendable: available counts
-- reserved+spent spends at their UN-restored remainder. Expiry is still
-- enforced inside apply_reward_credit (restoration never overrides it).
CREATE OR REPLACE FUNCTION reward_credit_available(p_credit uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT greatest(c.amount_minor - coalesce(sum(s.amount_minor - s.restored_minor)
       FILTER(WHERE s.status IN ('reserved','spent')),0),0)::bigint
    FROM reward_credits c
    LEFT JOIN reward_credit_spends s ON s.credit_id=c.id
   WHERE c.id=p_credit GROUP BY c.amount_minor;
$$;
