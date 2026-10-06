-- Refund / transfer-reversal tracking.
--
-- A customer refund returns money to the customer; the driver-share transfer
-- reversal returns the driver's proportional share to the platform. Refund and
-- reversal identities are persisted SEPARATELY, with cumulative minor-unit
-- totals so partial refunds can never exceed the original charge/transfer.
--
-- Forward-only. Defensive IF NOT EXISTS.

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS reversal_id text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS total_refunded_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS total_reversed_minor bigint NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Atomic refund/reversal reservation. The server fetches the captured/transfer
-- minor-unit totals from Stripe and passes them in; a row lock serializes
-- concurrent reservations so cumulative refunds can never exceed the captured
-- amount and reversals can never exceed the original transfer. A reservation is
-- released only by the caller when the provider call definitively failed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_job_refund(
  p_job_id uuid,
  p_amount_minor bigint,
  p_captured_minor bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current bigint;
BEGIN
  SELECT total_refunded_minor INTO v_current FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_amount_minor <= 0 OR (v_current + p_amount_minor) > p_captured_minor THEN RETURN false; END IF;
  UPDATE public.jobs SET total_refunded_minor = v_current + p_amount_minor WHERE id = p_job_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_job_refund(
  p_job_id uuid,
  p_amount_minor bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.jobs
  SET total_refunded_minor = GREATEST(0, total_refunded_minor - p_amount_minor)
  WHERE id = p_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_job_reversal(
  p_job_id uuid,
  p_amount_minor bigint,
  p_transfer_minor bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current bigint;
BEGIN
  SELECT total_reversed_minor INTO v_current FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_amount_minor <= 0 OR (v_current + p_amount_minor) > p_transfer_minor THEN RETURN false; END IF;
  UPDATE public.jobs SET total_reversed_minor = v_current + p_amount_minor WHERE id = p_job_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_job_reversal(
  p_job_id uuid,
  p_amount_minor bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.jobs
  SET total_reversed_minor = GREATEST(0, total_reversed_minor - p_amount_minor)
  WHERE id = p_job_id;
END;
$$;
