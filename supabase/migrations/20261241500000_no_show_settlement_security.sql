-- No-show settlement authority + server-only financial RPC hardening.
--
-- 1. A `settlement_purpose` distinguishes ordinary job earnings from no-show
--    compensation, so ordinary completion and no-show can never both settle.
-- 2. `record_no_show_settlement` records the driver compensation through the SAME
--    claim -> transfer -> record machinery as ordinary settlement (it preserves
--    the cancelled status and writes the no-show purpose).
-- 3. Every privileged financial/settlement/no-show RPC is made SERVER-ONLY: the
--    service-role (supabaseAdmin) is the only caller; clients can never invoke
--    them directly or supply fee/split/timestamp values.
--
-- Forward-only. Defensive IF NOT EXISTS.

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS settlement_purpose text NOT NULL DEFAULT 'job_earnings';
ALTER TABLE public.driver_earnings ADD COLUMN IF NOT EXISTS settlement_purpose text NOT NULL DEFAULT 'job_earnings';

-- Record the no-show driver compensation atomically (jobs + earnings), without
-- touching the booking's terminal 'cancelled' status.
CREATE OR REPLACE FUNCTION public.record_no_show_settlement(
  p_job_id uuid,
  p_driver_id uuid,
  p_amount_minor bigint,
  p_platform_share_minor bigint,
  p_fee_minor bigint,
  p_currency text,
  p_stripe_transfer_id text
)
RETURNS SETOF public.jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.jobs SET
    settlement_status = 'transferred',
    settlement_purpose = 'no_show_compensation',
    stripe_transfer_id = p_stripe_transfer_id,
    stripe_transfer_status = 'succeeded',
    transferred_at = COALESCE(transferred_at, now()),
    updated_at = now()
  WHERE id = p_job_id AND status = 'cancelled'
  RETURNING *;

  INSERT INTO public.driver_earnings
    (driver_id, job_id, amount, platform_fee, gross_amount, status, currency_code, country_code, stripe_transfer_id, settled_at, settlement_purpose)
  VALUES
    (p_driver_id, p_job_id, p_amount_minor / 100.0, p_platform_share_minor / 100.0, p_fee_minor / 100.0,
     'paid', p_currency, 'GB', p_stripe_transfer_id, now(), 'no_show_compensation')
  ON CONFLICT (job_id) DO UPDATE SET
    amount = EXCLUDED.amount,
    platform_fee = EXCLUDED.platform_fee,
    gross_amount = EXCLUDED.gross_amount,
    status = 'paid',
    stripe_transfer_id = EXCLUDED.stripe_transfer_id,
    settlement_purpose = EXCLUDED.settlement_purpose,
    settled_at = now();
END;
$$;

-- ---------------------------------------------------------------------------
-- Server-only hardening: revoke EXECUTE from PUBLIC (and therefore anon and
-- authenticated) on every privileged money/transition function. The server
-- (service role) is the only caller.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.claim_job_settlement(uuid, bigint, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_job_settlement(uuid, uuid, numeric, numeric, numeric, numeric, numeric, text, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_job_refund(uuid, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_job_refund(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_job_reversal(uuid, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_job_reversal(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_job_arrived(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_job_no_show(uuid, uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_refund_operation(uuid, bigint, bigint, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_refund_operation(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_refund_operation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_reversal_operation(uuid, bigint, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_reversal_operation(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_reversal_operation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_no_show_settlement(uuid, uuid, bigint, bigint, bigint, text, text) FROM PUBLIC;

-- Grant execute back to the server's service role ONLY (never anon/authenticated),
-- so clients cannot invoke these directly or supply fee/split/timestamp values.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.claim_job_settlement(uuid, bigint, text, text, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION public.record_job_settlement(uuid, uuid, numeric, numeric, numeric, numeric, numeric, text, text, text, boolean) TO service_role;
    GRANT EXECUTE ON FUNCTION public.record_no_show_settlement(uuid, uuid, bigint, bigint, bigint, text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.reserve_job_refund(uuid, bigint, bigint) TO service_role;
    GRANT EXECUTE ON FUNCTION public.release_job_refund(uuid, bigint) TO service_role;
    GRANT EXECUTE ON FUNCTION public.reserve_job_reversal(uuid, bigint, bigint) TO service_role;
    GRANT EXECUTE ON FUNCTION public.release_job_reversal(uuid, bigint) TO service_role;
    GRANT EXECUTE ON FUNCTION public.mark_job_arrived(uuid, uuid, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION public.finalize_job_no_show(uuid, uuid, text, boolean) TO service_role;
    GRANT EXECUTE ON FUNCTION public.reserve_refund_operation(uuid, bigint, bigint, bigint, text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.mark_refund_operation(uuid, text, text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.release_refund_operation(uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION public.reserve_reversal_operation(uuid, bigint, bigint, text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.mark_reversal_operation(uuid, text, text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.release_reversal_operation(uuid) TO service_role;
  END IF;
END
$$;

-- Supabase grants EXECUTE to anon/authenticated via DEFAULT PRIVILEGES, so a
-- `REVOKE ... FROM PUBLIC` is insufficient. Explicitly revoke the CLIENT roles so
-- only the server (service_role / postgres owner) can execute these.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION public.claim_job_settlement(uuid, bigint, text, text, integer) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.record_job_settlement(uuid, uuid, numeric, numeric, numeric, numeric, numeric, text, text, text, boolean) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.record_no_show_settlement(uuid, uuid, bigint, bigint, bigint, text, text) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.reserve_job_refund(uuid, bigint, bigint) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.release_job_refund(uuid, bigint) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.reserve_job_reversal(uuid, bigint, bigint) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.release_job_reversal(uuid, bigint) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.mark_job_arrived(uuid, uuid, integer) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.finalize_job_no_show(uuid, uuid, text, boolean) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.reserve_refund_operation(uuid, bigint, bigint, bigint, text, text) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.mark_refund_operation(uuid, text, text, text) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.release_refund_operation(uuid) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.reserve_reversal_operation(uuid, bigint, bigint, text, text) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.mark_reversal_operation(uuid, text, text, text) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.release_reversal_operation(uuid) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.claim_job_settlement(uuid, bigint, text, text, integer) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.record_job_settlement(uuid, uuid, numeric, numeric, numeric, numeric, numeric, text, text, text, boolean) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.record_no_show_settlement(uuid, uuid, bigint, bigint, bigint, text, text) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.reserve_job_refund(uuid, bigint, bigint) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.release_job_refund(uuid, bigint) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.reserve_job_reversal(uuid, bigint, bigint) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.release_job_reversal(uuid, bigint) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.mark_job_arrived(uuid, uuid, integer) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.finalize_job_no_show(uuid, uuid, text, boolean) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.reserve_refund_operation(uuid, bigint, bigint, bigint, text, text) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.mark_refund_operation(uuid, text, text, text) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.release_refund_operation(uuid) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.reserve_reversal_operation(uuid, bigint, bigint, text, text) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.mark_reversal_operation(uuid, text, text, text) FROM anon;
    REVOKE EXECUTE ON FUNCTION public.release_reversal_operation(uuid) FROM anon;
  END IF;
END
$$;
