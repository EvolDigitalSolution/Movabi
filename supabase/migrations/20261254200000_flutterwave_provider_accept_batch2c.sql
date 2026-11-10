-- =============================================================================
-- Batch 2C — accept Flutterwave in the top-up/ledger lifecycle (additive).
-- Batch 1B and Batch 1C reject 'flutterwave' in their provider CHECKs and
-- functions. This migration widens the accepted provider set WITHOUT replacing
-- the applied migrations (CREATE OR REPLACE + precise CHECK swaps).
-- =============================================================================
BEGIN;

-- 1. wallet_business_events.payment_provider CHECK (Batch 1B).
ALTER TABLE public.wallet_business_events
  DROP CONSTRAINT IF EXISTS wallet_business_events_payment_provider_check;
ALTER TABLE public.wallet_business_events
  ADD CONSTRAINT wallet_business_events_payment_provider_check
  CHECK (payment_provider IS NULL OR payment_provider IN ('stripe','kora','fincra','flutterwave'));

-- 2. wallet_topup_attempts.payment_provider CHECK (Batch 1C).
ALTER TABLE public.wallet_topup_attempts
  DROP CONSTRAINT IF EXISTS wallet_topup_attempts_payment_provider_check;
ALTER TABLE public.wallet_topup_attempts
  ADD CONSTRAINT wallet_topup_attempts_payment_provider_check
  CHECK (payment_provider IN ('stripe','kora','flutterwave'));

-- 3. post_wallet_event: widen the accepted provider set (everything else unchanged).
CREATE OR REPLACE FUNCTION public.post_wallet_event(
  p_event_key text,
  p_operation text,
  p_tenant_id uuid,
  p_owner_id uuid,
  p_currency_code text,
  p_entries jsonb,
  p_payment_provider text DEFAULT NULL,
  p_merchant_account_ref text DEFAULT NULL,
  p_provider_reference text DEFAULT NULL,
  p_reverses_event_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event_id uuid;
  v_account_id uuid;
  v_sum numeric := 0;
  v_entries jsonb;
  v_expected jsonb;
  v_original public.wallet_business_events%ROWTYPE;
  v_constraint_name text;
  entry record;
  leg jsonb;
BEGIN
  -- Input validation (BP003).
  IF p_event_key IS NULL OR btrim(p_event_key) = '' OR length(p_event_key) > 200 THEN
    RAISE EXCEPTION 'Batch 1B: invalid event_key' USING ERRCODE = 'BP003';
  END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' OR length(p_operation) > 64 THEN
    RAISE EXCEPTION 'Batch 1B: invalid operation' USING ERRCODE = 'BP003';
  END IF;
  IF p_tenant_id IS NULL OR p_owner_id IS NULL THEN
    RAISE EXCEPTION 'Batch 1B: tenant_id and owner_id are required' USING ERRCODE = 'BP003';
  END IF;
  IF public.wallet_currency_minor_exponent(p_currency_code) IS NULL THEN
    RAISE EXCEPTION 'Batch 1B: invalid currency format %', p_currency_code USING ERRCODE = 'BP003';
  END IF;
  -- Canonical supported-currency authority (no divergent list).
  IF NOT EXISTS (SELECT 1 FROM public.market_availability WHERE upper(supported_currency) = p_currency_code) THEN
    RAISE EXCEPTION 'Batch 1B: unsupported currency %', p_currency_code USING ERRCODE = 'BP003';
  END IF;
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array'
     OR jsonb_array_length(p_entries) < 2 OR jsonb_array_length(p_entries) > 20 THEN
    RAISE EXCEPTION 'Batch 1B: entries must be an array of 2..20 legs' USING ERRCODE = 'BP003';
  END IF;

  -- Provider identity (BP004).
  IF p_payment_provider IS NOT NULL THEN
    IF p_payment_provider NOT IN ('stripe','kora','fincra','flutterwave') THEN
      RAISE EXCEPTION 'Batch 1B: unknown payment_provider %', p_payment_provider USING ERRCODE = 'BP004';
    END IF;
    IF p_merchant_account_ref IS NULL OR btrim(p_merchant_account_ref) = ''
       OR p_provider_reference IS NULL OR btrim(p_provider_reference) = '' THEN
      RAISE EXCEPTION 'Batch 1B: external event requires merchant_account_ref and provider_reference' USING ERRCODE = 'BP004';
    END IF;
  ELSIF p_merchant_account_ref IS NOT NULL OR p_provider_reference IS NOT NULL THEN
    RAISE EXCEPTION 'Batch 1B: internal event must not carry merchant/provider identity' USING ERRCODE = 'BP004';
  END IF;

  -- Per-leg validation (BP003): exact keys, valid purpose, whole-number, reversible range, nonzero.
  FOR entry IN SELECT e.value AS leg FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e(value, ord) LOOP
    leg := entry.leg;
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(leg) AS k)
       IS DISTINCT FROM ARRAY['accountPurpose','amountMinor'] THEN
      RAISE EXCEPTION 'Batch 1B: leg has unexpected fields' USING ERRCODE = 'BP003';
    END IF;
    IF leg->>'accountPurpose' IS NULL OR btrim(leg->>'accountPurpose') = ''
       OR length(leg->>'accountPurpose') > 64 THEN
      RAISE EXCEPTION 'Batch 1B: invalid accountPurpose' USING ERRCODE = 'BP003';
    END IF;
    IF jsonb_typeof(leg->'amountMinor') <> 'number' THEN
      RAISE EXCEPTION 'Batch 1B: amountMinor must be a number' USING ERRCODE = 'BP003';
    END IF;
    IF (leg->>'amountMinor')::numeric <> round((leg->>'amountMinor')::numeric) THEN
      RAISE EXCEPTION 'Batch 1B: amountMinor must be a whole number' USING ERRCODE = 'BP003';
    END IF;
    IF (leg->>'amountMinor')::numeric NOT BETWEEN -9223372036854775807::numeric AND 9223372036854775807::numeric THEN
      RAISE EXCEPTION 'Batch 1B: amountMinor out of reversible bigint range' USING ERRCODE = 'BP003';
    END IF;
    IF (leg->>'amountMinor')::bigint = 0 THEN
      RAISE EXCEPTION 'Batch 1B: amountMinor must be non-zero' USING ERRCODE = 'BP003';
    END IF;
  END LOOP;

  -- Server-side canonicalization: merge duplicate account purposes (sum), sort
  -- by purpose, drop zero nets. Deterministic for storage, comparison, locking.
  SELECT jsonb_agg(jsonb_build_object('accountPurpose', purpose, 'amountMinor', total) ORDER BY purpose)
  INTO v_entries
  FROM (
    SELECT e.value->>'accountPurpose' AS purpose, sum((e.value->>'amountMinor')::bigint) AS total
    FROM jsonb_array_elements(p_entries) AS e(value)
    GROUP BY e.value->>'accountPurpose'
    HAVING sum((e.value->>'amountMinor')::bigint) <> 0
  ) g;

  IF v_entries IS NULL OR jsonb_array_length(v_entries) < 2 THEN
    RAISE EXCEPTION 'Batch 1B: canonicalized entries require at least 2 non-zero legs' USING ERRCODE = 'BP003';
  END IF;

  -- Post-canonicalization range validation: a merged total can overflow the
  -- reversible bigint range even when each individual leg is valid.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_entries) e
    WHERE (e.value->>'amountMinor')::numeric NOT BETWEEN -9223372036854775807::numeric AND 9223372036854775807::numeric
  ) THEN
    RAISE EXCEPTION 'Batch 1B: merged amountMinor out of reversible bigint range' USING ERRCODE = 'BP003';
  END IF;

  SELECT COALESCE(sum((e->>'amountMinor')::numeric), 0) INTO v_sum FROM jsonb_array_elements(v_entries) e;
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'Batch 1B: unbalanced event % (net=%)', p_event_key, v_sum USING ERRCODE = 'BP001';
  END IF;

  -- Replay (BP002) BEFORE reversal check so a same-key reversal retry is idempotent.
  SELECT id INTO v_event_id FROM public.wallet_business_events WHERE event_key = p_event_key;
  IF FOUND THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.wallet_business_events
      WHERE id = v_event_id
        AND operation = p_operation
        AND tenant_id = p_tenant_id AND owner_id = p_owner_id
        AND currency_code = p_currency_code
        AND payment_provider IS NOT DISTINCT FROM p_payment_provider
        AND merchant_account_ref IS NOT DISTINCT FROM p_merchant_account_ref
        AND provider_reference IS NOT DISTINCT FROM p_provider_reference
        AND entries = v_entries
        AND reverses_event_id IS NOT DISTINCT FROM p_reverses_event_id
    ) THEN
      RAISE EXCEPTION 'Batch 1B: event_key % reused with different terms', p_event_key USING ERRCODE = 'BP002';
    END IF;
    RETURN v_event_id;
  END IF;

  -- Controlled reversal (BP005).
  IF p_reverses_event_id IS NOT NULL THEN
    SELECT * INTO v_original FROM public.wallet_business_events WHERE id = p_reverses_event_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Batch 1B: reversal original event not found' USING ERRCODE = 'BP005';
    END IF;
    IF v_original.tenant_id <> p_tenant_id OR v_original.owner_id <> p_owner_id
       OR v_original.currency_code <> p_currency_code THEN
      RAISE EXCEPTION 'Batch 1B: reversal scope mismatch' USING ERRCODE = 'BP005';
    END IF;
    IF EXISTS (SELECT 1 FROM public.wallet_business_events WHERE reverses_event_id = p_reverses_event_id) THEN
      RAISE EXCEPTION 'Batch 1B: event already reversed' USING ERRCODE = 'BP005';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('accountPurpose', a.balance_purpose, 'amountMinor', -m.amount_minor)
                     ORDER BY a.balance_purpose)
    INTO v_expected
    FROM public.wallet_movements m
    JOIN public.wallet_accounts a ON a.id = m.account_id
    WHERE m.event_id = p_reverses_event_id;
    IF v_entries IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'Batch 1B: reversal legs do not exactly negate the original' USING ERRCODE = 'BP005';
    END IF;
  END IF;

  -- Insert the event; distinguish event-key vs reversal-uniqueness conflicts.
  BEGIN
    INSERT INTO public.wallet_business_events
      (event_key, operation, payment_provider, merchant_account_ref, provider_reference,
       tenant_id, owner_id, currency_code, entries, reverses_event_id)
    VALUES
      (p_event_key, p_operation, p_payment_provider, p_merchant_account_ref, p_provider_reference,
       p_tenant_id, p_owner_id, p_currency_code, v_entries, p_reverses_event_id)
    RETURNING id INTO v_event_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name = 'wallet_business_events_event_key_key' THEN
      SELECT id INTO v_event_id FROM public.wallet_business_events WHERE event_key = p_event_key;
      IF NOT EXISTS (
        SELECT 1 FROM public.wallet_business_events
        WHERE id = v_event_id
          AND operation = p_operation
          AND tenant_id = p_tenant_id AND owner_id = p_owner_id
          AND currency_code = p_currency_code
          AND payment_provider IS NOT DISTINCT FROM p_payment_provider
          AND merchant_account_ref IS NOT DISTINCT FROM p_merchant_account_ref
          AND provider_reference IS NOT DISTINCT FROM p_provider_reference
          AND entries = v_entries
          AND reverses_event_id IS NOT DISTINCT FROM p_reverses_event_id
      ) THEN
        RAISE EXCEPTION 'Batch 1B: event_key % reused with different terms', p_event_key USING ERRCODE = 'BP002';
      END IF;
      RETURN v_event_id;
    ELSIF v_constraint_name = 'wallet_business_events_reversal_unique' THEN
      RAISE EXCEPTION 'Batch 1B: event already reversed' USING ERRCODE = 'BP005';
    ELSE
      RAISE;
    END IF;
  END;

  -- Post the canonical legs (sorted; accounts locked in deterministic order).
  FOR entry IN SELECT e.value AS leg, e.ord AS seq FROM jsonb_array_elements(v_entries) WITH ORDINALITY AS e(value, ord) LOOP
    INSERT INTO public.wallet_accounts (tenant_id, owner_id, currency_code, balance_purpose)
    VALUES (p_tenant_id, p_owner_id, p_currency_code, entry.leg->>'accountPurpose')
    ON CONFLICT (tenant_id, owner_id, currency_code, balance_purpose) DO NOTHING;
    SELECT id INTO v_account_id FROM public.wallet_accounts
    WHERE tenant_id = p_tenant_id AND owner_id = p_owner_id
      AND currency_code = p_currency_code AND balance_purpose = entry.leg->>'accountPurpose'
    FOR UPDATE;

    INSERT INTO public.wallet_movements (event_id, account_id, amount_minor, entry_seq)
    VALUES (v_event_id, v_account_id, (entry.leg->>'amountMinor')::bigint, entry.seq::smallint);
  END LOOP;

  RETURN v_event_id;
END
$$;

-- 4. initiate_wallet_topup: widen the accepted provider set (everything else unchanged).
CREATE OR REPLACE FUNCTION public.initiate_wallet_topup(
  p_attempt_key text, p_tenant_id uuid, p_owner_id uuid, p_country_code text,
  p_currency_code text, p_amount_minor bigint, p_destination_account_purpose text,
  p_payment_provider text, p_merchant_account_ref text, p_provider_idempotency_identity text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid; v_route public.market_payment_routes%ROWTYPE; v_n integer; v_max bigint;
BEGIN
  IF p_attempt_key IS NULL OR btrim(p_attempt_key) = '' OR length(p_attempt_key) > 200 THEN
    RAISE EXCEPTION 'Batch 1C: invalid attempt_key' USING ERRCODE = 'BP003';
  END IF;
  IF p_tenant_id IS NULL OR p_owner_id IS NULL THEN
    RAISE EXCEPTION 'Batch 1C: tenant_id and owner_id are required' USING ERRCODE = 'BP003';
  END IF;
  IF p_country_code IS NULL OR p_country_code !~ '^[A-Z]{2}$' OR p_currency_code IS NULL OR p_currency_code !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Batch 1C: invalid country/currency' USING ERRCODE = 'BP003';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR p_amount_minor > 9223372036854775807 THEN
    RAISE EXCEPTION 'Batch 1C: invalid amount' USING ERRCODE = 'BP003';
  END IF;
  IF p_destination_account_purpose IS NULL OR p_destination_account_purpose NOT IN ('customer_credit','driver_cash_credit') THEN
    RAISE EXCEPTION 'Batch 1C: destination account % is not an approved collectible destination', p_destination_account_purpose USING ERRCODE = 'BP008';
  END IF;
  IF p_payment_provider IS NULL OR p_payment_provider NOT IN ('stripe','kora','flutterwave') THEN
    RAISE EXCEPTION 'Batch 1C: unknown payment_provider %', p_payment_provider USING ERRCODE = 'BP004';
  END IF;
  IF p_merchant_account_ref IS NULL OR btrim(p_merchant_account_ref) = '' THEN
    RAISE EXCEPTION 'Batch 1C: merchant_account_ref is required' USING ERRCODE = 'BP004';
  END IF;
  IF p_provider_idempotency_identity IS NULL OR btrim(p_provider_idempotency_identity) = '' THEN
    RAISE EXCEPTION 'Batch 1C: provider_idempotency_identity is required' USING ERRCODE = 'BP004';
  END IF;
  IF NOT public.wallet_collection_enabled() THEN
    RAISE EXCEPTION 'Batch 1C: wallet collection is disabled (no approved usable destination)' USING ERRCODE = 'BP008';
  END IF;

  -- Market-specific limit is REQUIRED for each collectible currency.
  SELECT NULLIF((SELECT value FROM public.wallet_collection_config WHERE key='max_amount_minor_' || p_currency_code), '')::bigint INTO v_max;
  IF v_max IS NULL OR v_max <= 0 THEN
    RAISE EXCEPTION 'Batch 1C: no configured collection limit for %', p_currency_code USING ERRCODE = 'BP008';
  END IF;
  IF p_amount_minor > v_max THEN
    RAISE EXCEPTION 'Batch 1C: amount exceeds market limit for %', p_currency_code USING ERRCODE = 'BP008';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.market_availability WHERE country_code=p_country_code AND upper(supported_currency)=p_currency_code) THEN
    RAISE EXCEPTION 'Batch 1C: unsupported country/currency pair' USING ERRCODE='BP008';
  END IF;

  -- Resolve exactly one eligible route.
  SELECT count(*) INTO v_n FROM public.market_payment_routes
  WHERE country_code = p_country_code AND currency_code = p_currency_code
    AND method = 'card' AND preferred AND enabled AND merchant_approved AND adapter_ready
    AND capabilities @> ARRAY['collect']::text[];
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Batch 1C: expected exactly one eligible collection route for %/%, found %', p_country_code, p_currency_code, v_n USING ERRCODE = 'BP008';
  END IF;
  SELECT * INTO v_route FROM public.market_payment_routes
  WHERE country_code = p_country_code AND currency_code = p_currency_code
    AND method = 'card' AND preferred AND enabled AND merchant_approved AND adapter_ready
    AND capabilities @> ARRAY['collect']::text[];
  IF v_route.provider IS DISTINCT FROM p_payment_provider OR v_route.merchant_account_ref IS DISTINCT FROM p_merchant_account_ref THEN
    RAISE EXCEPTION 'Batch 1C: requested provider/account does not match the eligible route' USING ERRCODE = 'BP008';
  END IF;

  -- Concurrent-safe replay: identical terms return the same attempt; a conflicting
  -- attempt_key reuse raises BP002 (never silently returns a mismatched row).
  INSERT INTO public.wallet_topup_attempts
    (attempt_key, tenant_id, owner_id, country_code, currency_code, amount_minor,
     destination_account_purpose, payment_provider, merchant_account_ref, provider_idempotency_identity)
  VALUES
    (p_attempt_key, p_tenant_id, p_owner_id, p_country_code, p_currency_code, p_amount_minor,
     p_destination_account_purpose, p_payment_provider, p_merchant_account_ref, p_provider_idempotency_identity)
  ON CONFLICT (attempt_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.wallet_topup_attempts WHERE attempt_key = p_attempt_key
               AND tenant_id = p_tenant_id AND owner_id = p_owner_id
               AND country_code = p_country_code AND currency_code = p_currency_code
               AND amount_minor = p_amount_minor AND destination_account_purpose = p_destination_account_purpose
               AND payment_provider = p_payment_provider AND merchant_account_ref = p_merchant_account_ref
               AND provider_idempotency_identity = p_provider_idempotency_identity) THEN
      SELECT id INTO v_id FROM public.wallet_topup_attempts WHERE attempt_key = p_attempt_key;
    ELSE
      RAISE EXCEPTION 'Batch 1C: attempt_key % reused with different terms', p_attempt_key USING ERRCODE = 'BP002';
    END IF;
  END IF;
  RETURN v_id;
END
$$;

-- Regrant the replaced functions (privileges survive CREATE OR REPLACE, but be explicit).
REVOKE ALL ON FUNCTION public.post_wallet_event(text,text,uuid,uuid,text,jsonb,text,text,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_wallet_event(text,text,uuid,uuid,text,jsonb,text,text,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.initiate_wallet_topup(text,uuid,uuid,text,text,bigint,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.initiate_wallet_topup(text,uuid,uuid,text,text,bigint,text,text,text,text) TO service_role;

COMMIT;
