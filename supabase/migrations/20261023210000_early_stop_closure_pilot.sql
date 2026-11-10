BEGIN;
DO $preflight$
BEGIN
 IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'Expected movabi_develop'; END IF;
 IF to_regprocedure('public.early_stop_fare_context_v23(uuid,uuid,uuid)') IS NULL
  OR to_regclass('public.kora_sandbox_booking_payments') IS NULL THEN RAISE EXCEPTION 'Fare and Kora booking pilots required'; END IF;
END
$preflight$;
CREATE TABLE public.journey_closures_v23(
 job_id uuid PRIMARY KEY REFERENCES public.jobs(id),proposal_id uuid NOT NULL UNIQUE REFERENCES public.journey_fare_proposals_v23(id),
 actor_id uuid NOT NULL,customer_id uuid NOT NULL,driver_id uuid NOT NULL,
 original_job jsonb NOT NULL,closed_job jsonb NOT NULL,calculation jsonb NOT NULL,
 closed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.journey_closures_v23 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.journey_closures_v23 FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.journey_closures_v23 TO service_role;
CREATE FUNCTION public.close_early_stop_ngn_pilot_v23(p_actor uuid,p_job uuid,p_stop uuid,p_proposal uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $close$
DECLARE j public.jobs%ROWTYPE;p public.journey_fare_proposals_v23%ROWTYPE;c public.journey_closures_v23%ROWTYPE;
 context jsonb;b jsonb;original jsonb;charge numeric;fee numeric;commission numeric;payout numeric;amount bigint;
BEGIN
 SELECT * INTO j FROM public.jobs WHERE id=p_job FOR UPDATE;
 IF NOT FOUND OR p_actor IS NULL OR (j.customer_id IS DISTINCT FROM p_actor AND j.driver_id IS DISTINCT FROM p_actor) THEN RAISE EXCEPTION 'CLOSE_NOT_PARTICIPANT'; END IF;
 SELECT * INTO c FROM public.journey_closures_v23 WHERE job_id=p_job;
 IF FOUND THEN
  IF c.customer_id IS DISTINCT FROM j.customer_id OR c.driver_id IS DISTINCT FROM j.driver_id
   OR c.proposal_id IS DISTINCT FROM p_proposal
   OR NOT EXISTS(SELECT 1 FROM public.journey_fare_proposals_v23 WHERE id=p_proposal AND stop_id=p_stop)
  THEN RAISE EXCEPTION 'CLOSE_RECONCILIATION_REQUIRED'; END IF;
  RETURN jsonb_build_object('bookingId',p_job,'proposalId',c.proposal_id,'closed',true,'currency','NGN',
   'amountMinor',c.calculation->'amountMinor','paymentVerified',false,'driverPayoutEnabled',false,'sandbox',true);
 END IF;
 context:=public.early_stop_fare_context_v23(p_actor,p_job,p_stop);
 SELECT * INTO p FROM public.journey_fare_proposals_v23 WHERE id=p_proposal AND stop_id=p_stop FOR UPDATE;
 IF NOT FOUND OR p.state IS DISTINCT FROM 'agreed' OR p.customer_accepted_at IS NULL OR p.driver_accepted_at IS NULL THEN RAISE EXCEPTION 'CLOSE_FARE_AGREEMENT_REQUIRED'; END IF;
 IF p.source_digest IS DISTINCT FROM context->>'digest' THEN RAISE EXCEPTION 'CLOSE_SOURCE_CHANGED'; END IF;
 -- Quoted NGN rides only. Authorised, negotiated, wallet or existing provider
 -- attempts require an explicit reconciliation path; none is released here.
 IF j.country_code IS DISTINCT FROM 'NG' OR j.currency_code IS DISTINCT FROM 'NGN'
  OR j.payment_status IS DISTINCT FROM 'pending' OR coalesce(j.payment_intent_id,'')<>''
  OR j.agreed_fare IS NOT NULL OR j.payment_method='wallet' OR j.stripe_transfer_id IS NOT NULL
  OR j.settlement_status IN('claimed','unknown','transferred','reversed')
  OR NOT EXISTS(SELECT 1 FROM public.service_types WHERE id=j.service_type_id AND slug='ride')
  OR EXISTS(SELECT 1 FROM public.driver_earnings WHERE job_id=p_job)
  OR EXISTS(SELECT 1 FROM public.job_payout_queue WHERE job_id=p_job)
  OR EXISTS(SELECT 1 FROM public.job_payment_bindings WHERE job_id=p_job)
  OR EXISTS(SELECT 1 FROM public.kora_sandbox_booking_payments WHERE job_id=p_job)
  OR EXISTS(SELECT 1 FROM public.refund_operations WHERE job_id=p_job)
 THEN RAISE EXCEPTION 'CLOSE_ISOLATED_UNPAID_NGN_RIDE_REQUIRED'; END IF;
 b:=j.fare_breakdown;
 IF b->>'policyVersion' IS DISTINCT FROM 'fare-split-v1' OR b->>'currency' IS DISTINCT FROM 'NGN'
  OR p.calculation->>'currency' IS DISTINCT FROM 'NGN' OR p.calculation->>'exponent' IS DISTINCT FROM '2'
  OR p.calculation->>'policyVersion' IS DISTINCT FROM 'early-stop-distance-prorata-v1'
  OR coalesce((b->>'shoppingBudget')::numeric,0)<>0 THEN RAISE EXCEPTION 'CLOSE_INVALID_TERMS'; END IF;
 amount:=(p.calculation->>'amountMinor')::bigint;
 charge:=amount::numeric/100;fee:=(p.calculation->'split'->>'platformFeeMinor')::numeric/100;
 commission:=(p.calculation->'split'->>'driverCommissionMinor')::numeric/100;payout:=(p.calculation->'split'->>'driverEntitlementMinor')::numeric/100;
 IF amount IS NULL OR amount<10000 OR fee IS NULL OR commission IS NULL OR payout IS NULL
  OR fee<0 OR commission<0 OR payout<=0 OR charge<>fee+commission+payout
  OR (p.calculation->>'originalMinor')::numeric IS DISTINCT FROM (b->>'customerCharge')::numeric*100
  OR amount>(p.calculation->>'originalMinor')::bigint THEN RAISE EXCEPTION 'CLOSE_INVALID_TERMS'; END IF;
 original:=to_jsonb(j);
 b:=b||jsonb_build_object('customerCharge',charge,'customerServiceTotal',charge,'total',charge,'serviceFare',charge,
  'totalAuthorisation',charge,'shoppingBudget',0,'platformFeeAmount',fee,'platformFee',fee,
  'baseServiceFare',charge-fee,'serviceFareBeforePlatformFee',charge-fee,'driverBase',charge-fee,'driverGrossEarnings',charge-fee,
  'driverCommissionAmount',commission,'commissionAmount',commission,'commissionFee',commission,
  'driverEntitlement',payout,'driverPayout',payout,'driverNetEarnings',payout,'grossRevenue',fee+commission);
 -- All existing price and protected-margin triggers remain enabled.
 UPDATE public.jobs SET status='completed',completed_at=clock_timestamp(),fare_breakdown=b,
  price=charge,total_price=charge,estimated_price=charge,platform_fee=fee,driver_payout=payout,commission_fee=commission,
  metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('early_stop_sandbox',true,'early_stop_proposal_id',p.id,'early_stop_payment_pending',true)
 WHERE id=p_job RETURNING * INTO j;
 IF j.status IS DISTINCT FROM 'completed' OR j.payment_status IS DISTINCT FROM 'pending'
  OR j.price IS DISTINCT FROM charge OR j.total_price IS DISTINCT FROM charge OR j.estimated_price IS DISTINCT FROM charge
  OR j.fare_breakdown->>'currency' IS DISTINCT FROM 'NGN'
  OR (j.fare_breakdown->>'customerCharge')::numeric IS DISTINCT FROM charge
  OR (j.fare_breakdown->>'platformFeeAmount')::numeric IS DISTINCT FROM fee
  OR (j.fare_breakdown->>'driverCommissionAmount')::numeric IS DISTINCT FROM commission
  OR (j.fare_breakdown->>'driverEntitlement')::numeric IS DISTINCT FROM payout
  OR EXISTS(SELECT 1 FROM public.driver_earnings WHERE job_id=p_job)
  OR EXISTS(SELECT 1 FROM public.job_payout_queue WHERE job_id=p_job)
  OR EXISTS(SELECT 1 FROM public.job_payment_bindings WHERE job_id=p_job)
 THEN RAISE EXCEPTION 'CLOSE_RECONCILIATION_REQUIRED'; END IF;
 INSERT INTO public.journey_closures_v23(job_id,proposal_id,actor_id,customer_id,driver_id,original_job,closed_job,calculation)
 VALUES(p_job,p.id,p_actor,j.customer_id,j.driver_id,original,to_jsonb(j),p.calculation);
 RETURN jsonb_build_object('bookingId',p_job,'proposalId',p.id,'closed',true,'currency','NGN','amountMinor',amount,
  'paymentVerified',false,'driverPayoutEnabled',false,'sandbox',true);
END
$close$;
REVOKE ALL ON FUNCTION public.close_early_stop_ngn_pilot_v23(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.close_early_stop_ngn_pilot_v23(uuid,uuid,uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
