-- =============================================================================
-- Batch 2A â€” Flutterwave provider (additive, disabled by default).
-- Adds Flutterwave as a configurable provider (routed by country/currency/
-- capability/merchant approval, never by continent) and an explicit fee-policy
-- table so wallet credit, provider fee and total charge are frozen before
-- payment. No route is enabled and no live key is configured.
-- =============================================================================
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.wallet_topup_attempts') IS NULL OR to_regclass('public.market_payment_routes') IS NULL THEN
    RAISE EXCEPTION 'Batch 2A precondition: Batch 1C top-ups and market_payment_routes are required';
  END IF;
END
$$;

-- 1. Fee policy table (explicit approved provider/market/method configuration).
CREATE TABLE IF NOT EXISTS public.wallet_topup_fee_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL,
  provider text NOT NULL,
  country_code text NOT NULL,
  currency_code text NOT NULL,
  method text NOT NULL,
  fee_basis_points integer NOT NULL DEFAULT 0 CHECK (fee_basis_points BETWEEN 0 AND 10000),
  fee_fixed_minor bigint NOT NULL DEFAULT 0 CHECK (fee_fixed_minor >= 0),
  exponent integer NOT NULL CHECK (exponent BETWEEN 0 AND 3),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (fee_basis_points = 0 OR fee_fixed_minor = 0),
  CHECK (fee_basis_points <> 0 OR fee_fixed_minor <> 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_topup_fee_policies_active_unique
  ON public.wallet_topup_fee_policies (provider, country_code, currency_code, method) WHERE active;
-- Flutterwave + Stripe/Kora/Fincra must also have explicit fee rows; none is active here.

-- 2. Freeze fee amounts + policy version on the attempt.
ALTER TABLE public.wallet_topup_attempts
  ADD COLUMN IF NOT EXISTS provider_fee_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_charge_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee_policy_version text,
  ADD COLUMN IF NOT EXISTS fee_exponent smallint CHECK (fee_exponent BETWEEN 0 AND 3);
-- Ensure new attempts carry the total charge (amount + fee); existing rows keep 0 default.
COMMENT ON COLUMN public.wallet_topup_attempts.provider_fee_minor IS 'Frozen provider fee in currency minor units';
COMMENT ON COLUMN public.wallet_topup_attempts.total_charge_minor IS 'Frozen total charge (wallet amount + provider fee) in minor units';
COMMENT ON COLUMN public.wallet_topup_attempts.fee_policy_version IS 'Approved fee-policy version applied to this attempt';

-- 4. Privileges: server-owned configuration; no client write.
REVOKE ALL ON public.wallet_topup_fee_policies FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.wallet_topup_fee_policies TO service_role;

COMMIT;
