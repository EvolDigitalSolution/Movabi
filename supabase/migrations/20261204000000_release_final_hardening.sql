-- ============================================================================
-- MOVABI 2.1 — FINAL RELEASE HARDENING (forward-only, schema-qualified)
-- ============================================================================
-- Addresses the remaining Phase C release blockers:
--   1. acquisition requires payment eligibility (active execution gate);
--   2. completion PIN is moved out of jobs.metadata into a customer-only store;
--   3. wallet errands no longer conflate purchase budget with service fare;
--   4. the hardcoded 10% calculate_job_payouts trigger is retired.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Retire the hardcoded-10% payout trigger. completeJob +
--    MarketplaceConfigService are the single commission/payout authority.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS tr_calculate_job_payouts ON public.jobs;
DROP FUNCTION IF EXISTS public.calculate_job_payouts();

-- ----------------------------------------------------------------------------
-- 2. Acquisition payment-eligibility gate. A job may not enter ACTIVE driver
--    execution (status assigned/accepted) unless its server/database payment
--    state is eligible. The negotiation LOCK state (fare_agreed) is explicitly
--    allowed pre-payment. This single trigger covers every path that writes
--    driver_id/status (RPCs, admin, and any future path).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_job_payment_eligibility()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.driver_id IS NOT NULL
       AND OLD.driver_id IS DISTINCT FROM NEW.driver_id
       AND NEW.status IN ('assigned', 'accepted') THEN
        IF NEW.payment_status NOT IN (
            'paid', 'wallet_funded', 'authorized', 'requires_capture', 'succeeded', 'captured'
        ) THEN
            RAISE EXCEPTION 'Job is not payment-eligible for driver acquisition'
                USING ERRCODE = 'MB003',
                      DETAIL = 'payment_eligibility';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_job_payment_eligibility ON public.jobs;
CREATE TRIGGER trg_enforce_job_payment_eligibility
    BEFORE UPDATE OF driver_id, status ON public.jobs
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_job_payment_eligibility();

-- ----------------------------------------------------------------------------
-- 3. Wallet errand budget separation. pay_job_from_wallet must NOT overwrite
--    jobs.total_price with the full authorisation (service fare + shopping
--    budget). The service fare already set at booking create remains the
--    commission/payout basis; total_price is only back-filled when absent.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pay_job_from_wallet(
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
  FROM public.jobs
  WHERE id = p_job_id
    AND customer_id = p_customer_id
  FOR UPDATE;

  IF v_job IS NULL THEN
    RAISE EXCEPTION 'Job not found for wallet payment';
  END IF;

  -- C2C idempotency: prove that THIS wallet operation already occurred.
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

  INSERT INTO public.wallets (user_id, currency_code)
  VALUES (p_customer_id, COALESCE(p_currency_code, 'GBP'))
  ON CONFLICT (user_id) DO NOTHING;

  SELECT id, available_balance
  INTO v_wallet_id, v_available
  FROM public.wallets
  WHERE user_id = p_customer_id
  FOR UPDATE;

  IF v_available IS NULL OR v_available < v_amount THEN
    RAISE EXCEPTION 'Insufficient wallet balance. Required: %, Available: %', v_amount, COALESCE(v_available, 0);
  END IF;

  UPDATE public.wallets
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
      'INSERT INTO public.wallet_transactions (wallet_id, user_id, job_id, amount, %I, description, metadata)
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
      'INSERT INTO public.wallet_transactions (user_id, job_id, amount, %I, description, metadata)
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

  UPDATE public.jobs
  SET payment_status = 'wallet_funded',
      payment_method = 'wallet',
      payment_intent_id = NULL,
      -- Release closure: NEVER inflate the payout basis with the reserved
      -- shopping budget. total_price stays the service fare.
      total_price = COALESCE(total_price, v_amount),
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

-- ----------------------------------------------------------------------------
-- 4. Completion secret isolation. The completion PIN lives in a customer-only
--    RLS table, never in jobs.metadata (which is SELECTed wholesale by the
--    driver). service_role (server) reads/verifies it; the customer SELECTs
--    only their own row; the driver has no path to it.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_completion_secrets (
    job_id UUID PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
    completion_pin TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.job_completion_secrets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Customers can view own completion pin" ON public.job_completion_secrets;
CREATE POLICY "Customers can view own completion pin"
    ON public.job_completion_secrets FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.jobs j
        WHERE j.id = job_completion_secrets.job_id
          AND j.customer_id = auth.uid()
    ));

REVOKE ALL ON public.job_completion_secrets FROM anon, authenticated;
GRANT SELECT ON public.job_completion_secrets TO authenticated;
