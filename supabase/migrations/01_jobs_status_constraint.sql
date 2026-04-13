-- Migration: Update jobs status constraint to include 'requested'
-- Issue: jobs insert fails because 'requested' is not in the allowed statuses

DO $$ 
BEGIN
    -- Drop the existing constraint if it exists
    ALTER TABLE IF EXISTS public.jobs DROP CONSTRAINT IF EXISTS jobs_status_check;

    -- Add the updated constraint
    ALTER TABLE public.jobs ADD CONSTRAINT jobs_status_check 
    CHECK (status IN (
        'requested',
        'searching',
        'assigned',
        'accepted',
        'heading_to_pickup',
        'arrived',
        'arrived_at_store',
        'shopping_in_progress',
        'collected',
        'en_route_to_customer',
        'delivered',
        'in_progress',
        'settled',
        'completed',
        'cancelled'
    ));
END $$;
