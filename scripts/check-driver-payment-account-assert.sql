DO $$ BEGIN
 IF (SELECT provider FROM public.market_payment_routes WHERE country_code='NG' AND preferred)<>'flutterwave'
 OR (SELECT provider FROM public.market_payment_routes WHERE country_code='GH' AND preferred)<>'kora'
 OR EXISTS(SELECT 1 FROM public.driver_payout_markets WHERE enabled OR merchant_approved OR adapter_ready)
 OR (SELECT count(*) FROM public.market_payment_routes WHERE country_code='NG' AND provider='kora')<>1
 THEN RAISE EXCEPTION 'Default/override/disabled invariants failed'; END IF;
END $$;
INSERT INTO public.profiles VALUES('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','driver','NG','NG',now());
UPDATE public.driver_payout_markets SET enabled=true,merchant_approved=true,adapter_ready=true,merchant_account_ref='synthetic-merchant',capability_verified_at=now(),capability_evidence_ref='synthetic-only',
 sandbox_driver_id='11111111-1111-4111-8111-111111111111',sandbox_tenant_id='22222222-2222-4222-8222-222222222222' WHERE country_code='NG';
SELECT count(*) FROM public.claim_driver_payment_setup('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','NG','NGN','synthetic-merchant');
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.claim_driver_payment_setup('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','NG','NGN','synthetic-merchant'))
 THEN RAISE EXCEPTION 'Concurrent setup claim accepted'; END IF;
 BEGIN
  PERFORM public.claim_driver_payment_setup('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','NG','NGN','synthetic-merchant');
  RAISE EXCEPTION 'Wrong tenant accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM='Wrong tenant accepted' THEN RAISE; END IF; END;
END $$;
UPDATE public.driver_payment_accounts SET state='completed',beneficiary_id='9',bank_code='044',last4='6789',fingerprint=repeat('a',64);
INSERT INTO public.jobs(id,driver_id,tenant_id,country_code,currency_code,status,payment_status,payment_method)
 VALUES('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','NG','NGN','in_progress','paid','card');
SELECT id FROM public.complete_job_with_pending_payout('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111',
 (SELECT jsonb_build_object('total',105,'payout',100,'platformFee',5,'commission',0,'commissionRate',0,'amountMinor',10000,'currency','NGN','country','NG',
 'destination','flw:'||id,'payout_provider','flutterwave','payout_account_id',id,'payout_merchant',merchant_account_ref,'payout_tenant',tenant_id) FROM public.driver_payment_accounts),
 '{"completion_pin_verified_at":"synthetic-only"}');
SELECT job_id FROM public.claim_queued_job_payout('44444444-4444-4444-8444-444444444444');
DO $$ BEGIN
 IF (SELECT status FROM public.driver_earnings WHERE job_id='44444444-4444-4444-8444-444444444444')<>'pending' THEN RAISE EXCEPTION 'Accepted completion prematurely paid earnings'; END IF;
 IF EXISTS(SELECT 1 FROM public.claim_queued_job_payout('44444444-4444-4444-8444-444444444444')) THEN RAISE EXCEPTION 'Duplicate lease'; END IF;
END $$;
