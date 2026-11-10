-- =============================================================================
-- Batch 1A — hard assertions (RAISE on failure). Run AFTER the migration has
-- been applied by the runner. Any failed assertion aborts psql (ON_ERROR_STOP)
-- and therefore fails the runner.
-- =============================================================================
\set ON_ERROR_STOP on

-- 1a. Eight metadata columns: exact type, nullable, no default, not generated, not identity.
DO $$
DECLARE expected text[][]; i integer;
BEGIN
  expected := ARRAY[
    ARRAY['tenant_id','uuid'], ARRAY['currency_code','text'], ARRAY['amount_minor','int8'],
    ARRAY['balance_purpose','text'], ARRAY['payment_provider','text'],
    ARRAY['merchant_account_ref','text'], ARRAY['provider_reference','text'], ARRAY['event_key','text']
  ];
  FOR i IN 1..array_length(expected, 1) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='wallet_transactions'
        AND column_name=expected[i][1] AND udt_name=expected[i][2]
        AND is_nullable='YES' AND column_default IS NULL
        AND is_generated='NEVER' AND is_identity='NO'
    ) THEN
      RAISE EXCEPTION 'ASSERT FAIL: column % wrong type/nullable/default/generated/identity', expected[i][1];
    END IF;
  END LOOP;
END $$;

-- 1b. Exact catalog-backed index validation.
DO $$
DECLARE idx record;
BEGIN
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
  WHERE i.indexrelid='public.wallet_transactions_event_key_uniq'::regclass
    AND i.indrelid='public.wallet_transactions'::regclass;
  IF idx IS NULL
     OR NOT idx.indisunique OR NOT idx.indisvalid OR NOT idx.indisready
     OR idx.indnkeyatts<>1 OR idx.indnatts<>1
     OR coalesce(idx.amname,'')<>'btree'
     OR idx.sole_attnum IS NULL OR idx.sole_attnum<=0
     OR idx.sole_key IS DISTINCT FROM 'event_key'
     OR idx.predicate IS NULL
     OR lower(regexp_replace(coalesce(idx.predicate,''),'[^a-z_]+','','gi'))<>'event_keyisnotnull'
     OR idx.opc_default IS NOT TRUE
     OR idx.idx_collation IS DISTINCT FROM idx.col_collation THEN
    RAISE EXCEPTION 'ASSERT FAIL: event_key index incompatible';
  END IF;
END $$;

-- 11. Preservation: constraints/policies/grants/RPC definitions unchanged.
DO $$
DECLARE diff integer;
BEGIN
  SELECT count(*) INTO diff FROM (
    (SELECT 'constraint' AS kind, conname AS name, pg_get_constraintdef(oid) AS def
     FROM pg_constraint WHERE conrelid='public.wallet_transactions'::regclass
     UNION ALL
     SELECT 'policy_wt', policyname, cmd||'|'||array_to_string(roles,',')||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'')
     FROM pg_policies WHERE schemaname='public' AND tablename='wallet_transactions'
     UNION ALL
     SELECT 'policy_wallets', policyname, cmd||'|'||array_to_string(roles,',')||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'')
     FROM pg_policies WHERE schemaname='public' AND tablename='wallets'
     UNION ALL
     SELECT 'table_grant', table_name||'.'||privilege_type, grantee
     FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name IN ('wallet_transactions','wallets')
     UNION ALL
     SELECT 'fn', p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid))
     FROM pg_proc p WHERE p.proname IN ('release_job_wallet_reservation','settle_job_wallet_reservation')
     UNION ALL
     SELECT 'fn_grant', p.oid::regprocedure::text, coalesce(p.proacl::text,'PUBLIC-DEFAULT')
     FROM pg_proc p WHERE p.proname IN ('release_job_wallet_reservation','settle_job_wallet_reservation'))
    EXCEPT
    (SELECT kind, name, def FROM batch1a_snapshot_before)
  ) q;
  IF diff > 0 THEN RAISE EXCEPTION 'ASSERT FAIL: % catalog objects changed after migration', diff; END IF;

  SELECT count(*) INTO diff FROM (
    (SELECT kind, name, def FROM batch1a_snapshot_before)
    EXCEPT
    (SELECT 'constraint' AS kind, conname AS name, pg_get_constraintdef(oid) AS def
     FROM pg_constraint WHERE conrelid='public.wallet_transactions'::regclass
     UNION ALL
     SELECT 'policy_wt', policyname, cmd||'|'||array_to_string(roles,',')||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'')
     FROM pg_policies WHERE schemaname='public' AND tablename='wallet_transactions'
     UNION ALL
     SELECT 'policy_wallets', policyname, cmd||'|'||array_to_string(roles,',')||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'')
     FROM pg_policies WHERE schemaname='public' AND tablename='wallets'
     UNION ALL
     SELECT 'table_grant', table_name||'.'||privilege_type, grantee
     FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name IN ('wallet_transactions','wallets')
     UNION ALL
     SELECT 'fn', p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid))
     FROM pg_proc p WHERE p.proname IN ('release_job_wallet_reservation','settle_job_wallet_reservation')
     UNION ALL
     SELECT 'fn_grant', p.oid::regprocedure::text, coalesce(p.proacl::text,'PUBLIC-DEFAULT')
     FROM pg_proc p WHERE p.proname IN ('release_job_wallet_reservation','settle_job_wallet_reservation'))
  ) q;
  IF diff > 0 THEN RAISE EXCEPTION 'ASSERT FAIL: % catalog objects removed after migration', diff; END IF;
END $$;

-- 7. Legacy-shaped insert retains NULL metadata.
TRUNCATE public.wallet_transactions;
INSERT INTO public.wallets (id, user_id, available_balance, reserved_balance)
VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',0,0)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.wallet_transactions (wallet_id,user_id,job_id,transaction_type,amount,description,metadata,
  balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'adjustment',1,'legacy','{}',0,0,0,0);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.wallet_transactions
    WHERE transaction_type='adjustment'
      AND tenant_id IS NULL AND currency_code IS NULL AND amount_minor IS NULL
      AND balance_purpose IS NULL AND payment_provider IS NULL
      AND merchant_account_ref IS NULL AND provider_reference IS NULL AND event_key IS NULL
  ) THEN RAISE EXCEPTION 'ASSERT FAIL: legacy insert did not retain NULL metadata'; END IF;
END $$;

-- 8. Multiple NULL event keys succeed.
INSERT INTO public.wallet_transactions (wallet_id,user_id,job_id,transaction_type,amount,event_key)
VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'adjustment',1,NULL),
       ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'adjustment',1,NULL);
DO $$
BEGIN
  IF (SELECT count(*) FROM public.wallet_transactions WHERE event_key IS NULL) < 2 THEN
    RAISE EXCEPTION 'ASSERT FAIL: multiple NULL event_key rows not permitted';
  END IF;
END $$;

-- 9. Duplicate non-NULL event keys must be rejected (unique_violation).
DO $$
BEGIN
  BEGIN
    INSERT INTO public.wallet_transactions (wallet_id,user_id,job_id,transaction_type,amount,event_key)
    VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'adjustment',1,'stripe:x:topup:pi_1'),
           ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'adjustment',1,'stripe:x:topup:pi_1');
    RAISE EXCEPTION 'ASSERT FAIL: duplicate non-NULL event_key was not rejected';
  EXCEPTION WHEN unique_violation THEN
    NULL; -- expected
  END;
END $$;

-- 10. Release and settle RPC movements unchanged.
TRUNCATE public.wallet_transactions;
DELETE FROM public.jobs; DELETE FROM public.errand_funding; DELETE FROM public.errand_details;

INSERT INTO public.jobs (id, customer_id, status, payment_method, payment_status)
VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1','cancelled','wallet','wallet_funded');
INSERT INTO public.errand_funding (job_id, status, amount_reserved) VALUES ('00000000-0000-0000-0000-0000000000c1','reserved',50);
UPDATE public.wallets SET available_balance=0, reserved_balance=50;
INSERT INTO public.wallet_transactions (wallet_id,user_id,job_id,transaction_type,amount,metadata,
  balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
        'reservation',50,jsonb_build_object('service_fare',50),0,0,0,50);
SELECT public.release_job_wallet_reservation('00000000-0000-0000-0000-0000000000c1','test release');
DO $$
BEGIN
  IF NOT (
    (SELECT available_balance FROM public.wallets WHERE id='00000000-0000-0000-0000-0000000000a1') = 50
    AND (SELECT reserved_balance FROM public.wallets WHERE id='00000000-0000-0000-0000-0000000000a1') = 0
    AND (SELECT count(*) FROM public.wallet_transactions WHERE transaction_type='release') = 1
  ) THEN RAISE EXCEPTION 'ASSERT FAIL: release movement diverged'; END IF;
END $$;

TRUNCATE public.wallet_transactions;
DELETE FROM public.jobs; DELETE FROM public.errand_funding; DELETE FROM public.errand_details;
INSERT INTO public.jobs (id, customer_id, status, payment_method, payment_status)
VALUES ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000b1','accepted','wallet','wallet_funded');
INSERT INTO public.errand_funding (job_id, status, amount_reserved) VALUES ('00000000-0000-0000-0000-0000000000c2','reserved',50);
INSERT INTO public.errand_details (job_id, actual_spending) VALUES ('00000000-0000-0000-0000-0000000000c2',5);
UPDATE public.wallets SET available_balance=0, reserved_balance=50;
INSERT INTO public.wallet_transactions (wallet_id,user_id,job_id,transaction_type,amount,metadata,
  balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c2',
        'reservation',50,jsonb_build_object('service_fare',40),0,0,0,50);
SELECT public.settle_job_wallet_reservation('00000000-0000-0000-0000-0000000000c2',40);
DO $$
BEGIN
  IF NOT (
    (SELECT available_balance FROM public.wallets WHERE id='00000000-0000-0000-0000-0000000000a1') = 5
    AND (SELECT reserved_balance FROM public.wallets WHERE id='00000000-0000-0000-0000-0000000000a1') = 0
    AND (SELECT count(*) FROM public.wallet_transactions WHERE transaction_type='settlement') = 1
    AND (SELECT count(*) FROM public.wallet_transactions WHERE transaction_type='release' AND amount=5) = 1
  ) THEN RAISE EXCEPTION 'ASSERT FAIL: settle movement diverged'; END IF;
END $$;

\echo 'Batch 1A assertions passed'
