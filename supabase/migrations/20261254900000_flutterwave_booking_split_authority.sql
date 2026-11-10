BEGIN;
DO $$ BEGIN IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'Develop database required';END IF;END $$;
CREATE FUNCTION public.reserve_flutterwave_booking_split(p_job uuid,p_customer uuid,p_terms jsonb)
RETURNS SETOF public.job_settlement_methods LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE;s public.job_settlement_methods%ROWTYPE;BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job FOR UPDATE;
 IF j.metadata->>'driver_settlement_method' IS DISTINCT FROM 'split' OR j.customer_id IS DISTINCT FROM p_customer OR j.status<>'completed' OR j.country_code<>'NG' OR j.currency_code<>'NGN'
  OR j.driver_id IS NULL OR j.payment_method<>'card' OR j.payment_status NOT IN('pending','unpaid','requires_payment') OR j.payment_intent_id IS NOT NULL
  OR j.stripe_transfer_id IS NOT NULL OR j.payout_transfer_id IS NOT NULL OR j.no_show_status IS NOT NULL OR coalesce(j.total_refunded_minor,0)>0
  OR EXISTS(SELECT 1 FROM public.driver_earnings WHERE job_id=p_job AND (status='paid' OR stripe_transfer_id IS NOT NULL OR payout_transfer_id IS NOT NULL))
  OR EXISTS(SELECT 1 FROM public.job_payout_queue WHERE job_id=p_job) OR EXISTS(SELECT 1 FROM public.refund_operations WHERE job_id=p_job)
 THEN RAISE EXCEPTION 'Booking is not eligible for split collection';END IF;
 IF p_terms->>'version' IS DISTINCT FROM 'vaydu-frozen-booking-split-v1' OR p_terms->>'environment' IS DISTINCT FROM 'test'
  OR p_terms->>'jobId' IS DISTINCT FROM p_job::text OR p_terms->>'customerId' IS DISTINCT FROM p_customer::text
  OR p_terms->>'driverId' IS DISTINCT FROM j.driver_id::text OR p_terms->>'tenantId' IS DISTINCT FROM j.tenant_id::text
  OR p_terms->'fareSnapshot' IS DISTINCT FROM j.fare_breakdown OR p_terms->>'currency' IS DISTINCT FROM 'NGN'
  OR (p_terms->>'totalMinor')::bigint IS DISTINCT FROM round((j.fare_breakdown->>'customerCharge')::numeric*100)::bigint
  OR (p_terms->>'driverMinor')::bigint IS DISTINCT FROM round((j.fare_breakdown->>'driverEntitlement')::numeric*100)::bigint
  OR (p_terms->>'platformFeeMinor')::bigint IS DISTINCT FROM round((j.fare_breakdown->>'platformFeeAmount')::numeric*100)::bigint
  OR (p_terms->>'commissionMinor')::bigint IS DISTINCT FROM round((j.fare_breakdown->>'driverCommissionAmount')::numeric*100)::bigint
  OR (p_terms->>'totalMinor')::bigint<>(p_terms->>'driverMinor')::bigint+(p_terms->>'platformFeeMinor')::bigint+(p_terms->>'commissionMinor')::bigint
  OR coalesce((p_terms->>'driverMinor')::bigint,0)<=0
  OR jsonb_array_length(p_terms->'subaccounts') IS DISTINCT FROM 1
  OR p_terms->'subaccounts'->0->>'id' IS DISTINCT FROM p_terms->>'subaccountId'
  OR p_terms->'subaccounts'->0->>'transaction_charge_type' IS DISTINCT FROM 'flat_subaccount'
  OR (p_terms->'subaccounts'->0->>'transaction_charge')::numeric*100 IS DISTINCT FROM (p_terms->>'driverMinor')::numeric
 THEN RAISE EXCEPTION 'Frozen split fare/identity mismatch';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.driver_collection_subaccounts a JOIN public.driver_collection_markets m USING(country_code,currency_code)
  JOIN public.profiles p ON p.id=a.driver_id
  WHERE a.id::text=p_terms->>'subaccountRecordId' AND a.driver_id=j.driver_id AND a.tenant_id=j.tenant_id AND a.environment='test'
  AND p.tenant_id=j.tenant_id AND p.role='driver' AND coalesce(p.registration_country_code,p.country_code)='NG'
  AND a.state='completed' AND a.subaccount_id=p_terms->>'subaccountId' AND a.merchant_account_ref=p_terms->>'merchantAccountRef'
  AND m.merchant_account_ref=a.merchant_account_ref AND m.setup_approved AND m.split_collection_approved AND m.adapter_ready
  AND m.split_semantics_verified AND m.fee_passing_verified AND m.settlement_verified AND m.sandbox_driver_id=j.driver_id AND m.sandbox_tenant_id=j.tenant_id
  AND m.provider_fee_budget_minor=(p_terms->>'providerFeeBudgetMinor')::bigint
  AND (p_terms->>'totalMinor')::bigint<=m.max_charge_minor
  AND (p_terms->>'platformFeeMinor')::bigint+(p_terms->>'commissionMinor')::bigint>=m.provider_fee_budget_minor)
 THEN RAISE EXCEPTION 'Approved driver subaccount/merchant capability missing';END IF;
 INSERT INTO public.job_settlement_methods(job_id,method,terms,reference) VALUES(p_job,'split',p_terms,'vaydu-split-'||p_job) ON CONFLICT(job_id) DO NOTHING;
 SELECT * INTO STRICT s FROM public.job_settlement_methods WHERE job_id=p_job;
 IF s.method<>'split' OR s.terms<>p_terms THEN RAISE EXCEPTION 'Settlement method/terms already frozen';END IF;
 RETURN NEXT s;
END $$;
CREATE FUNCTION public.claim_flutterwave_split_submission(p_job uuid,p_customer uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM public.jobs WHERE id=p_job AND customer_id=p_customer AND status='completed' AND payment_status IN('pending','unpaid','requires_payment') FOR UPDATE;
 IF NOT FOUND THEN RETURN false;END IF;
 UPDATE public.job_settlement_methods SET state='submitting' WHERE job_id=p_job AND method='split' AND state='reserved';RETURN FOUND;
END $$;
CREATE FUNCTION public.save_flutterwave_split_checkout(p_job uuid,p_customer uuid,p_url text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM public.jobs WHERE id=p_job AND customer_id=p_customer AND status='completed' FOR UPDATE;IF NOT FOUND THEN RETURN false;END IF;
 IF p_url !~ '^https://(checkout.flutterwave.com|ravemodal-dev.flutterwave.com)/' THEN RETURN false;END IF;
 UPDATE public.job_settlement_methods SET state='checkout',checkout_url=p_url WHERE job_id=p_job AND method='split' AND state='submitting';RETURN FOUND;
END $$;
CREATE FUNCTION public.confirm_flutterwave_split_collection(p_job uuid,p_customer uuid,p_transaction text,p_observation jsonb DEFAULT '{}'::jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.job_settlement_methods%ROWTYPE;BEGIN
 PERFORM 1 FROM public.jobs WHERE id=p_job AND customer_id=p_customer AND status='completed' FOR UPDATE;IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO STRICT s FROM public.job_settlement_methods WHERE job_id=p_job FOR UPDATE;
 IF s.method<>'split' OR p_transaction IS NULL OR p_transaction !~ '^\d+$' THEN RETURN false;END IF;
 IF s.state IN('collected','settled') THEN RETURN s.provider_transaction_id=p_transaction;END IF;
 IF s.state NOT IN('submitting','checkout') THEN RETURN false;END IF;
 UPDATE public.job_settlement_methods SET state='collected',provider_transaction_id=p_transaction,collection_evidence=jsonb_build_object('transactionId',p_transaction,
  'appFee',CASE WHEN p_observation->>'appFee' ~ '^\d+(\.\d+)?$' THEN p_observation->>'appFee' ELSE NULL END,
  'merchantFee',CASE WHEN p_observation->>'merchantFee' ~ '^\d+(\.\d+)?$' THEN p_observation->>'merchantFee' ELSE NULL END) WHERE job_id=p_job;
 UPDATE public.jobs SET payment_status='paid',settlement_status='pending',metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('driver_split_settlement_pending',true) WHERE id=p_job;
 INSERT INTO public.driver_earnings(driver_id,job_id,amount,platform_fee,gross_amount,status,currency_code,country_code)
 VALUES((s.terms->>'driverId')::uuid,p_job,(s.terms->>'driverMinor')::numeric/100,(s.terms->>'platformFeeMinor')::numeric/100,(s.terms->>'totalMinor')::numeric/100,'pending','NGN','NG')
 ON CONFLICT(job_id) DO NOTHING;
 RETURN true;
END $$;
CREATE FUNCTION public.finish_flutterwave_split_settlement(p_job uuid,p_transaction text,p_evidence jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.job_settlement_methods%ROWTYPE;BEGIN
 PERFORM 1 FROM public.jobs WHERE id=p_job AND status='completed' AND payment_status='paid' FOR UPDATE;IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO STRICT s FROM public.job_settlement_methods WHERE job_id=p_job FOR UPDATE;
 IF s.method<>'split' OR s.provider_transaction_id IS DISTINCT FROM p_transaction THEN RETURN false;END IF;
 IF s.state='settled' THEN RETURN s.settlement_evidence=p_evidence;END IF;
 IF s.state<>'collected' OR p_evidence->>'transactionId' IS DISTINCT FROM p_transaction OR p_evidence->>'reference' IS DISTINCT FROM s.reference
  OR p_evidence->>'subaccountId' IS DISTINCT FROM s.terms->>'subaccountId'
  OR (p_evidence->>'driverMinor')::bigint IS DISTINCT FROM (s.terms->>'driverMinor')::bigint
  OR coalesce(p_evidence->>'batchId','') !~ '^\d+$'
 THEN RETURN false;END IF;
 -- The original settlement writer remains the single earnings authority.
 PERFORM public.record_job_settlement(p_job,(s.terms->>'driverId')::uuid,(s.terms->>'totalMinor')::numeric/100,(s.terms->>'driverMinor')::numeric/100,
  (s.terms->>'platformFeeMinor')::numeric/100,(s.terms->>'commissionMinor')::numeric/100,(s.terms->'fareSnapshot'->>'commissionPercent')::numeric,
  NULL,'NGN','NG',true);
 UPDATE public.jobs SET payout_provider='flutterwave',payout_transfer_id=NULL,stripe_transfer_status=NULL,
  metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('driver_split_settlement_pending',false,'driver_settlement_method','split') WHERE id=p_job;
 UPDATE public.driver_earnings SET payout_provider='flutterwave' WHERE job_id=p_job;
 UPDATE public.job_settlement_methods SET state='settled',settlement_evidence=p_evidence WHERE job_id=p_job;RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.reserve_flutterwave_booking_split(uuid,uuid,jsonb),public.claim_flutterwave_split_submission(uuid,uuid),public.save_flutterwave_split_checkout(uuid,uuid,text),public.confirm_flutterwave_split_collection(uuid,uuid,text,jsonb),public.finish_flutterwave_split_settlement(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_flutterwave_booking_split(uuid,uuid,jsonb),public.claim_flutterwave_split_submission(uuid,uuid),public.save_flutterwave_split_checkout(uuid,uuid,text),public.confirm_flutterwave_split_collection(uuid,uuid,text,jsonb),public.finish_flutterwave_split_settlement(uuid,text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';COMMIT;
