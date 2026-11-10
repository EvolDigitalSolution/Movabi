-- ============================================================================
-- MOVABI 2.1 — FINAL WALLET-ERRAND SETTLEMENT ECONOMICS (forward-only)
-- ============================================================================
-- Closes the one remaining money-accuracy nuance: settle_job_wallet_reservation
-- conflated the authoritative SERVICE fare with the customer PURCHASE budget by
-- capping v_amount (service fare) to actual_spending.
--
-- Correct model:
--   TOTAL customer settlement = authoritative service fare + actual shopping spend
--   UNUSED purchase budget = reserved budget - actual spend (released to customer)
--   DRIVER payout basis = service fare only
--
-- This CREATE OR REPLACE replaces ONLY the errand branch. Non-errand wallet
-- settlement, the ledger shape, the errand_funding marker, idempotency
-- (already_settled), C2C already_paid, and the ACL are preserved unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.settle_job_wallet_reservation(
    p_job_id UUID,
    p_amount NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_job RECORD;
    v_wallet RECORD;
    v_funding RECORD;
    v_amount NUMERIC;
    v_reserved NUMERIC;
    v_available NUMERIC;
    v_job_reserved NUMERIC;
    v_reservation_amount NUMERIC;
    v_settlement_amount NUMERIC;
    v_refund_amount NUMERIC;
    v_actual_spending NUMERIC := 0;
    v_budget NUMERIC := 0;
    v_service_slug TEXT;
    v_available_before NUMERIC;
    v_reserved_before NUMERIC;
    v_available_after_settlement NUMERIC;
    v_reserved_after_settlement NUMERIC;
    v_available_after_release NUMERIC;
    v_reserved_after_release NUMERIC;
    v_now TIMESTAMPTZ := NOW();
BEGIN
    IF p_job_id IS NULL THEN
        RAISE EXCEPTION 'p_job_id is required';
    END IF;

    v_amount := ROUND(COALESCE(p_amount, 0)::NUMERIC, 2);

    IF v_amount <= 0 THEN
        RAISE EXCEPTION 'Wallet settlement amount must be greater than zero';
    END IF;

    SELECT *
    INTO v_job
    FROM public.jobs
    WHERE id = p_job_id
    FOR UPDATE;

    IF v_job IS NULL THEN
        RAISE EXCEPTION 'Job not found for wallet settlement';
    END IF;

    IF v_job.customer_id IS NULL THEN
        RAISE EXCEPTION 'Job has no customer to settle against';
    END IF;

    SELECT *
    INTO v_wallet
    FROM public.wallets
    WHERE user_id = v_job.customer_id
    FOR UPDATE;

    IF v_wallet IS NULL THEN
        RETURN jsonb_build_object('status', 'not_wallet_job', 'job_id', p_job_id, 'reason', 'Wallet not found');
    END IF;

    SELECT *
    INTO v_funding
    FROM public.errand_funding
    WHERE job_id = p_job_id
    FOR UPDATE;

    IF v_funding IS NOT NULL AND LOWER(COALESCE(v_funding.status, '')) = 'settled' THEN
        RETURN jsonb_build_object(
            'status', 'already_settled',
            'job_id', p_job_id,
            'amount_settled', COALESCE((v_funding.metadata -> 'settlement' ->> 'amount_settled')::NUMERIC, 0)
        );
    END IF;

    v_reserved := ROUND(GREATEST(COALESCE(v_wallet.reserved_balance, 0), 0)::NUMERIC, 2);
    v_available := ROUND(GREATEST(COALESCE(v_wallet.available_balance, 0), 0)::NUMERIC, 2);

    IF v_funding IS NOT NULL THEN
        v_job_reserved := ROUND(GREATEST(COALESCE(v_funding.amount_reserved, 0), 0)::NUMERIC, 2);
    ELSE
        v_job_reserved := v_amount;
    END IF;

    SELECT COALESCE(
        (SELECT COALESCE(st.slug::TEXT, st.name::TEXT)
         FROM public.service_types st
         WHERE st.id = v_job.service_type_id),
        v_job.metadata ->> 'service_slug',
        ''
    ) INTO v_service_slug;

    -- Final release closure: an errand's TOTAL customer settlement is the
    -- authoritative SERVICE fare (v_amount) PLUS the actual verified shopping
    -- spend. The purchase budget is (v_job_reserved - v_amount); unused budget
    -- is released to the customer. The service fare is NEVER capped to spend,
    -- and shopping spend is never driver income (payout basis is the fare).
    IF LOWER(COALESCE(v_service_slug, '')) = 'errand'
       OR EXISTS (
           SELECT 1 FROM public.errand_details ed WHERE ed.job_id = p_job_id
       )
    THEN
        SELECT COALESCE(actual_spending, 0)
        INTO v_actual_spending
        FROM public.errand_details
        WHERE job_id = p_job_id
        LIMIT 1;

        v_actual_spending := ROUND(GREATEST(COALESCE(v_actual_spending, 0), 0)::NUMERIC, 2);

        v_budget := ROUND(GREATEST(v_job_reserved - v_amount, 0)::NUMERIC, 2);
        v_actual_spending := ROUND(LEAST(v_actual_spending, v_budget)::NUMERIC, 2);

        v_settlement_amount := ROUND((v_amount + v_actual_spending)::NUMERIC, 2);
        v_refund_amount := ROUND(GREATEST(v_job_reserved - v_settlement_amount, 0)::NUMERIC, 2);
        v_reservation_amount := ROUND(v_job_reserved::NUMERIC, 2);
    ELSE
        v_reservation_amount := ROUND(LEAST(v_reserved, v_job_reserved)::NUMERIC, 2);
        v_settlement_amount := ROUND(LEAST(v_reservation_amount, v_amount)::NUMERIC, 2);
        v_refund_amount := ROUND(GREATEST(v_reservation_amount - v_settlement_amount, 0)::NUMERIC, 2);
    END IF;

    IF v_settlement_amount <= 0 THEN
        RETURN jsonb_build_object('status', 'not_wallet_job', 'job_id', p_job_id, 'reason', 'Customer wallet reservation is empty');
    END IF;

    v_available_before := v_available;
    v_reserved_before := v_reserved;

    v_available_after_settlement := v_available_before;
    v_reserved_after_settlement := ROUND(GREATEST(v_reserved_before - v_settlement_amount, 0)::NUMERIC, 2);

    v_available_after_release := ROUND((v_available_after_settlement + v_refund_amount)::NUMERIC, 2);
    v_reserved_after_release := ROUND(GREATEST(v_reserved_before - v_reservation_amount, 0)::NUMERIC, 2);

    UPDATE public.wallets
    SET available_balance = v_available_after_release,
        reserved_balance = v_reserved_after_release,
        updated_at = v_now
    WHERE user_id = v_job.customer_id;

    INSERT INTO public.wallet_transactions (
        wallet_id, user_id, job_id, amount, transaction_type, description, metadata,
        balance_before_available, balance_after_available,
        balance_before_reserved, balance_after_reserved
    )
    VALUES (
        v_wallet.id, v_job.customer_id, p_job_id, v_settlement_amount, 'settlement',
        'Job payment settled from wallet reservation',
        jsonb_build_object(
            'payment_method', 'wallet',
            'currency_code', COALESCE(v_job.currency_code, 'GBP'),
            'settled_at', v_now
        ),
        v_available_before, v_available_after_settlement,
        v_reserved_before, v_reserved_after_settlement
    );

    IF v_refund_amount > 0 THEN
        INSERT INTO public.wallet_transactions (
            wallet_id, user_id, job_id, amount, transaction_type, description, metadata,
            balance_before_available, balance_after_available,
            balance_before_reserved, balance_after_reserved
        )
        VALUES (
            v_wallet.id, v_job.customer_id, p_job_id, v_refund_amount, 'release',
            'Unused errand wallet reservation returned',
            jsonb_build_object(
                'payment_method', 'wallet',
                'currency_code', COALESCE(v_job.currency_code, 'GBP'),
                'released_at', v_now,
                'reason', 'actual_spending_below_reserved_amount'
            ),
            v_available_after_settlement, v_available_after_release,
            v_reserved_after_settlement, v_reserved_after_release
        );
    END IF;

    IF v_funding IS NOT NULL THEN
        UPDATE public.errand_funding
        SET status = 'settled',
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'settlement', jsonb_build_object(
                    'amount_settled', v_settlement_amount,
                    'amount_released', v_refund_amount,
                    'settled_at', v_now
                )
            ),
            updated_at = v_now
        WHERE job_id = p_job_id;
    END IF;

    RETURN jsonb_build_object(
        'status', 'settled',
        'job_id', p_job_id,
        'amount_settled', v_settlement_amount,
        'amount_released', v_refund_amount
    );
END;
$$;
