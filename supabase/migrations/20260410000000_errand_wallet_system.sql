-- Create wallets table
CREATE TABLE IF NOT EXISTS public.wallets (
    user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    available_balance DECIMAL(12, 2) DEFAULT 0.00 NOT NULL,
    reserved_balance DECIMAL(12, 2) DEFAULT 0.00 NOT NULL,
    currency_code TEXT DEFAULT 'GBP' NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Enable RLS
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own wallet" 
    ON public.wallets FOR SELECT 
    USING (auth.uid() = user_id);

-- Create errand_funding table
CREATE TABLE IF NOT EXISTS public.errand_funding (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    amount_reserved DECIMAL(12, 2) NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL CHECK (status IN ('pending', 'reserved', 'approved', 'settled', 'cancelled')),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Enable RLS
ALTER TABLE public.errand_funding ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own errand funding" 
    ON public.errand_funding FOR SELECT 
    USING (auth.uid() = customer_id);

CREATE POLICY "Drivers can view funding for assigned jobs" 
    ON public.errand_funding FOR SELECT 
    USING (
        EXISTS (
            SELECT 1 FROM public.jobs 
            WHERE jobs.id = errand_funding.job_id 
            AND jobs.driver_id = auth.uid()
        )
    );

-- Function to initialize wallet for new users
CREATE OR REPLACE FUNCTION public.handle_new_user_wallet()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.wallets (user_id, currency_code)
    VALUES (NEW.id, NEW.currency_code);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for new user wallet
CREATE TRIGGER on_profile_created_wallet
    AFTER INSERT ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_wallet();

-- Initialize wallets for existing users
INSERT INTO public.wallets (user_id, currency_code)
SELECT id, currency_code FROM public.profiles
ON CONFLICT (user_id) DO NOTHING;

-- RPC for atomic fund reservation
CREATE OR REPLACE FUNCTION public.reserve_errand_funds(
    p_job_id UUID,
    p_user_id UUID,
    p_amount DECIMAL(12, 2)
)
RETURNS JSONB AS $$
DECLARE
    v_available DECIMAL(12, 2);
    v_funding_id UUID;
BEGIN
    -- Check balance
    SELECT available_balance INTO v_available
    FROM public.wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF v_available < p_amount THEN
        RAISE EXCEPTION 'Insufficient funds';
    END IF;

    -- Deduct from available, add to reserved
    UPDATE public.wallets
    SET available_balance = available_balance - p_amount,
        reserved_balance = reserved_balance + p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    -- Create funding record
    INSERT INTO public.errand_funding (job_id, customer_id, amount_reserved, status)
    VALUES (p_job_id, p_user_id, p_amount, 'reserved')
    RETURNING id INTO v_funding_id;

    -- Update job status to funded if needed (or handle in app logic)
    -- For now just return the funding info
    RETURN jsonb_build_object(
        'funding_id', v_funding_id,
        'amount_reserved', p_amount,
        'status', 'reserved'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
