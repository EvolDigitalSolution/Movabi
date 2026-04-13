-- Migration: Fix RLS recursion between jobs and driver_locations
-- Issue: Recursive policies cause infinite loops when checking driver visibility

-- 1. Create a SECURITY DEFINER helper function to break recursion
CREATE OR REPLACE FUNCTION public.customer_has_active_job_with_driver(p_customer_id UUID, p_driver_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 
        FROM jobs 
        WHERE customer_id = p_customer_id 
          AND driver_id = p_driver_id 
          AND status NOT IN ('completed', 'cancelled')
    );
END;
$$;

-- 2. Update driver_locations policy
-- Allow customers to see driver locations ONLY if they have an active job with that driver
DROP POLICY IF EXISTS "Customers can view assigned driver location" ON public.driver_locations;
DROP POLICY IF EXISTS "Customers can view their active driver location" ON public.driver_locations;

CREATE POLICY "Customers can view assigned driver location" 
ON public.driver_locations
FOR SELECT
USING (
    customer_has_active_job_with_driver(auth.uid(), driver_id)
);

-- 3. Ensure drivers can see and update their own location
DROP POLICY IF EXISTS "Drivers can update own location" ON public.driver_locations;
DROP POLICY IF EXISTS "Drivers can manage their own location" ON public.driver_locations;

CREATE POLICY "Drivers can manage their own location" 
ON public.driver_locations
FOR ALL
USING (auth.uid() = driver_id)
WITH CHECK (auth.uid() = driver_id);
