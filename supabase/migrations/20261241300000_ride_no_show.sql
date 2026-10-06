-- Ride customer no-show — runtime state, atomic arrival/finalize transitions,
-- and a guard that prevents direct client status writes from bypassing the
-- server-authoritative arrival.
--
-- The DISCLOSED fee/split is persisted in `jobs.fare_breakdown` at agreement
-- time (noShowPolicyVersion / noShowFeeMinor / noShowDriverShareMinor /
-- noShowPlatformShareMinor). These columns record only RUNTIME state; the
-- client can never supply a fee, share, timestamp or grace deadline.
--
-- Forward-only. No historical migration is edited. Defensive IF NOT EXISTS.

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS no_show_arrived_at timestamptz;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS no_show_grace_until timestamptz;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS no_show_status text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS no_show_reason text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS no_show_contact_attempted_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_no_show_status_check') THEN
    ALTER TABLE public.jobs ADD CONSTRAINT jobs_no_show_status_check
      CHECK (no_show_status IS NULL OR no_show_status IN (
        'pending','fee_charged','released','compensation_paid','failed','review'
      ));
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Server-authoritative arrival: atomic, idempotent, ownership-checked, and
-- restricted to an eligible ride-pickup state. Repeated arrival never resets
-- the timer (the WHERE/early-return keeps the ORIGINAL no_show_arrived_at).
-- Proximity/freshness are validated SERVER-side before this call.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_job_arrived(
  p_job_id uuid,
  p_driver_id uuid,
  p_grace_minutes integer DEFAULT 5
)
RETURNS public.jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.jobs;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_job.driver_id IS DISTINCT FROM p_driver_id THEN RETURN NULL; END IF;

  -- Idempotent: a repeated arrival returns the existing deadline unchanged.
  IF v_job.no_show_arrived_at IS NOT NULL THEN RETURN v_job; END IF;

  IF v_job.status NOT IN ('assigned','accepted','driver_arrived') THEN RETURN NULL; END IF;

  UPDATE public.jobs SET
    status = 'arrived',
    no_show_arrived_at = now(),
    no_show_grace_until = now() + make_interval(mins => COALESCE(p_grace_minutes, 5)),
    updated_at = now()
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  RETURN v_job;
END;
$$;

-- ---------------------------------------------------------------------------
-- Server-authoritative no-show finalize: terminal customer-no-show cancellation.
-- DB-only; Stripe money movement is performed by the server afterwards. The
-- booking is terminal even if financial recovery is later pending/failed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_job_no_show(
  p_job_id uuid,
  p_driver_id uuid,
  p_reason text,
  p_contact_attempted boolean DEFAULT false
)
RETURNS public.jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.jobs;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_job.driver_id IS DISTINCT FROM p_driver_id THEN RETURN NULL; END IF;
  IF v_job.status <> 'arrived' THEN RETURN NULL; END IF;                       -- still waiting at pickup
  IF v_job.no_show_grace_until IS NULL OR v_job.no_show_grace_until > now() THEN RETURN NULL; END IF; -- grace not elapsed
  IF v_job.fare_breakdown IS NULL OR v_job.fare_breakdown->>'noShowPolicyVersion' IS NULL THEN RETURN NULL; END IF; -- undisclosed

  UPDATE public.jobs SET
    status = 'cancelled',
    no_show_status = 'pending',
    no_show_reason = left(coalesce(p_reason, 'Customer no-show'), 500),
    no_show_contact_attempted_at = CASE WHEN p_contact_attempted THEN now() ELSE no_show_contact_attempted_at END,
    updated_at = now()
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  RETURN v_job;
END;
$$;

-- ---------------------------------------------------------------------------
-- Prevent direct client status writes from bypassing the arrival authority.
-- A direct `status -> 'arrived'/'driver_arrived'` write (no server timestamp)
-- is rejected only for bookings that carry a disclosed no-show policy, so
-- default-off bookings are completely unaffected.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_guard_direct_arrival()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('arrived','driver_arrived')
     AND NEW.no_show_arrived_at IS NULL
     AND OLD.no_show_arrived_at IS NULL
     AND NEW.fare_breakdown IS NOT NULL
     AND NEW.fare_breakdown->>'noShowPolicyVersion' IS NOT NULL THEN
    RAISE EXCEPTION 'Arrival must be recorded through mark_job_arrived (server-authoritative).';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_direct_arrival ON public.jobs;
CREATE TRIGGER trg_guard_direct_arrival
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.trg_guard_direct_arrival();

-- Clients may invoke the arrival/finalize functions (with only ids/reason), but
-- may never execute them anonymously or supply fee/share/timestamp parameters.
REVOKE ALL ON FUNCTION public.mark_job_arrived(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_job_no_show(uuid, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_job_arrived(uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_job_no_show(uuid, uuid, text, boolean) TO authenticated;
