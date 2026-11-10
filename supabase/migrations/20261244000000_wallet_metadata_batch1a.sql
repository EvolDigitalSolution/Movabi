-- =============================================================================
-- Batch 1A — Additive wallet ledger metadata (provider-neutral)
--
-- Adds eight NULLABLE metadata columns to public.wallet_transactions and a
-- partial uniqueness index for provider-scoped idempotency. No existing
-- financial behaviour, wallet RPC, historical row, provider restriction, or
-- driver_earnings record is changed. No balance becomes spendable here.
--
-- Column purposes (NULL = unresolved/legacy provenance, see comments):
--   tenant_id            tenant isolation tag (mirrors jobs.tenant_id)
--   currency_code        exact ISO-4217 currency of the entry
--   amount_minor         exact integer minor units (bigint); NULL unless exact
--   balance_purpose      account/purpose dimension (separate from transaction_type)
--   payment_provider     canonical provider id: stripe | kora | fincra
--   merchant_account_ref merchant-account scope from market_payment_routes
--   provider_reference   external provider reference (Stripe PI id / Kora ref)
--   event_key            provider-scoped idempotency key
--
-- Preconditions stop only on demonstrated incompatibility and NEVER modify a
-- pre-existing object: a required column missing with a conflicting type, a new
-- column pre-existing with the wrong type/nullability/default/generation/identity,
-- or an incompatible same-name index. They do not raise on coexistence or on the
-- presence of legacy columns.
-- =============================================================================
BEGIN;

-- Preconditions part 1 + 2: required canonical columns, and new metadata columns.
DO $$
DECLARE
  required text[][]; i integer; col record;
BEGIN
  IF to_regclass('public.wallet_transactions') IS NULL THEN
    RAISE EXCEPTION 'Batch 1A precondition: public.wallet_transactions is missing';
  END IF;

  -- Canonical columns already relied on by the wallet RPCs must exist, exact types.
  required := ARRAY[
    ARRAY['wallet_id','uuid'], ARRAY['user_id','uuid'], ARRAY['job_id','uuid'],
    ARRAY['transaction_type','text'], ARRAY['amount','numeric'], ARRAY['metadata','jsonb'],
    ARRAY['balance_before_available','numeric'], ARRAY['balance_after_available','numeric'],
    ARRAY['balance_before_reserved','numeric'], ARRAY['balance_after_reserved','numeric'],
    ARRAY['stripe_payment_intent_id','text'], ARRAY['payment_intent_id','text'],
    ARRAY['description','text']
  ];
  FOR i IN 1..array_length(required, 1) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'wallet_transactions'
        AND column_name = required[i][1]
        AND udt_name = required[i][2]
    ) THEN
      RAISE EXCEPTION 'Batch 1A precondition: required column public.wallet_transactions.% of type % is missing',
        required[i][1], required[i][2];
    END IF;
  END LOOP;

  -- New columns: if present, must be exact type, nullable, no default, not
  -- generated, not identity. Stop (never modify) on any mismatch.
  FOR col IN
    SELECT column_name, udt_name, is_nullable, column_default, is_generated, is_identity
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'wallet_transactions'
      AND column_name IN (
        'tenant_id','currency_code','amount_minor','balance_purpose',
        'payment_provider','merchant_account_ref','provider_reference','event_key'
      )
  LOOP
    IF (col.column_name = 'tenant_id'            AND col.udt_name <> 'uuid')
    OR (col.column_name = 'currency_code'        AND col.udt_name <> 'text')
    OR (col.column_name = 'amount_minor'         AND col.udt_name <> 'int8')
    OR (col.column_name = 'balance_purpose'      AND col.udt_name <> 'text')
    OR (col.column_name = 'payment_provider'     AND col.udt_name <> 'text')
    OR (col.column_name = 'merchant_account_ref' AND col.udt_name <> 'text')
    OR (col.column_name = 'provider_reference'   AND col.udt_name <> 'text')
    OR (col.column_name = 'event_key'            AND col.udt_name <> 'text')
    THEN
      RAISE EXCEPTION 'Batch 1A precondition: public.wallet_transactions.% has wrong type %', col.column_name, col.udt_name;
    ELSIF col.is_nullable <> 'YES' THEN
      RAISE EXCEPTION 'Batch 1A precondition: public.wallet_transactions.% must be nullable (NOT NULL)', col.column_name;
    ELSIF col.column_default IS NOT NULL THEN
      RAISE EXCEPTION 'Batch 1A precondition: public.wallet_transactions.% must have no default', col.column_name;
    ELSIF col.is_generated <> 'NEVER' THEN
      RAISE EXCEPTION 'Batch 1A precondition: public.wallet_transactions.% must not be generated', col.column_name;
    ELSIF col.is_identity <> 'NO' THEN
      RAISE EXCEPTION 'Batch 1A precondition: public.wallet_transactions.% must not be an identity column', col.column_name;
    END IF;
  END LOOP;
END
$$;

-- Preconditions part 3: validate an existing event_key index via pg_catalog.
-- Exact, catalog-backed validation (not substring matching): rejects expressions,
-- wrong key, wrong table, included columns, non-btree access method, unexpected
-- operator class/collation, invalid indexes, and narrower/wider predicates.
DO $$
DECLARE
  idx record;
BEGIN
  IF to_regclass('public.wallet_transactions_event_key_uniq') IS NOT NULL THEN
    SELECT i.indisunique, i.indisvalid, i.indisready, i.indnkeyatts, i.indnatts,
           (SELECT amname FROM pg_am am WHERE am.oid = ic.relam) AS amname,
           pg_get_expr(i.indpred, i.indrelid) AS predicate,
           (SELECT a.attname
            FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
            WHERE k.ord = 1) AS sole_key,
           (SELECT k.attnum
            FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
            WHERE k.ord = 1) AS sole_attnum,
           (SELECT opc.opcdefault
            FROM unnest(i.indclass::oid[]) WITH ORDINALITY AS k(oid, ord)
            JOIN pg_opclass opc ON opc.oid = k.oid
            WHERE k.ord = 1) AS opc_default,
           (SELECT k.oid
            FROM unnest(i.indcollation::oid[]) WITH ORDINALITY AS k(oid, ord)
            WHERE k.ord = 1) AS idx_collation,
           (SELECT a.attcollation
            FROM pg_attribute a
            WHERE a.attrelid = i.indrelid
              AND a.attnum = (SELECT k2.attnum
                              FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k2(attnum, ord)
                              WHERE k2.ord = 1)) AS col_collation
    INTO idx
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indexrelid = 'public.wallet_transactions_event_key_uniq'::regclass
      AND i.indrelid = 'public.wallet_transactions'::regclass;

    IF idx IS NULL THEN
      RAISE EXCEPTION 'Batch 1A precondition: wallet_transactions_event_key_uniq exists but is not an index on public.wallet_transactions';
    ELSIF NOT idx.indisunique THEN
      RAISE EXCEPTION 'Batch 1A precondition: wallet_transactions_event_key_uniq is not UNIQUE';
    ELSIF NOT idx.indisvalid THEN
      RAISE EXCEPTION 'Batch 1A precondition: wallet_transactions_event_key_uniq is not valid';
    ELSIF NOT idx.indisready THEN
      RAISE EXCEPTION 'Batch 1A precondition: wallet_transactions_event_key_uniq is not ready';
    ELSIF idx.indnkeyatts <> 1 OR idx.indnatts <> 1 THEN
      RAISE EXCEPTION 'Batch 1A precondition: wallet_transactions_event_key_uniq must have exactly one key column and no included columns';
    ELSIF coalesce(idx.amname,'') <> 'btree' THEN
      RAISE EXCEPTION 'Batch 1A precondition: wallet_transactions_event_key_uniq access method is not btree';
    ELSIF idx.sole_attnum IS NULL OR idx.sole_attnum <= 0 THEN
      RAISE EXCEPTION 'Batch 1A precondition: wallet_transactions_event_key_uniq key is an expression, not a plain column';
    ELSIF idx.sole_key IS DISTINCT FROM 'event_key' THEN
      RAISE EXCEPTION 'Batch 1A precondition: wallet_transactions_event_key_uniq key column is not event_key';
    ELSIF idx.predicate IS NULL
          OR lower(regexp_replace(idx.predicate, '[^a-z_]+', '', 'gi')) <> 'event_keyisnotnull' THEN
      RAISE EXCEPTION 'Batch 1A precondition: wallet_transactions_event_key_uniq predicate is not exactly event_key IS NOT NULL';
    ELSIF idx.opc_default IS NOT TRUE THEN
      RAISE EXCEPTION 'Batch 1A precondition: wallet_transactions_event_key_uniq operator class is not the default';
    ELSIF idx.idx_collation IS DISTINCT FROM idx.col_collation THEN
      RAISE EXCEPTION 'Batch 1A precondition: wallet_transactions_event_key_uniq collation differs from the column collation';
    END IF;
  END IF;
END
$$;

ALTER TABLE public.wallet_transactions
  ADD COLUMN IF NOT EXISTS tenant_id            uuid,
  ADD COLUMN IF NOT EXISTS currency_code        text,
  ADD COLUMN IF NOT EXISTS amount_minor         bigint,
  ADD COLUMN IF NOT EXISTS balance_purpose      text,
  ADD COLUMN IF NOT EXISTS payment_provider     text,
  ADD COLUMN IF NOT EXISTS merchant_account_ref text,
  ADD COLUMN IF NOT EXISTS provider_reference   text,
  ADD COLUMN IF NOT EXISTS event_key            text;

CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_event_key_uniq
  ON public.wallet_transactions (event_key)
  WHERE event_key IS NOT NULL;

COMMENT ON COLUMN public.wallet_transactions.tenant_id IS
  'Tenant isolation tag (mirrors jobs.tenant_id). NULL = unresolved/legacy provenance.';
COMMENT ON COLUMN public.wallet_transactions.currency_code IS
  'Exact ISO-4217 currency of the entry. NULL = unresolved/legacy provenance; never inferred.';
COMMENT ON COLUMN public.wallet_transactions.amount_minor IS
  'Exact integer minor units (bigint) = amount * 10^exp(currency_code), exp in {0,2,3}. NULL unless the conversion is exact; never rounded, never inferred.';
COMMENT ON COLUMN public.wallet_transactions.balance_purpose IS
  'Account/purpose dimension (customer_credit, driver_cash_credit, promotional_credit, commission, bonus, compensation, earnings_payable). NULL = unresolved/legacy. No constraint yet; taxonomy finalised in a later batch.';
COMMENT ON COLUMN public.wallet_transactions.payment_provider IS
  'Canonical provider id (stripe | kora | fincra). NULL = unresolved/legacy provenance: this does not by itself prove the entry was an internal-only movement.';
COMMENT ON COLUMN public.wallet_transactions.merchant_account_ref IS
  'Merchant-account scope from market_payment_routes. NULL = unresolved/legacy provenance; not proof of an internal-only movement.';
COMMENT ON COLUMN public.wallet_transactions.provider_reference IS
  'External provider reference (Stripe PaymentIntent id, Kora checkout/transaction reference). NULL = unresolved/legacy provenance.';
COMMENT ON COLUMN public.wallet_transactions.event_key IS
  'Provider-scoped idempotency key. Format and durable, coordinated identities are defined in a later batch (no per-retry sequence). Partial unique index deduplicates non-NULL keys only.';

COMMIT;
