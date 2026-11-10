-- =============================================================================
-- Cancellation-fee compensation settlement.
--
-- THE MISSING CONNECTION. The approved policy (driver_compensation_percent=80,
-- compensation_funding='on_collection') is persisted by publish_cancellation_policy,
-- and customer_receivables records the charged fee as debt. Nothing, however,
-- connected a COLLECTED fee to compensation accounting: the debt webhook marks a
-- receivable `paid` and then stops — no driver compensation, no platform share,
-- no wallet ledger entry, no replay guard, no reversal.
--
-- This migration adds the server-only authority that, for a collected fee,
--   * resolves the versioned policy used when the fee was charged,
--   * computes driver = floor(collected * percent / 100), platform = remainder,
--   * enforces on_collection funding: an uncollected fee posts NO spendable
--     compensation (the driver's `compensation` account stays at zero),
--   * posts the split through the canonical batch-1B double-entry ledger
--     (post_wallet_event), so replay is idempotent and reversal is a linked,
--     exact negation.
--
-- Balanced legs (owner = driver, currency = receivable currency):
--   compensation                +driver_compensation_minor   (spendable)
--   platform_share              +platform_share_minor
--   cancellation_fee_collected  -collected_minor             (clearing source)
--
-- Forward-only. Defensive IF NOT EXISTS / CREATE OR REPLACE.
-- =============================================================================
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.cancellation_policies') IS NULL
     OR to_regclass('public.customer_receivables') IS NULL
     OR to_regclass('public.wallet_business_events') IS NULL
     OR to_regclass('public.wallet_accounts') IS NULL
     OR to_regclass('public.wallet_movements') IS NULL
     OR to_regprocedure('public.post_wallet_event(text,text,uuid,uuid,text,jsonb,text,text,text,uuid)') IS NULL
     OR to_regprocedure('public.post_wallet_reversal(text,text)') IS NULL THEN
    RAISE EXCEPTION 'Cancellation compensation prerequisites missing (cancellation_policies, customer_receivables, batch-1B wallet ledger)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Settlement authority: collected fee -> driver compensation + platform share.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_cancellation_compensation(
  p_receivable uuid,
  p_driver uuid,
  p_collected_minor bigint,
  p_market text,
  p_payment_reference text DEFAULT NULL,
  p_provider text DEFAULT NULL,
  p_merchant_account_ref text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  r customer_receivables%ROWTYPE;
  pol cancellation_policies%ROWTYPE;
  v_event_key text;
  v_event uuid;
  v_comp bigint;
  v_platform bigint;
BEGIN
  IF p_receivable IS NULL OR p_driver IS NULL THEN
    RAISE EXCEPTION 'Compensation requires a receivable and a driver' USING ERRCODE = 'CC001';
  END IF;
  IF p_collected_minor IS NULL OR p_collected_minor < 0 THEN
    RAISE EXCEPTION 'Collected amount must be >= 0' USING ERRCODE = 'CC001';
  END IF;

  SELECT * INTO r FROM customer_receivables WHERE id = p_receivable FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receivable not found' USING ERRCODE = 'CC002';
  END IF;

  -- Replay first: a duplicate collection/settlement returns the recorded event
  -- and posts nothing new (post_wallet_event would also reject a reuse with
  -- different terms, but we short-circuit cleanly for the server caller).
  v_event_key := 'cancellation-comp:' || p_receivable::text;
  SELECT id INTO v_event FROM wallet_business_events WHERE event_key = v_event_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'already_settled',
      'event_id', v_event,
      'collected_minor', r.amount_minor,
      'driver_compensation_minor', 0,
      'platform_share_minor', 0);
  END IF;

  -- on_collection: an uncollected fee funds nothing. No spendable compensation.
  IF r.status IN ('waived','written_off') OR p_collected_minor = 0 THEN
    RETURN jsonb_build_object(
      'status', 'uncollected',
      'collected_minor', 0,
      'driver_compensation_minor', 0,
      'platform_share_minor', 0);
  END IF;

  -- The collected amount cannot exceed the fee that was actually charged.
  IF p_collected_minor > r.amount_minor THEN
    RAISE EXCEPTION 'Collected amount exceeds the charged fee' USING ERRCODE = 'CC004';
  END IF;

  -- Resolve the versioned policy snapshot used when the fee was charged,
  -- falling back to the active policy for legacy receivables without a version.
  SELECT * INTO pol
    FROM cancellation_policies
   WHERE tenant_id = r.tenant_id AND market_code = p_market
     AND version = r.policy_version AND enabled;
  IF NOT FOUND THEN
    SELECT * INTO pol FROM active_cancellation_policy(r.tenant_id, p_market);
    IF NOT FOUND OR pol.id IS NULL THEN
      RAISE EXCEPTION 'No enabled cancellation policy for market %', p_market USING ERRCODE = 'CC003';
    END IF;
  END IF;

  IF pol.compensation_funding IS DISTINCT FROM 'on_collection' THEN
    RAISE EXCEPTION 'Compensation funding model % is not implemented', pol.compensation_funding USING ERRCODE = 'CC003';
  END IF;

  -- 80/20 split; platform absorbs the rounding remainder.
  v_comp := floor(p_collected_minor::numeric * pol.driver_compensation_percent / 100)::bigint;
  v_platform := p_collected_minor - v_comp;

  -- Post the balanced, replay-safe ledger event (the canonical batch-1B
  -- authority). External collection carries the provider/merchant/reference
  -- triple; internal collection carries none.
  v_event := public.post_wallet_event(
    v_event_key,
    'cancellation_compensation',
    r.tenant_id,
    p_driver,
    r.currency_code,
    jsonb_build_array(
      jsonb_build_object('accountPurpose', 'compensation',              'amountMinor', v_comp),
      jsonb_build_object('accountPurpose', 'platform_share',            'amountMinor', v_platform),
      jsonb_build_object('accountPurpose', 'cancellation_fee_collected','amountMinor', -p_collected_minor)
    ),
    p_provider, p_merchant_account_ref, p_payment_reference, NULL);

  -- Mark the receivable collected with the verified reference/binding triple.
  UPDATE customer_receivables
     SET status = 'paid',
         payment_reference   = COALESCE(p_payment_reference, payment_reference),
         payment_provider    = COALESCE(p_provider, payment_provider),
         merchant_account_ref = COALESCE(p_merchant_account_ref, merchant_account_ref),
         resolved_at = now()
   WHERE id = p_receivable;

  RETURN jsonb_build_object(
    'status', 'settled',
    'event_id', v_event,
    'collected_minor', p_collected_minor,
    'driver_compensation_minor', v_comp,
    'platform_share_minor', v_platform,
    'policy_version', pol.version);
END;
$$;

-- ---------------------------------------------------------------------------
-- Reversal authority: posts the exact negation of a recorded compensation
-- settlement with a linked reverses_event_id (controlled batch-1B reversal).
-- Retry with the same key is idempotent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_cancellation_compensation(p_receivable uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_key text;
  v_event uuid;
BEGIN
  IF p_receivable IS NULL THEN
    RAISE EXCEPTION 'Receivable is required' USING ERRCODE = 'CC001';
  END IF;
  v_key := 'cancellation-comp:' || p_receivable::text;
  v_event := public.post_wallet_reversal(v_key, v_key || ':reverse');
  RETURN jsonb_build_object('status', 'reversed', 'event_id', v_event);
END;
$$;

-- Server-only: the compensation and reversal authorities are never callable by
-- clients; only the service role (and the postgres owner) may execute them.
REVOKE ALL ON FUNCTION public.settle_cancellation_compensation(uuid,uuid,bigint,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reverse_cancellation_compensation(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_cancellation_compensation(uuid,uuid,bigint,text,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_cancellation_compensation(uuid)
  TO service_role;

COMMIT;
