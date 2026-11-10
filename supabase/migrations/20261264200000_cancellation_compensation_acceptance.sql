-- =============================================================================
-- Cancellation-fee compensation acceptance hardening (supersedes 641 RPCs).
--
-- 1. Retry/recovery: settlement is a single atomic authority (collection
--    recorded + compensation posted in one transaction). The webhook must NOT
--    acknowledge a failed settlement, so Stripe re-delivers and the idempotent
--    RPC completes it — no acknowledged event can leave collection recorded
--    with compensation permanently missing.
-- 2. Dedupe is bound to the canonical (provider, merchant_account_ref,
--    test/live environment, provider_reference) — never reference alone.
-- 3. Refund after payout preserves paid driver_earnings history and records a
--    linked recovery adjustment (recovery_required) instead of silently
--    editing or deleting paid earnings.
-- 4. Minor->major conversion is exponent-aware (0/2/3 decimal), and
--    driver_earnings money columns widen to numeric(18,4) so three-decimal
--    currencies are stored without rounding.
--
-- Forward-only. Defensive IF NOT EXISTS / CREATE OR REPLACE.
-- =============================================================================
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.customer_receivables') IS NULL
     OR to_regclass('public.cancellation_policies') IS NULL
     OR to_regclass('public.driver_earnings') IS NULL
     OR to_regclass('public.jobs') IS NULL
     OR to_regclass('public.cancellation_compensation_events') IS NULL
     OR to_regprocedure('public.wallet_currency_minor_exponent(text)') IS NULL THEN
    RAISE EXCEPTION 'Cancellation compensation acceptance prerequisites missing';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Three-decimal-safe earnings storage (matches major_money_scale's widening).
-- ---------------------------------------------------------------------------
ALTER TABLE public.driver_earnings
  ALTER COLUMN amount TYPE numeric(18,4),
  ALTER COLUMN platform_fee TYPE numeric(18,4),
  ALTER COLUMN gross_amount TYPE numeric(18,4);

-- ---------------------------------------------------------------------------
-- Exponent-aware minor -> major conversion (0/2/3 decimal currencies).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.minor_to_major(p_minor bigint, p_currency text)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS
$$ SELECT p_minor::numeric / power(10::numeric, public.wallet_currency_minor_exponent(p_currency)) $$;

-- ---------------------------------------------------------------------------
-- Events carry canonical identity + recovery state; dedupe is the full triple
-- (provider, merchant, environment) plus provider reference.
-- ---------------------------------------------------------------------------
ALTER TABLE public.cancellation_compensation_events
  ADD COLUMN IF NOT EXISTS merchant_account_ref text,
  ADD COLUMN IF NOT EXISTS environment text CHECK (environment IN ('test','live')),
  ADD COLUMN IF NOT EXISTS recovery_required boolean NOT NULL DEFAULT false;
DROP INDEX IF EXISTS cancellation_compensation_events_dedupe;
CREATE UNIQUE INDEX cancellation_compensation_events_dedupe
  ON public.cancellation_compensation_events
    (coalesce(provider,''), coalesce(merchant_account_ref,''), coalesce(environment,''), provider_reference)
  WHERE provider_reference IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Settlement authority (idempotent, environment/merchant-bound).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_cancellation_compensation(
  p_receivable uuid,
  p_collected_minor bigint,
  p_payment_reference text,
  p_provider text DEFAULT NULL,
  p_merchant_account_ref text DEFAULT NULL,
  p_environment text DEFAULT 'test'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  r customer_receivables%ROWTYPE;
  pol cancellation_policies%ROWTYPE;
  v_event_id uuid;
  v_net bigint; v_comp bigint; v_platform bigint; v_delta_comp bigint; v_delta_platform bigint;
  v_comp_major numeric; v_platform_major numeric; v_gross_major numeric;
BEGIN
  IF p_receivable IS NULL THEN RAISE EXCEPTION 'Receivable required' USING ERRCODE='CC001'; END IF;
  IF p_collected_minor IS NULL OR p_collected_minor <= 0 THEN RAISE EXCEPTION 'Collected amount must be positive' USING ERRCODE='CC001'; END IF;

  SELECT * INTO r FROM customer_receivables WHERE id = p_receivable FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receivable not found' USING ERRCODE='CC002'; END IF;

  -- Replay: the same (provider, merchant, environment, reference) converges.
  IF p_provider IS NOT NULL AND p_payment_reference IS NOT NULL THEN
    SELECT id INTO v_event_id FROM cancellation_compensation_events
     WHERE provider = p_provider
       AND merchant_account_ref IS NOT DISTINCT FROM p_merchant_account_ref
       AND environment IS NOT DISTINCT FROM p_environment
       AND provider_reference = p_payment_reference;
    IF FOUND THEN RETURN jsonb_build_object('status','already_settled','event_id',v_event_id); END IF;
  END IF;

  -- Frozen policy only. A missing/irresolvable version is routed to review —
  -- the fee is still recorded as collected, but no compensation is computed.
  SELECT * INTO pol FROM public.cancellation_compensation_policy(p_receivable);
  IF NOT FOUND OR pol.compensation_funding IS DISTINCT FROM 'on_collection'
     OR r.driver_id IS NULL OR r.job_id IS NULL THEN
    UPDATE customer_receivables
       SET status='paid', review_required=true, resolved_at=now(),
           collected_minor = collected_minor + p_collected_minor,
           payment_reference = COALESCE(p_payment_reference, payment_reference),
           payment_provider = COALESCE(p_provider, payment_provider),
           merchant_account_ref = COALESCE(p_merchant_account_ref, merchant_account_ref)
     WHERE id = p_receivable;
    INSERT INTO cancellation_compensation_events(receivable_id,kind,amount_minor,provider,merchant_account_ref,environment,provider_reference)
      VALUES(p_receivable,'collection',p_collected_minor,p_provider,p_merchant_account_ref,p_environment,p_payment_reference)
      ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('status','review_required','collected_minor',p_collected_minor,
      'driver_compensation_minor',0,'platform_share_minor',0);
  END IF;

  -- Cumulative bounds: never collect more than the charged fee.
  IF r.collected_minor + p_collected_minor > r.amount_minor THEN
    RAISE EXCEPTION 'Collected amount exceeds the charged fee' USING ERRCODE='CC004';
  END IF;

  v_net := r.collected_minor + p_collected_minor - r.refunded_minor;
  v_comp := floor(v_net::numeric * pol.driver_compensation_percent / 100)::bigint;
  v_platform := v_net - v_comp;
  v_delta_comp := v_comp - r.compensation_minor;
  v_delta_platform := v_platform - r.platform_share_minor;

  v_comp_major := public.minor_to_major(v_comp, r.currency_code);
  v_platform_major := public.minor_to_major(v_platform, r.currency_code);
  v_gross_major := public.minor_to_major(v_net, r.currency_code);

  INSERT INTO public.driver_earnings
    (driver_id, job_id, amount, platform_fee, gross_amount, status, currency_code, country_code, settlement_purpose, settled_at)
  VALUES
    (r.driver_id, r.job_id, v_comp_major, v_platform_major, v_gross_major, 'pending',
     r.currency_code, coalesce(r.market_code, 'GB'), 'cancellation_compensation', now())
  ON CONFLICT (job_id) DO UPDATE SET
    amount = EXCLUDED.amount,
    platform_fee = EXCLUDED.platform_fee,
    gross_amount = EXCLUDED.gross_amount,
    status = 'pending',
    currency_code = EXCLUDED.currency_code,
    country_code = EXCLUDED.country_code,
    settlement_purpose = 'cancellation_compensation',
    settled_at = COALESCE(driver_earnings.settled_at, now())
  WHERE driver_earnings.settlement_purpose = 'cancellation_compensation'
    AND driver_earnings.status IS DISTINCT FROM 'paid';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Existing earnings for this job have a different purpose or are already paid; reconciliation required' USING ERRCODE='CC005';
  END IF;

  INSERT INTO cancellation_compensation_events
    (receivable_id,kind,amount_minor,provider,merchant_account_ref,environment,provider_reference,compensation_delta_minor,platform_delta_minor)
  VALUES
    (p_receivable,'collection',p_collected_minor,p_provider,p_merchant_account_ref,p_environment,p_payment_reference,v_delta_comp,v_delta_platform)
  RETURNING id INTO v_event_id;

  UPDATE customer_receivables
     SET status='paid', review_required=false, resolved_at=now(),
         collected_minor = r.collected_minor + p_collected_minor,
         compensation_minor = v_comp,
         platform_share_minor = v_platform,
         payment_reference = COALESCE(p_payment_reference, payment_reference),
         payment_provider = COALESCE(p_provider, payment_provider),
         merchant_account_ref = COALESCE(p_merchant_account_ref, merchant_account_ref)
   WHERE id = p_receivable;

  RETURN jsonb_build_object(
    'status','settled','event_id',v_event_id,
    'collected_minor', p_collected_minor,
    'driver_compensation_minor', v_comp,
    'platform_share_minor', v_platform,
    'policy_version', pol.version);
END;
$$;

-- ---------------------------------------------------------------------------
-- Reversal authority: confirmed refund reduces compensation. Paid history is
-- preserved (never edited/deleted); a refund after payout records a linked
-- recovery adjustment instead. Cumulative and bounded.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_cancellation_compensation(
  p_receivable uuid,
  p_refund_minor bigint,
  p_refund_reference text,
  p_provider text DEFAULT NULL,
  p_merchant_account_ref text DEFAULT NULL,
  p_environment text DEFAULT 'test'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  r customer_receivables%ROWTYPE;
  pol cancellation_policies%ROWTYPE;
  v_event_id uuid; v_linked uuid; v_earnings_status text; v_recovery boolean := false;
  v_net bigint; v_comp bigint; v_platform bigint; v_delta_comp bigint; v_delta_platform bigint;
  v_comp_major numeric; v_platform_major numeric; v_gross_major numeric;
BEGIN
  IF p_receivable IS NULL THEN RAISE EXCEPTION 'Receivable required' USING ERRCODE='CC001'; END IF;
  IF p_refund_minor IS NULL OR p_refund_minor <= 0 THEN RAISE EXCEPTION 'Refund amount must be positive' USING ERRCODE='CC001'; END IF;

  SELECT * INTO r FROM customer_receivables WHERE id = p_receivable FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receivable not found' USING ERRCODE='CC002'; END IF;

  IF p_provider IS NOT NULL AND p_refund_reference IS NOT NULL THEN
    SELECT id INTO v_event_id FROM cancellation_compensation_events
     WHERE provider = p_provider
       AND merchant_account_ref IS NOT DISTINCT FROM p_merchant_account_ref
       AND environment IS NOT DISTINCT FROM p_environment
       AND provider_reference = p_refund_reference;
    IF FOUND THEN RETURN jsonb_build_object('status','already_reversed','event_id',v_event_id); END IF;
  END IF;

  -- Never refund more than was collected.
  IF r.refunded_minor + p_refund_minor > r.collected_minor THEN
    RAISE EXCEPTION 'Refund exceeds the collected amount' USING ERRCODE='CC006';
  END IF;

  SELECT * INTO pol FROM public.cancellation_compensation_policy(p_receivable);
  IF NOT FOUND OR pol.compensation_funding IS DISTINCT FROM 'on_collection' THEN
    UPDATE customer_receivables SET review_required=true WHERE id = p_receivable;
    RETURN jsonb_build_object('status','review_required');
  END IF;

  v_net := r.collected_minor - (r.refunded_minor + p_refund_minor);
  v_comp := floor(v_net::numeric * pol.driver_compensation_percent / 100)::bigint;
  v_platform := v_net - v_comp;
  v_delta_comp := v_comp - r.compensation_minor;
  v_delta_platform := v_platform - r.platform_share_minor;

  v_comp_major := public.minor_to_major(v_comp, r.currency_code);
  v_platform_major := public.minor_to_major(v_platform, r.currency_code);
  v_gross_major := public.minor_to_major(v_net, r.currency_code);

  -- Preserve paid history: a refund after payout must NOT edit/delete the paid
  -- earnings row — it records a linked recovery adjustment instead.
  IF r.job_id IS NOT NULL AND r.driver_id IS NOT NULL THEN
    SELECT status INTO v_earnings_status FROM driver_earnings WHERE job_id = r.job_id;
    IF v_earnings_status = 'paid' THEN
      v_recovery := true;
    ELSE
      INSERT INTO public.driver_earnings
        (driver_id, job_id, amount, platform_fee, gross_amount, status, currency_code, country_code, settlement_purpose, settled_at)
      VALUES
        (r.driver_id, r.job_id, v_comp_major, v_platform_major, v_gross_major, 'pending',
         r.currency_code, coalesce(r.market_code, 'GB'), 'cancellation_compensation', now())
      ON CONFLICT (job_id) DO UPDATE SET
        amount = EXCLUDED.amount,
        platform_fee = EXCLUDED.platform_fee,
        gross_amount = EXCLUDED.gross_amount,
        status = 'pending',
        settlement_purpose = 'cancellation_compensation',
        settled_at = COALESCE(driver_earnings.settled_at, now())
      WHERE driver_earnings.settlement_purpose = 'cancellation_compensation'
        AND driver_earnings.status IS DISTINCT FROM 'paid';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Existing earnings for this job have a different purpose or are already paid; reconciliation required' USING ERRCODE='CC005';
      END IF;
    END IF;
  END IF;

  SELECT id INTO v_linked FROM cancellation_compensation_events
   WHERE receivable_id = p_receivable AND kind = 'collection'
   ORDER BY created_at DESC, id DESC LIMIT 1;

  INSERT INTO cancellation_compensation_events
    (receivable_id,kind,amount_minor,provider,merchant_account_ref,environment,provider_reference,linked_event_id,recovery_required,compensation_delta_minor,platform_delta_minor)
  VALUES
    (p_receivable,'refund',p_refund_minor,p_provider,p_merchant_account_ref,p_environment,p_refund_reference,v_linked,v_recovery,v_delta_comp,v_delta_platform)
  RETURNING id INTO v_event_id;

  UPDATE customer_receivables
     SET refunded_minor = r.refunded_minor + p_refund_minor,
         compensation_minor = v_comp,
         platform_share_minor = v_platform,
         review_required = false,
         resolved_at = now()
   WHERE id = p_receivable;

  RETURN jsonb_build_object(
    'status','reversed','event_id',v_event_id,'recovery_required',v_recovery,
    'driver_compensation_minor', v_comp,
    'platform_share_minor', v_platform);
END;
$$;

-- Drop the 641 five-argument overloads; this migration is the authority.
DROP FUNCTION IF EXISTS public.settle_cancellation_compensation(uuid,bigint,text,text,text);
DROP FUNCTION IF EXISTS public.reverse_cancellation_compensation(uuid,bigint,text,text,text);

REVOKE ALL ON FUNCTION public.settle_cancellation_compensation(uuid,bigint,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reverse_cancellation_compensation(uuid,bigint,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_cancellation_compensation(uuid,bigint,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_cancellation_compensation(uuid,bigint,text,text,text,text) TO service_role;

COMMIT;
