-- Rollback of 20261266100000_cash_ride_booking_fee_hold: restores the deployed enforce_job_payment_eligibility body exactly,
-- then drops the acquisition check and the fee-hold table. Release or capture any authorised
-- holds at the provider BEFORE running this; the table's references are dropped with it.
BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_job_payment_eligibility() RETURNS trigger
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

DROP FUNCTION public.cash_ride_acquirable_v1e(public.jobs);
DROP TABLE public.cash_ride_fee_holds_v1e;
-- Fails (and rolls back everything) while any job still has a cash payment state.
ALTER TABLE public.jobs DROP CONSTRAINT jobs_payment_status_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_payment_status_check CHECK (((payment_status IS NULL) OR (payment_status = ANY (ARRAY['pending'::text, 'authorized'::text, 'wallet_funded'::text, 'paid'::text, 'cancelled'::text, 'canceled'::text, 'refunded'::text, 'failed'::text, 'requires_refund'::text, 'requires_review'::text]))));

COMMIT;
