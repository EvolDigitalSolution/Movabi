-- =============================================================================
-- Batch 1A — synthetic fixture for the disposable-database runner.
--
-- Creates a clean, disposable fixture (tables, constraints, indexes, RLS
-- policies, grants, and the release/settle RPCs) plus a pre-migration catalog
-- snapshot. Representative policies/grants are included so preservation
-- assertions are not vacuous. Synthetic only — no customer financial records.
--
-- Run ONLY via scripts/run-wallet-metadata-batch1a-db.sh (which guards the
-- database name). Do NOT run against an application database.
-- =============================================================================
\set ON_ERROR_STOP on

DROP TABLE IF EXISTS public.errand_details, public.errand_funding, public.jobs, public.wallets, public.wallet_transactions CASCADE;
DROP TABLE IF EXISTS batch1a_snapshot_before;
DROP FUNCTION IF EXISTS public.release_job_wallet_reservation(uuid, text);
DROP FUNCTION IF EXISTS public.settle_job_wallet_reservation(uuid, numeric);

-- Minimal auth.uid() stub so RLS policies are representative without Supabase.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

-- NOLOGIN roles referenced by policies/grants. Disposable database only — never
-- create or alter roles in an application cluster.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;

CREATE TABLE public.jobs (
  id uuid PRIMARY KEY, customer_id uuid, status text,
  payment_method text, payment_status text, updated_at timestamptz
);
CREATE TABLE public.wallets (
  id uuid PRIMARY KEY, user_id uuid UNIQUE NOT NULL,
  available_balance numeric NOT NULL DEFAULT 0, reserved_balance numeric NOT NULL DEFAULT 0,
  updated_at timestamptz
);
CREATE TABLE public.errand_funding (
  job_id uuid, status text, amount_reserved numeric, metadata jsonb, updated_at timestamptz,
  actual_item_spend numeric, refund_amount numeric
);
CREATE TABLE public.errand_details (
  job_id uuid, actual_spending numeric
);
CREATE TABLE public.wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid, user_id uuid, job_id uuid,
  transaction_type text NOT NULL, amount numeric NOT NULL,
  description text, metadata jsonb,
  balance_before_available numeric, balance_after_available numeric,
  balance_before_reserved numeric, balance_after_reserved numeric,
  stripe_payment_intent_id text, payment_intent_id text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.wallet_transactions ADD CONSTRAINT chk_wallet_transaction_type
  CHECK (transaction_type IN ('topup','reservation','release','settlement','refund','adjustment'));
ALTER TABLE public.wallet_transactions ADD CONSTRAINT chk_wallet_transaction_amount_non_negative
  CHECK (amount >= 0);
ALTER TABLE public.wallet_transactions ADD CONSTRAINT chk_topup_requires_stripe
  CHECK (transaction_type <> 'topup' OR stripe_payment_intent_id IS NOT NULL);
CREATE UNIQUE INDEX wallet_one_job_settlement ON public.wallet_transactions (job_id, user_id)
  WHERE transaction_type = 'settlement' AND job_id IS NOT NULL;
CREATE UNIQUE INDEX unique_payment_intent ON public.wallet_transactions (payment_intent_id);

-- Representative RLS policies + grants (so preservation is not vacuous).
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY wallet_tx_select_own ON public.wallet_transactions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
GRANT SELECT ON public.wallet_transactions TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.wallet_transactions FROM authenticated;

ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY wallets_select_own ON public.wallets
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
GRANT SELECT ON public.wallets TO authenticated;

-- Canonical wallet RPC bodies (release + settle) verbatim from 20261241700000.
CREATE OR REPLACE FUNCTION public.release_job_wallet_reservation(p_job_id uuid,p_reason text DEFAULT 'Wallet reservation released')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; w public.wallets%ROWTYPE; f public.errand_funding%ROWTYPE; net numeric; reserved_count integer;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF j.payment_method IS DISTINCT FROM 'wallet' AND j.payment_status IS DISTINCT FROM 'wallet_funded' THEN RETURN jsonb_build_object('released',false,'reason','Job is not wallet-funded'); END IF;
 IF j.status NOT IN ('cancelled','canceled','expired','failed','no_driver_found') THEN RAISE EXCEPTION 'Wallet release requires a terminal cancelled booking'; END IF;
 IF j.payment_status IN ('paid','captured','succeeded') THEN RAISE EXCEPTION 'Captured funds require refund review'; END IF;
 SELECT * INTO STRICT w FROM public.wallets WHERE user_id=j.customer_id FOR UPDATE;
 SELECT * INTO f FROM public.errand_funding WHERE job_id=j.id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id AND transaction_type='settlement') OR f.status='settled' THEN
  RAISE EXCEPTION 'Settled reservation cannot be released as cancellation';
 END IF;
 SELECT coalesce(sum(CASE WHEN transaction_type='reservation' THEN amount WHEN transaction_type='release' THEN -amount ELSE 0 END),0),count(*) FILTER(WHERE transaction_type='reservation')
 INTO net,reserved_count FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id;
 IF reserved_count=0 AND f.status IN ('reserved','approved','over_budget_requested') THEN net:=f.amount_reserved; END IF;
 IF net<0 THEN RAISE EXCEPTION 'Wallet ledger requires reconciliation'; END IF;
 IF net=0 THEN
  UPDATE public.jobs SET payment_status='cancelled',updated_at=now() WHERE id=j.id;
  RETURN jsonb_build_object('released',false,'reason','No active wallet reservation');
 END IF;
 IF w.reserved_balance<net THEN RAISE EXCEPTION 'Reserved balance is inconsistent with this booking'; END IF;
 UPDATE public.wallets SET available_balance=w.available_balance+net,reserved_balance=w.reserved_balance-net,updated_at=now() WHERE id=w.id;
 INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,description,metadata,
  balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
 VALUES(w.id,j.customer_id,j.id,'release',net,p_reason,jsonb_build_object('payment_method','wallet','legacy_funding',reserved_count=0),
  w.available_balance,w.available_balance+net,w.reserved_balance,w.reserved_balance-net);
 UPDATE public.errand_funding SET status='cancelled',metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('released_amount',net,'release_reason',p_reason),updated_at=now()
 WHERE job_id=j.id AND status IN ('reserved','approved','over_budget_requested');
 UPDATE public.jobs SET payment_status='cancelled',updated_at=now() WHERE id=j.id;
 RETURN jsonb_build_object('released',true,'amount',net,'job_id',j.id);
END $$;

CREATE OR REPLACE FUNCTION public.settle_job_wallet_reservation(p_job_id uuid,p_amount numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.jobs%ROWTYPE; w public.wallets%ROWTYPE; f public.errand_funding%ROWTYPE;
 net numeric; fare numeric; spend numeric:=0; budget numeric:=0; charge numeric; refund numeric; prior public.wallet_transactions%ROWTYPE; reserved_count integer;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 IF j.status IN ('cancelled','canceled','expired','failed','no_driver_found') THEN RAISE EXCEPTION 'Cancelled booking cannot settle'; END IF;
 IF j.payment_method IS DISTINCT FROM 'wallet' AND j.payment_status IS DISTINCT FROM 'wallet_funded' THEN RAISE EXCEPTION 'Not a wallet booking'; END IF;
 SELECT * INTO prior FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id AND transaction_type='settlement';
 IF FOUND THEN RETURN jsonb_build_object('status','already_settled','job_id',j.id,'amount_settled',prior.amount); END IF;
 SELECT * INTO STRICT w FROM public.wallets WHERE user_id=j.customer_id FOR UPDATE;
 SELECT * INTO f FROM public.errand_funding WHERE job_id=j.id FOR UPDATE;
 IF f.status='settled' THEN RETURN jsonb_build_object('status','already_settled','job_id',j.id); END IF;
 SELECT coalesce(sum(CASE WHEN transaction_type='reservation' THEN amount WHEN transaction_type IN ('release','settlement') THEN -amount ELSE 0 END),0),count(*) FILTER(WHERE transaction_type='reservation')
 INTO net,reserved_count FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id;
 IF reserved_count=0 AND f.status IN ('reserved','approved','over_budget_requested') THEN net:=f.amount_reserved; END IF;
 IF net<=0 OR w.reserved_balance<net THEN RAISE EXCEPTION 'Wallet reservation is missing or inconsistent'; END IF;
 SELECT (metadata->>'service_fare')::numeric INTO fare FROM public.wallet_transactions WHERE job_id=j.id AND user_id=j.customer_id AND transaction_type='reservation' AND metadata ? 'service_fare' ORDER BY created_at,id LIMIT 1;
 fare:=coalesce(fare,round(p_amount,2));
 IF fare IS NULL OR fare<=0 OR fare IS DISTINCT FROM round(p_amount,2) OR fare>net THEN RAISE EXCEPTION 'Wallet settlement fare mismatch'; END IF;
 budget:=net-fare;
 SELECT coalesce(actual_spending,0) INTO spend FROM public.errand_details WHERE job_id=j.id FOR UPDATE;
 spend:=round(coalesce(spend,0),2);
 IF spend<0 OR spend>budget THEN RAISE EXCEPTION 'Shopping spend exceeds the funded budget; review required'; END IF;
 charge:=fare+spend; refund:=net-charge;
 UPDATE public.wallets SET available_balance=w.available_balance+refund,reserved_balance=w.reserved_balance-net,updated_at=now() WHERE id=w.id;
 INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,description,metadata,
  balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
 VALUES(w.id,j.customer_id,j.id,'settlement',charge,'Job payment settled from wallet reservation',
  jsonb_build_object('payment_method','wallet','service_fare',fare,'actual_item_spend',spend),
  w.available_balance,w.available_balance,w.reserved_balance,w.reserved_balance-charge);
 IF refund>0 THEN
  INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,description,metadata,
   balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved)
  VALUES(w.id,j.customer_id,j.id,'release',refund,'Unused shopping budget returned',jsonb_build_object('payment_method','wallet','reason','unused_budget'),
   w.available_balance,w.available_balance+refund,w.reserved_balance-charge,w.reserved_balance-net);
 END IF;
 UPDATE public.errand_funding SET status='settled',actual_item_spend=spend,refund_amount=refund,
  metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('settlement',jsonb_build_object('amount_settled',charge,'amount_released',refund)),updated_at=now() WHERE job_id=j.id;
 UPDATE public.jobs SET payment_status='paid',updated_at=now() WHERE id=j.id;
 RETURN jsonb_build_object('status','settled','job_id',j.id,'amount_settled',charge,'amount_released',refund);
END $$;

REVOKE ALL ON FUNCTION public.release_job_wallet_reservation(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_job_wallet_reservation(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_job_wallet_reservation(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_job_wallet_reservation(uuid, numeric) TO service_role;

-- Pre-migration catalog snapshot (constraints, policies, grants, RPC definitions).
CREATE TABLE batch1a_snapshot_before (kind text, name text, def text);
INSERT INTO batch1a_snapshot_before
SELECT 'constraint', conname, pg_get_constraintdef(oid)
FROM pg_constraint WHERE conrelid = 'public.wallet_transactions'::regclass
UNION ALL
SELECT 'policy_wt', policyname, cmd || '|' || array_to_string(roles,',') || '|' || coalesce(qual,'') || '|' || coalesce(with_check,'')
FROM pg_policies WHERE schemaname='public' AND tablename='wallet_transactions'
UNION ALL
SELECT 'policy_wallets', policyname, cmd || '|' || array_to_string(roles,',') || '|' || coalesce(qual,'') || '|' || coalesce(with_check,'')
FROM pg_policies WHERE schemaname='public' AND tablename='wallets'
UNION ALL
SELECT 'table_grant', table_name || '.' || privilege_type, grantee
FROM information_schema.role_table_grants
WHERE table_schema='public' AND table_name IN ('wallet_transactions','wallets')
UNION ALL
SELECT 'fn', p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid))
FROM pg_proc p WHERE p.proname IN ('release_job_wallet_reservation','settle_job_wallet_reservation')
UNION ALL
SELECT 'fn_grant', p.oid::regprocedure::text, coalesce(p.proacl::text, 'PUBLIC-DEFAULT')
FROM pg_proc p WHERE p.proname IN ('release_job_wallet_reservation','settle_job_wallet_reservation');

\echo 'fixture ready'
