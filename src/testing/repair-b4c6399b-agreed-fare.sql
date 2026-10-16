-- Run only after the atomic snapshot migration. This file NEVER commits.
-- Stripe must separately confirm pi_3UQwGWGqKIrFJSq50fmgaxzI remains
-- requires_capture, GBP, amount=604 and amount_capturable=604 before a real repair.
BEGIN;
DO $$
DECLARE j public.jobs%ROWTYPE;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs
 WHERE id='b4c6399b-7e3d-41be-b0ee-caa711ea7c09' FOR UPDATE;
 IF j.status IS DISTINCT FROM 'in_progress' OR j.payment_status IS DISTINCT FROM 'authorized' OR j.payment_method IS DISTINCT FROM 'card'
 OR j.payment_intent_id IS DISTINCT FROM 'pi_3UQwGWGqKIrFJSq50fmgaxzI' OR j.currency_code IS DISTINCT FROM 'GBP'
 OR j.agreed_fare IS DISTINCT FROM 6.04 OR j.total_price IS DISTINCT FROM 6.71
 OR (j.fare_breakdown->>'customerCharge')::numeric IS DISTINCT FROM 6.71
 OR (j.fare_breakdown->>'commissionPercent')::numeric IS DISTINCT FROM 15
 OR j.fare_breakdown->'driverCommissionPolicy' IS NOT NULL
 OR j.stripe_transfer_id IS NOT NULL
 OR j.settlement_status IN ('claimed','unknown','transferred','reversed')
 OR EXISTS(SELECT 1 FROM public.job_payout_queue WHERE job_id=j.id)
 OR EXISTS(SELECT 1 FROM public.refund_operations WHERE job_id=j.id) THEN
   RAISE EXCEPTION 'Booking changed; review instead of applying this repair';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.marketplace_negotiation_sessions
   WHERE job_id=j.id AND status='fare_agreed' AND active_driver_id=j.driver_id AND agreed_fare=6.04) THEN
   RAISE EXCEPTION 'Matching server agreement is required';
 END IF;
 UPDATE public.jobs SET agreed_fare=agreed_fare,updated_at=now() WHERE id=j.id;
 SELECT * INTO STRICT j FROM public.jobs WHERE id=j.id;
 IF j.total_price IS DISTINCT FROM 6.04 OR j.platform_fee IS DISTINCT FROM .29 OR j.commission_fee IS DISTINCT FROM .86 OR j.driver_payout IS DISTINCT FROM 4.89
 OR j.commission_rate_used IS DISTINCT FROM 15 OR (j.fare_breakdown->>'customerCharge')::numeric IS DISTINCT FROM 6.04 THEN
   RAISE EXCEPTION 'Repair did not produce the reviewed frozen split';
 END IF;
END $$;
SELECT id,status,payment_status,agreed_fare,total_price,platform_fee,commission_fee,driver_payout
FROM public.jobs WHERE id='b4c6399b-7e3d-41be-b0ee-caa711ea7c09';
SELECT 'PAYMENT_REPAIR_DRY_RUN=PASSED' AS result;
ROLLBACK;
