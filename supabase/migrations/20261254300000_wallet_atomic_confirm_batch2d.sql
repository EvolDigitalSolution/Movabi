-- =============================================================================
-- Batch 2D — atomic total-check-and-credit (additive).
-- One transactional confirmation: locks the attempt, validates the immutable
-- wallet amount/fee/total/policy version + provider/account/reference/currency
-- and trusted successful evidence, then credits ONLY the wallet amount exactly
-- once. Identical retries return the original event; conflicting retries raise
-- BP002. The legacy 6-arg confirm is restricted once a fee is frozen.
-- =============================================================================
BEGIN;

-- 0. Durable legacy-attempt classification: new attempts are non-legacy by
--    default and MUST freeze a fee; genuine pre-existing attempts must be
--    backfilled legacy_attempt = true before applying this migration.
ALTER TABLE public.wallet_topup_attempts
  ADD COLUMN IF NOT EXISTS legacy_attempt boolean NOT NULL DEFAULT false;
-- One-time locked backfill: classify only the attempts that existed before this
-- migration. A rerun (with new attempts present) must NOT reclassify them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.wallet_collection_config WHERE key = 'legacy_backfill_done') THEN
    UPDATE public.wallet_topup_attempts SET legacy_attempt = true;
    INSERT INTO public.wallet_collection_config(key, value) VALUES ('legacy_backfill_done', 'true');
  END IF;
END
$$;

-- Freeze legacy classification: it can never change after this migration.
CREATE OR REPLACE FUNCTION public.wallet_topup_attempt_freeze()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
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
     OR NEW.provider_idempotency_identity IS DISTINCT FROM OLD.provider_idempotency_identity
     OR NEW.legacy_attempt IS DISTINCT FROM OLD.legacy_attempt THEN
    RAISE EXCEPTION 'Batch 1C: top-up attempt terms are frozen' USING ERRCODE = 'BP007';
  END IF;
  -- Fee snapshot: immutable once fee_policy_version is set (including a zero fee).
  IF OLD.fee_policy_version IS NOT NULL AND (
    NEW.fee_policy_version IS DISTINCT FROM OLD.fee_policy_version
    OR NEW.provider_fee_minor IS DISTINCT FROM OLD.provider_fee_minor
    OR NEW.total_charge_minor IS DISTINCT FROM OLD.total_charge_minor
    OR NEW.fee_exponent IS DISTINCT FROM OLD.fee_exponent
  ) THEN
    RAISE EXCEPTION 'Batch 1C: top-up fee snapshot is immutable' USING ERRCODE = 'BP007';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS wallet_topup_attempt_freeze ON public.wallet_topup_attempts;
CREATE TRIGGER wallet_topup_attempt_freeze BEFORE UPDATE ON public.wallet_topup_attempts
  FOR EACH ROW EXECUTE FUNCTION public.wallet_topup_attempt_freeze();

-- 1. Atomic confirmation (replaces the two-call verify+confirm gap).

-- Fee-before-claim: a new (non-legacy) attempt must freeze an approved fee
-- before its submission can be claimed.
CREATE OR REPLACE FUNCTION public.claim_wallet_topup_submission(p_attempt_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.wallet_collection_enabled() THEN RAISE EXCEPTION 'Batch 1C: collection disabled at submission' USING ERRCODE='BP008'; END IF;
  UPDATE public.wallet_topup_attempts SET status = 'submitting'
  WHERE id = p_attempt_id AND status = 'initiated'
    AND (legacy_attempt OR fee_policy_version IS NOT NULL);
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION public.claim_wallet_topup_submission(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_wallet_topup_submission(uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.confirm_wallet_topup_with_total(
  p_attempt_id uuid,
  p_verified_provider_reference text,
  p_verified_merchant_account_ref text,
  p_verified_currency text,
  p_verified_total_minor bigint,
  p_final_status text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  a public.wallet_topup_attempts%ROWTYPE; v_event_id uuid; v_legs jsonb;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 2D: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF p_final_status IS NULL OR p_final_status NOT IN ('succeeded','completed') THEN
    RAISE EXCEPTION 'Batch 2D: final status % is not a confirmed success', p_final_status USING ERRCODE = 'BP008';
  END IF;

  -- Idempotent replay: validate ALL immutable terms before returning the credit.
  IF a.status = 'credited' AND a.credited_event_id IS NOT NULL THEN
    IF p_verified_provider_reference IS DISTINCT FROM a.provider_reference
       OR p_verified_merchant_account_ref IS DISTINCT FROM a.merchant_account_ref
       OR p_verified_currency IS DISTINCT FROM a.currency_code
       OR p_verified_total_minor IS DISTINCT FROM a.total_charge_minor THEN
      RAISE EXCEPTION 'Batch 2D: replay terms do not match the credited attempt' USING ERRCODE = 'BP002';
    END IF;
    RETURN a.credited_event_id;
  END IF;
  IF a.status IN ('failed','refunded') THEN
    RAISE EXCEPTION 'Batch 2D: attempt is terminal (%)', a.status USING ERRCODE = 'BP008';
  END IF;
  IF a.provider_reference IS NULL THEN
    RAISE EXCEPTION 'Batch 2D: no provider reference bound yet' USING ERRCODE = 'BP008';
  END IF;
  -- Fee must be frozen from an approved policy before a total-checked credit.
  IF a.fee_policy_version IS NULL OR a.total_charge_minor IS NULL OR a.total_charge_minor <= 0 THEN
    RAISE EXCEPTION 'Batch 2D: fee and total charge must be frozen before confirmation' USING ERRCODE = 'BP008';
  END IF;
  -- Verify all immutable terms + the provider's actual total.
  IF p_verified_provider_reference IS DISTINCT FROM a.provider_reference
     OR p_verified_merchant_account_ref IS DISTINCT FROM a.merchant_account_ref
     OR p_verified_currency IS DISTINCT FROM a.currency_code
     OR p_verified_total_minor IS DISTINCT FROM a.total_charge_minor THEN
    RAISE EXCEPTION 'Batch 2D: verified terms/total do not match the frozen attempt' USING ERRCODE = 'BP008';
  END IF;

  -- Credit ONLY the wallet amount (amount_minor), never the fee or total.
  v_legs := jsonb_build_array(
    jsonb_build_object('accountPurpose', a.destination_account_purpose, 'amountMinor', a.amount_minor),
    jsonb_build_object('accountPurpose', 'platform_funding', 'amountMinor', -a.amount_minor));
  v_event_id := public.post_wallet_event(
    'wallet-topup:' || a.id, 'topup', a.tenant_id, a.owner_id, a.currency_code,
    v_legs, a.payment_provider, a.merchant_account_ref, a.provider_reference);

  UPDATE public.wallet_topup_attempts SET status = 'credited', credited_event_id = v_event_id WHERE id = p_attempt_id;
  RETURN v_event_id;
END
$$;

-- 2. Restrict the legacy 6-arg confirm so it cannot bypass the total check once
--    a fee has been frozen (reconciliation of in-flight legacy attempts without
--    a fee policy still works).
CREATE OR REPLACE FUNCTION public.confirm_wallet_topup(
  p_attempt_id uuid, p_verified_provider_reference text, p_verified_merchant_account_ref text,
  p_verified_currency text, p_verified_amount_minor bigint, p_final_status text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  a public.wallet_topup_attempts%ROWTYPE; v_event_id uuid; v_legs jsonb;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;
  -- New attempts must use the total-checked path, independent of policy status;
  -- only genuine legacy attempts may reconcile here.
  IF NOT a.legacy_attempt THEN
    RAISE EXCEPTION 'Batch 2D: use confirm_wallet_topup_with_total (new attempts require a frozen fee)' USING ERRCODE = 'BP008';
  END IF;
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
    'wallet-topup:' || a.id, 'topup', a.tenant_id, a.owner_id, a.currency_code,
    v_legs, a.payment_provider, a.merchant_account_ref, a.provider_reference);
  UPDATE public.wallet_topup_attempts SET status = 'credited', credited_event_id = v_event_id WHERE id = p_attempt_id;
  RETURN v_event_id;
END
$$;

-- Full refunds verify the original total; only the wallet ledger credit reverses.
CREATE OR REPLACE FUNCTION public.mark_wallet_topup_refunded(
  p_attempt_id uuid, p_evidence_reference text, p_verified_provider_reference text,
  p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint,
  p_final_status text, p_reason text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
       OR (CASE WHEN a.fee_policy_version IS NULL THEN a.amount_minor ELSE a.total_charge_minor END) IS DISTINCT FROM p_verified_amount_minor THEN
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
  IF p_verified_amount_minor IS DISTINCT FROM (CASE WHEN a.fee_policy_version IS NULL THEN a.amount_minor ELSE a.total_charge_minor END) THEN
    RAISE EXCEPTION 'Batch 1C: partial refunds are unsupported (evidence %, attempt %)', p_verified_amount_minor, CASE WHEN a.fee_policy_version IS NULL THEN a.amount_minor ELSE a.total_charge_minor END USING ERRCODE = 'BP008';
  END IF;
  v_reversal := public.post_wallet_reversal('wallet-topup:' || a.id::text, 'wallet-topup:' || a.id::text || ':refund');
  UPDATE public.wallet_topup_attempts SET status='refunded', refund_evidence_reference=p_evidence_reference, failure_reason=COALESCE(p_reason,failure_reason) WHERE id=p_attempt_id;
  RETURN v_reversal;
END $$;

REVOKE ALL ON FUNCTION public.confirm_wallet_topup_with_total(uuid,text,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_wallet_topup(uuid,text,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_wallet_topup_with_total(uuid,text,text,text,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_wallet_topup(uuid,text,text,text,bigint,text) TO service_role;

COMMIT;
