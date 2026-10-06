-- Refund / reversal operation records — durable, per-operation persistence.
--
-- Replaces reliance on the job's latest refund_id/reversal_id with one immutable
-- row per partial refund/reversal: amount, purpose, idempotency key, provider id,
-- status, and the service/budget component split for errand allocations.
--
-- Status lifecycle:
--   reserved  -> reservation held (cumulative totals incremented)
--   executed  -> provider success (provider_id recorded; totals retained)
--   failed    -> definitive provider rejection (4xx); caller then releases
--   unknown   -> ambiguous timeout/network/5xx; reservation RETAINED and blocks
--   released  -> non-execution established (totals decremented)
--
-- Forward-only. Defensive IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS public.refund_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  operation_type text NOT NULL CHECK (operation_type IN ('refund','reversal')),
  amount_minor bigint NOT NULL,
  service_component_minor bigint NOT NULL DEFAULT 0,
  budget_component_minor bigint NOT NULL DEFAULT 0,
  purpose text,
  idempotency_key text NOT NULL,
  provider_id text,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','executed','failed','unknown','released')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_operations_key_unique UNIQUE (job_id, operation_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_refund_operations_job ON public.refund_operations (job_id, operation_type, status);

-- Cumulative component totals so errand budget is never double-subtracted.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS total_service_refunded_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS total_budget_refunded_minor bigint NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Reserve a refund operation. Splits the amount into budget-first then service,
-- enforces CUMULATIVE limits on both components atomically, and is idempotent on
-- (job_id, 'refund', idempotency_key).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_refund_operation(
  p_job_id uuid,
  p_amount_minor bigint,
  p_captured_minor bigint,
  p_service_fare_minor bigint,
  p_idempotency_key text,
  p_purpose text DEFAULT NULL
)
RETURNS public.refund_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.jobs;
  v_budget_remaining bigint;
  v_service_remaining bigint;
  v_budget_component bigint;
  v_service_component bigint;
  v_op public.refund_operations;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Idempotent resume: a repeat of the same key returns the SAME operation.
  SELECT * INTO v_op FROM public.refund_operations
    WHERE job_id = p_job_id AND operation_type = 'refund' AND idempotency_key = p_idempotency_key
      AND status IN ('reserved','executed','unknown')
    LIMIT 1;
  IF FOUND THEN RETURN v_op; END IF;

  v_budget_remaining  := GREATEST(0, (p_captured_minor - p_service_fare_minor) - COALESCE(v_job.total_budget_refunded_minor, 0));
  v_service_remaining := GREATEST(0, p_service_fare_minor - COALESCE(v_job.total_service_refunded_minor, 0));

  -- Budget is refunded first, then the service fare.
  v_budget_component  := LEAST(p_amount_minor, v_budget_remaining);
  v_service_component := p_amount_minor - v_budget_component;

  IF p_amount_minor <= 0 THEN RETURN NULL; END IF;
  IF v_service_component > v_service_remaining THEN RETURN NULL; END IF;
  IF p_amount_minor > (v_budget_remaining + v_service_remaining) THEN RETURN NULL; END IF;

  UPDATE public.jobs SET
    total_refunded_minor         = COALESCE(total_refunded_minor, 0) + p_amount_minor,
    total_budget_refunded_minor  = COALESCE(total_budget_refunded_minor, 0) + v_budget_component,
    total_service_refunded_minor = COALESCE(total_service_refunded_minor, 0) + v_service_component
  WHERE id = p_job_id;

  INSERT INTO public.refund_operations
    (job_id, operation_type, amount_minor, service_component_minor, budget_component_minor, purpose, idempotency_key, status)
  VALUES
    (p_job_id, 'refund', p_amount_minor, v_service_component, v_budget_component, p_purpose, p_idempotency_key, 'reserved')
  RETURNING * INTO v_op;

  RETURN v_op;
END;
$$;

-- Record provider outcome. 'unknown' retains the reservation (blocks); 'failed'
-- is definitive and should be followed by release_refund_operation.
CREATE OR REPLACE FUNCTION public.mark_refund_operation(
  p_operation_id uuid,
  p_provider_id text,
  p_status text,
  p_error text DEFAULT NULL
)
RETURNS public.refund_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op public.refund_operations;
BEGIN
  IF p_status NOT IN ('executed','failed','unknown') THEN RETURN NULL; END IF;
  UPDATE public.refund_operations SET
    provider_id = COALESCE(p_provider_id, provider_id),
    status = p_status,
    error = p_error,
    updated_at = now()
  WHERE id = p_operation_id AND status IN ('reserved','unknown')
  RETURNING * INTO v_op;
  RETURN v_op;
END;
$$;

-- Release only when non-execution is established (definitive rejection).
CREATE OR REPLACE FUNCTION public.release_refund_operation(p_operation_id uuid)
RETURNS public.refund_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op public.refund_operations;
BEGIN
  SELECT * INTO v_op FROM public.refund_operations WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_op.status IN ('released','executed') THEN RETURN v_op; END IF;

  UPDATE public.jobs SET
    total_refunded_minor         = GREATEST(0, total_refunded_minor - v_op.amount_minor),
    total_budget_refunded_minor  = GREATEST(0, total_budget_refunded_minor - v_op.budget_component_minor),
    total_service_refunded_minor = GREATEST(0, total_service_refunded_minor - v_op.service_component_minor)
  WHERE id = v_op.job_id;

  UPDATE public.refund_operations SET status = 'released', updated_at = now()
  WHERE id = p_operation_id RETURNING * INTO v_op;
  RETURN v_op;
END;
$$;

-- ---------------------------------------------------------------------------
-- Reversal operations (no budget component): the driver share is reversed
-- against the original transfer. Same reserved/executed/failed/unknown/released
-- lifecycle, idempotent on (job_id, 'reversal', idempotency_key).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_reversal_operation(
  p_job_id uuid,
  p_amount_minor bigint,
  p_transfer_minor bigint,
  p_idempotency_key text,
  p_purpose text DEFAULT NULL
)
RETURNS public.refund_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.jobs;
  v_op public.refund_operations;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO v_op FROM public.refund_operations
    WHERE job_id = p_job_id AND operation_type = 'reversal' AND idempotency_key = p_idempotency_key
      AND status IN ('reserved','executed','unknown')
    LIMIT 1;
  IF FOUND THEN RETURN v_op; END IF;

  IF p_amount_minor <= 0 THEN RETURN NULL; END IF;
  IF (COALESCE(v_job.total_reversed_minor, 0) + p_amount_minor) > p_transfer_minor THEN RETURN NULL; END IF;

  UPDATE public.jobs SET
    total_reversed_minor = COALESCE(total_reversed_minor, 0) + p_amount_minor
  WHERE id = p_job_id;

  INSERT INTO public.refund_operations
    (job_id, operation_type, amount_minor, service_component_minor, budget_component_minor, purpose, idempotency_key, status)
  VALUES
    (p_job_id, 'reversal', p_amount_minor, p_amount_minor, 0, p_purpose, p_idempotency_key, 'reserved')
  RETURNING * INTO v_op;

  RETURN v_op;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_reversal_operation(
  p_operation_id uuid,
  p_provider_id text,
  p_status text,
  p_error text DEFAULT NULL
)
RETURNS public.refund_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op public.refund_operations;
BEGIN
  IF p_status NOT IN ('executed','failed','unknown') THEN RETURN NULL; END IF;
  UPDATE public.refund_operations SET
    provider_id = COALESCE(p_provider_id, provider_id),
    status = p_status,
    error = p_error,
    updated_at = now()
  WHERE id = p_operation_id AND status IN ('reserved','unknown')
  RETURNING * INTO v_op;
  RETURN v_op;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_reversal_operation(p_operation_id uuid)
RETURNS public.refund_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op public.refund_operations;
BEGIN
  SELECT * INTO v_op FROM public.refund_operations WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_op.status IN ('released','executed') THEN RETURN v_op; END IF;

  UPDATE public.jobs SET
    total_reversed_minor = GREATEST(0, total_reversed_minor - v_op.amount_minor)
  WHERE id = v_op.job_id;

  UPDATE public.refund_operations SET status = 'released', updated_at = now()
  WHERE id = p_operation_id RETURNING * INTO v_op;
  RETURN v_op;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_refund_operation(uuid, bigint, bigint, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_refund_operation(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_refund_operation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_reversal_operation(uuid, bigint, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_reversal_operation(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_reversal_operation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_refund_operation(uuid, bigint, bigint, bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_refund_operation(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_refund_operation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_reversal_operation(uuid, bigint, bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_reversal_operation(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_reversal_operation(uuid) TO authenticated;
