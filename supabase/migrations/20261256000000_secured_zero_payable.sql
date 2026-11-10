-- ============================================================================
-- SECURED ZERO-PAYABLE — atomic validation + wallet_funded transition.
-- The whole check runs inside one transaction on the locked job row: a
-- concurrent cancellation/release cannot change the funding picture between
-- validation and the status write. Retries short-circuit on the already-
-- funded state without re-validating mutable records.
-- ============================================================================
CREATE OR REPLACE FUNCTION secure_zero_payable_funding(p_job uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
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
REVOKE ALL ON FUNCTION secure_zero_payable_funding(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION secure_zero_payable_funding(uuid) TO service_role;
