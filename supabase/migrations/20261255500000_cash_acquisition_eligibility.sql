-- Cash acquisition eligibility: enforce_job_payment_eligibility was written
-- before cash custody existed and only accepts electronic-payment statuses.
-- A cash job legitimately stays 'pending'/'cash_due'/'cash_pending' — custody
-- is enforced by enforce_ride_cash_credit_v1e (full_customer_charge, no
-- payment_intent, frozen terms). Exempt payment_method='cash' here so the
-- two authorities don't contradict; non-cash behaviour is unchanged.
CREATE OR REPLACE FUNCTION public.enforce_job_payment_eligibility()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
    IF NEW.driver_id IS NOT NULL
       AND OLD.driver_id IS DISTINCT FROM NEW.driver_id
       AND NEW.status IN ('assigned', 'accepted') THEN
        -- Cash custody is verified by enforce_ride_cash_credit_v1e; exempt it
        -- from the electronic-payment status gate.
        IF NEW.payment_method IS DISTINCT FROM 'cash'
           AND NEW.payment_status NOT IN (
               'paid', 'wallet_funded', 'authorized', 'requires_capture', 'succeeded', 'captured'
           ) THEN
            RAISE EXCEPTION 'Job is not payment-eligible for driver acquisition'
                USING ERRCODE = 'MB003',
                      DETAIL = 'payment_eligibility';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;
