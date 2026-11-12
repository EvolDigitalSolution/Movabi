-- =============================================================================
-- Batch 1C — provider-neutral wallet top-ups (Stripe + Korapay), additive.
--
-- Durable attempt (fully frozen terms incl. attempt_key) persisted BEFORE
-- provider contact. Disabled-by-default collection gate. Recoverable
-- uncertainty via same-provider reconciliation and durable webhook-before-
-- reference verification evidence. Refund/chargeback requires verified evidence
-- and is idempotent. Reruns validate existing definitions rather than trusting
-- IF NOT EXISTS.
-- =============================================================================
BEGIN;
SET LOCAL search_path = pg_catalog, public;

DO $$
BEGIN
  IF to_regclass('public.wallet_business_events') IS NULL
     OR to_regprocedure('public.post_wallet_event(text,text,uuid,uuid,text,jsonb,text,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Batch 1C precondition: Batch 1B accounting foundation is required';
  END IF;
  IF to_regclass('public.market_payment_routes') IS NULL THEN
    RAISE EXCEPTION 'Batch 1C precondition: market_payment_routes is required';
  END IF;
END
$$;

-- Accept only the server-parsed original expression or its exact collect extension.
-- Separate guards (including Kora/Fincra readiness) are neither edited nor removed.
CREATE TEMP TABLE _b1c_capability_shape (
  capabilities text[],
  CONSTRAINT b1c_expected_base CHECK (capabilities <@ ARRAY['authorise','capture','release','refund','retrieve','payout']::text[] AND array_position(capabilities,NULL) IS NULL),
  CONSTRAINT b1c_expected_collect CHECK (capabilities <@ ARRAY['authorise','capture','release','refund','retrieve','payout','collect']::text[] AND array_position(capabilities,NULL) IS NULL)
) ON COMMIT DROP;
DO $$
DECLARE c record; n integer := 0; base_expr text; collect_expr text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO base_expr FROM pg_constraint
    WHERE conrelid='pg_temp._b1c_capability_shape'::regclass
      AND conname='b1c_expected_base';
  SELECT pg_get_expr(conbin,conrelid) INTO collect_expr FROM pg_constraint
    WHERE conrelid='pg_temp._b1c_capability_shape'::regclass
      AND conname='b1c_expected_collect';
  IF base_expr IS NULL OR collect_expr IS NULL THEN
    RAISE EXCEPTION 'Batch 1C: capability template missing';
  END IF;
  FOR c IN SELECT conname, convalidated, connoinherit, pg_get_expr(conbin,conrelid) AS expression
    FROM pg_constraint WHERE conrelid='public.market_payment_routes'::regclass
      AND contype='c' AND pg_get_expr(conbin,conrelid) IN (base_expr,collect_expr)
  LOOP
    n := n+1;
    IF NOT c.convalidated OR c.connoinherit THEN
      RAISE EXCEPTION 'Batch 1C: incompatible capability CHECK';
    END IF;
  END LOOP;
  IF n<>1 THEN RAISE EXCEPTION 'Batch 1C: incompatible capability CHECK (expected exactly one exact definition)'; END IF;
  SELECT conname, pg_get_expr(conbin,conrelid) AS expression INTO c FROM pg_constraint
    WHERE conrelid='public.market_payment_routes'::regclass AND contype='c'
      AND pg_get_expr(conbin,conrelid) IN (base_expr,collect_expr);
  IF c.expression=base_expr THEN
    EXECUTE format('ALTER TABLE public.market_payment_routes DROP CONSTRAINT %I',c.conname);
    EXECUTE format('ALTER TABLE public.market_payment_routes ADD CONSTRAINT %I CHECK (capabilities <@ ARRAY[''authorise'',''capture'',''release'',''refund'',''retrieve'',''payout'',''collect'']::text[] AND array_position(capabilities,NULL) IS NULL)',c.conname);
  END IF;
END $$;

-- 2. Collection gate + market limits.
CREATE TABLE IF NOT EXISTS public.wallet_collection_config (
  key text PRIMARY KEY,
  value text NOT NULL
);
CREATE OR REPLACE FUNCTION public.wallet_collection_enabled()
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public AS
$$ SELECT COALESCE((SELECT value = 'true' FROM public.wallet_collection_config WHERE key='enabled'), false) $$;

-- 3. Durable attempt.
CREATE TABLE IF NOT EXISTS public.wallet_topup_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_key text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  country_code text NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  destination_account_purpose text NOT NULL,
  payment_provider text NOT NULL CHECK (payment_provider IN ('stripe','kora')),
  merchant_account_ref text NOT NULL,
  provider_idempotency_identity text NOT NULL,
  status text NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated','submitting','provider_pending','confirmed','credited','failed','uncertain','refunded')),
  provider_reference text,
  failure_reason text,
  credited_event_id uuid REFERENCES public.wallet_business_events(id),
  refund_evidence_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallet_topup_attempts_owner ON public.wallet_topup_attempts(tenant_id, owner_id, currency_code);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_topup_attempts_credit_unique
  ON public.wallet_topup_attempts(credited_event_id) WHERE credited_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wallet_topup_attempts_provider_reference_unique
  ON public.wallet_topup_attempts(payment_provider, merchant_account_ref, provider_reference)
  WHERE provider_reference IS NOT NULL;

-- 4. Durable webhook-before-reference verification evidence.
CREATE TABLE IF NOT EXISTS public.wallet_topup_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES public.wallet_topup_attempts(id),
  evidence_key text NOT NULL UNIQUE,
  provider_reference text,
  merchant_account_ref text,
  currency_code text,
  amount_minor bigint,
  final_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);


-- Expected objects are parsed by this PostgreSQL server; compare catalog semantics,
-- not regexes. A mismatch aborts the entire transaction; no object is rebuilt.
CREATE TEMP TABLE _b1c_wallet_collection_config (
  key text PRIMARY KEY,
  value text NOT NULL
) ON COMMIT DROP;
CREATE TEMP TABLE _b1c_wallet_topup_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_key text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  country_code text NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  destination_account_purpose text NOT NULL,
  payment_provider text NOT NULL CHECK (payment_provider IN ('stripe','kora')),
  merchant_account_ref text NOT NULL,
  provider_idempotency_identity text NOT NULL,
  status text NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated','submitting','provider_pending','confirmed','credited','failed','uncertain','refunded')),
  provider_reference text,
  failure_reason text,
  credited_event_id uuid,
  refund_evidence_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
) ON COMMIT DROP;
CREATE TEMP TABLE _b1c_wallet_topup_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL,
  evidence_key text NOT NULL UNIQUE,
  provider_reference text,
  merchant_account_ref text,
  currency_code text,
  amount_minor bigint,
  final_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
) ON COMMIT DROP;
CREATE INDEX _b1c_attempts_owner ON _b1c_wallet_topup_attempts(tenant_id,owner_id,currency_code);
CREATE UNIQUE INDEX _b1c_credit_unique ON _b1c_wallet_topup_attempts(credited_event_id) WHERE credited_event_id IS NOT NULL;
CREATE UNIQUE INDEX _b1c_provider_unique ON _b1c_wallet_topup_attempts(payment_provider,merchant_account_ref,provider_reference) WHERE provider_reference IS NOT NULL;
CREATE OR REPLACE FUNCTION pg_temp._b1c_assert_table(a regclass, e regclass)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=a AND relkind='r' AND relpersistence='p') THEN
   RAISE EXCEPTION 'Batch 1C: incompatible persistent table %',a;
 END IF;
 IF EXISTS (
   WITH actual AS (SELECT attnum,attname,atttypid,atttypmod,attnotnull,attcollation,attidentity,attgenerated,
      pg_get_expr(d.adbin,d.adrelid) AS def
      FROM pg_attribute x LEFT JOIN pg_attrdef d ON d.adrelid=x.attrelid AND d.adnum=x.attnum
      WHERE x.attrelid=a AND attnum>0 AND NOT attisdropped),
   expected AS (SELECT attnum,attname,atttypid,atttypmod,attnotnull,attcollation,attidentity,attgenerated,
      pg_get_expr(d.adbin,d.adrelid) AS def
      FROM pg_attribute x LEFT JOIN pg_attrdef d ON d.adrelid=x.attrelid AND d.adnum=x.attnum
      WHERE x.attrelid=e AND attnum>0 AND NOT attisdropped)
   (SELECT * FROM actual EXCEPT SELECT * FROM expected) UNION ALL
   (SELECT * FROM expected EXCEPT SELECT * FROM actual)
 ) THEN RAISE EXCEPTION 'Batch 1C: incompatible table columns %',a; END IF;
 IF EXISTS (
   WITH actual AS (SELECT contype,convalidated,condeferrable,condeferred,connoinherit,pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conrelid=a AND contype<>'f'),
   expected AS (SELECT contype,convalidated,condeferrable,condeferred,connoinherit,pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conrelid=e)
   (SELECT * FROM actual EXCEPT SELECT * FROM expected) UNION ALL
   (SELECT * FROM expected EXCEPT SELECT * FROM actual)
 ) THEN RAISE EXCEPTION 'Batch 1C: incompatible table constraints %',a; END IF;
END $$;
CREATE OR REPLACE FUNCTION pg_temp._b1c_assert_index(a regclass, e regclass, t regclass)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF a IS NULL OR NOT EXISTS (
   SELECT 1 FROM pg_index x JOIN pg_class xc ON xc.oid=x.indexrelid,
      pg_index y JOIN pg_class yc ON yc.oid=y.indexrelid
   WHERE x.indexrelid=a AND y.indexrelid=e AND x.indrelid=t
     AND xc.relkind='i' AND xc.relam=yc.relam
     AND x.indisunique=y.indisunique AND x.indisprimary=y.indisprimary
     AND x.indisvalid AND x.indisready AND x.indislive
     AND x.indimmediate=y.indimmediate AND x.indnullsnotdistinct=y.indnullsnotdistinct
     AND x.indnkeyatts=y.indnkeyatts AND x.indnatts=y.indnatts
     AND x.indkey=y.indkey AND x.indclass=y.indclass
     AND x.indcollation=y.indcollation AND x.indoption=y.indoption
     AND pg_get_expr(x.indexprs,x.indrelid) IS NOT DISTINCT FROM pg_get_expr(y.indexprs,y.indrelid)
     AND pg_get_expr(x.indpred,x.indrelid) IS NOT DISTINCT FROM pg_get_expr(y.indpred,y.indrelid)
 ) THEN RAISE EXCEPTION 'Batch 1C: incompatible index %',a; END IF;
END $$;
DO $$
DECLARE t text; c record;
BEGIN
 FOREACH t IN ARRAY ARRAY['wallet_collection_config','wallet_topup_attempts','wallet_topup_verifications'] LOOP
   PERFORM pg_temp._b1c_assert_table(('public.'||t)::regclass,('pg_temp._b1c_'||t)::regclass);
   FOR c IN SELECT x.conindid, e.conindid AS expected
      FROM pg_constraint x JOIN pg_constraint e ON e.contype=x.contype
        AND pg_get_constraintdef(e.oid)=pg_get_constraintdef(x.oid)
      WHERE x.conrelid=('public.'||t)::regclass
        AND e.conrelid=('pg_temp._b1c_'||t)::regclass AND x.contype IN ('p','u')
   LOOP
      PERFORM pg_temp._b1c_assert_index(c.conindid,c.expected,('public.'||t)::regclass);
   END LOOP;
 END LOOP;
 PERFORM pg_temp._b1c_assert_index(to_regclass('public.wallet_topup_attempts_owner'),'pg_temp._b1c_attempts_owner','public.wallet_topup_attempts');
 PERFORM pg_temp._b1c_assert_index(to_regclass('public.wallet_topup_attempts_credit_unique'),'pg_temp._b1c_credit_unique','public.wallet_topup_attempts');
 PERFORM pg_temp._b1c_assert_index(to_regclass('public.wallet_topup_attempts_provider_reference_unique'),'pg_temp._b1c_provider_unique','public.wallet_topup_attempts');
 IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.wallet_topup_attempts'::regclass AND contype='f')<>1
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.wallet_topup_attempts'::regclass
      AND contype='f' AND confrelid='public.wallet_business_events'::regclass AND convalidated
      AND pg_get_constraintdef(oid)='FOREIGN KEY (credited_event_id) REFERENCES wallet_business_events(id)')
    OR (SELECT count(*) FROM pg_constraint WHERE conrelid='public.wallet_topup_verifications'::regclass AND contype='f')<>1
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.wallet_topup_verifications'::regclass
      AND contype='f' AND confrelid='public.wallet_topup_attempts'::regclass AND convalidated
      AND pg_get_constraintdef(oid)='FOREIGN KEY (attempt_id) REFERENCES wallet_topup_attempts(id)')
 THEN RAISE EXCEPTION 'Batch 1C: incompatible foreign keys'; END IF;
END $$;

-- Frozen-terms guard (attempt_key is immutable too).
CREATE OR REPLACE FUNCTION public.wallet_topup_attempt_freeze()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.attempt_key IS DISTINCT FROM OLD.attempt_key
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.country_code IS DISTINCT FROM OLD.country_code
     OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.destination_account_purpose IS DISTINCT FROM OLD.destination_account_purpose
     OR NEW.payment_provider IS DISTINCT FROM OLD.payment_provider
     OR NEW.merchant_account_ref IS DISTINCT FROM OLD.merchant_account_ref
     OR NEW.provider_idempotency_identity IS DISTINCT FROM OLD.provider_idempotency_identity THEN
    RAISE EXCEPTION 'Batch 1C: top-up attempt terms are frozen' USING ERRCODE = 'BP007';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS wallet_topup_attempt_freeze ON public.wallet_topup_attempts;
CREATE TRIGGER wallet_topup_attempt_freeze BEFORE UPDATE ON public.wallet_topup_attempts
  FOR EACH ROW EXECUTE FUNCTION public.wallet_topup_attempt_freeze();

-- 5. Initiate with concurrent-safe replay and market limits.
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
  IF p_payment_provider IS NULL OR p_payment_provider NOT IN ('stripe','kora') THEN
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

-- 5b. Atomic durable submission claim: exactly one caller proceeds to provider contact.
CREATE OR REPLACE FUNCTION public.claim_wallet_topup_submission(p_attempt_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.wallet_collection_enabled() THEN RAISE EXCEPTION 'Batch 1C: collection disabled at submission' USING ERRCODE='BP008'; END IF;
  UPDATE public.wallet_topup_attempts SET status = 'submitting'
  WHERE id = p_attempt_id AND status = 'initiated';
  RETURN FOUND;
END
$$;

-- 6. Bind provider reference (idempotent same; reject different).
CREATE OR REPLACE FUNCTION public.record_wallet_topup_provider_reference(p_attempt_id uuid, p_provider_reference text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF p_provider_reference IS NULL OR btrim(p_provider_reference) = '' THEN
    RAISE EXCEPTION 'Batch 1C: provider_reference is required' USING ERRCODE = 'BP004';
  END IF;
  IF a.provider_reference IS NOT NULL THEN
    IF a.provider_reference = p_provider_reference THEN RETURN true; END IF;
    RAISE EXCEPTION 'Batch 1C: provider reference already bound; never switch providers' USING ERRCODE = 'BP008';
  END IF;
  IF a.status NOT IN ('initiated','submitting','uncertain') THEN
    RAISE EXCEPTION 'Batch 1C: attempt is not awaiting provider reference' USING ERRCODE = 'BP008';
  END IF;
  UPDATE public.wallet_topup_attempts SET provider_reference = p_provider_reference, status = 'provider_pending'
  WHERE id = p_attempt_id;
  RETURN true;
END
$$;

-- 7. Durable webhook-before-reference verification evidence (idempotent).
CREATE OR REPLACE FUNCTION public.record_wallet_topup_verification(
  p_attempt_id uuid, p_evidence_key text, p_provider_reference text, p_merchant_account_ref text,
  p_currency_code text, p_amount_minor bigint, p_final_status text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_evidence_key IS NULL OR btrim(p_evidence_key) = '' THEN
    RAISE EXCEPTION 'Batch 1C: evidence_key is required' USING ERRCODE = 'BP004';
  END IF;
  IF p_final_status IS NULL OR p_final_status NOT IN ('succeeded','completed','failed','pending','unknown') THEN
    RAISE EXCEPTION 'Batch 1C: invalid final status %', p_final_status USING ERRCODE = 'BP008';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wallet-topup-evidence:' || p_evidence_key, 0));
  -- Idempotent only for identical evidence; conflicting reuse is rejected.
  IF EXISTS (SELECT 1 FROM public.wallet_topup_verifications WHERE evidence_key = p_evidence_key) THEN
    IF EXISTS (SELECT 1 FROM public.wallet_topup_verifications WHERE evidence_key = p_evidence_key
               AND attempt_id = p_attempt_id AND provider_reference IS NOT DISTINCT FROM p_provider_reference
               AND merchant_account_ref IS NOT DISTINCT FROM p_merchant_account_ref
               AND currency_code IS NOT DISTINCT FROM p_currency_code
               AND amount_minor IS NOT DISTINCT FROM p_amount_minor
               AND final_status = p_final_status) THEN
      RETURN true;
    END IF;
    RAISE EXCEPTION 'Batch 1C: evidence_key % reused with conflicting evidence', p_evidence_key USING ERRCODE = 'BP002';
  END IF;
  INSERT INTO public.wallet_topup_verifications
    (attempt_id, evidence_key, provider_reference, merchant_account_ref, currency_code, amount_minor, final_status)
  VALUES
    (p_attempt_id, p_evidence_key, p_provider_reference, p_merchant_account_ref, p_currency_code, p_amount_minor, p_final_status);
  RETURN true;
END
$$;

-- 8. Confirm + credit (recoverable from uncertain; replay terms validated).
CREATE OR REPLACE FUNCTION public.confirm_wallet_topup(
  p_attempt_id uuid, p_verified_provider_reference text, p_verified_merchant_account_ref text,
  p_verified_currency text, p_verified_amount_minor bigint, p_final_status text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  a public.wallet_topup_attempts%ROWTYPE; v_event_id uuid; v_legs jsonb;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;

  IF p_final_status IS NULL OR p_final_status NOT IN ('succeeded','completed') THEN
    RAISE EXCEPTION 'Batch 1C: final status % is not a confirmed success', p_final_status USING ERRCODE = 'BP008';
  END IF;

  IF a.status = 'credited' AND a.credited_event_id IS NOT NULL THEN
    IF p_verified_provider_reference IS DISTINCT FROM a.provider_reference
       OR p_verified_merchant_account_ref IS DISTINCT FROM a.merchant_account_ref
       OR p_verified_currency IS DISTINCT FROM a.currency_code
       OR p_verified_amount_minor IS DISTINCT FROM a.amount_minor THEN
      RAISE EXCEPTION 'Batch 1C: replay terms do not match the credited attempt' USING ERRCODE = 'BP002';
    END IF;
    RETURN a.credited_event_id;
  END IF;
  IF a.status IN ('failed','refunded') THEN
    RAISE EXCEPTION 'Batch 1C: attempt is terminal (%)', a.status USING ERRCODE = 'BP008';
  END IF;
  -- 'uncertain' is recoverable: same-provider reconciliation proceeds below.
  IF a.provider_reference IS NULL THEN
    RAISE EXCEPTION 'Batch 1C: no provider reference bound yet (webhook-before-reference race)' USING ERRCODE = 'BP008';
  END IF;
  IF p_verified_provider_reference IS DISTINCT FROM a.provider_reference
     OR p_verified_merchant_account_ref IS DISTINCT FROM a.merchant_account_ref
     OR p_verified_currency IS DISTINCT FROM a.currency_code
     OR p_verified_amount_minor IS DISTINCT FROM a.amount_minor THEN
    RAISE EXCEPTION 'Batch 1C: verified terms do not match the frozen attempt' USING ERRCODE = 'BP008';
  END IF;

  v_legs := jsonb_build_array(
    jsonb_build_object('accountPurpose', a.destination_account_purpose, 'amountMinor', a.amount_minor),
    jsonb_build_object('accountPurpose', 'platform_funding', 'amountMinor', -a.amount_minor));
  v_event_id := public.post_wallet_event(
    'wallet-topup:' || a.id::text, 'topup', a.tenant_id, a.owner_id, a.currency_code,
    v_legs, a.payment_provider, a.merchant_account_ref, a.provider_reference);

  UPDATE public.wallet_topup_attempts SET status = 'credited', credited_event_id = v_event_id WHERE id = p_attempt_id;
  RETURN v_event_id;
END
$$;

-- 9. Reconcile a stored verification (same-provider; applies confirmed evidence).
CREATE OR REPLACE FUNCTION public.reconcile_wallet_topup(p_attempt_id uuid, p_evidence_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v public.wallet_topup_verifications%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.wallet_topup_verifications WHERE attempt_id = p_attempt_id AND evidence_key = p_evidence_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: verification evidence not found' USING ERRCODE = 'BP003'; END IF;
  RETURN public.confirm_wallet_topup(p_attempt_id, v.provider_reference, v.merchant_account_ref, v.currency_code, v.amount_minor, v.final_status);
END
$$;

-- 10. Terminal marks + refund (verified evidence, idempotent, history-preserving).
CREATE OR REPLACE FUNCTION public.mark_wallet_topup_failed(p_attempt_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF a.status IN ('credited','refunded') THEN
    RAISE EXCEPTION 'Batch 1C: credited/refunded attempt cannot be downgraded to failed' USING ERRCODE = 'BP008';
  END IF;
  UPDATE public.wallet_topup_attempts SET status='failed', failure_reason=COALESCE(p_reason,failure_reason) WHERE id=p_attempt_id;
END $$;

CREATE OR REPLACE FUNCTION public.mark_wallet_topup_uncertain(p_attempt_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF a.status IN ('credited','refunded') THEN
    RAISE EXCEPTION 'Batch 1C: credited/refunded attempt cannot be downgraded to uncertain' USING ERRCODE = 'BP008';
  END IF;
  UPDATE public.wallet_topup_attempts SET status='uncertain', failure_reason=COALESCE(p_reason,failure_reason) WHERE id=p_attempt_id;
END $$;

CREATE OR REPLACE FUNCTION public.mark_wallet_topup_refunded(
  p_attempt_id uuid, p_evidence_reference text, p_verified_provider_reference text,
  p_verified_merchant_account_ref text, p_verified_currency text, p_verified_amount_minor bigint,
  p_final_status text, p_reason text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  a public.wallet_topup_attempts%ROWTYPE; v_reversal uuid;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF p_evidence_reference IS NULL OR btrim(p_evidence_reference) = '' THEN
    RAISE EXCEPTION 'Batch 1C: refund/chargeback evidence reference is required' USING ERRCODE = 'BP004';
  END IF;
  IF p_final_status IS NULL OR p_final_status NOT IN ('refunded','reversed') THEN
    RAISE EXCEPTION 'Batch 1C: refund final status % is not confirmed', p_final_status USING ERRCODE = 'BP008';
  END IF;
  IF a.status = 'refunded' THEN
    -- Replay: validate ALL evidence terms before returning the existing reversal.
    IF a.refund_evidence_reference IS DISTINCT FROM p_evidence_reference
       OR a.provider_reference IS DISTINCT FROM p_verified_provider_reference
       OR a.merchant_account_ref IS DISTINCT FROM p_verified_merchant_account_ref
       OR a.currency_code IS DISTINCT FROM p_verified_currency
       OR a.amount_minor IS DISTINCT FROM p_verified_amount_minor THEN
      RAISE EXCEPTION 'Batch 1C: replay refund terms do not match' USING ERRCODE = 'BP002';
    END IF;
    SELECT e.id INTO v_reversal FROM public.wallet_business_events e
    WHERE e.event_key = 'wallet-topup:' || a.id::text || ':refund';
    RETURN v_reversal;
  END IF;
  IF a.status <> 'credited' OR a.credited_event_id IS NULL THEN
    RAISE EXCEPTION 'Batch 1C: only a credited attempt can be refunded' USING ERRCODE = 'BP008';
  END IF;
  -- Evidence must match provider, merchant, original payment, currency, full amount.
  IF a.provider_reference IS DISTINCT FROM p_verified_provider_reference
     OR a.merchant_account_ref IS DISTINCT FROM p_verified_merchant_account_ref
     OR a.currency_code IS DISTINCT FROM p_verified_currency THEN
    RAISE EXCEPTION 'Batch 1C: refund evidence does not match the original payment' USING ERRCODE = 'BP008';
  END IF;
  IF p_verified_amount_minor IS DISTINCT FROM a.amount_minor THEN
    RAISE EXCEPTION 'Batch 1C: partial refunds are unsupported (evidence %, attempt %)', p_verified_amount_minor, a.amount_minor USING ERRCODE = 'BP008';
  END IF;
  v_reversal := public.post_wallet_reversal('wallet-topup:' || a.id::text, 'wallet-topup:' || a.id::text || ':refund');
  UPDATE public.wallet_topup_attempts SET status='refunded', refund_evidence_reference=p_evidence_reference, failure_reason=COALESCE(p_reason,failure_reason) WHERE id=p_attempt_id;
  RETURN v_reversal;
END $$;

-- 11. Legacy chk_topup_requires_stripe transition (conditional comment).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_topup_requires_stripe' AND conrelid='public.wallet_transactions'::regclass) THEN
    COMMENT ON CONSTRAINT chk_topup_requires_stripe ON public.wallet_transactions IS
      'Legacy Stripe-only top-up guard (historical rows preserved). Batch 1C credits the Batch 1B ledger via post_wallet_event and does not write wallet_transactions; do not require stripe_payment_intent_id for new provider-neutral credits.';
  END IF;
END $$;

-- 12. Privileges.
ALTER TABLE public.wallet_topup_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wallet_topup_attempts_select_own ON public.wallet_topup_attempts;
CREATE POLICY wallet_topup_attempts_select_own ON public.wallet_topup_attempts
  FOR SELECT TO authenticated USING (owner_id = auth.uid());
REVOKE ALL ON public.wallet_topup_attempts, public.wallet_collection_config, public.wallet_topup_verifications FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.wallet_topup_attempts TO authenticated, service_role;
GRANT SELECT ON public.wallet_collection_config TO service_role;
GRANT SELECT ON public.wallet_topup_verifications TO service_role;

REVOKE ALL ON FUNCTION public.initiate_wallet_topup(text,uuid,uuid,text,text,bigint,text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_wallet_topup_provider_reference(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_wallet_topup_submission(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_wallet_topup_verification(uuid,text,text,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_wallet_topup(uuid,text,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_wallet_topup(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_wallet_topup_failed(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_wallet_topup_uncertain(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_wallet_topup_refunded(uuid,text,text,text,text,bigint,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.initiate_wallet_topup(text,uuid,uuid,text,text,bigint,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_wallet_topup_submission(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_wallet_topup_provider_reference(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_wallet_topup_verification(uuid,text,text,text,text,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_wallet_topup(uuid,text,text,text,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_wallet_topup(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_wallet_topup_failed(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_wallet_topup_uncertain(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_wallet_topup_refunded(uuid,text,text,text,text,bigint,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wallet_collection_enabled() TO authenticated, service_role;

COMMIT;
