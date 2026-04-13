-- Migration: Refactor Errand Funding Functions
-- Issue: Update functions to use job_id and implement secure wallet-based funding

-- 1. Reserve Errand Funds
CREATE OR REPLACE FUNCTION public.reserve_errand_funds(
    p_job_id UUID,
    p_customer_id UUID,
    p_item_budget DECIMAL,
    p_service_estimate DECIMAL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total_required DECIMAL;
    v_available_balance DECIMAL;
BEGIN
    v_total_required := p_item_budget + p_service_estimate;

    -- Check balance
    SELECT available_balance INTO v_available_balance 
    FROM wallets 
    WHERE user_id = p_customer_id
    FOR UPDATE;

    IF v_available_balance IS NULL OR v_available_balance < v_total_required THEN
        RAISE EXCEPTION 'Insufficient wallet balance. Required: %, Available: %', v_total_required, COALESCE(v_available_balance, 0);
    END IF;

    -- Deduct from available, add to reserved
    UPDATE wallets 
    SET available_balance = available_balance - v_total_required,
        reserved_balance = reserved_balance + v_total_required,
        updated_at = NOW()
    WHERE user_id = p_customer_id;

    -- Create funding record
    INSERT INTO errand_funding (
        job_id,
        customer_id,
        amount_reserved,
        status,
        metadata
    ) VALUES (
        p_job_id,
        p_customer_id,
        v_total_required,
        'reserved',
        jsonb_build_object(
            'item_budget', p_item_budget,
            'service_estimate', p_service_estimate
        )
    );
END;
$$;

-- 2. Settle Errand Funds
CREATE OR REPLACE FUNCTION public.settle_errand_funds(p_job_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_funding RECORD;
    v_actual_spending DECIMAL;
    v_fare DECIMAL;
    v_total_actual DECIMAL;
    v_refund_amount DECIMAL;
BEGIN
    -- Get funding record
    SELECT * INTO v_funding FROM errand_funding WHERE job_id = p_job_id AND status = 'reserved';
    
    IF v_funding IS NULL THEN
        RAISE EXCEPTION 'No active funding record found for job %', p_job_id;
    END IF;

    -- Get actual spending and fare
    SELECT price INTO v_fare FROM jobs WHERE id = p_job_id;
    SELECT actual_spending INTO v_actual_spending FROM errand_details WHERE job_id = p_job_id;

    v_total_actual := COALESCE(v_fare, 0) + COALESCE(v_actual_spending, 0);
    v_refund_amount := v_funding.amount_reserved - v_total_actual;

    -- Update wallet: release reserved, add refund to available
    UPDATE wallets
    SET 
        reserved_balance = reserved_balance - v_funding.amount_reserved,
        available_balance = available_balance + GREATEST(v_refund_amount, 0),
        updated_at = NOW()
    WHERE user_id = v_funding.customer_id;

    -- Update funding record
    UPDATE errand_funding
    SET 
        status = 'settled',
        metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb), 
            '{settlement}', 
            jsonb_build_object(
                'fare', v_fare,
                'spending', v_actual_spending,
                'total', v_total_actual,
                'refund', v_refund_amount
            )
        ),
        updated_at = NOW()
    WHERE job_id = p_job_id;
    
    -- Update job status
    UPDATE jobs SET status = 'settled' WHERE id = p_job_id;
END;
$$;

-- 3. Request Over Budget
CREATE OR REPLACE FUNCTION public.request_errand_over_budget(
    p_job_id UUID,
    p_amount DECIMAL,
    p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE errand_funding 
    SET status = 'over_budget_requested',
        requested_over_budget_amount = p_amount,
        over_budget_reason = p_reason,
        updated_at = NOW()
    WHERE job_id = p_job_id;
END;
$$;

-- 4. Approve Over Budget
CREATE OR REPLACE FUNCTION public.approve_errand_over_budget(p_job_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_funding RECORD;
    v_additional_required DECIMAL;
    v_available_balance DECIMAL;
BEGIN
    SELECT * INTO v_funding FROM errand_funding WHERE job_id = p_job_id;
    
    -- Calculate how much more we need to reserve
    -- requested_over_budget_amount is the NEW total item budget
    -- metadata->'item_budget' is the OLD item budget
    v_additional_required := v_funding.requested_over_budget_amount - (v_funding.metadata->>'item_budget')::DECIMAL;
    
    IF v_additional_required <= 0 THEN
        RAISE EXCEPTION 'Invalid over-budget request amount';
    END IF;

    -- Check wallet
    SELECT available_balance INTO v_available_balance 
    FROM wallets 
    WHERE user_id = v_funding.customer_id
    FOR UPDATE;

    IF v_available_balance IS NULL OR v_available_balance < v_additional_required THEN
        RAISE EXCEPTION 'Insufficient wallet balance for over-budget approval';
    END IF;

    -- Deduct additional funds
    UPDATE wallets 
    SET available_balance = available_balance - v_additional_required,
        reserved_balance = reserved_balance + v_additional_required,
        updated_at = NOW()
    WHERE user_id = v_funding.customer_id;

    -- Update funding
    UPDATE errand_funding 
    SET status = 'reserved',
        amount_reserved = amount_reserved + v_additional_required,
        metadata = jsonb_set(metadata, '{item_budget}', to_jsonb(requested_over_budget_amount)),
        requested_over_budget_amount = NULL,
        updated_at = NOW()
    WHERE job_id = p_job_id;
END;
$$;

-- 5. Reject Over Budget
CREATE OR REPLACE FUNCTION public.reject_errand_over_budget(p_job_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE errand_funding 
    SET status = 'reserved', -- Revert to reserved with original budget
        requested_over_budget_amount = NULL,
        updated_at = NOW()
    WHERE job_id = p_job_id;
END;
$$;
