-- =============================================================================
-- Batch 1A — rollback-only schema compatibility check.
--
-- Run AFTER applying supabase/migrations/20261244000000_wallet_metadata_batch1a.sql
-- to a disposable database. This file contains NO COMMIT and NO migration DDL:
-- it only asserts the already-applied schema via hard RAISE assertions and then
-- rolls back. Any failed assertion aborts (ON_ERROR_STOP) and fails the run.
--
--   psql -X -v ON_ERROR_STOP=1 -f scripts/check-wallet-metadata-batch1a.sql
-- =============================================================================
BEGIN;
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  expected text[][]; i integer; constraint_name text; idx record;
BEGIN
  expected := ARRAY[
    ARRAY['tenant_id','uuid'], ARRAY['currency_code','text'], ARRAY['amount_minor','int8'],
    ARRAY['balance_purpose','text'], ARRAY['payment_provider','text'],
    ARRAY['merchant_account_ref','text'], ARRAY['provider_reference','text'], ARRAY['event_key','text']
  ];

  FOR i IN 1..array_length(expected, 1) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'wallet_transactions'
        AND column_name = expected[i][1]
        AND udt_name = expected[i][2]
        AND is_nullable = 'YES'
        AND column_default IS NULL
        AND is_generated = 'NEVER'
        AND is_identity = 'NO'
    ) THEN
      RAISE EXCEPTION 'Batch 1A check failed: column % missing, wrong type, NOT NULL, has default, generated, or identity', expected[i][1];
    END IF;
  END LOOP;

  -- Exact catalog-backed index validation (mirrors the migration preconditions).
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

  IF idx IS NULL
     OR NOT idx.indisunique OR NOT idx.indisvalid OR NOT idx.indisready
     OR idx.indnkeyatts <> 1 OR idx.indnatts <> 1
     OR coalesce(idx.amname,'') <> 'btree'
     OR idx.sole_attnum IS NULL OR idx.sole_attnum <= 0
     OR idx.sole_key IS DISTINCT FROM 'event_key'
     OR idx.predicate IS NULL
     OR lower(regexp_replace(coalesce(idx.predicate,''), '[^a-z_]+', '', 'gi')) <> 'event_keyisnotnull'
     OR idx.opc_default IS NOT TRUE
     OR idx.idx_collation IS DISTINCT FROM idx.col_collation THEN
    RAISE EXCEPTION 'Batch 1A check failed: wallet_transactions_event_key_uniq missing or incompatible';
  END IF;

  -- Existing constraints, scoped to public.wallet_transactions.
  FOREACH constraint_name IN ARRAY ARRAY['chk_wallet_transaction_type','chk_wallet_transaction_amount_non_negative','chk_topup_requires_stripe'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = constraint_name
        AND conrelid = 'public.wallet_transactions'::regclass
    ) THEN
      RAISE EXCEPTION 'Batch 1A check failed: existing constraint % missing on public.wallet_transactions', constraint_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'wallet_transactions'
      AND indexname = 'wallet_one_job_settlement'
  ) THEN
    RAISE EXCEPTION 'Batch 1A check failed: wallet_one_job_settlement index missing on public.wallet_transactions';
  END IF;

  RAISE NOTICE 'Batch 1A schema check passed: eight nullable metadata columns, partial unique index, existing constraints preserved';
END
$$;

ROLLBACK;
