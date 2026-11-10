-- ============================================================================
-- MOVABI PHASE C2C — SETTLEMENT IDEMPOTENCY (wallet payment retry)
-- ============================================================================
--
-- Forward-only. Idempotent (CREATE OR REPLACE). Does NOT touch recovered
-- historical migrations, the C2B ACL migration, N12, MB001/MB002, or Phase A.
--
-- PROBLEM PROVEN (C0/C2): public.pay_job_from_wallet had NO durable per-job
-- boundary. A repeated or concurrent call re-debited available_balance and
-- re-inserted a 'reservation' ledger row, because the only guard was the job
-- status ('cancelled'/'completed'), which a wallet-funded job does NOT match.
-- C2B restricted the RPC to service_role, but ACL alone is not idempotency.
--
-- FIX: inside the existing SELECT ... FOR UPDATE on jobs, short-circuit when the
-- job is already wallet-funded/settled. The row lock serializes concurrent
-- callers, so exactly one caller performs the debit; every later caller returns
-- an idempotent 'already_paid' result without moving money again.
--
-- PRESERVED: signature, INVOKER semantics (service_role caller), the wallet
-- debit/reserve shape, the reservation ledger insert, and the jobs update.
-- ACL is NOT changed (C2B keeps it service_role-only).
-- ============================================================================

CREATE OR REPLACE FUNCTION pay_job_from_wallet(
  p_job_id UUID,
  p_customer_id UUID,
  p_amount NUMERIC,
  p_currency_code TEXT DEFAULT 'GBP',
  p_tenant_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_available NUMERIC;
  v_wallet_id UUID;
  v_job RECORD;
  v_amount NUMERIC := ROUND(COALESCE(p_amount, 0)::NUMERIC, 2);
  v_tx_type_col TEXT;
  v_has_wallet_id BOOLEAN;
BEGIN
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Wallet payment amount must be greater than zero';
  END IF;

  SELECT *
  INTO v_job
  FROM jobs
  WHERE id = p_job_id
    AND customer_id = p_customer_id
  FOR UPDATE;

  IF v_job IS NULL THEN
    RAISE EXCEPTION 'Job not found for wallet payment';
  END IF;

  -- C2C idempotency: prove that THIS wallet operation already occurred, not
  -- merely that some payment completed. jobs.payment_method is the durable,
  -- wallet-exclusive method marker (this RPC writes 'wallet' atomically with the
  -- reservation debit; the card flow writes 'card' at create-intent). A generic
  -- 'paid' is NOT used because a card-paid job also reaches payment_status='paid'
  -- while payment_method='card'. 'wallet_funded' is likewise wallet-exclusive,
  -- so either signal is safe; a card job satisfies neither and is rejected by
  -- the status guard below instead of returning a false wallet 'already_paid'.
  IF v_job.payment_method = 'wallet' OR v_job.payment_status = 'wallet_funded' THEN
    RETURN jsonb_build_object(
      'status', 'already_paid',
      'job_id', p_job_id,
      'payment_method', 'wallet'
    );
  END IF;

  IF v_job.status IN ('cancelled', 'completed') THEN
    RAISE EXCEPTION 'Wallet payment is not available for this job status';
  END IF;

  INSERT INTO wallets (user_id, currency_code)
  VALUES (p_customer_id, COALESCE(p_currency_code, 'GBP'))
  ON CONFLICT (user_id) DO NOTHING;

  SELECT id, available_balance
  INTO v_wallet_id, v_available
  FROM wallets
  WHERE user_id = p_customer_id
  FOR UPDATE;

  IF v_available IS NULL OR v_available < v_amount THEN
    RAISE EXCEPTION 'Insufficient wallet balance. Required: %, Available: %', v_amount, COALESCE(v_available, 0);
  END IF;

  UPDATE wallets
  SET available_balance = available_balance - v_amount,
      reserved_balance = COALESCE(reserved_balance, 0) + v_amount,
      updated_at = NOW()
  WHERE id = v_wallet_id;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'wallet_transactions'
        AND column_name = 'transaction_type'
    ) THEN 'transaction_type'
    ELSE 'type'
  END INTO v_tx_type_col;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'wallet_transactions'
      AND column_name = 'wallet_id'
  ) INTO v_has_wallet_id;

  IF v_has_wallet_id THEN
    EXECUTE format(
      'INSERT INTO wallet_transactions (wallet_id, user_id, job_id, amount, %I, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)',
      v_tx_type_col
    )
    USING
      v_wallet_id,
      p_customer_id,
      p_job_id,
      v_amount,
      'reservation',
      'Job payment reserved from wallet',
      jsonb_build_object(
        'currency_code', COALESCE(p_currency_code, 'GBP'),
        'tenant_id', p_tenant_id,
        'payment_method', 'wallet'
      );
  ELSE
    EXECUTE format(
      'INSERT INTO wallet_transactions (user_id, job_id, amount, %I, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)',
      v_tx_type_col
    )
    USING
      p_customer_id,
      p_job_id,
      v_amount,
      'reservation',
      'Job payment reserved from wallet',
      jsonb_build_object(
        'currency_code', COALESCE(p_currency_code, 'GBP'),
        'tenant_id', p_tenant_id,
        'payment_method', 'wallet'
      );
  END IF;

  UPDATE jobs
  SET payment_status = 'wallet_funded',
      payment_method = 'wallet',
      payment_intent_id = NULL,
      total_price = v_amount,
      price = COALESCE(price, v_amount),
      confirmed_at = NOW(),
      updated_at = NOW()
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'job_id', p_job_id,
    'amount', v_amount,
    'payment_method', 'wallet'
  );
END;
$$ LANGUAGE plpgsql;
