UPDATE public.driver_collection_markets SET merchant_account_ref='synthetic-merchant',sandbox_driver_id='11111111-1111-4111-8111-111111111111',
 sandbox_tenant_id='22222222-2222-4222-8222-222222222222',setup_approved=true,adapter_ready=true,capability_evidence_ref='synthetic-only',
 default_split_type='flat',default_split_value=0,split_collection_approved=true,split_semantics_verified=true,fee_passing_verified=true,settlement_verified=true,
 provider_fee_budget_minor=10000,max_charge_minor=2000000 WHERE country_code='NG';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.driver_collection_markets WHERE country_code<>'NG' AND (setup_approved OR split_collection_approved))
 THEN RAISE EXCEPTION 'Other market was enabled';END IF;
END $$;
CREATE FUNCTION public.synthetic_split_plan(p_job uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('version','vaydu-frozen-booking-split-v1','provider','flutterwave','environment','test','jobId',j.id,'customerId',j.customer_id,
 'driverId',j.driver_id,'tenantId',j.tenant_id,'country','NG','currency','NGN','merchantAccountRef',a.merchant_account_ref,'subaccountId',a.subaccount_id,
 'subaccountRecordId',a.id,'totalMinor',1030000,'driverMinor',880000,'vayduGrossMinor',150000,'platformFeeMinor',30000,'commissionMinor',120000,
 'providerFeeBudgetMinor',10000,'fareSnapshot',j.fare_breakdown,'subaccounts',jsonb_build_array(jsonb_build_object('id',a.subaccount_id,'transaction_charge_type','flat_subaccount','transaction_charge','8800')))
 FROM public.jobs j JOIN public.driver_collection_subaccounts a ON a.driver_id=j.driver_id WHERE j.id=p_job
$$;
INSERT INTO public.jobs(id,driver_id,customer_id,tenant_id,country_code,currency_code,status,payment_status,payment_method,price,total_price,metadata,fare_breakdown)
 SELECT id::uuid,'11111111-1111-4111-8111-111111111111','88888888-8888-4888-8888-888888888888','22222222-2222-4222-8222-222222222222',
 'NG','NGN','completed','pending','card',10300,10300,'{"driver_settlement_method":"split"}'::jsonb,
 '{"policyVersion":"fare-split-v1","currency":"NGN","customerCharge":10300,"platformFeeAmount":300,"driverCommissionAmount":1200,"driverEntitlement":8800,"driverBase":10000,"grossRevenue":1500,"commissionPercent":12}'::jsonb
 FROM unnest(ARRAY['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc','dddddddd-dddd-4ddd-8ddd-dddddddddddd']) id;
SELECT job_id FROM public.reserve_flutterwave_booking_split('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','88888888-8888-4888-8888-888888888888',public.synthetic_split_plan('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
DO $$ BEGIN
 BEGIN
  PERFORM public.claim_driver_collection_subaccount('11111111-1111-4111-8111-111111111111','99999999-9999-4999-8999-999999999999','synthetic-merchant',repeat('b',64),repeat('c',64),'bank','6789');
  RAISE EXCEPTION 'Foreign tenant setup accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM='Foreign tenant setup accepted' THEN RAISE;END IF;END;
 BEGIN
  PERFORM public.reserve_flutterwave_booking_split('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','88888888-8888-4888-8888-888888888888',
   jsonb_set(public.synthetic_split_plan('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),'{environment}','"live"'));
  RAISE EXCEPTION 'Foreign environment accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM='Foreign environment accepted' THEN RAISE;END IF;END;
 BEGIN
  PERFORM public.reserve_flutterwave_booking_split('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','88888888-8888-4888-8888-888888888888',
   jsonb_set(public.synthetic_split_plan('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),'{subaccountId}','"RS_OTHER"'));
  RAISE EXCEPTION 'Foreign subaccount accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM='Foreign subaccount accepted' THEN RAISE;END IF;END;
 BEGIN
  UPDATE public.jobs SET fare_breakdown=jsonb_set(fare_breakdown,'{driverEntitlement}','8801') WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';RAISE EXCEPTION 'Changed fare accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM='Changed fare accepted' THEN RAISE;END IF;END;
 BEGIN
  UPDATE public.jobs SET no_show_status='fee_charged' WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';RAISE EXCEPTION 'No-show accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM='No-show accepted' THEN RAISE;END IF;END;
 BEGIN
  INSERT INTO public.refund_operations(job_id) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');RAISE EXCEPTION 'Unreconciled refund accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM='Unreconciled refund accepted' THEN RAISE;END IF;END;
 BEGIN
  INSERT INTO public.job_payout_queue(job_id,driver_id,destination,amount_minor,currency,terms)
   SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',driver_id,destination,amount_minor,currency,terms FROM public.job_payout_queue LIMIT 1;
  RAISE EXCEPTION 'Double transfer queue accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM='Double transfer queue accepted' THEN RAISE;END IF;END;
 BEGIN
  PERFORM public.reserve_flutterwave_booking_split('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','99999999-9999-4999-8999-999999999999',public.synthetic_split_plan('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  RAISE EXCEPTION 'Wrong customer accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM='Wrong customer accepted' THEN RAISE;END IF;END;
END $$;
-- Cancellation before submit never collects; cancellation after submit needs refund review.
SELECT job_id FROM public.reserve_flutterwave_booking_split('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','88888888-8888-4888-8888-888888888888',public.synthetic_split_plan('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
UPDATE public.jobs SET status='cancelled' WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
SELECT job_id FROM public.reserve_flutterwave_booking_split('cccccccc-cccc-4ccc-8ccc-cccccccccccc','88888888-8888-4888-8888-888888888888',public.synthetic_split_plan('cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
SELECT public.claim_flutterwave_split_submission('cccccccc-cccc-4ccc-8ccc-cccccccccccc','88888888-8888-4888-8888-888888888888');
UPDATE public.jobs SET status='cancelled' WHERE id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
DO $$ BEGIN
 IF (SELECT state FROM public.job_settlement_methods WHERE job_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')<>'cancelled'
 OR (SELECT state FROM public.job_settlement_methods WHERE job_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc')<>'refund_review'
 OR public.confirm_flutterwave_split_collection('cccccccc-cccc-4ccc-8ccc-cccccccccccc','88888888-8888-4888-8888-888888888888','77')
 THEN RAISE EXCEPTION 'Cancellation reconciliation failed';END IF;
END $$;
