-- ============================================================================
-- JOB REFUND ALLOCATIONS — external money and credit restore are tracked
-- separately and bounded. Refund external never exceeds captured-minus-
-- refunded; credit restores proportionally to the funded share of the
-- charge, once per refund reference, never fully on a partial refund.
-- ============================================================================
ALTER TABLE job_funding_breakdown
  ADD COLUMN IF NOT EXISTS captured_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE reward_credit_spends
  ADD COLUMN IF NOT EXISTS restored_minor bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS job_refund_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id),
  provider_ref text NOT NULL,
  external_minor bigint NOT NULL CHECK(external_minor>=0),
  credit_minor bigint NOT NULL CHECK(credit_minor>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_ref)           -- webhook replay cannot double-allocate
);
ALTER TABLE job_refund_allocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON job_refund_allocations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON job_refund_allocations TO service_role;

-- apply_job_refund(p_job, p_external_minor, p_ref):
--   external bound  = min(requested, captured - already_refunded)
--   credit restore  = proportional to the funding share of the charge:
--                     floor(external_refund * reward_credit_minor /
--                           customer_charge_minor) cumulative-capped at the
--                     unreversed spend amount. Partial refunds restore only
--                     their share — never the whole allocation.
CREATE OR REPLACE FUNCTION apply_job_refund(
  p_job uuid, p_external_minor bigint, p_ref text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
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
REVOKE ALL ON FUNCTION apply_job_refund(uuid,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION apply_job_refund(uuid,bigint,text) TO service_role;
