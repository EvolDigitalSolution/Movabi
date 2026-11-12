-- =============================================================================
-- Batch 1B — role-boundary verification (disposable DB only, rollback-only).
-- Tests under actual anon / authenticated / service_role roles:
--   - clients cannot execute posting/reversal functions (insufficient_privilege)
--   - clients cannot access the server-only diagnostic view
--   - service_role cannot directly insert/update/delete ledger records
--   - the controlled posting function remains usable by service_role
-- =============================================================================
BEGIN;
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE v uuid; r record;
BEGIN
  -- anon: posting + view denied.
  SET ROLE anon;
  BEGIN
    PERFORM public.post_wallet_event('internal:role-anon','topup','11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','GBP',
      '[{"accountPurpose":"customer_credit","amountMinor":1},{"accountPurpose":"platform_funding","amountMinor":-1}]'::jsonb,
      'stripe','stripe-platform','pi_anon');
    RAISE EXCEPTION 'ASSERT: anon executed posting';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    SELECT * INTO r FROM public.wallet_reconciliation_projection LIMIT 1;
    RAISE EXCEPTION 'ASSERT: anon accessed the diagnostic view';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;

  -- authenticated: posting + view denied.
  SET ROLE authenticated;
  BEGIN
    PERFORM public.post_wallet_event('internal:role-auth','topup','11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','GBP',
      '[{"accountPurpose":"customer_credit","amountMinor":1},{"accountPurpose":"platform_funding","amountMinor":-1}]'::jsonb,
      'stripe','stripe-platform','pi_auth');
    RAISE EXCEPTION 'ASSERT: authenticated executed posting';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    SELECT * INTO r FROM public.wallet_reconciliation_projection LIMIT 1;
    RAISE EXCEPTION 'ASSERT: authenticated accessed the diagnostic view';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;

  -- service_role: direct insert/update/delete denied; posting usable.
  SET ROLE service_role;
  BEGIN
    INSERT INTO public.wallet_business_events (event_key, operation, tenant_id, owner_id, currency_code, entries)
    VALUES ('internal:role-svc','topup','11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','GBP','[]'::jsonb);
    RAISE EXCEPTION 'ASSERT: service_role inserted directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.wallet_accounts SET balance_purpose = 'tampered' WHERE false;
    RAISE EXCEPTION 'ASSERT: service_role updated directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    DELETE FROM public.wallet_movements WHERE false;
    RAISE EXCEPTION 'ASSERT: service_role deleted directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  v := public.post_wallet_event('internal:role-svc-ok','topup','11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','GBP',
    '[{"accountPurpose":"customer_credit","amountMinor":1},{"accountPurpose":"platform_funding","amountMinor":-1}]'::jsonb,
    'stripe','stripe-platform','pi_svc');
  IF v IS NULL THEN RAISE EXCEPTION 'ASSERT: service_role posting returned NULL'; END IF;
  RESET ROLE;
END
$$;

ROLLBACK;
