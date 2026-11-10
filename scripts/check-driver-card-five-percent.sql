BEGIN;
INSERT INTO public.wallet_collection_config(key,value) VALUES('enabled','false'),('driver_card_sandbox_enabled','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
DO $$
DECLARE provider text; currency text; country text; exponent integer; merchant text; account text; a uuid; ev uuid; wallet bigint; fee bigint; tenant uuid:='11111111-1111-1111-1111-111111111111'; owner uuid:='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
BEGIN
 FOREACH provider IN ARRAY ARRAY['stripe','flutterwave'] LOOP
  FOREACH currency IN ARRAY ARRAY['NGN','JPY','KWD'] LOOP
   country:=CASE currency WHEN 'NGN' THEN 'NG' WHEN 'JPY' THEN 'JP' ELSE 'KW' END;
   exponent:=public.wallet_currency_minor_exponent(currency);wallet:=10000*power(10,exponent)::bigint;fee:=500*power(10,exponent)::bigint;
   merchant:='synthetic-'||provider||'-'||currency;account:=CASE provider WHEN 'stripe' THEN 'acct_synthetic' ELSE '17321' END;
   UPDATE public.market_payment_routes SET enabled=false WHERE country_code=country AND currency_code=currency;
   INSERT INTO public.market_availability(country_code,supported_currency) SELECT country,currency WHERE NOT EXISTS(SELECT 1 FROM public.market_availability WHERE country_code=country AND supported_currency=currency);
   INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref,preferred,enabled,merchant_approved,adapter_ready,capabilities) VALUES(country,currency,'card',provider,merchant,true,true,true,true,ARRAY['collect']);
   INSERT INTO public.wallet_collection_config(key,value) VALUES('max_amount_minor_'||currency,'100000000') ON CONFLICT(key) DO UPDATE SET value='100000000';
   INSERT INTO public.wallet_topup_fee_schedules(version,provider,country_code,currency_code,method,exponent,fee_basis,fee_basis_points,fee_fixed_minor,rounding,approved_by,approved_at,active)
   VALUES('vaydu-driver-card-5pct-wallet-v1',provider,country,currency,'card',exponent,'wallet',500,0,'half_up','synthetic approval',now(),true);
   INSERT INTO public.driver_card_topup_sandbox_scopes(provider,method,country_code,currency_code,merchant_account_ref,provider_account_id,tenant_id,driver_id,fee_passing_mode,reviewed_by,reviewed_at,evidence_reference,policy_version,enabled)
   VALUES(provider,'card',country,currency,merchant,account,tenant,owner,'merchant','synthetic reviewer',now(),'synthetic merchant-absorbs-fees review','vaydu-driver-card-5pct-wallet-v1',true);
   a:=public.initiate_wallet_topup('driver-topup:5pct:'||provider||currency,tenant,owner,country,currency,wallet,'driver_cash_credit',provider,merchant,'idem-'||provider||currency);
   PERFORM public.freeze_wallet_topup_fee(a,'vaydu-driver-card-5pct-wallet-v1');
   IF NOT EXISTS(SELECT 1 FROM public.wallet_topup_attempts WHERE id=a AND amount_minor=wallet AND provider_fee_minor=fee AND total_charge_minor=wallet+fee AND fee_exponent=exponent AND provider_account_id=account) THEN RAISE EXCEPTION 'Five percent mismatch'; END IF;
   IF NOT public.claim_wallet_topup_submission(a) OR public.claim_wallet_topup_submission(a) THEN RAISE EXCEPTION 'Duplicate submission'; END IF;
   PERFORM public.record_wallet_topup_provider_reference(a,a::text);
   PERFORM public.record_driver_topup_provider_observation(a,jsonb_build_object('source','server-query','provider',provider,'reference',a::text,'chargedAmountMajor','10500','appFeeMajor','123.456789','amountSettledMajor','10376.543211'));
   PERFORM public.record_driver_topup_provider_observation(a,jsonb_build_object('source','server-query','provider',provider,'reference',a::text,'chargedAmountMajor','10500','appFeeMajor','123.456789','amountSettledMajor','10376.543211'));
   IF (SELECT count(*) FROM public.wallet_topup_provider_observations WHERE attempt_id=a)<>1 THEN RAISE EXCEPTION 'Duplicate observation'; END IF;
   BEGIN
    PERFORM public.record_driver_topup_provider_observation(a,jsonb_build_object('source','server-query','provider',provider,'cardToken','forbidden'));
    RAISE EXCEPTION 'Sensitive observation field accepted';
   EXCEPTION WHEN SQLSTATE 'BP004' THEN NULL; END;
   ev:=public.confirm_wallet_topup_with_total(a,a::text,merchant,currency,wallet+fee,'succeeded');
   IF public.confirm_wallet_topup_with_total(a,a::text,merchant,currency,wallet+fee,'succeeded')<>ev THEN RAISE EXCEPTION 'Duplicate credit'; END IF;
   IF (SELECT m.amount_minor FROM public.wallet_movements m JOIN public.wallet_accounts w ON w.id=m.account_id WHERE m.event_id=ev AND w.balance_purpose='driver_cash_credit')<>wallet THEN RAISE EXCEPTION 'Fee credited'; END IF;
  END LOOP;
 END LOOP;
END $$;
DO $$ BEGIN
 SET ROLE authenticated;
 BEGIN
  PERFORM public.record_driver_topup_provider_observation(gen_random_uuid(),'{}');RAISE EXCEPTION 'Client observation accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 RESET ROLE;
END $$;
DO $$ BEGIN IF public.wallet_collection_enabled() IS DISTINCT FROM false THEN RAISE EXCEPTION 'Broad collection gate changed'; END IF; END $$;
ROLLBACK;
