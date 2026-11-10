-- =============================================================================
-- Batch 1B — provider-neutral accounting foundation (additive, diagnostic).
--
-- Double-entry ledger isolating balances by (tenant_id, owner_id,
-- currency_code, balance_purpose) with SIGNED, BALANCED, append-only movements
-- keyed by durable business-event identities. Controlled reversals; diagnostic
-- (non-spendable) server-only reconciliation projection.
--
-- Supported currency is validated against the canonical market_availability
-- authority (no divergent list). Internal movements carry payment_provider
-- NULL and never require Stripe Connect. External events require complete
-- provider/merchant/reference identity.
-- =============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- Preconditions: validate complete object definitions; stop only on a
-- demonstrated incompatibility. A re-run against the correct shape is a no-op.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  req text[][]; i integer; v_oid oid;
BEGIN
  req := ARRAY[
    ARRAY['wallet_accounts','tenant_id','uuid'], ARRAY['wallet_accounts','owner_id','uuid'],
    ARRAY['wallet_accounts','currency_code','text'], ARRAY['wallet_accounts','balance_purpose','text'],
    ARRAY['wallet_business_events','event_key','text'], ARRAY['wallet_business_events','operation','text'],
    ARRAY['wallet_business_events','entries','jsonb'], ARRAY['wallet_business_events','reverses_event_id','uuid'],
    ARRAY['wallet_movements','event_id','uuid'], ARRAY['wallet_movements','account_id','uuid'],
    ARRAY['wallet_movements','amount_minor','int8']
  ];
  FOR i IN 1..array_length(req,1) LOOP
    IF to_regclass('public.' || req[i][1]) IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=req[i][1]
        AND column_name=req[i][2] AND udt_name=req[i][3]
    ) THEN
      RAISE EXCEPTION 'Batch 1B precondition: public.% exists without required column % %',
        req[i][1], req[i][2], req[i][3];
    END IF;
  END LOOP;

  -- Functions: resolve the expected overload by its exact TYPE signature via
  -- to_regprocedure (never compare against a bare type list), then validate
  -- return type and SECURITY DEFINER/language. Detect unexpected overloads
  -- explicitly; never silently replace.

  v_oid := to_regprocedure('public.post_wallet_event(text,text,uuid,uuid,text,jsonb,text,text,text,uuid)');
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.pronamespace='public'::regnamespace AND p.proname='post_wallet_event'
               AND p.oid IS DISTINCT FROM v_oid) THEN
    RAISE EXCEPTION 'Batch 1B precondition: post_wallet_event has an incompatible signature or unexpected overload';
  END IF;
  IF v_oid IS NOT NULL AND (
    pg_get_function_result(v_oid) IS DISTINCT FROM 'uuid'
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid AND prosecdef)
    OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = v_oid AND l.lanname = 'plpgsql')
  ) THEN
    RAISE EXCEPTION 'Batch 1B precondition: post_wallet_event has incompatible properties';
  END IF;

  v_oid := to_regprocedure('public.post_wallet_reversal(text,text)');
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.pronamespace='public'::regnamespace AND p.proname='post_wallet_reversal'
               AND p.oid IS DISTINCT FROM v_oid) THEN
    RAISE EXCEPTION 'Batch 1B precondition: post_wallet_reversal has an incompatible signature or unexpected overload';
  END IF;
  IF v_oid IS NOT NULL AND (
    pg_get_function_result(v_oid) IS DISTINCT FROM 'uuid'
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid AND prosecdef)
    OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = v_oid AND l.lanname = 'plpgsql')
  ) THEN
    RAISE EXCEPTION 'Batch 1B precondition: post_wallet_reversal has incompatible properties';
  END IF;

  v_oid := to_regprocedure('public.wallet_currency_minor_exponent(text)');
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.pronamespace='public'::regnamespace AND p.proname='wallet_currency_minor_exponent'
               AND p.oid IS DISTINCT FROM v_oid) THEN
    RAISE EXCEPTION 'Batch 1B precondition: wallet_currency_minor_exponent has an incompatible signature or unexpected overload';
  END IF;
  IF v_oid IS NOT NULL AND pg_get_function_result(v_oid) IS DISTINCT FROM 'integer' THEN
    RAISE EXCEPTION 'Batch 1B precondition: wallet_currency_minor_exponent has an incompatible return type';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Canonical ISO-4217 minor exponent (mirrors FareSplitService). This is the
-- EXPONENT authority only; the supported-currency authority is
-- market_availability.supported_currency, enforced in post_wallet_event.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wallet_currency_minor_exponent(p_currency_code text)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS
$$ SELECT CASE
  WHEN p_currency_code IN ('BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF') THEN 0
  WHEN p_currency_code IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND') THEN 3
  WHEN p_currency_code ~ '^[A-Z]{3}$' THEN 2
  ELSE NULL END $$;

-- ---------------------------------------------------------------------------
-- Isolated account scope.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  balance_purpose text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_accounts_scope_unique
    UNIQUE NULLS NOT DISTINCT (tenant_id, owner_id, currency_code, balance_purpose)
);

-- ---------------------------------------------------------------------------
-- Durable business-event identities (with controlled reversal link).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wallet_business_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,
  operation text NOT NULL,
  payment_provider text CHECK (payment_provider IS NULL OR payment_provider IN ('stripe','kora','fincra')),
  merchant_account_ref text,
  provider_reference text,
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  entries jsonb NOT NULL,
  reverses_event_id uuid REFERENCES public.wallet_business_events(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_business_events_reversal_unique
  ON public.wallet_business_events(reverses_event_id) WHERE reverses_event_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Signed, balanced movements (append-only; ON DELETE RESTRICT, no CASCADE).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wallet_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.wallet_business_events(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES public.wallet_accounts(id),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  entry_seq smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_movements_event_id ON public.wallet_movements(event_id);
CREATE INDEX IF NOT EXISTS wallet_movements_account_id ON public.wallet_movements(account_id);
CREATE INDEX IF NOT EXISTS wallet_business_events_owner_scope ON public.wallet_business_events(tenant_id, owner_id, currency_code);

-- ---------------------------------------------------------------------------
-- Append-only guard for the financial ledger (applies to ALL roles).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wallet_ledger_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Batch 1B: % is append-only', TG_TABLE_NAME USING ERRCODE = 'BP006';
END $$;
DROP TRIGGER IF EXISTS wallet_accounts_append_only ON public.wallet_accounts;
CREATE TRIGGER wallet_accounts_append_only BEFORE UPDATE OR DELETE ON public.wallet_accounts
  FOR EACH ROW EXECUTE FUNCTION public.wallet_ledger_append_only();
DROP TRIGGER IF EXISTS wallet_business_events_append_only ON public.wallet_business_events;
CREATE TRIGGER wallet_business_events_append_only BEFORE UPDATE OR DELETE ON public.wallet_business_events
  FOR EACH ROW EXECUTE FUNCTION public.wallet_ledger_append_only();
DROP TRIGGER IF EXISTS wallet_movements_append_only ON public.wallet_movements;
CREATE TRIGGER wallet_movements_append_only BEFORE UPDATE OR DELETE ON public.wallet_movements
  FOR EACH ROW EXECUTE FUNCTION public.wallet_ledger_append_only();

-- ---------------------------------------------------------------------------
-- Atomic posting: validated, balanced, replay-validated, concurrency-safe,
-- controlled reversals, server-side leg canonicalization, deterministic
-- account locking. Distinct SQLSTATE codes for each validation failure.
-- ---------------------------------------------------------------------------
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
    IF p_payment_provider NOT IN ('stripe','kora','fincra') THEN
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

-- ---------------------------------------------------------------------------
-- Controlled reversal: computes the exact negation of the original event and
-- posts it with a reversal link. Retry with the same key is idempotent (replay
-- check runs before the already-reversed check).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_wallet_reversal(
  p_original_event_key text,
  p_event_key text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_original public.wallet_business_events%ROWTYPE;
  v_legs jsonb;
BEGIN
  SELECT * INTO STRICT v_original FROM public.wallet_business_events WHERE event_key = p_original_event_key;

  SELECT jsonb_agg(jsonb_build_object('accountPurpose', a.balance_purpose, 'amountMinor', -m.amount_minor)
                   ORDER BY a.balance_purpose)
  INTO v_legs
  FROM public.wallet_movements m
  JOIN public.wallet_accounts a ON a.id = m.account_id
  WHERE m.event_id = v_original.id;

  RETURN public.post_wallet_event(
    p_event_key, 'reversal', v_original.tenant_id, v_original.owner_id, v_original.currency_code,
    v_legs, NULL, NULL, NULL, v_original.id);
END
$$;

-- ---------------------------------------------------------------------------
-- Diagnostic reconciliation projection (NON-SPENDABLE, server-only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.wallet_reconciliation_projection AS
SELECT a.tenant_id, a.owner_id, a.currency_code, a.balance_purpose,
       COALESCE(sum(m.amount_minor), 0) AS diagnostic_balance_minor,
       count(m.id) AS movement_count
FROM public.wallet_accounts a
LEFT JOIN public.wallet_movements m ON m.account_id = a.id
GROUP BY a.tenant_id, a.owner_id, a.currency_code, a.balance_purpose;

COMMENT ON VIEW public.wallet_reconciliation_projection IS
  'DIAGNOSTIC ONLY. Sums signed movements per isolated account. NOT a spendable balance; never feed it into payment or payout authority.';

-- ---------------------------------------------------------------------------
-- Privileges: append-only + direct writes revoked from every role (including
-- service_role); only the SECURITY DEFINER posting functions write.
-- ---------------------------------------------------------------------------
ALTER TABLE public.wallet_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_business_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wallet_accounts_select_own ON public.wallet_accounts;
CREATE POLICY wallet_accounts_select_own ON public.wallet_accounts
  FOR SELECT TO authenticated USING (owner_id = auth.uid());
DROP POLICY IF EXISTS wallet_business_events_select_own ON public.wallet_business_events;
CREATE POLICY wallet_business_events_select_own ON public.wallet_business_events
  FOR SELECT TO authenticated USING (owner_id = auth.uid());
DROP POLICY IF EXISTS wallet_movements_select_own ON public.wallet_movements;
CREATE POLICY wallet_movements_select_own ON public.wallet_movements
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.wallet_accounts a
                 WHERE a.id = wallet_movements.account_id AND a.owner_id = auth.uid()));

REVOKE ALL ON public.wallet_accounts, public.wallet_business_events, public.wallet_movements FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.wallet_accounts, public.wallet_business_events, public.wallet_movements TO authenticated, service_role;

REVOKE ALL ON public.wallet_reconciliation_projection FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.wallet_reconciliation_projection TO service_role;

REVOKE ALL ON FUNCTION public.post_wallet_event(text,text,uuid,uuid,text,jsonb,text,text,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_wallet_reversal(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_wallet_event(text,text,uuid,uuid,text,jsonb,text,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_wallet_reversal(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wallet_currency_minor_exponent(text) TO authenticated, service_role;

COMMIT;
