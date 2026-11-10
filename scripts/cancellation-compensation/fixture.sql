-- =============================================================================
-- Cancellation-compensation disposable-PG fixture.
--
-- Reproduces the production prerequisites for settle_cancellation_compensation:
--   * roles + auth shims (the test runner connects as postgres superuser, so
--     RLS is bypassed, but the shims keep SECURITY DEFINER / grant checks real)
--   * market_availability — the canonical supported-currency authority that
--     post_wallet_event validates against
--   * the provider-neutral wallet ledger (batch 1B foundation): wallet_accounts,
--     wallet_business_events, wallet_movements, post_wallet_event,
--     post_wallet_reversal, wallet_reconciliation_projection, append-only guard
--   * versioned cancellation policies + publish authority + customer
--     receivables with the provider/merchant/reference binding
-- =============================================================================

CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE authenticator NOINHERIT;
GRANT anon,authenticated,service_role TO authenticator;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.user',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('test.role',true) $$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;

-- Canonical supported-currency authority (post_wallet_event checks this).
CREATE TABLE market_availability(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code text NOT NULL,
  supported_currency text NOT NULL,
  enabled boolean DEFAULT true
);

-- Booking + canonical driver earnings (mirrors the deployed baseline; the
-- compensation authority resolves driver/market from jobs and lands earnings
-- in driver_earnings, the table payout/reporting actually reads).
CREATE TABLE jobs(
  id uuid PRIMARY KEY,
  customer_id uuid, tenant_id uuid, driver_id uuid, accepted_driver_id uuid,
  status text, payment_status text, payment_method text, payment_intent_id text,
  country_code text, currency_code text, service_type_id uuid,
  agreed_fare numeric, total_price numeric, price numeric, cancellation_fee numeric,
  fare_breakdown jsonb DEFAULT '{}', metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE driver_earnings(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id),
  amount numeric(10,2) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  created_at timestamptz DEFAULT now(),
  currency_code text NOT NULL DEFAULT 'GBP',
  country_code text NOT NULL DEFAULT 'GB',
  stripe_transfer_id text,
  platform_fee numeric(10,2) DEFAULT 0,
  gross_amount numeric(10,2) DEFAULT 0,
  settled_at timestamptz,
  settlement_purpose text NOT NULL DEFAULT 'job_earnings',
  CONSTRAINT driver_earnings_job_id_key UNIQUE (job_id)
);

-- ---------------------------------------------------------------------------
-- Batch 1B provider-neutral accounting foundation (faithful extraction).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wallet_currency_minor_exponent(p_currency_code text)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS
$$ SELECT CASE
  WHEN p_currency_code IN ('BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF') THEN 0
  WHEN p_currency_code IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND') THEN 3
  WHEN p_currency_code ~ '^[A-Z]{3}$' THEN 2
  ELSE NULL END $$;

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
  IF NOT EXISTS (SELECT 1 FROM public.market_availability WHERE upper(supported_currency) = p_currency_code) THEN
    RAISE EXCEPTION 'Batch 1B: unsupported currency %', p_currency_code USING ERRCODE = 'BP003';
  END IF;
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array'
     OR jsonb_array_length(p_entries) < 2 OR jsonb_array_length(p_entries) > 20 THEN
    RAISE EXCEPTION 'Batch 1B: entries must be an array of 2..20 legs' USING ERRCODE = 'BP003';
  END IF;

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

CREATE OR REPLACE VIEW public.wallet_reconciliation_projection AS
SELECT a.tenant_id, a.owner_id, a.currency_code, a.balance_purpose,
       COALESCE(sum(m.amount_minor), 0) AS diagnostic_balance_minor,
       count(m.id) AS movement_count
FROM public.wallet_accounts a
LEFT JOIN public.wallet_movements m ON m.account_id = a.id
GROUP BY a.tenant_id, a.owner_id, a.currency_code, a.balance_purpose;

REVOKE ALL ON FUNCTION public.post_wallet_event(text,text,uuid,uuid,text,jsonb,text,text,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_wallet_reversal(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_wallet_event(text,text,uuid,uuid,text,jsonb,text,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_wallet_reversal(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wallet_currency_minor_exponent(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Versioned cancellation policies (cancellation_debt) + publish authority
-- (commercial policies v2, scoped to the policy columns it owns).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cancellation_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  market_code text not null,
  version int not null,
  enabled boolean not null default false,
  grace_seconds int not null default 300 check (grace_seconds >= 0),
  fee_minor bigint not null default 0 check (fee_minor >= 0),
  fee_cap_minor bigint check (fee_cap_minor is null or fee_cap_minor >= 0),
  responsibility_rules jsonb not null default '{}'::jsonb,
  driver_compensation_percent numeric not null default 0 check (driver_compensation_percent between 0 and 100),
  compensation_funding text not null default 'on_collection' check (compensation_funding in ('on_collection','advanced')),
  debt_threshold_minor bigint not null default 0,
  exempt_reasons text[] not null default '{}',
  reference_fare_minor bigint check (reference_fare_minor >= 0),
  debt_threshold_bps int check (debt_threshold_bps BETWEEN 0 AND 10000),
  effective_from timestamptz not null default now(),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, market_code, version)
);

CREATE OR REPLACE FUNCTION active_cancellation_policy(p_tenant uuid, p_market text)
RETURNS cancellation_policies LANGUAGE plpgsql stable security definer set search_path=public AS $$
DECLARE v cancellation_policies;
BEGIN
  select * into v from cancellation_policies
   where tenant_id=p_tenant and market_code=p_market and enabled and effective_from<=now()
   order by version desc limit 1;
  return v;
END$$;

CREATE OR REPLACE FUNCTION publish_cancellation_policy(
  p_tenant uuid, p_market text, p_reference_fare_minor bigint, p_debt_threshold_bps int,
  p_grace_seconds int, p_fee_minor bigint, p_fee_cap_minor bigint,
  p_compensation_percent numeric, p_created_by uuid)
RETURNS cancellation_policies LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v cancellation_policies;
BEGIN
  INSERT INTO cancellation_policies(
    tenant_id, market_code, version, enabled,
    grace_seconds, fee_minor, fee_cap_minor,
    driver_compensation_percent, compensation_funding,
    reference_fare_minor, debt_threshold_bps, debt_threshold_minor,
    created_by)
  VALUES(
    p_tenant, p_market,
    (SELECT coalesce(max(version),0)+1 FROM cancellation_policies WHERE tenant_id=p_tenant AND market_code=p_market),
    false,
    p_grace_seconds, p_fee_minor, p_fee_cap_minor,
    p_compensation_percent, 'on_collection',
    p_reference_fare_minor, p_debt_threshold_bps,
    (p_reference_fare_minor * p_debt_threshold_bps / 10000)::bigint,
    p_created_by)
  RETURNING * INTO v;
  RETURN v;
END $$;

-- Customer receivables: unpaid cancellation/no-show/adjustment fees (debt).
CREATE TABLE IF NOT EXISTS customer_receivables (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  customer_id uuid not null,
  job_id uuid,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  amount_minor bigint not null check (amount_minor > 0),
  reason text not null check (reason in ('cancellation_fee','no_show_fee','fare_adjustment','manual')),
  status text not null default 'open' check (status in ('open','disputed','paid','waived','written_off')),
  policy_version int,
  payment_reference text,
  payment_provider text CHECK (payment_provider IN ('stripe','flutterwave','paystack')),
  merchant_account_ref text,
  dispute_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);

-- Provider/merchant/reference binding: a `paid` resolution must carry the triple.
CREATE OR REPLACE FUNCTION enforce_receivable_reference_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_reference IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT'
     OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference
     OR NEW.payment_provider IS DISTINCT FROM OLD.payment_provider
     OR NEW.merchant_account_ref IS DISTINCT FROM OLD.merchant_account_ref THEN
    IF NEW.payment_provider IS NULL OR NEW.merchant_account_ref IS NULL THEN
      RAISE EXCEPTION 'A payment reference requires provider + merchant binding' USING ERRCODE='RBD01';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receivable_reference_binding BEFORE INSERT OR UPDATE OF
  payment_reference, payment_provider, merchant_account_ref
  ON customer_receivables FOR EACH ROW EXECUTE FUNCTION enforce_receivable_reference_binding();
CREATE UNIQUE INDEX IF NOT EXISTS customer_receivables_ref_binding_uniq
  ON customer_receivables (
    coalesce(payment_provider,''),
    coalesce(merchant_account_ref,''),
    payment_reference)
  WHERE payment_reference IS NOT NULL;

-- Record a receivable idempotently per (job,reason); duplicate cancels reuse it.
CREATE OR REPLACE FUNCTION record_customer_receivable(
  p_tenant uuid, p_customer uuid, p_job uuid, p_currency text,
  p_amount bigint, p_reason text, p_policy_version int default null)
RETURNS customer_receivables LANGUAGE plpgsql security definer set search_path=public AS $$
DECLARE v customer_receivables;
BEGIN
  select * into v from customer_receivables
   where job_id=p_job and customer_id=p_customer and reason=p_reason and status in ('open','disputed','paid')
   order by created_at desc limit 1;
  if found then return v; end if;
  insert into customer_receivables(tenant_id,customer_id,job_id,currency_code,amount_minor,reason,policy_version)
    values(p_tenant,p_customer,p_job,p_currency,p_amount,p_reason,p_policy_version) returning * into v;
  return v;
END $$;
