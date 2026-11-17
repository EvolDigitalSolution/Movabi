-- Customer wallet collection → booking wallet bridge.
--
-- The batch-1 collection orchestration (initiate_wallet_topup →
-- freeze_wallet_topup_fee → provider-bound reference →
-- confirm_wallet_topup[_with_total]) credits the wallet_accounts ledger for
-- destination_account_purpose='customer_credit'. However, the booking wallet
-- (public.wallets + public.wallet_transactions) is the only balance
-- pay_job_from_wallet can reserve and settle against, and nothing moved a
-- verified customer collection into it. The legacy direct top-up RPC
-- (credit_wallet_topup) is retired at the API boundary (410) and must not be
-- re-exposed: it bypassed attempt binding, fee freeze, provider verification
-- and merchant-account checks.
--
-- This migration completes the intended path at the authoritative point: the
-- attempt's transition to 'credited'. Both confirm RPCs set status='credited'
-- inside the same transaction that posts the wallet business event, so this
-- trigger makes the booking-wallet credit atomic with the ledger credit —
-- either both exist or neither does. It covers new attempts, legacy attempts
-- and any future crediting path.
--
-- Safety properties:
--   * ONLY 'customer_credit' attempts bridge. driver_cash_credit stays on the
--     driver-side ledger (never substitutes for customer wallet funding).
--   * Exactly once per attempt: the trigger only fires on a transition INTO
--     'credited' and the bridge row's unique event_key dedupes any replay.
--   * provider_reference is bound and verified before 'credited' is reached,
--     so the topup row carries the authoritative provider identity; the
--     chk_topup_requires_stripe invariant is satisfied by recording it in
--     stripe_payment_intent_id (the legacy "provider payment reference"
--     column for booking-wallet top-ups).
--   * Currency mismatch or a missing wallet raises: the whole credit
--     transaction (ledger event included) rolls back, so money is never
--     silently stranded; reconciliation can repair and retry the idempotent
--     confirm.
--   * Amount units: attempt.amount_minor is minor units at fee_exponent
--     granularity; wallets/wallet_transactions are major units — converted
--     via wallet_currency_minor_exponent.

CREATE OR REPLACE FUNCTION public.bridge_customer_wallet_topup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_wallet public.wallets%ROWTYPE;
  v_exponent integer;
  v_amount numeric(12,2);
  v_event_key text;
BEGIN
  -- Only the transition INTO credited, and only customer funds.
  IF TG_OP = 'UPDATE' AND OLD.status = 'credited' THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'credited'
     OR NEW.credited_event_id IS NULL
     OR NEW.destination_account_purpose <> 'customer_credit' THEN
    RETURN NEW;
  END IF;

  v_event_key := 'wallet-topup-booking:' || NEW.id::text;

  -- Replay/stray-write safety: one booking credit per attempt.
  IF EXISTS (SELECT 1 FROM public.wallet_transactions WHERE event_key = v_event_key) THEN
    RETURN NEW;
  END IF;

  v_exponent := public.wallet_currency_minor_exponent(NEW.currency_code);
  v_amount := (NEW.amount_minor::numeric / (10::numeric ^ v_exponent))::numeric(12,2);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Wallet top-up bridge: non-positive amount % minor for attempt %', NEW.amount_minor, NEW.id
      USING ERRCODE = 'BP009';
  END IF;

  INSERT INTO public.wallets (user_id, available_balance, reserved_balance, currency_code)
  VALUES (NEW.owner_id, 0, 0, NEW.currency_code)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_wallet FROM public.wallets WHERE user_id = NEW.owner_id FOR UPDATE;
  IF v_wallet.currency_code <> NEW.currency_code THEN
    RAISE EXCEPTION 'Wallet top-up bridge: wallet currency % does not match attempt currency % for attempt %',
      v_wallet.currency_code, NEW.currency_code, NEW.id
      USING ERRCODE = 'BP009';
  END IF;

  UPDATE public.wallets
  SET available_balance = available_balance + v_amount,
      updated_at = now()
  WHERE id = v_wallet.id;

  INSERT INTO public.wallet_transactions (
    wallet_id, user_id, job_id, transaction_type, amount,
    balance_before_available, balance_after_available,
    balance_before_reserved, balance_after_reserved,
    description, metadata,
    stripe_payment_intent_id,
    tenant_id, currency_code, amount_minor,
    balance_purpose, payment_provider, merchant_account_ref,
    provider_reference, event_key
  ) VALUES (
    v_wallet.id, NEW.owner_id, NULL, 'topup', v_amount,
    v_wallet.available_balance, v_wallet.available_balance + v_amount,
    v_wallet.reserved_balance, v_wallet.reserved_balance,
    'Customer wallet top-up',
    jsonb_build_object(
      'source', 'wallet_collection',
      'attemptId', NEW.id,
      'creditedEventId', NEW.credited_event_id,
      'feePolicyVersion', NEW.fee_policy_version,
      'totalChargeMinor', NEW.total_charge_minor),
    COALESCE(NEW.provider_reference, NEW.id::text),
    NEW.tenant_id, NEW.currency_code, NEW.amount_minor,
    'customer_credit', NEW.payment_provider, NEW.merchant_account_ref,
    NEW.provider_reference, v_event_key
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet_topup_customer_credit_bridge ON public.wallet_topup_attempts;
CREATE TRIGGER trg_wallet_topup_customer_credit_bridge
  AFTER UPDATE ON public.wallet_topup_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.bridge_customer_wallet_topup();

REVOKE ALL ON FUNCTION public.bridge_customer_wallet_topup() FROM PUBLIC;
GRANT ALL ON FUNCTION public.bridge_customer_wallet_topup() TO postgres;
GRANT ALL ON FUNCTION public.bridge_customer_wallet_topup() TO service_role;
