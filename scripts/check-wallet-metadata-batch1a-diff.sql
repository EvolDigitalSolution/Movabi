-- =============================================================================
-- Batch 1A — schema-diff helper (run AFTER a negative migration attempt).
-- Compares the current public.wallet_transactions columns/indexes against the
-- batch1a_pre_negative snapshot and RAISEs on any leak or removal.
-- =============================================================================
\set ON_ERROR_STOP on
DO $$
DECLARE diff integer;
BEGIN
  SELECT count(*) INTO diff FROM (
    (SELECT 'col' AS kind, column_name AS name,
            udt_name||'|'||is_nullable||'|'||coalesce(column_default,'') AS def
     FROM information_schema.columns WHERE table_schema='public' AND table_name='wallet_transactions'
     UNION ALL
     SELECT 'idx', indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='wallet_transactions')
    EXCEPT
    (SELECT kind, name, def FROM batch1a_pre_negative)
  ) q;
  IF diff > 0 THEN RAISE EXCEPTION 'Batch 1A leak: % schema object(s) added', diff; END IF;

  SELECT count(*) INTO diff FROM (
    (SELECT kind, name, def FROM batch1a_pre_negative)
    EXCEPT
    (SELECT 'col' AS kind, column_name AS name,
            udt_name||'|'||is_nullable||'|'||coalesce(column_default,'') AS def
     FROM information_schema.columns WHERE table_schema='public' AND table_name='wallet_transactions'
     UNION ALL
     SELECT 'idx', indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='wallet_transactions')
  ) q;
  IF diff > 0 THEN RAISE EXCEPTION 'Batch 1A removal: % schema object(s) changed or removed', diff; END IF;
END
$$;
