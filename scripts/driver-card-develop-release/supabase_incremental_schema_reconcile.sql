-- VAYDU_DRIVER_CARD_TOPUP_20261027_BEGIN
-- Development-only additive card-top-up schema. No collection enablement.
BEGIN;
DO $driver_card_reconcile$
DECLARE applied record; observed_schema_fingerprint text;
BEGIN
 IF current_database()<>'movabi_develop' THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('vaydu-driver-card-schema',0));
 CREATE TABLE IF NOT EXISTS public.vaydu_driver_card_schema_releases(version text PRIMARY KEY,source_sha256 text NOT NULL,catalog_fingerprint text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());
 REVOKE ALL ON public.vaydu_driver_card_schema_releases FROM PUBLIC,anon,authenticated,service_role;
 SELECT * INTO applied FROM public.vaydu_driver_card_schema_releases WHERE version='driver-card-topup-20261027-v1';
 IF FOUND THEN
  SELECT md5(jsonb_build_object(
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl::text) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('claim_wallet_topup_submission','confirm_wallet_topup','initiate_wallet_topup','post_wallet_event','record_wallet_topup_provider_reference','wallet_collection_enabled','wallet_currency_minor_exponent','wallet_topup_attempt_freeze','freeze_wallet_topup_fee','freeze_wallet_topup_fee_v1','freeze_wallet_topup_fee_v2','confirm_wallet_topup_with_total','record_driver_topup_provider_observation','wallet_fee_schedule_freeze','driver_card_scope_freeze','driver_card_attempt_scope_freeze','driver_card_sandbox_enabled','driver_card_sandbox_permit','driver_card_sandbox_attempt_permit')),
 'columns',(SELECT jsonb_agg(jsonb_build_array(table_name,column_name,udt_name,is_nullable,column_default) ORDER BY table_name,ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('wallet_topup_attempts','payment_checkout_attempts','wallet_topup_fee_policies','wallet_topup_fee_schedules','driver_card_fee_policy_versions','driver_card_topup_sandbox_scopes','wallet_topup_provider_observations')),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.relname,x.conname,pg_get_constraintdef(x.oid)) ORDER BY c.relname,x.conname) FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('wallet_topup_attempts','payment_checkout_attempts','wallet_topup_fee_policies','wallet_topup_fee_schedules','driver_card_fee_policy_versions','driver_card_topup_sandbox_scopes','wallet_topup_provider_observations')),
 'tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relrowsecurity,c.relacl::text) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('wallet_topup_attempts','payment_checkout_attempts','wallet_topup_fee_policies','wallet_topup_fee_schedules','driver_card_fee_policy_versions','driver_card_topup_sandbox_scopes','wallet_topup_provider_observations')),
 'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public' AND c.relname IN ('wallet_topup_attempts','payment_checkout_attempts','wallet_topup_fee_policies','wallet_topup_fee_schedules','driver_card_fee_policy_versions','driver_card_topup_sandbox_scopes','wallet_topup_provider_observations'))
 )::text) INTO observed_schema_fingerprint;
  IF applied.source_sha256 IS DISTINCT FROM '746192dd0435bb34724819a1ef94de3b1011fba741c09dd2ba3e9ee6af1a9de8' OR applied.catalog_fingerprint IS DISTINCT FROM observed_schema_fingerprint THEN
   RAISE EXCEPTION 'Driver card release drift; refuse automatic reconciliation';
  END IF;
  RETURN;
 END IF;
 EXECUTE $driver_card_sql$
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
LOCK TABLE public.wallet_topup_attempts,public.wallet_collection_config,public.market_payment_routes,public.payment_checkout_attempts IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'Wrong database'; END IF;
 IF public.wallet_collection_enabled() IS DISTINCT FROM false THEN RAISE EXCEPTION 'Collection must remain disabled'; END IF;
 IF EXISTS(SELECT 1 FROM public.wallet_topup_attempts) THEN RAISE EXCEPTION 'Attempt baseline changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.market_payment_routes WHERE enabled OR merchant_approved OR adapter_ready OR payout_approved) THEN RAISE EXCEPTION 'Route approval baseline changed'; END IF;
 IF (SELECT count(*) FROM public.payment_checkout_attempts)<>2 THEN RAISE EXCEPTION 'Provider-store baseline changed'; END IF;
 IF to_regclass('public.wallet_topup_fee_policies') IS NOT NULL OR to_regclass('public.wallet_topup_fee_schedules') IS NOT NULL THEN RAISE EXCEPTION 'Fee schema baseline changed'; END IF;
END $$;
DO $$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='claim_wallet_topup_submission' AND md5(pg_get_functiondef(p.oid))='0ff1197e432107c69f2c591917a80cca')<>1 THEN RAISE EXCEPTION 'Function baseline changed: claim_wallet_topup_submission'; END IF; END $$;
DO $$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='confirm_wallet_topup' AND md5(pg_get_functiondef(p.oid))='099267ac21fcb291d218dd08717401b0')<>1 THEN RAISE EXCEPTION 'Function baseline changed: confirm_wallet_topup'; END IF; END $$;
DO $$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='initiate_wallet_topup' AND md5(pg_get_functiondef(p.oid))='24dd1a38a941359349950ebe245c735b')<>1 THEN RAISE EXCEPTION 'Function baseline changed: initiate_wallet_topup'; END IF; END $$;
DO $$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='post_wallet_event' AND md5(pg_get_functiondef(p.oid))='0fe33c2fbea877b181d637aa0bfe7f10')<>1 THEN RAISE EXCEPTION 'Function baseline changed: post_wallet_event'; END IF; END $$;
DO $$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='record_wallet_topup_provider_reference' AND md5(pg_get_functiondef(p.oid))='340bd44df3bd557ab5b18eec619239a1')<>1 THEN RAISE EXCEPTION 'Function baseline changed: record_wallet_topup_provider_reference'; END IF; END $$;
DO $$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='wallet_collection_enabled' AND md5(pg_get_functiondef(p.oid))='cb6d40cff166261a208753822fd3a50f')<>1 THEN RAISE EXCEPTION 'Function baseline changed: wallet_collection_enabled'; END IF; END $$;
DO $$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='wallet_currency_minor_exponent' AND md5(pg_get_functiondef(p.oid))='bbd1b5c8d1a49c90a302f5efb6f6278e')<>1 THEN RAISE EXCEPTION 'Function baseline changed: wallet_currency_minor_exponent'; END IF; END $$;
DO $$ BEGIN IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='wallet_topup_attempt_freeze' AND md5(pg_get_functiondef(p.oid))='de86b788446923a78d0ad5f74477a87a')<>1 THEN RAISE EXCEPTION 'Function baseline changed: wallet_topup_attempt_freeze'; END IF; END $$;

-- Source: 20261253900000_flutterwave_market_provider_prerequisite.sql
-- Additive prerequisite for Batch 2A on the inspected develop schema.
-- Only widen the provider enum; no route, capability or approval is enabled.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_constraintdef(c.oid) INTO definition FROM pg_constraint c
 WHERE c.conrelid='public.market_payment_routes'::regclass AND c.conname='market_payment_routes_provider_check' AND c.contype='c';
 IF definition IS NULL THEN
   RAISE EXCEPTION 'Expected market provider constraint missing; inspect schema before deployment';
 END IF;
 IF definition NOT IN (
   'CHECK ((provider = ANY (ARRAY[''stripe''::text, ''kora''::text, ''fincra''::text])))',
   'CHECK ((provider = ANY (ARRAY[''stripe''::text, ''kora''::text, ''fincra''::text, ''flutterwave''::text])))'
 ) THEN RAISE EXCEPTION 'Unexpected market provider constraint; refusing replacement'; END IF;
END $$;
ALTER TABLE public.market_payment_routes DROP CONSTRAINT market_payment_routes_provider_check;
ALTER TABLE public.market_payment_routes ADD CONSTRAINT market_payment_routes_provider_check
 CHECK(provider IN ('stripe','kora','fincra','flutterwave'));

-- Source: 20261254000000_flutterwave_provider_batch2a.sql
-- =============================================================================
-- Batch 2A — Flutterwave provider (additive, disabled by default).
-- Adds Flutterwave as a configurable provider (routed by country/currency/
-- capability/merchant approval, never by continent) and an explicit fee-policy
-- table so wallet credit, provider fee and total charge are frozen before
-- payment. No route is enabled and no live key is configured.
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.wallet_topup_attempts') IS NULL OR to_regclass('public.market_payment_routes') IS NULL THEN
    RAISE EXCEPTION 'Batch 2A precondition: Batch 1C top-ups and market_payment_routes are required';
  END IF;
END
$$;

-- 1. Fee policy table (explicit approved provider/market/method configuration).
CREATE TABLE IF NOT EXISTS public.wallet_topup_fee_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL,
  provider text NOT NULL,
  country_code text NOT NULL,
  currency_code text NOT NULL,
  method text NOT NULL,
  fee_basis_points integer NOT NULL DEFAULT 0 CHECK (fee_basis_points BETWEEN 0 AND 10000),
  fee_fixed_minor bigint NOT NULL DEFAULT 0 CHECK (fee_fixed_minor >= 0),
  exponent integer NOT NULL CHECK (exponent BETWEEN 0 AND 3),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (fee_basis_points = 0 OR fee_fixed_minor = 0),
  CHECK (fee_basis_points <> 0 OR fee_fixed_minor <> 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_topup_fee_policies_active_unique
  ON public.wallet_topup_fee_policies (provider, country_code, currency_code, method) WHERE active;
-- Flutterwave + Stripe/Kora/Fincra must also have explicit fee rows; none is active here.

-- 2. Freeze fee amounts + policy version on the attempt.
ALTER TABLE public.wallet_topup_attempts
  ADD COLUMN IF NOT EXISTS provider_fee_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_charge_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee_policy_version text,
  ADD COLUMN IF NOT EXISTS fee_exponent smallint CHECK (fee_exponent BETWEEN 0 AND 3);
-- Ensure new attempts carry the total charge (amount + fee); existing rows keep 0 default.
COMMENT ON COLUMN public.wallet_topup_attempts.provider_fee_minor IS 'Frozen provider fee in currency minor units';
COMMENT ON COLUMN public.wallet_topup_attempts.total_charge_minor IS 'Frozen total charge (wallet amount + provider fee) in minor units';
COMMENT ON COLUMN public.wallet_topup_attempts.fee_policy_version IS 'Approved fee-policy version applied to this attempt';

-- 3. A disabled Flutterwave route (routed by config; never enabled here).
INSERT INTO public.market_payment_routes (country_code, currency_code, method, provider, merchant_account_ref, preferred, enabled, merchant_approved, adapter_ready, payout_approved, capabilities)
SELECT 'NG','NGN','card','flutterwave','flw-ng-merchant', true, false, false, false, false, ARRAY['collect']::text[]
WHERE NOT EXISTS (
  SELECT 1 FROM public.market_payment_routes
  WHERE country_code='NG' AND currency_code='NGN' AND method='card' AND provider='flutterwave');

-- 4. Privileges: server-owned configuration; no client write.
REVOKE ALL ON public.wallet_topup_fee_policies FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.wallet_topup_fee_policies TO service_role;


-- Source: 20261254100000_wallet_fee_freeze_batch2b.sql
-- =============================================================================
-- Batch 2B — integrate fee policy into the top-up lifecycle (additive).
-- Freezes wallet credit, provider fee, total charge and fee-policy version
-- BEFORE provider contact; the confirm path credits only the wallet amount.
-- Does NOT replace previously applied migrations.
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.wallet_topup_attempts') IS NULL OR to_regclass('public.wallet_topup_fee_policies') IS NULL THEN
    RAISE EXCEPTION 'Batch 2B precondition: Batch 1C and Batch 2A are required';
  END IF;
END
$$;

-- Validate + freeze the three amounts and policy version (before provider contact).
CREATE OR REPLACE FUNCTION public.freeze_wallet_topup_fee(p_attempt_id uuid, p_fee_policy_version text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  a public.wallet_topup_attempts%ROWTYPE;
  pol public.wallet_topup_fee_policies%ROWTYPE;
  v_fee bigint; v_total bigint;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 2B: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF a.status <> 'initiated' AND a.fee_policy_version IS NULL THEN
    RAISE EXCEPTION 'Batch 2B: fee must be frozen before submission' USING ERRCODE = 'BP008';
  END IF;
  IF p_fee_policy_version IS NULL OR btrim(p_fee_policy_version) = '' THEN
    RAISE EXCEPTION 'Batch 2B: fee policy version is required' USING ERRCODE = 'BP004';
  END IF;
  -- Conflicting retry: reject a different policy version after freezing.
  IF a.fee_policy_version IS NOT NULL THEN
    IF a.fee_policy_version <> p_fee_policy_version THEN
      RAISE EXCEPTION 'Batch 2B: attempt already frozen with policy %', a.fee_policy_version USING ERRCODE = 'BP002';
    END IF;
    RETURN;
  END IF;
  -- Fee is CALCULATED from the approved server-owned policy (never caller-supplied).
  SELECT * INTO pol FROM public.wallet_topup_fee_policies
  WHERE active AND provider = a.payment_provider AND country_code = a.country_code
    AND currency_code = a.currency_code AND method = 'card' AND version = p_fee_policy_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch 2B: no active fee policy % for %/%/%', p_fee_policy_version, a.payment_provider, a.country_code, a.currency_code USING ERRCODE = 'BP008';
  END IF;
  IF pol.exponent IS DISTINCT FROM public.wallet_currency_minor_exponent(a.currency_code) THEN
    RAISE EXCEPTION 'Batch 2B: configured currency exponent does not match ledger authority' USING ERRCODE = 'BP008';
  END IF;
  IF pol.fee_basis_points > 0 THEN
    v_fee := round((a.amount_minor::numeric * pol.fee_basis_points::numeric) / 10000.0)::bigint;
  ELSE
    v_fee := pol.fee_fixed_minor;
  END IF;
  v_total := a.amount_minor + v_fee;
  UPDATE public.wallet_topup_attempts
  SET provider_fee_minor = v_fee, total_charge_minor = v_total, fee_policy_version = p_fee_policy_version, fee_exponent = pol.exponent
  WHERE id = p_attempt_id;
END
$$;

-- Server-side charge verification: the provider's actual total must equal the
-- frozen total charge before crediting; credit only the wallet amount (amount_minor).
CREATE OR REPLACE FUNCTION public.verify_wallet_topup_charge(p_attempt_id uuid, p_verified_total_minor bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 2B: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF p_verified_total_minor IS NULL OR p_verified_total_minor <= 0 THEN
    RAISE EXCEPTION 'Batch 2B: verified total is required' USING ERRCODE = 'BP004';
  END IF;
  IF p_verified_total_minor IS DISTINCT FROM a.total_charge_minor THEN
    RAISE EXCEPTION 'Batch 2B: verified total % does not match frozen total %', p_verified_total_minor, a.total_charge_minor USING ERRCODE = 'BP008';
  END IF;
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION public.freeze_wallet_topup_fee(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_wallet_topup_charge(uuid,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.freeze_wallet_topup_fee(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_wallet_topup_charge(uuid,bigint) TO service_role;


-- Source: 20261254200000_flutterwave_provider_accept_batch2c.sql
-- =============================================================================
-- Batch 2C — accept Flutterwave in the top-up/ledger lifecycle (additive).
-- Batch 1B and Batch 1C reject 'flutterwave' in their provider CHECKs and
-- functions. This migration widens the accepted provider set WITHOUT replacing
-- the applied migrations (CREATE OR REPLACE + precise CHECK swaps).
-- =============================================================================

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


-- Source: 20261254300000_wallet_atomic_confirm_batch2d.sql
-- =============================================================================
-- Batch 2D — atomic total-check-and-credit (additive).
-- One transactional confirmation: locks the attempt, validates the immutable
-- wallet amount/fee/total/policy version + provider/account/reference/currency
-- and trusted successful evidence, then credits ONLY the wallet amount exactly
-- once. Identical retries return the original event; conflicting retries raise
-- BP002. The legacy 6-arg confirm is restricted once a fee is frozen.
-- =============================================================================

-- 0. Durable legacy-attempt classification: new attempts are non-legacy by
--    default and MUST freeze a fee; genuine pre-existing attempts must be
--    backfilled legacy_attempt = true before applying this migration.
ALTER TABLE public.wallet_topup_attempts
  ADD COLUMN IF NOT EXISTS legacy_attempt boolean NOT NULL DEFAULT false;
-- One-time locked backfill: classify only the attempts that existed before this
-- migration. A rerun (with new attempts present) must NOT reclassify them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.wallet_collection_config WHERE key = 'legacy_backfill_done') THEN
    UPDATE public.wallet_topup_attempts SET legacy_attempt = true;
    INSERT INTO public.wallet_collection_config(key, value) VALUES ('legacy_backfill_done', 'true');
  END IF;
END
$$;

-- Freeze legacy classification: it can never change after this migration.
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
     OR NEW.provider_idempotency_identity IS DISTINCT FROM OLD.provider_idempotency_identity
     OR NEW.legacy_attempt IS DISTINCT FROM OLD.legacy_attempt THEN
    RAISE EXCEPTION 'Batch 1C: top-up attempt terms are frozen' USING ERRCODE = 'BP007';
  END IF;
  -- Fee snapshot: immutable once fee_policy_version is set (including a zero fee).
  IF OLD.fee_policy_version IS NOT NULL AND (
    NEW.fee_policy_version IS DISTINCT FROM OLD.fee_policy_version
    OR NEW.provider_fee_minor IS DISTINCT FROM OLD.provider_fee_minor
    OR NEW.total_charge_minor IS DISTINCT FROM OLD.total_charge_minor
    OR NEW.fee_exponent IS DISTINCT FROM OLD.fee_exponent
  ) THEN
    RAISE EXCEPTION 'Batch 1C: top-up fee snapshot is immutable' USING ERRCODE = 'BP007';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS wallet_topup_attempt_freeze ON public.wallet_topup_attempts;
CREATE TRIGGER wallet_topup_attempt_freeze BEFORE UPDATE ON public.wallet_topup_attempts
  FOR EACH ROW EXECUTE FUNCTION public.wallet_topup_attempt_freeze();

-- 1. Atomic confirmation (replaces the two-call verify+confirm gap).

-- Fee-before-claim: a new (non-legacy) attempt must freeze an approved fee
-- before its submission can be claimed.
CREATE OR REPLACE FUNCTION public.claim_wallet_topup_submission(p_attempt_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.wallet_collection_enabled() THEN RAISE EXCEPTION 'Batch 1C: collection disabled at submission' USING ERRCODE='BP008'; END IF;
  UPDATE public.wallet_topup_attempts SET status = 'submitting'
  WHERE id = p_attempt_id AND status = 'initiated'
    AND (legacy_attempt OR fee_policy_version IS NOT NULL);
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION public.claim_wallet_topup_submission(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_wallet_topup_submission(uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.confirm_wallet_topup_with_total(
  p_attempt_id uuid,
  p_verified_provider_reference text,
  p_verified_merchant_account_ref text,
  p_verified_currency text,
  p_verified_total_minor bigint,
  p_final_status text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  a public.wallet_topup_attempts%ROWTYPE; v_event_id uuid; v_legs jsonb;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 2D: attempt not found' USING ERRCODE = 'BP003'; END IF;
  IF p_final_status IS NULL OR p_final_status NOT IN ('succeeded','completed') THEN
    RAISE EXCEPTION 'Batch 2D: final status % is not a confirmed success', p_final_status USING ERRCODE = 'BP008';
  END IF;

  -- Idempotent replay: validate ALL immutable terms before returning the credit.
  IF a.status = 'credited' AND a.credited_event_id IS NOT NULL THEN
    IF p_verified_provider_reference IS DISTINCT FROM a.provider_reference
       OR p_verified_merchant_account_ref IS DISTINCT FROM a.merchant_account_ref
       OR p_verified_currency IS DISTINCT FROM a.currency_code
       OR p_verified_total_minor IS DISTINCT FROM a.total_charge_minor THEN
      RAISE EXCEPTION 'Batch 2D: replay terms do not match the credited attempt' USING ERRCODE = 'BP002';
    END IF;
    RETURN a.credited_event_id;
  END IF;
  IF a.status IN ('failed','refunded') THEN
    RAISE EXCEPTION 'Batch 2D: attempt is terminal (%)', a.status USING ERRCODE = 'BP008';
  END IF;
  IF a.provider_reference IS NULL THEN
    RAISE EXCEPTION 'Batch 2D: no provider reference bound yet' USING ERRCODE = 'BP008';
  END IF;
  -- Fee must be frozen from an approved policy before a total-checked credit.
  IF a.fee_policy_version IS NULL OR a.total_charge_minor IS NULL OR a.total_charge_minor <= 0 THEN
    RAISE EXCEPTION 'Batch 2D: fee and total charge must be frozen before confirmation' USING ERRCODE = 'BP008';
  END IF;
  -- Verify all immutable terms + the provider's actual total.
  IF p_verified_provider_reference IS DISTINCT FROM a.provider_reference
     OR p_verified_merchant_account_ref IS DISTINCT FROM a.merchant_account_ref
     OR p_verified_currency IS DISTINCT FROM a.currency_code
     OR p_verified_total_minor IS DISTINCT FROM a.total_charge_minor THEN
    RAISE EXCEPTION 'Batch 2D: verified terms/total do not match the frozen attempt' USING ERRCODE = 'BP008';
  END IF;

  -- Credit ONLY the wallet amount (amount_minor), never the fee or total.
  v_legs := jsonb_build_array(
    jsonb_build_object('accountPurpose', a.destination_account_purpose, 'amountMinor', a.amount_minor),
    jsonb_build_object('accountPurpose', 'platform_funding', 'amountMinor', -a.amount_minor));
  v_event_id := public.post_wallet_event(
    'wallet-topup:' || a.id, 'topup', a.tenant_id, a.owner_id, a.currency_code,
    v_legs, a.payment_provider, a.merchant_account_ref, a.provider_reference);

  UPDATE public.wallet_topup_attempts SET status = 'credited', credited_event_id = v_event_id WHERE id = p_attempt_id;
  RETURN v_event_id;
END
$$;

-- 2. Restrict the legacy 6-arg confirm so it cannot bypass the total check once
--    a fee has been frozen (reconciliation of in-flight legacy attempts without
--    a fee policy still works).
CREATE OR REPLACE FUNCTION public.confirm_wallet_topup(
  p_attempt_id uuid, p_verified_provider_reference text, p_verified_merchant_account_ref text,
  p_verified_currency text, p_verified_amount_minor bigint, p_final_status text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  a public.wallet_topup_attempts%ROWTYPE; v_event_id uuid; v_legs jsonb;
BEGIN
  SELECT * INTO a FROM public.wallet_topup_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch 1C: attempt not found' USING ERRCODE = 'BP003'; END IF;
  -- New attempts must use the total-checked path, independent of policy status;
  -- only genuine legacy attempts may reconcile here.
  IF NOT a.legacy_attempt THEN
    RAISE EXCEPTION 'Batch 2D: use confirm_wallet_topup_with_total (new attempts require a frozen fee)' USING ERRCODE = 'BP008';
  END IF;
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
    'wallet-topup:' || a.id, 'topup', a.tenant_id, a.owner_id, a.currency_code,
    v_legs, a.payment_provider, a.merchant_account_ref, a.provider_reference);
  UPDATE public.wallet_topup_attempts SET status = 'credited', credited_event_id = v_event_id WHERE id = p_attempt_id;
  RETURN v_event_id;
END
$$;

-- Full refunds verify the original total; only the wallet ledger credit reverses.
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
       OR (CASE WHEN a.fee_policy_version IS NULL THEN a.amount_minor ELSE a.total_charge_minor END) IS DISTINCT FROM p_verified_amount_minor THEN
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
  IF p_verified_amount_minor IS DISTINCT FROM (CASE WHEN a.fee_policy_version IS NULL THEN a.amount_minor ELSE a.total_charge_minor END) THEN
    RAISE EXCEPTION 'Batch 1C: partial refunds are unsupported (evidence %, attempt %)', p_verified_amount_minor, CASE WHEN a.fee_policy_version IS NULL THEN a.amount_minor ELSE a.total_charge_minor END USING ERRCODE = 'BP008';
  END IF;
  v_reversal := public.post_wallet_reversal('wallet-topup:' || a.id::text, 'wallet-topup:' || a.id::text || ':refund');
  UPDATE public.wallet_topup_attempts SET status='refunded', refund_evidence_reference=p_evidence_reference, failure_reason=COALESCE(p_reason,failure_reason) WHERE id=p_attempt_id;
  RETURN v_reversal;
END $$;

REVOKE ALL ON FUNCTION public.confirm_wallet_topup_with_total(uuid,text,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_wallet_topup(uuid,text,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_wallet_topup_with_total(uuid,text,text,text,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_wallet_topup(uuid,text,text,text,bigint,text) TO service_role;


-- Source: 20261254400000_wallet_fee_policy_v2.sql
-- Additive approved fee schedules. No merchant, fee or collection enablement.
DO $$ BEGIN
 IF to_regprocedure('public.confirm_wallet_topup_with_total(uuid,text,text,text,bigint,text)') IS NULL
 OR to_regprocedure('public.freeze_wallet_topup_fee(uuid,text)') IS NULL
 OR to_regclass('public.wallet_topup_fee_policies') IS NULL THEN
 RAISE EXCEPTION 'Fee v2 requires the verified Batch 2A-2D schema'; END IF;
END $$;
-- Durable provider submission store was previously referenced only by source.
CREATE TABLE IF NOT EXISTS public.payment_checkout_attempts (
 reference text PRIMARY KEY,
 request jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('started','submitted','unknown')),
 checkout_url text,
 created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT * FROM (VALUES ('reference','text'),('request','jsonb'),('state','text'),('checkout_url','text'),('created_at','timestamptz')) AS required(name,kind) LOOP
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payment_checkout_attempts' AND column_name=c.name AND udt_name=c.kind) THEN
   RAISE EXCEPTION 'Incompatible payment_checkout_attempts column %',c.name;
  END IF;
 END LOOP;
END $$;
ALTER TABLE public.payment_checkout_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_checkout_attempts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.payment_checkout_attempts TO service_role;
CREATE TABLE public.wallet_topup_fee_schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 version text NOT NULL CHECK (btrim(version) <> ''),
 provider text NOT NULL, country_code text NOT NULL, currency_code text NOT NULL,
 method text NOT NULL CHECK (method = 'card'),
 exponent integer NOT NULL CHECK (exponent BETWEEN 0 AND 3),
 fee_basis text NOT NULL CHECK (fee_basis IN ('wallet','total')),
 fee_basis_points integer NOT NULL CHECK (fee_basis_points BETWEEN 0 AND 9999),
 fee_fixed_minor bigint NOT NULL CHECK (fee_fixed_minor BETWEEN 0 AND 9007199254740991),
 fee_cap_minor bigint CHECK (fee_cap_minor BETWEEN 0 AND 9007199254740991),
 rounding text NOT NULL CHECK (rounding IN ('half_up','ceil')),
 approved_by text NOT NULL CHECK (btrim(approved_by) <> ''),
 approved_at timestamptz NOT NULL,
 active boolean NOT NULL DEFAULT false,
 UNIQUE(provider,country_code,currency_code,method,version)
);
CREATE UNIQUE INDEX wallet_topup_fee_schedules_active ON public.wallet_topup_fee_schedules(provider,country_code,currency_code,method) WHERE active;
CREATE FUNCTION public.wallet_fee_schedule_terms_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'active') IS DISTINCT FROM (to_jsonb(OLD)-'active') THEN
 RAISE EXCEPTION 'Create a new approved fee schedule version instead of editing terms' USING ERRCODE='BP007'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wallet_fee_schedule_terms_immutable BEFORE UPDATE ON public.wallet_topup_fee_schedules FOR EACH ROW EXECUTE FUNCTION public.wallet_fee_schedule_terms_immutable();
REVOKE ALL ON public.wallet_topup_fee_schedules FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.wallet_topup_fee_schedules TO service_role;
ALTER TABLE public.wallet_topup_attempts ADD COLUMN fee_schedule_id uuid REFERENCES public.wallet_topup_fee_schedules(id);

CREATE FUNCTION public.wallet_scheduled_fee(p_amount numeric, p_rate integer, p_fixed bigint, p_cap bigint, p_rounding text)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT least(CASE WHEN p_rounding='ceil' THEN ceil(p_amount*p_rate/10000+p_fixed)
 ELSE round(p_amount*p_rate/10000+p_fixed) END, coalesce(p_cap::numeric, 9007199254740992::numeric))
$$;
-- Keep the old freeze for historical callers; new driver attempts require v2.
ALTER FUNCTION public.freeze_wallet_topup_fee(uuid,text) RENAME TO freeze_wallet_topup_fee_v1;
CREATE FUNCTION public.freeze_wallet_topup_fee(p_attempt_id uuid,p_fee_policy_version text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE; p public.wallet_topup_fee_schedules%ROWTYPE;
 lo numeric; hi numeric; mid numeric; total numeric; fee numeric;
BEGIN
 SELECT * INTO a FROM public.wallet_topup_attempts WHERE id=p_attempt_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'attempt missing' USING ERRCODE='BP003'; END IF;
 IF a.fee_policy_version IS NOT NULL THEN
   IF a.fee_policy_version IS DISTINCT FROM p_fee_policy_version THEN RAISE EXCEPTION 'conflicting policy' USING ERRCODE='BP002'; END IF;
   RETURN;
 END IF;
 SELECT * INTO p FROM public.wallet_topup_fee_schedules WHERE active AND provider=a.payment_provider
 AND country_code=a.country_code AND currency_code=a.currency_code AND method='card' AND version=p_fee_policy_version FOR SHARE;
 IF NOT FOUND THEN
   IF a.attempt_key LIKE 'driver-topup:%' THEN RAISE EXCEPTION 'approved schedule missing' USING ERRCODE='BP008'; END IF;
   PERFORM public.freeze_wallet_topup_fee_v1(p_attempt_id,p_fee_policy_version); RETURN;
 END IF;
 IF a.status <> 'initiated' OR p.exponent IS DISTINCT FROM public.wallet_currency_minor_exponent(a.currency_code)
 OR a.amount_minor > 9007199254740991 THEN RAISE EXCEPTION 'invalid fee terms' USING ERRCODE='BP008'; END IF;
 IF p.fee_basis='wallet' THEN
   total := a.amount_minor + public.wallet_scheduled_fee(a.amount_minor,p.fee_basis_points,p.fee_fixed_minor,p.fee_cap_minor,p.rounding);
 ELSE
   lo:=a.amount_minor; hi:=9007199254740991;
   IF hi-public.wallet_scheduled_fee(hi,p.fee_basis_points,p.fee_fixed_minor,p.fee_cap_minor,p.rounding)<lo THEN
     RAISE EXCEPTION 'total overflow' USING ERRCODE='BP008';
   END IF;
   WHILE lo<hi LOOP
     mid:=floor((lo+hi)/2);
     IF mid-public.wallet_scheduled_fee(mid,p.fee_basis_points,p.fee_fixed_minor,p.fee_cap_minor,p.rounding)>=a.amount_minor THEN hi:=mid; ELSE lo:=mid+1; END IF;
   END LOOP;
   total:=lo;
 END IF;
 IF total>9007199254740991 THEN RAISE EXCEPTION 'total overflow' USING ERRCODE='BP008'; END IF;
 UPDATE public.wallet_topup_attempts SET provider_fee_minor=total-a.amount_minor,total_charge_minor=total,
 fee_policy_version=p.version,fee_exponent=p.exponent,fee_schedule_id=p.id WHERE id=a.id;
END $$;
REVOKE ALL ON FUNCTION public.freeze_wallet_topup_fee(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.freeze_wallet_topup_fee(uuid,text) TO service_role;
-- The legacy helper cannot bypass the driver schedule requirement.
REVOKE ALL ON FUNCTION public.freeze_wallet_topup_fee_v1(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.wallet_fee_schedule_freeze() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.fee_schedule_id IS DISTINCT FROM OLD.fee_schedule_id AND OLD.fee_policy_version IS NOT NULL THEN
 RAISE EXCEPTION 'immutable fee identity' USING ERRCODE='BP007'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wallet_fee_schedule_freeze BEFORE UPDATE ON public.wallet_topup_attempts FOR EACH ROW EXECUTE FUNCTION public.wallet_fee_schedule_freeze();

-- Source: 20261254500000_driver_card_five_percent_policy.sql
-- Shared CARD fee approval, 2026-10-27. No market/provider/driver is activated.
CREATE TABLE public.driver_card_fee_policy_versions (
 version text PRIMARY KEY, basis text NOT NULL CHECK(basis='wallet'),
 basis_points integer NOT NULL CHECK(basis_points=500),
 fixed_minor bigint NOT NULL CHECK(fixed_minor=0),
 rounding text NOT NULL CHECK(rounding='half_up'),
 method text NOT NULL CHECK(method='card'), approval_reference text NOT NULL
);
INSERT INTO public.driver_card_fee_policy_versions VALUES
 ('vaydu-driver-card-5pct-wallet-v1','wallet',500,0,'half_up','card','user approval 2026-10-27; sandbox checks required per provider/market');
REVOKE ALL ON public.driver_card_fee_policy_versions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.driver_card_fee_policy_versions TO service_role;

CREATE TABLE public.driver_card_topup_sandbox_scopes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 provider text NOT NULL, method text NOT NULL CHECK(method='card'),
 country_code text NOT NULL CHECK(country_code ~ '^[A-Z]{2}$'),
 currency_code text NOT NULL CHECK(currency_code ~ '^[A-Z]{3}$'),
 merchant_account_ref text NOT NULL CHECK(btrim(merchant_account_ref)<>''),
 provider_account_id text NOT NULL CHECK(btrim(provider_account_id)<>''),
 tenant_id uuid NOT NULL, driver_id uuid NOT NULL,
 fee_passing_mode text NOT NULL CHECK(fee_passing_mode='merchant'),
 reviewed_by text NOT NULL CHECK(btrim(reviewed_by)<>''),
 reviewed_at timestamptz NOT NULL,
 evidence_reference text NOT NULL CHECK(btrim(evidence_reference)<>''),
 policy_version text NOT NULL REFERENCES public.driver_card_fee_policy_versions(version),
 enabled boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX driver_card_topup_scope_active ON public.driver_card_topup_sandbox_scopes(provider,country_code,currency_code,tenant_id,driver_id) WHERE enabled;
CREATE FUNCTION public.driver_card_scope_freeze() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-'enabled') IS DISTINCT FROM (to_jsonb(OLD)-'enabled') THEN RAISE EXCEPTION 'Create a new sandbox review' USING ERRCODE='BP007'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER driver_card_scope_immutable BEFORE UPDATE ON public.driver_card_topup_sandbox_scopes FOR EACH ROW EXECUTE FUNCTION public.driver_card_scope_freeze();
ALTER TABLE public.driver_card_topup_sandbox_scopes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_card_topup_sandbox_scopes FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.driver_card_topup_sandbox_scopes TO service_role;
-- A separate gate prevents the driver sandbox from enabling existing customer
-- wallet collection. No gate row is inserted here; absent means disabled.
CREATE FUNCTION public.driver_card_sandbox_enabled() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT (current_database()='movabi_develop' OR current_database() LIKE '%\_batch2a\_test' ESCAPE '\')
 AND coalesce((SELECT value='true' FROM public.wallet_collection_config WHERE key='driver_card_sandbox_enabled'),false)
$$;
CREATE FUNCTION public.driver_card_sandbox_permit(p_tenant uuid,p_owner uuid,p_country text,p_currency text,p_purpose text,p_provider text,p_merchant text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.driver_card_sandbox_enabled() AND p_purpose='driver_cash_credit' AND EXISTS(
 SELECT 1 FROM public.driver_card_topup_sandbox_scopes s WHERE s.enabled AND s.method='card' AND s.provider=p_provider
 AND s.tenant_id=p_tenant AND s.driver_id=p_owner AND s.country_code=p_country AND s.currency_code=p_currency AND s.merchant_account_ref=p_merchant
 AND s.policy_version='vaydu-driver-card-5pct-wallet-v1')
$$;
CREATE FUNCTION public.driver_card_sandbox_attempt_permit(p_attempt uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT public.driver_card_sandbox_permit(a.tenant_id,a.owner_id,a.country_code,a.currency_code,a.destination_account_purpose,a.payment_provider,a.merchant_account_ref)
 FROM public.wallet_topup_attempts a WHERE a.id=p_attempt),false)
$$;
REVOKE ALL ON FUNCTION public.driver_card_sandbox_enabled(),public.driver_card_sandbox_permit(uuid,uuid,text,text,text,text,text),public.driver_card_sandbox_attempt_permit(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.driver_card_sandbox_enabled() TO service_role;
-- Narrowly extend the existing, inspected functions; preserve their remaining
-- validation, provider routing, limits, idempotency and legacy behavior exactly.
DO $patch$
DECLARE definition text; old_gate text:='IF NOT public.wallet_collection_enabled() THEN';
BEGIN
 definition:=pg_get_functiondef('public.initiate_wallet_topup(text,uuid,uuid,text,text,bigint,text,text,text,text)'::regprocedure);
 IF (length(definition)-length(replace(definition,old_gate,'')))/length(old_gate)<>1 THEN RAISE EXCEPTION 'Unexpected initiation gate definition'; END IF;
 EXECUTE replace(definition,old_gate,'IF NOT public.wallet_collection_enabled() AND NOT public.driver_card_sandbox_permit(p_tenant_id,p_owner_id,p_country_code,p_currency_code,p_destination_account_purpose,p_payment_provider,p_merchant_account_ref) THEN');
 definition:=pg_get_functiondef('public.claim_wallet_topup_submission(uuid)'::regprocedure);
 IF (length(definition)-length(replace(definition,old_gate,'')))/length(old_gate)<>1 THEN RAISE EXCEPTION 'Unexpected submission gate definition'; END IF;
 EXECUTE replace(definition,old_gate,'IF NOT public.wallet_collection_enabled() AND NOT public.driver_card_sandbox_attempt_permit(p_attempt_id) THEN');
END $patch$;
ALTER TABLE public.wallet_topup_attempts
 ADD COLUMN card_sandbox_scope_id uuid REFERENCES public.driver_card_topup_sandbox_scopes(id),
 ADD COLUMN provider_account_id text;
ALTER TABLE public.payment_checkout_attempts ADD COLUMN provider_session_id text;
COMMENT ON COLUMN public.wallet_topup_attempts.provider_fee_minor IS 'Historical fee field; for vaydu-driver-card-5pct-wallet-v1 this is the Vaydu fee, not the provider settlement cost';

ALTER FUNCTION public.freeze_wallet_topup_fee(uuid,text) RENAME TO freeze_wallet_topup_fee_v2;
CREATE FUNCTION public.freeze_wallet_topup_fee(p_attempt_id uuid,p_fee_policy_version text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE; s public.driver_card_topup_sandbox_scopes%ROWTYPE; p public.wallet_topup_fee_schedules%ROWTYPE;
BEGIN
 SELECT * INTO a FROM public.wallet_topup_attempts WHERE id=p_attempt_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Attempt missing' USING ERRCODE='BP003'; END IF;
 IF a.destination_account_purpose='driver_cash_credit' AND a.fee_policy_version IS NULL THEN
  IF NOT public.driver_card_sandbox_enabled() THEN RAISE EXCEPTION 'Driver sandbox disabled' USING ERRCODE='BP008'; END IF;
  IF p_fee_policy_version IS DISTINCT FROM 'vaydu-driver-card-5pct-wallet-v1' THEN RAISE EXCEPTION 'Approved card policy required' USING ERRCODE='BP008'; END IF;
  SELECT * INTO STRICT s FROM public.driver_card_topup_sandbox_scopes WHERE enabled AND method='card'
   AND provider=a.payment_provider AND country_code=a.country_code AND currency_code=a.currency_code
   AND merchant_account_ref=a.merchant_account_ref AND tenant_id=a.tenant_id AND driver_id=a.owner_id
   AND policy_version=p_fee_policy_version FOR SHARE;
  SELECT * INTO STRICT p FROM public.wallet_topup_fee_schedules WHERE active AND provider=a.payment_provider AND country_code=a.country_code AND currency_code=a.currency_code AND method='card' AND version=p_fee_policy_version FOR SHARE;
  IF p.fee_basis<>'wallet' OR p.fee_basis_points<>500 OR p.fee_fixed_minor<>0 OR p.fee_cap_minor IS NOT NULL OR p.rounding<>'half_up' THEN RAISE EXCEPTION 'Unapproved fee terms' USING ERRCODE='BP008'; END IF;
  PERFORM public.freeze_wallet_topup_fee_v2(p_attempt_id,p_fee_policy_version);
  UPDATE public.wallet_topup_attempts SET card_sandbox_scope_id=s.id,provider_account_id=s.provider_account_id WHERE id=a.id;
 ELSE
  PERFORM public.freeze_wallet_topup_fee_v2(p_attempt_id,p_fee_policy_version);
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.freeze_wallet_topup_fee_v2(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.freeze_wallet_topup_fee(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.freeze_wallet_topup_fee(uuid,text) TO service_role;
CREATE FUNCTION public.driver_card_attempt_scope_freeze() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.provider_account_id IS NOT NULL AND (NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id OR NEW.card_sandbox_scope_id IS DISTINCT FROM OLD.card_sandbox_scope_id) THEN
 RAISE EXCEPTION 'Provider review identity is frozen' USING ERRCODE='BP007'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER driver_card_attempt_scope_freeze BEFORE UPDATE ON public.wallet_topup_attempts FOR EACH ROW EXECUTE FUNCTION public.driver_card_attempt_scope_freeze();

CREATE TABLE public.wallet_topup_provider_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),attempt_id uuid NOT NULL REFERENCES public.wallet_topup_attempts(id),
 evidence jsonb NOT NULL, evidence_hash text NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(attempt_id,evidence_hash)
);
ALTER TABLE public.wallet_topup_provider_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wallet_topup_provider_observations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.wallet_topup_provider_observations TO service_role;
CREATE FUNCTION public.record_driver_topup_provider_observation(p_attempt_id uuid,p_evidence jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE; k text;
BEGIN
 SELECT * INTO STRICT a FROM public.wallet_topup_attempts WHERE id=p_attempt_id;
 IF jsonb_typeof(p_evidence)<>'object' OR octet_length(p_evidence::text)>4096 OR coalesce(p_evidence->>'source','') NOT IN ('server-query','server-fee-query') OR p_evidence->>'provider' IS DISTINCT FROM a.payment_provider THEN RAISE EXCEPTION 'Invalid observation' USING ERRCODE='BP004'; END IF;
 FOR k IN SELECT jsonb_object_keys(p_evidence) LOOP
  IF k<>ALL(ARRAY['source','provider','reference','currency','status','paymentMethod','providerAccountId','amountMajor','chargedAmountMajor','appFeeMajor','merchantFeeMajor','stampDutyFeeMajor','amountSettledMajor','chargedAmountApiMinor','providerFeeApiMinor','settlementNetApiMinor','settlementCurrency','providerBalanceReference']) THEN RAISE EXCEPTION 'Unexpected observation field' USING ERRCODE='BP004'; END IF;
  IF jsonb_typeof(p_evidence->k) NOT IN ('string','null') OR length(p_evidence->>k)>200 THEN RAISE EXCEPTION 'Invalid observation value' USING ERRCODE='BP004'; END IF;
 END LOOP;
 INSERT INTO public.wallet_topup_provider_observations(attempt_id,evidence,evidence_hash)
 VALUES(a.id,p_evidence,encode(sha256(convert_to(p_evidence::text,'UTF8')),'hex')) ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.record_driver_topup_provider_observation(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_driver_topup_provider_observation(uuid,jsonb) TO service_role;

DO $$ BEGIN
 IF public.wallet_collection_enabled() IS DISTINCT FROM false THEN RAISE EXCEPTION 'Collection unexpectedly enabled'; END IF;
 IF EXISTS(SELECT 1 FROM public.market_payment_routes WHERE enabled OR merchant_approved OR adapter_ready OR payout_approved) THEN RAISE EXCEPTION 'Approval unexpectedly enabled'; END IF;
 IF (SELECT count(*) FROM public.payment_checkout_attempts)<>2 THEN RAISE EXCEPTION 'Provider records changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.wallet_topup_fee_schedules) THEN RAISE EXCEPTION 'Unapproved fee schedule created'; END IF;
 IF public.driver_card_sandbox_enabled() IS DISTINCT FROM false THEN RAISE EXCEPTION 'Driver sandbox unexpectedly enabled'; END IF;
END $$;
$driver_card_sql$;
 SELECT md5(jsonb_build_object(
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl::text) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('claim_wallet_topup_submission','confirm_wallet_topup','initiate_wallet_topup','post_wallet_event','record_wallet_topup_provider_reference','wallet_collection_enabled','wallet_currency_minor_exponent','wallet_topup_attempt_freeze','freeze_wallet_topup_fee','freeze_wallet_topup_fee_v1','freeze_wallet_topup_fee_v2','confirm_wallet_topup_with_total','record_driver_topup_provider_observation','wallet_fee_schedule_freeze','driver_card_scope_freeze','driver_card_attempt_scope_freeze','driver_card_sandbox_enabled','driver_card_sandbox_permit','driver_card_sandbox_attempt_permit')),
 'columns',(SELECT jsonb_agg(jsonb_build_array(table_name,column_name,udt_name,is_nullable,column_default) ORDER BY table_name,ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('wallet_topup_attempts','payment_checkout_attempts','wallet_topup_fee_policies','wallet_topup_fee_schedules','driver_card_fee_policy_versions','driver_card_topup_sandbox_scopes','wallet_topup_provider_observations')),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.relname,x.conname,pg_get_constraintdef(x.oid)) ORDER BY c.relname,x.conname) FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('wallet_topup_attempts','payment_checkout_attempts','wallet_topup_fee_policies','wallet_topup_fee_schedules','driver_card_fee_policy_versions','driver_card_topup_sandbox_scopes','wallet_topup_provider_observations')),
 'tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relrowsecurity,c.relacl::text) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('wallet_topup_attempts','payment_checkout_attempts','wallet_topup_fee_policies','wallet_topup_fee_schedules','driver_card_fee_policy_versions','driver_card_topup_sandbox_scopes','wallet_topup_provider_observations')),
 'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public' AND c.relname IN ('wallet_topup_attempts','payment_checkout_attempts','wallet_topup_fee_policies','wallet_topup_fee_schedules','driver_card_fee_policy_versions','driver_card_topup_sandbox_scopes','wallet_topup_provider_observations'))
 )::text) INTO observed_schema_fingerprint;
 INSERT INTO public.vaydu_driver_card_schema_releases(version,source_sha256,catalog_fingerprint) VALUES('driver-card-topup-20261027-v1','746192dd0435bb34724819a1ef94de3b1011fba741c09dd2ba3e9ee6af1a9de8',observed_schema_fingerprint);
 NOTIFY pgrst, 'reload schema';
END $driver_card_reconcile$;
COMMIT;
-- VAYDU_DRIVER_CARD_TOPUP_20261027_END
