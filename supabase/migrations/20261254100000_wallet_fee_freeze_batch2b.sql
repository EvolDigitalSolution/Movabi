-- =============================================================================
-- Batch 2B — integrate fee policy into the top-up lifecycle (additive).
-- Freezes wallet credit, provider fee, total charge and fee-policy version
-- BEFORE provider contact; the confirm path credits only the wallet amount.
-- Does NOT replace previously applied migrations.
-- =============================================================================
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.wallet_topup_attempts') IS NULL OR to_regclass('public.wallet_topup_fee_policies') IS NULL THEN
    RAISE EXCEPTION 'Batch 2B precondition: Batch 1C and Batch 2A are required';
  END IF;
END
$$;

-- Validate + freeze the three amounts and policy version (before provider contact).
CREATE OR REPLACE FUNCTION public.freeze_wallet_topup_fee(p_attempt_id uuid, p_fee_policy_version text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  a public.wallet_topup_attempts%ROWTYPE;
  pol public.wallet_topup_fee_policies%ROWTYPE;
  v_fee bigint; v_total bigint;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 2B: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF a.status <> 'initiated' AND a.fee_policy_version IS NULL THEN
    RAISE EXCEPTION 'Batch 2B: fee must be frozen before submission' USING ERRCODE = 'BP008';
  END IF;
  IF p_fee_policy_version IS NULL OR btrim(p_fee_policy_version) = '' THEN
    RAISE EXCEPTION 'Batch 2B: fee policy version is required' USING ERRCODE = 'BP004';
  END IF;
  -- Conflicting retry: reject a different policy version after freezing.
  IF a.fee_policy_version IS NOT NULL THEN
    IF a.fee_policy_version <> p_fee_policy_version THEN
      RAISE EXCEPTION 'Batch 2B: attempt already frozen with policy %', a.fee_policy_version USING ERRCODE = 'BP002';
    END IF;
    RETURN;
  END IF;
  -- Fee is CALCULATED from the approved server-owned policy (never caller-supplied).
  SELECT * INTO pol FROM public.wallet_topup_fee_policies
  WHERE active AND provider = a.payment_provider AND country_code = a.country_code
    AND currency_code = a.currency_code AND method = 'card' AND version = p_fee_policy_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch 2B: no active fee policy % for %/%/%', p_fee_policy_version, a.payment_provider, a.country_code, a.currency_code USING ERRCODE = 'BP008';
  END IF;
  IF pol.exponent IS DISTINCT FROM public.wallet_currency_minor_exponent(a.currency_code) THEN
    RAISE EXCEPTION 'Batch 2B: configured currency exponent does not match ledger authority' USING ERRCODE = 'BP008';
  END IF;
  IF pol.fee_basis_points > 0 THEN
    v_fee := round((a.amount_minor::numeric * pol.fee_basis_points::numeric) / 10000.0)::bigint;
  ELSE
    v_fee := pol.fee_fixed_minor;
  END IF;
  v_total := a.amount_minor + v_fee;
  UPDATE public.wallet_topup_attempts
  SET provider_fee_minor = v_fee, total_charge_minor = v_total, fee_policy_version = p_fee_policy_version, fee_exponent = pol.exponent
  WHERE id = p_attempt_id;
END
$$;

-- Server-side charge verification: the provider's actual total must equal the
-- frozen total charge before crediting; credit only the wallet amount (amount_minor).
CREATE OR REPLACE FUNCTION public.verify_wallet_topup_charge(p_attempt_id uuid, p_verified_total_minor bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 2B: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF p_verified_total_minor IS NULL OR p_verified_total_minor <= 0 THEN
    RAISE EXCEPTION 'Batch 2B: verified total is required' USING ERRCODE = 'BP004';
  END IF;
  IF p_verified_total_minor IS DISTINCT FROM a.total_charge_minor THEN
    RAISE EXCEPTION 'Batch 2B: verified total % does not match frozen total %', p_verified_total_minor, a.total_charge_minor USING ERRCODE = 'BP008';
  END IF;
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION public.freeze_wallet_topup_fee(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_wallet_topup_charge(uuid,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.freeze_wallet_topup_fee(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_wallet_topup_charge(uuid,bigint) TO service_role;

COMMIT;
