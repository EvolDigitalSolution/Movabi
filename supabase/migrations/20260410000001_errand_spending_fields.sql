-- Ensure errand_details has spending fields
ALTER TABLE public.errand_details 
ADD COLUMN IF NOT EXISTS actual_spending DECIMAL(12, 2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS spending_notes TEXT,
ADD COLUMN IF NOT EXISTS receipt_url TEXT;

-- Update errand_funding status when spending is recorded
CREATE OR REPLACE FUNCTION public.on_errand_spending_update()
RETURNS TRIGGER AS $$
BEGIN
    -- If spending is recorded, we might want to update the funding record status or metadata
    -- This is a placeholder for more complex logic if needed
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER tr_on_errand_spending_update
    AFTER UPDATE OF actual_spending ON public.errand_details
    FOR EACH ROW
    EXECUTE FUNCTION public.on_errand_spending_update();

-- RPC to settle errand funds and refund unused balance
CREATE OR REPLACE FUNCTION public.settle_errand_funds(p_job_id UUID)
RETURNS VOID AS $$
DECLARE
    v_customer_id UUID;
    v_amount_reserved DECIMAL(12, 2);
    v_actual_spending DECIMAL(12, 2);
    v_fare DECIMAL(12, 2);
    v_total_actual DECIMAL(12, 2);
    v_refund_amount DECIMAL(12, 2);
BEGIN
    -- Get funding details
    SELECT customer_id, amount_reserved INTO v_customer_id, v_amount_reserved
    FROM public.errand_funding
    WHERE job_id = p_job_id AND status = 'reserved';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No active reservation found for this job';
    END IF;

    -- Get actual spending and fare
    SELECT price INTO v_fare FROM public.jobs WHERE id = p_job_id;
    SELECT actual_spending INTO v_actual_spending FROM public.errand_details WHERE job_id = p_job_id;

    v_total_actual := v_fare + COALESCE(v_actual_spending, 0);
    v_refund_amount := v_amount_reserved - v_total_actual;

    -- Update wallet: release reserved, add refund to available
    UPDATE public.wallets
    SET 
        reserved_balance = reserved_balance - v_amount_reserved,
        available_balance = available_balance + GREATEST(v_refund_amount, 0),
        updated_at = NOW()
    WHERE user_id = v_customer_id;

    -- Update funding record
    UPDATE public.errand_funding
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

END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
