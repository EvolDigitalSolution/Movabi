BEGIN;
DO $$ DECLARE a record; e uuid; BEGIN
 FOR a IN SELECT * FROM public.wallet_topup_attempts WHERE attempt_key LIKE 'legacy-test-%' LOOP
  IF NOT a.legacy_attempt THEN RAISE EXCEPTION 'lost legacy classification'; END IF;
  e:=public.confirm_wallet_topup(a.id,a.provider_reference,a.merchant_account_ref,a.currency_code,a.amount_minor,'succeeded');
  IF public.confirm_wallet_topup(a.id,a.provider_reference,a.merchant_account_ref,a.currency_code,a.amount_minor,'succeeded')<>e THEN RAISE EXCEPTION 'legacy duplicate'; END IF;
 END LOOP;
END $$;
ROLLBACK;
