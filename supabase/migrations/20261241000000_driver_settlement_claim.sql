-- Driver settlement claim / state machine.
--
-- `stripe_transfer_id` is reserved EXCLUSIVELY for genuine Stripe transfer IDs
-- (never a local claim token). The in-flight claim, lease, and immutable
-- settlement identity live in dedicated columns so crash recovery and
-- reconciliation are explicit instead of inferred from a missing transfer id.
--
-- State machine:
--   pending     -> claimable
--   claimed     -> in-flight (lease active); a stale lease is re-claimable only after reconciliation
--   transferred -> terminal success (stripe_transfer_id set)
--   failed      -> definitive 4xx rejection (re-claimable on retry)
--   unknown     -> ambiguous outcome; BLOCKS another transfer until reconciled
--   reversed    -> transfer reversed after a refund
--
-- Two functions make the money tail atomic:
--   claim_job_settlement  — atomic claim + immutable identity write.
--   record_job_settlement — atomic transfer-success + earnings recording.
--
-- Forward-only. No historical migration is edited. Defensive IF NOT EXISTS.

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS settlement_status text NOT NULL DEFAULT 'pending';
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS settlement_claimed_at timestamptz;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS settlement_lease_expires_at timestamptz;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS settlement_amount_minor bigint;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS settlement_currency text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS settlement_destination_account text;

-- Constrain the state machine (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_settlement_status_check') THEN
    ALTER TABLE public.jobs ADD CONSTRAINT jobs_settlement_status_check
      CHECK (settlement_status IN ('pending','claimed','transferred','failed','unknown','reversed'));
  END IF;
END
$$;

-- Fast lookup for the reconciliation runner: in-flight or blocked settlements.
CREATE INDEX IF NOT EXISTS idx_jobs_settlement_status
  ON public.jobs (settlement_status)
  WHERE settlement_status IN ('claimed','unknown');

-- ---------------------------------------------------------------------------
-- Atomic claim: transition a claimable (or stale) job to 'claimed' and persist
-- the immutable settlement identity in the SAME statement. Only one writer wins.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_job_settlement(
  p_job_id uuid,
  p_amount_minor bigint,
  p_currency text,
  p_destination text,
  p_lease_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id uuid;
BEGIN
  UPDATE public.jobs SET
    settlement_status = 'claimed',
    settlement_claimed_at = now(),
    settlement_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    settlement_amount_minor = p_amount_minor,
    settlement_currency = p_currency,
    settlement_destination_account = p_destination,
    updated_at = now()
  WHERE id = p_job_id
    AND stripe_transfer_id IS NULL
    AND settlement_status IN ('pending','failed')
  RETURNING id INTO v_job_id;

  -- NOTE: a 'claimed' row whose lease has expired is deliberately NOT claimable
  -- here. The original worker may still be in-flight with Stripe, and a
  -- transfer_group lookup that returns nothing cannot prove the original request
  -- will never succeed. Recovery of a stale claim must go through reconciliation
  -- (record a found transfer) or become 'unknown' (block) — never auto re-claim.

  RETURN v_job_id IS NOT NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Atomic transfer-success recording: the jobs update and the earnings upsert
-- run in ONE transaction. Callers must NOT claim atomicity unless this function
-- is the write path (it is).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_job_settlement(
  p_job_id uuid,
  p_driver_id uuid,
  p_total_price numeric,
  p_driver_payout numeric,
  p_platform_fee numeric,
  p_commission_fee numeric,
  p_commission_rate numeric,
  p_stripe_transfer_id text,
  p_currency_code text,
  p_country_code text,
  p_was_already_completed boolean
)
RETURNS SETOF public.jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.jobs SET
    status = CASE WHEN p_was_already_completed THEN status ELSE 'completed' END,
    payment_status = 'paid',
    driver_id = p_driver_id,
    price = p_total_price,
    total_price = p_total_price,
    driver_payout = p_driver_payout,
    platform_fee = p_platform_fee,
    commission_fee = p_commission_fee,
    commission_rate_used = p_commission_rate,
    stripe_transfer_id = p_stripe_transfer_id,
    stripe_transfer_status = 'succeeded',
    settlement_status = 'transferred',
    transferred_at = COALESCE(transferred_at, now()),
    completed_at = CASE WHEN p_was_already_completed THEN completed_at ELSE COALESCE(completed_at, now()) END,
    updated_at = now()
  WHERE id = p_job_id
  RETURNING *;

  INSERT INTO public.driver_earnings
    (driver_id, job_id, amount, platform_fee, gross_amount, status, currency_code, country_code, stripe_transfer_id, settled_at)
  VALUES
    (p_driver_id, p_job_id, p_driver_payout, p_platform_fee, p_total_price, 'paid', p_currency_code, p_country_code, p_stripe_transfer_id, now())
  ON CONFLICT (job_id) DO UPDATE SET
    driver_id = EXCLUDED.driver_id,
    amount = EXCLUDED.amount,
    platform_fee = EXCLUDED.platform_fee,
    gross_amount = EXCLUDED.gross_amount,
    status = 'paid',
    currency_code = EXCLUDED.currency_code,
    country_code = EXCLUDED.country_code,
    stripe_transfer_id = EXCLUDED.stripe_transfer_id,
    settled_at = now();
END;
$$;
