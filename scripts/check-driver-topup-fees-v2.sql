BEGIN;
INSERT INTO public.wallet_collection_config(key,value) VALUES('enabled','true'),('max_amount_minor_NGN','9007199254740991') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
UPDATE public.market_payment_routes SET enabled=true,merchant_approved=true,adapter_ready=true,capabilities=ARRAY['collect'] WHERE provider='flutterwave';
INSERT INTO public.wallet_topup_fee_schedules(version,provider,country_code,currency_code,method,exponent,fee_basis,fee_basis_points,fee_fixed_minor,rounding,approved_by,approved_at,active)
VALUES ('test-gross','flutterwave','NG','NGN','card',2,'total',150,100,'ceil','synthetic-test',now(),true);
DO $$ DECLARE a uuid; e uuid; t bigint; BEGIN
 a:=public.initiate_wallet_topup('driver-topup:synthetic:v2','11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','NG','NGN',10000,'driver_cash_credit','flutterwave','flw-ng-merchant','v2');
 PERFORM public.freeze_wallet_topup_fee(a,'test-gross');
 SELECT total_charge_minor INTO t FROM public.wallet_topup_attempts WHERE id=a;
 IF t<>10254 THEN RAISE EXCEPTION 'gross up incorrect: %',t; END IF;
 IF NOT public.claim_wallet_topup_submission(a) OR public.claim_wallet_topup_submission(a) THEN RAISE EXCEPTION 'duplicate submission'; END IF;
 PERFORM public.record_wallet_topup_provider_reference(a,a::text);
 e:=public.confirm_wallet_topup_with_total(a,a::text,'flw-ng-merchant','NGN',t,'succeeded');
 IF public.confirm_wallet_topup_with_total(a,a::text,'flw-ng-merchant','NGN',t,'succeeded')<>e THEN RAISE EXCEPTION 'duplicate credit'; END IF;
 IF (SELECT amount_minor FROM public.wallet_movements m JOIN public.wallet_accounts w ON w.id=m.account_id WHERE m.event_id=e AND w.balance_purpose='driver_cash_credit')<>10000 THEN RAISE EXCEPTION 'fee credited'; END IF;
 BEGIN
  PERFORM public.confirm_wallet_topup_with_total(a,'wrong','flw-ng-merchant','NGN',t,'succeeded'); RAISE EXCEPTION 'wrong reference accepted';
 EXCEPTION WHEN SQLSTATE 'BP002' THEN NULL; END;
 BEGIN
  PERFORM public.confirm_wallet_topup_with_total(a,a::text,'wrong','NGN',t,'succeeded'); RAISE EXCEPTION 'wrong merchant accepted';
 EXCEPTION WHEN SQLSTATE 'BP002' THEN NULL; END;
 BEGIN
  PERFORM public.confirm_wallet_topup_with_total(a,a::text,'flw-ng-merchant','USD',t,'succeeded'); RAISE EXCEPTION 'wrong currency accepted';
 EXCEPTION WHEN SQLSTATE 'BP002' THEN NULL; END;
 BEGIN
  PERFORM public.confirm_wallet_topup_with_total(a,a::text,'flw-ng-merchant','NGN',t+1,'succeeded');
  RAISE EXCEPTION 'wrong total accepted';
 EXCEPTION WHEN SQLSTATE 'BP002' THEN NULL; END;
 BEGIN
  PERFORM public.mark_wallet_topup_refunded(a,'partial',a::text,'flw-ng-merchant','NGN',t-1,'refunded','synthetic'); RAISE EXCEPTION 'partial refund accepted';
 EXCEPTION WHEN SQLSTATE 'BP008' THEN NULL; END;
 PERFORM public.mark_wallet_topup_refunded(a,'full',a::text,'flw-ng-merchant','NGN',t,'refunded','synthetic');
 PERFORM public.mark_wallet_topup_refunded(a,'full',a::text,'flw-ng-merchant','NGN',t,'refunded','synthetic');
 IF (SELECT sum(m.amount_minor) FROM public.wallet_movements m JOIN public.wallet_accounts w ON w.id=m.account_id WHERE w.balance_purpose='driver_cash_credit')<>0 THEN RAISE EXCEPTION 'refund failed to reverse credit'; END IF;
 BEGIN
  UPDATE public.wallet_topup_fee_schedules SET fee_fixed_minor=999 WHERE version='test-gross'; RAISE EXCEPTION 'policy edited';
 EXCEPTION WHEN SQLSTATE 'BP007' THEN NULL; END;
 a:=public.initiate_wallet_topup('driver-topup:synthetic:overflow','11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','NG','NGN',9007199254740991,'driver_cash_credit','flutterwave','flw-ng-merchant','overflow');
 BEGIN
  PERFORM public.freeze_wallet_topup_fee(a,'test-gross'); RAISE EXCEPTION 'overflow accepted';
 EXCEPTION WHEN SQLSTATE 'BP008' THEN NULL; END;
END $$;
-- Zero- and three-decimal ledger authorities, synthetic routes only.
INSERT INTO public.market_availability(country_code,supported_currency) VALUES('JP','JPY'),('KW','KWD');
INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref,preferred,enabled,merchant_approved,adapter_ready,capabilities)
VALUES('JP','JPY','card','flutterwave','synthetic-jpy',true,true,true,true,ARRAY['collect']),('KW','KWD','card','flutterwave','synthetic-kwd',true,true,true,true,ARRAY['collect']);
INSERT INTO public.wallet_collection_config(key,value) VALUES('max_amount_minor_JPY','100000'),('max_amount_minor_KWD','100000');
INSERT INTO public.wallet_topup_fee_schedules(version,provider,country_code,currency_code,method,exponent,fee_basis,fee_basis_points,fee_fixed_minor,rounding,approved_by,approved_at,active)
VALUES('zero','flutterwave','JP','JPY','card',0,'wallet',0,0,'half_up','synthetic',now(),true),('three','flutterwave','KW','KWD','card',3,'wallet',150,100,'ceil','synthetic',now(),true);
DO $$ DECLARE a uuid; BEGIN
 a:=public.initiate_wallet_topup('driver-topup:synthetic:zero','11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','JP','JPY',1234,'driver_cash_credit','flutterwave','synthetic-jpy','zero');
 PERFORM public.freeze_wallet_topup_fee(a,'zero');
 IF NOT EXISTS(SELECT 1 FROM public.wallet_topup_attempts WHERE id=a AND fee_exponent=0 AND provider_fee_minor=0 AND total_charge_minor=1234) THEN RAISE EXCEPTION 'zero failed'; END IF;
 a:=public.initiate_wallet_topup('driver-topup:synthetic:three','11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','KW','KWD',1234,'driver_cash_credit','flutterwave','synthetic-kwd','three');
 PERFORM public.freeze_wallet_topup_fee(a,'three');
 IF NOT EXISTS(SELECT 1 FROM public.wallet_topup_attempts WHERE id=a AND fee_exponent=3 AND provider_fee_minor=119 AND total_charge_minor=1353) THEN RAISE EXCEPTION 'three failed'; END IF;
END $$;
ROLLBACK;
