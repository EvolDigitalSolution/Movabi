-- Migration: Create missing detail tables
-- Issue: Jobs require specific detail tables for different service types

-- 1. Ride Details
CREATE TABLE IF NOT EXISTS public.ride_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
    passenger_count INTEGER NOT NULL,
    vehicle_type TEXT,
    special_requirements TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Errand Details
CREATE TABLE IF NOT EXISTS public.errand_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
    items_list JSONB NOT NULL DEFAULT '[]',
    estimated_budget DECIMAL,
    store_name TEXT,
    store_address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Delivery Details
CREATE TABLE IF NOT EXISTS public.delivery_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
    recipient_name TEXT NOT NULL,
    recipient_phone TEXT NOT NULL,
    package_description TEXT,
    package_weight TEXT,
    is_fragile BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Van Details
CREATE TABLE IF NOT EXISTS public.van_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
    helper_count INTEGER DEFAULT 0,
    floor_number INTEGER,
    has_elevator BOOLEAN,
    items_description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on all detail tables
ALTER TABLE public.ride_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.errand_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.van_details ENABLE ROW LEVEL SECURITY;

-- Add basic RLS policies (customers and drivers can view)
-- Using a helper function to check access
CREATE OR REPLACE FUNCTION public.can_view_job_details(p_job_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM jobs 
        WHERE id = p_job_id 
          AND (customer_id = auth.uid() OR driver_id = auth.uid())
    );
END;
$$;

CREATE POLICY "Users can view ride details" ON public.ride_details FOR SELECT USING (can_view_job_details(job_id));
CREATE POLICY "Users can view errand details" ON public.errand_details FOR SELECT USING (can_view_job_details(job_id));
CREATE POLICY "Users can view delivery details" ON public.delivery_details FOR SELECT USING (can_view_job_details(job_id));
CREATE POLICY "Users can view van details" ON public.van_details FOR SELECT USING (can_view_job_details(job_id));

-- 5. Ratings
CREATE TABLE IF NOT EXISTS public.ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES public.profiles(id),
    score INTEGER NOT NULL CHECK (score >= 1 AND score <= 5),
    comment TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Booking Status History (Job Status History)
CREATE TABLE IF NOT EXISTS public.booking_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    changed_by UUID REFERENCES public.profiles(id),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_status_history ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view relevant ratings" ON public.ratings FOR SELECT USING (can_view_job_details(job_id));
CREATE POLICY "Users can view relevant status history" ON public.booking_status_history FOR SELECT USING (can_view_job_details(job_id));
