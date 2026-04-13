-- Migration: Errand Notifications and Automation
-- Date: 2026-04-11

-- 1. Create notifications table if not exists
CREATE TABLE IF NOT EXISTS public.notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    type TEXT DEFAULT 'system' NOT NULL,
    is_read BOOLEAN DEFAULT FALSE NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Enable RLS
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own notifications"
    ON public.notifications FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own notifications"
    ON public.notifications FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "System can insert notifications"
    ON public.notifications FOR INSERT
    WITH CHECK (TRUE);

-- 2. Function to notify on errand funding changes
CREATE OR REPLACE FUNCTION public.on_errand_funding_change()
RETURNS TRIGGER AS $$
DECLARE
    v_customer_id UUID;
    v_driver_id UUID;
    v_job_id UUID;
    v_amount DECIMAL(12, 2);
BEGIN
    v_customer_id := NEW.customer_id;
    v_job_id := NEW.job_id;
    v_amount := NEW.amount_reserved;

    -- Get driver_id from jobs
    SELECT driver_id INTO v_driver_id FROM public.jobs WHERE id = v_job_id;

    -- Case: Over-budget requested (status was 'reserved', now 'requested' in metadata or status)
    -- Wait, the status in errand_funding is 'reserved', 'approved', 'settled', 'cancelled'
    -- The over_budget_status is in errand_funding (added in migration 20260410000002)
    
    IF (OLD.over_budget_status IS DISTINCT FROM NEW.over_budget_status) THEN
        IF (NEW.over_budget_status = 'requested') THEN
            -- Notify Customer
            INSERT INTO public.notifications (user_id, title, body, type, metadata)
            VALUES (
                v_customer_id,
                'Budget Increase Requested',
                'Your driver has requested an additional £' || NEW.over_budget_amount || ' for your errand.',
                'booking',
                jsonb_build_object('jobId', v_job_id, 'type', 'over_budget_requested')
            );
        ELSIF (NEW.over_budget_status = 'approved') THEN
            -- Notify Driver
            IF v_driver_id IS NOT NULL THEN
                INSERT INTO public.notifications (user_id, title, body, type, metadata)
                VALUES (
                    v_driver_id,
                    'Budget Increase Approved',
                    'The customer has approved your budget increase request.',
                    'booking',
                    jsonb_build_object('jobId', v_job_id, 'type', 'over_budget_approved')
                );
            END IF;
        ELSIF (NEW.over_budget_status = 'rejected') THEN
            -- Notify Driver
            IF v_driver_id IS NOT NULL THEN
                INSERT INTO public.notifications (user_id, title, body, type, metadata)
                VALUES (
                    v_driver_id,
                    'Budget Increase Rejected',
                    'The customer has rejected your budget increase request.',
                    'booking',
                    jsonb_build_object('jobId', v_job_id, 'type', 'over_budget_rejected')
                );
            END IF;
        END IF;
    END IF;

    -- Case: Errand Settled (Refund)
    IF (OLD.status != 'settled' AND NEW.status = 'settled') THEN
        -- Notify Customer about settlement/refund
        INSERT INTO public.notifications (user_id, title, body, type, metadata)
        VALUES (
            v_customer_id,
            'Errand Funds Settled',
            'Your errand funds have been settled. Any unused budget has been returned to your wallet.',
            'wallet',
            jsonb_build_object('jobId', v_job_id, 'type', 'errand_settled')
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for errand funding
CREATE TRIGGER on_errand_funding_update
    AFTER UPDATE ON public.errand_funding
    FOR EACH ROW EXECUTE FUNCTION public.on_errand_funding_change();

-- 3. Function to notify on new job messages
CREATE OR REPLACE FUNCTION public.on_new_job_message()
RETURNS TRIGGER AS $$
BEGIN
    -- Notify the receiver
    INSERT INTO public.notifications (user_id, title, body, type, metadata)
    VALUES (
        NEW.receiver_id,
        'New Message',
        'You have a new message regarding your booking.',
        'chat',
        jsonb_build_object('jobId', NEW.job_id, 'senderId', NEW.sender_id)
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for job messages
CREATE TRIGGER on_job_message_insert
    AFTER INSERT ON public.job_messages
    FOR EACH ROW EXECUTE FUNCTION public.on_new_job_message();
