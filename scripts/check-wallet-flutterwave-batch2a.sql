-- =============================================================================
-- Batch 2A/2B — rollback-only fee-integration test (disposable DB).
-- =============================================================================
BEGIN;
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  tenant uuid := '11111111-1111-1111-1111-111111111111';
  owner  uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  attempt_id uuid; ev uuid; pol_id uuid;
BEGIN
  -- Enable gate + route + an active fee policy.
  INSERT INTO public.wallet_collection_config(key,value) VALUES ('enabled','true');
  INSERT INTO public.wallet_collection_config(key,value) VALUES ('max_amount_minor_NGN','1000000');
  UPDATE public.market_payment_routes SET enabled=true, merchant_approved=true, adapter_ready=true, capabilities=ARRAY['collect']::text[]
  WHERE country_code='NG' AND currency_code='NGN' AND method='card' AND provider='flutterwave' AND merchant_account_ref='flw-ng-merchant';
  INSERT INTO public.wallet_topup_fee_policies (version, provider, country_code, currency_code, method, fee_basis_points, fee_fixed_minor, exponent, active)
  VALUES ('v1','flutterwave','NG','NGN','card',150,0,2,true) RETURNING id INTO pol_id;

  -- Initiate (wallet amount), bind the provider reference, then freeze the fee.
  attempt_id := public.initiate_wallet_topup('internal:topup:flw:1', tenant, owner, 'NG', 'NGN', 10000, 'customer_credit', 'flutterwave', 'flw-ng-merchant', 'idem-flw');
  PERFORM public.freeze_wallet_topup_fee(attempt_id, 'v1');
  PERFORM public.record_wallet_topup_provider_reference(attempt_id, 'flw_ref_1');
  -- Conflicting policy version rejected after freezing.
  BEGIN
    PERFORM public.freeze_wallet_topup_fee(attempt_id, 'v2');
    RAISE EXCEPTION 'ASSERT: conflicting fee retry was accepted';
  EXCEPTION WHEN SQLSTATE 'BP002' THEN NULL;
  END;

  -- Total mismatch rejected.
  BEGIN
    PERFORM public.verify_wallet_topup_charge(attempt_id, 9999);
    RAISE EXCEPTION 'ASSERT: wrong total was accepted';
  EXCEPTION WHEN SQLSTATE 'BP008' THEN NULL;
  END;

  -- Correct total verified.
  IF NOT public.verify_wallet_topup_charge(attempt_id, 10150) THEN
    RAISE EXCEPTION 'ASSERT: correct total was not verified';
  END IF;

  -- Old 6-arg confirm cannot bypass the total check once a fee is frozen.
  BEGIN
    PERFORM public.confirm_wallet_topup(attempt_id, 'flw_ref_1', 'flw-ng-merchant', 'NGN', 10000, 'succeeded');
    RAISE EXCEPTION 'ASSERT: legacy confirm bypassed the total check';
  EXCEPTION WHEN SQLSTATE 'BP008' THEN NULL;
  END;

  -- Atomic total-check + wallet-amount-only credit.
  ev := public.confirm_wallet_topup_with_total(attempt_id, 'flw_ref_1', 'flw-ng-merchant', 'NGN', 10150, 'succeeded');
  IF ev IS NULL THEN RAISE EXCEPTION 'ASSERT: atomic confirm returned NULL'; END IF;
  -- Replay idempotent; conflicting total rejected.
  IF public.confirm_wallet_topup_with_total(attempt_id, 'flw_ref_1', 'flw-ng-merchant', 'NGN', 10150, 'succeeded') <> ev THEN
    RAISE EXCEPTION 'ASSERT: atomic confirm replay not idempotent';
  END IF;
  BEGIN
    PERFORM public.confirm_wallet_topup_with_total(attempt_id, 'flw_ref_1', 'flw-ng-merchant', 'NGN', 9999, 'succeeded');
    RAISE EXCEPTION 'ASSERT: conflicting total was accepted';
  EXCEPTION WHEN SQLSTATE 'BP002' THEN NULL;
  END;
  IF (SELECT sum(m.amount_minor) FROM public.wallet_movements m JOIN public.wallet_accounts a ON a.id=m.account_id JOIN public.wallet_business_events e ON e.id=m.event_id WHERE e.event_key='wallet-topup:' || attempt_id::text AND a.balance_purpose='customer_credit') <> 10000 THEN
    RAISE EXCEPTION 'ASSERT: credited amount is not the wallet amount';
  END IF;

  RAISE NOTICE 'Batch 2A/2B fee-integration test passed';
END
$$;

ROLLBACK;
