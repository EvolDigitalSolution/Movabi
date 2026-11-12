-- =============================================================================
-- Batch 1C — rollback-only top-up test (disposable DB; after 1A+1B+1C applied).
-- =============================================================================
BEGIN;
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  tenant uuid := '11111111-1111-1111-1111-111111111111';
  owner  uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  attempt_id uuid; ev uuid; ev2 uuid;
  key1 text := 'internal:topup:stripe:1';
BEGIN
  -- 0. Disabled-by-default gate rejects collection before enabling.
  BEGIN
    PERFORM public.initiate_wallet_topup('internal:topup:disabled', tenant, owner, 'GB', 'GBP', 100, 'customer_credit', 'stripe', 'stripe-platform', 'idem-x');
    RAISE EXCEPTION 'ASSERT: disabled collection was accepted';
  EXCEPTION WHEN SQLSTATE 'BP008' THEN NULL;
  END;

  -- Enable the collection gate + market limit + an eligible Stripe collect route.
  INSERT INTO public.wallet_collection_config(key, value) VALUES ('enabled', 'true'), ('max_amount_minor_NGN','1000000');
  INSERT INTO public.wallet_collection_config(key, value) VALUES ('max_amount_minor_GBP', '1000000');
  UPDATE public.market_payment_routes
  SET enabled = true, merchant_approved = true, adapter_ready = true, capabilities = ARRAY['collect']::text[]
  WHERE country_code='GB' AND currency_code='GBP' AND method='card' AND provider='stripe' AND merchant_account_ref='stripe-platform';

  -- 1. Initiate (all immutable terms incl. provider idempotency identity).
  attempt_id := public.initiate_wallet_topup(key1, tenant, owner, 'GB', 'GBP', 10000, 'customer_credit', 'stripe', 'stripe-platform', 'idem-1');
  IF attempt_id IS NULL THEN RAISE EXCEPTION 'ASSERT: initiate returned NULL'; END IF;

  -- 2. Replay same terms idempotent; different terms -> BP002.
  IF public.initiate_wallet_topup(key1, tenant, owner, 'GB', 'GBP', 10000, 'customer_credit', 'stripe', 'stripe-platform', 'idem-1') <> attempt_id THEN
    RAISE EXCEPTION 'ASSERT: initiate replay not idempotent';
  END IF;
  BEGIN
    PERFORM public.initiate_wallet_topup(key1, tenant, owner, 'GB', 'GBP', 9999, 'customer_credit', 'stripe', 'stripe-platform', 'idem-1');
    RAISE EXCEPTION 'ASSERT: different-terms replay was accepted';
  EXCEPTION WHEN SQLSTATE 'BP002' THEN NULL;
  END;

  -- 3. Kora collection route not approved -> BP008 (never substitutes Stripe).
  BEGIN
    PERFORM public.initiate_wallet_topup('internal:topup:kora:1', tenant, owner, 'NG', 'NGN', 10000, 'customer_credit', 'kora', 'ng-merchant', 'idem-k');
    RAISE EXCEPTION 'ASSERT: Kora collection was not rejected';
  EXCEPTION WHEN SQLSTATE 'BP008' THEN NULL;
  END;

  -- 4. Destination validation: earnings_payable is not collectible -> BP008.
  BEGIN
    PERFORM public.initiate_wallet_topup('internal:topup:bad-dest', tenant, owner, 'GB', 'GBP', 10000, 'earnings_payable', 'stripe', 'stripe-platform', 'idem-d');
    RAISE EXCEPTION 'ASSERT: non-collectible destination was accepted';
  EXCEPTION WHEN SQLSTATE 'BP008' THEN NULL;
  END;

  -- 5. Record reference (same idempotent; different rejected).
  PERFORM public.record_wallet_topup_provider_reference(attempt_id, 'pi_1');
  IF (SELECT status FROM public.wallet_topup_attempts WHERE id=attempt_id) <> 'provider_pending' THEN
    RAISE EXCEPTION 'ASSERT: status not provider_pending';
  END IF;
  PERFORM public.record_wallet_topup_provider_reference(attempt_id, 'pi_1');  -- idempotent
  BEGIN
    PERFORM public.record_wallet_topup_provider_reference(attempt_id, 'pi_2');
    RAISE EXCEPTION 'ASSERT: different provider reference was accepted';
  EXCEPTION WHEN SQLSTATE 'BP008' THEN NULL;
  END;

  -- 6. Confirm: NULL/pending status rejected.
  BEGIN
    PERFORM public.confirm_wallet_topup(attempt_id, 'pi_1', 'stripe-platform', 'GBP', 10000, NULL);
    RAISE EXCEPTION 'ASSERT: NULL status was accepted';
  EXCEPTION WHEN SQLSTATE 'BP008' THEN NULL;
  END;
  BEGIN
    PERFORM public.confirm_wallet_topup(attempt_id, 'pi_1', 'stripe-platform', 'GBP', 10000, 'pending');
    RAISE EXCEPTION 'ASSERT: pending status was accepted';
  EXCEPTION WHEN SQLSTATE 'BP008' THEN NULL;
  END;

  -- 7. Confirm mismatched merchant -> BP008.
  BEGIN
    PERFORM public.confirm_wallet_topup(attempt_id, 'pi_1', 'wrong-merchant', 'GBP', 10000, 'succeeded');
    RAISE EXCEPTION 'ASSERT: wrong merchant was accepted';
  EXCEPTION WHEN SQLSTATE 'BP008' THEN NULL;
  END;

  -- 8. Confirm success -> single credit.
  ev := public.confirm_wallet_topup(attempt_id, 'pi_1', 'stripe-platform', 'GBP', 10000, 'succeeded');
  IF ev IS NULL THEN RAISE EXCEPTION 'ASSERT: confirm returned NULL'; END IF;
  IF (SELECT count(*) FROM public.wallet_movements m JOIN public.wallet_business_events e ON e.id=m.event_id WHERE e.id=ev) <> 2 THEN
    RAISE EXCEPTION 'ASSERT: credit did not post two movements';
  END IF;

  -- 9. Confirm replay idempotent + mismatched replay terms -> BP002.
  ev2 := public.confirm_wallet_topup(attempt_id, 'pi_1', 'stripe-platform', 'GBP', 10000, 'succeeded');
  IF ev <> ev2 THEN RAISE EXCEPTION 'ASSERT: confirm replay credited twice'; END IF;
  BEGIN
    PERFORM public.confirm_wallet_topup(attempt_id, 'pi_1', 'stripe-platform', 'GBP', 9999, 'succeeded');
    RAISE EXCEPTION 'ASSERT: mismatched replay terms were accepted';
  EXCEPTION WHEN SQLSTATE 'BP002' THEN NULL;
  END;

  -- 10. Refund requires verified evidence (provider/merchant/reference/currency/full amount).
  BEGIN
    PERFORM public.mark_wallet_topup_refunded(attempt_id,'partial','pi_1','stripe-platform','GBP',5000,'refunded','partial');
    RAISE EXCEPTION 'ASSERT: partial refund accepted before full reversal';
  EXCEPTION WHEN SQLSTATE 'BP008' THEN NULL; END;
  PERFORM public.mark_wallet_topup_refunded(attempt_id, 'evt-cb-1', 'pi_1', 'stripe-platform', 'GBP', 10000, 'refunded', 'chargeback');
  IF (SELECT status FROM public.wallet_topup_attempts WHERE id=attempt_id) <> 'refunded' THEN
    RAISE EXCEPTION 'ASSERT: refunded status not set';
  END IF;
  PERFORM public.mark_wallet_topup_refunded(attempt_id, 'evt-cb-1', 'pi_1', 'stripe-platform', 'GBP', 10000, 'refunded', 'chargeback');  -- idempotent
  BEGIN
    PERFORM public.mark_wallet_topup_refunded(attempt_id, 'evt-cb-1', 'pi_1', 'stripe-platform', 'GBP', 5000, 'refunded', 'chargeback');
    RAISE EXCEPTION 'ASSERT: partial refund was accepted';
  EXCEPTION WHEN SQLSTATE 'BP002' THEN NULL;
  END;
  BEGIN
    PERFORM public.mark_wallet_topup_refunded(attempt_id, 'evt-cb-1', 'pi_1', 'wrong-merchant', 'GBP', 10000, 'refunded', 'chargeback');
    RAISE EXCEPTION 'ASSERT: mismatched refund merchant was accepted';
  EXCEPTION WHEN SQLSTATE 'BP002' THEN NULL;
  END;
  BEGIN
    PERFORM public.mark_wallet_topup_refunded(attempt_id, 'evt-cb-2', 'pi_1', 'stripe-platform', 'GBP', 10000, 'refunded', 'chargeback');
    RAISE EXCEPTION 'ASSERT: different refund evidence was accepted';
  EXCEPTION WHEN SQLSTATE 'BP002' THEN NULL;
  END;
  BEGIN
    PERFORM public.mark_wallet_topup_failed(attempt_id, 'late failure');
    RAISE EXCEPTION 'ASSERT: refunded attempt was downgraded';
  EXCEPTION WHEN SQLSTATE 'BP008' THEN NULL;
  END;

  -- 11. Webhook-before-reference: durable evidence, then reconcile.
  DECLARE attempt2 uuid;
  BEGIN
    attempt2 := public.initiate_wallet_topup('internal:topup:stripe:2', tenant, owner, 'GB', 'GBP', 5000, 'customer_credit', 'stripe', 'stripe-platform', 'idem-2');
    PERFORM public.record_wallet_topup_verification(attempt2, 'evt-wb-1', 'pi_wb', 'stripe-platform', 'GBP', 5000, 'succeeded');
    PERFORM public.mark_wallet_topup_uncertain(attempt2,'webhook before provider response');
    PERFORM public.record_wallet_topup_provider_reference(attempt2, 'pi_wb');
    PERFORM public.reconcile_wallet_topup(attempt2, 'evt-wb-1');
    IF (SELECT status FROM public.wallet_topup_attempts WHERE id=attempt2) <> 'credited' THEN
      RAISE EXCEPTION 'ASSERT: webhook-before-reference did not reconcile to credited';
    END IF;
  END;

  -- 12. Uncertainty recovery via same-provider confirmation.
  DECLARE attempt3 uuid;
  BEGIN
    attempt3 := public.initiate_wallet_topup('internal:topup:stripe:3', tenant, owner, 'GB', 'GBP', 7000, 'customer_credit', 'stripe', 'stripe-platform', 'idem-3');
    PERFORM public.record_wallet_topup_provider_reference(attempt3, 'pi_u');
    PERFORM public.mark_wallet_topup_uncertain(attempt3, 'timeout');
    IF (SELECT status FROM public.wallet_topup_attempts WHERE id=attempt3) <> 'uncertain' THEN
      RAISE EXCEPTION 'ASSERT: uncertain not set';
    END IF;
    PERFORM public.confirm_wallet_topup(attempt3, 'pi_u', 'stripe-platform', 'GBP', 7000, 'succeeded');
    IF (SELECT status FROM public.wallet_topup_attempts WHERE id=attempt3) <> 'credited' THEN
      RAISE EXCEPTION 'ASSERT: uncertain not recovered to credited';
    END IF;
  END;

  RAISE NOTICE 'Batch 1C top-up test passed';
END
$$;

ROLLBACK;
