-- 20261271300000_ng_cash_wallet_reservation.sql
-- NG cash security: customer-WALLET reservation for the cancellation/no-show
-- exposure, alongside the existing driver cash-credit reservation for platform
-- charges. Markets opt in per-row via driver_cash_credit_markets_v1e
-- .cash_security_mode; existing rows default to 'card_hold' (GB unchanged).
-- The reservation lives on wallets.reserved_balance, is idempotent per job,
-- and settles only on capture — the remainder is released, mirroring the
-- card-hold contract without any card provider.
BEGIN;

ALTER TABLE public.driver_cash_credit_markets_v1e
  ADD COLUMN cash_security_mode text NOT NULL DEFAULT 'card_hold'
  CHECK (cash_security_mode IN ('card_hold','wallet_reservation'));

CREATE OR REPLACE FUNCTION public.cash_market_security_mode_v1e(p_country text, p_currency text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $$
  SELECT m.cash_security_mode FROM public.driver_cash_credit_markets_v1e m
  WHERE m.country_code=upper(p_country) AND m.currency_code=upper(p_currency) AND m.enabled $$;
REVOKE ALL ON FUNCTION public.cash_market_security_mode_v1e(text,text) FROM PUBLIC;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON FUNCTION public.cash_market_security_mode_v1e(text,text) FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON FUNCTION public.cash_market_security_mode_v1e(text,text) FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public.cash_market_security_mode_v1e(text,text) TO service_role; END IF;
END $g$;

CREATE TABLE public.cash_wallet_hold_reservations_v1e (
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  wallet_id uuid NOT NULL REFERENCES public.wallets(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','released','captured')),
  captured_minor bigint CHECK (captured_minor IS NULL OR captured_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE public.cash_wallet_hold_reservations_v1e FROM PUBLIC;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT SELECT,INSERT,UPDATE ON public.cash_wallet_hold_reservations_v1e TO service_role; END IF;
END $g$;

-- Reserve the exposure from the customer's spendable balance. Idempotent per job:
-- a replay with identical terms returns the same reference; different terms raise.
CREATE OR REPLACE FUNCTION public.cash_wallet_reserve_hold(p_job_id uuid, p_customer_id uuid, p_amount_minor bigint, p_currency text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $$
DECLARE w public.wallets%ROWTYPE; r public.cash_wallet_hold_reservations_v1e%ROWTYPE;
  v_amount numeric(12,2); v_exponent int; v_ref text := 'wres:' || p_job_id::text;
BEGIN
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR upper(p_currency) !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Invalid wallet reservation terms' USING ERRCODE='WH001'; END IF;
  SELECT * INTO r FROM public.cash_wallet_hold_reservations_v1e WHERE job_id=p_job_id;
  IF FOUND THEN
    IF r.customer_id=p_customer_id AND r.amount_minor=p_amount_minor AND r.currency_code=upper(p_currency) AND r.status='reserved'
      THEN RETURN v_ref; END IF;
    RAISE EXCEPTION 'Wallet reservation % already exists with different terms', p_job_id USING ERRCODE='WH002';
  END IF;
  SELECT * INTO w FROM public.wallets WHERE user_id=p_customer_id FOR UPDATE;
  IF NOT FOUND OR w.currency_code<>upper(p_currency) THEN
    RAISE EXCEPTION 'No % customer wallet for this market', upper(p_currency) USING ERRCODE='WH003'; END IF;
  v_exponent := public.wallet_currency_minor_exponent(upper(p_currency));
  v_amount := (p_amount_minor::numeric / (10::numeric ^ v_exponent))::numeric(12,2);
  IF w.available_balance < v_amount THEN
    RAISE EXCEPTION 'Insufficient spendable wallet balance for the cash fee reservation' USING ERRCODE='WH004'; END IF;
  UPDATE public.wallets SET available_balance=available_balance-v_amount, reserved_balance=reserved_balance+v_amount, updated_at=now() WHERE id=w.id;
  INSERT INTO public.cash_wallet_hold_reservations_v1e(job_id,customer_id,wallet_id,amount_minor,currency_code)
    VALUES (p_job_id,p_customer_id,w.id,p_amount_minor,upper(p_currency));
  INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,
      balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved,
      description,metadata,tenant_id,currency_code,amount_minor,balance_purpose,provider_reference,event_key)
    SELECT w.id,p_customer_id,p_job_id,'reservation',v_amount,
      w.available_balance,w.available_balance-v_amount,w.reserved_balance,w.reserved_balance+v_amount,
      'Cash ride fee reservation','{}'::jsonb,j.tenant_id,upper(p_currency),p_amount_minor,'customer_credit',v_ref,'cash-wallet-reserve:'||p_job_id::text
    FROM public.jobs j WHERE j.id=p_job_id;
  RETURN v_ref;
END $$;

-- Return the full reservation to spendable balance. Idempotent.
CREATE OR REPLACE FUNCTION public.cash_wallet_release_hold(p_job_id uuid, p_reference text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $$
DECLARE r public.cash_wallet_hold_reservations_v1e%ROWTYPE; w public.wallets%ROWTYPE; v_amount numeric(12,2);
BEGIN
  SELECT * INTO r FROM public.cash_wallet_hold_reservations_v1e WHERE job_id=p_job_id FOR UPDATE;
  IF NOT FOUND OR p_reference<>'wres:'||p_job_id::text THEN
    RAISE EXCEPTION 'Wallet reservation does not match this booking' USING ERRCODE='WH005'; END IF;
  IF r.status='released' OR r.status='captured' THEN RETURN; END IF;
  v_amount := (r.amount_minor::numeric / (10::numeric ^ public.wallet_currency_minor_exponent(r.currency_code)))::numeric(12,2);
  SELECT * INTO w FROM public.wallets WHERE id=r.wallet_id FOR UPDATE;
  IF NOT FOUND OR w.reserved_balance < v_amount THEN
    RAISE EXCEPTION 'Reserved balance is inconsistent with this hold' USING ERRCODE='WH006'; END IF;
  UPDATE public.wallets SET available_balance=available_balance+v_amount, reserved_balance=reserved_balance-v_amount, updated_at=now() WHERE id=w.id;
  UPDATE public.cash_wallet_hold_reservations_v1e SET status='released', updated_at=now() WHERE job_id=r.job_id;
  INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,
      balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved,
      description,metadata,tenant_id,currency_code,amount_minor,balance_purpose,provider_reference,event_key)
    SELECT w.id,r.customer_id,r.job_id,'release',v_amount,
      w.available_balance,w.available_balance+v_amount,w.reserved_balance,w.reserved_balance-v_amount,
      'Cash ride fee reservation released','{}'::jsonb,j.tenant_id,r.currency_code,r.amount_minor,'customer_credit',p_reference,'cash-wallet-release:'||r.job_id::text
    FROM public.jobs j WHERE j.id=r.job_id;
END $$;

-- Capture p_amount_minor once (<= the reservation); the remainder is released.
CREATE OR REPLACE FUNCTION public.cash_wallet_capture_hold(p_job_id uuid, p_reference text, p_amount_minor bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $$
DECLARE r public.cash_wallet_hold_reservations_v1e%ROWTYPE; w public.wallets%ROWTYPE;
  v_hold numeric(12,2); v_fee numeric(12,2); v_rest numeric(12,2);
BEGIN
  SELECT * INTO r FROM public.cash_wallet_hold_reservations_v1e WHERE job_id=p_job_id FOR UPDATE;
  IF NOT FOUND OR p_reference<>'wres:'||p_job_id::text THEN
    RAISE EXCEPTION 'Wallet reservation does not match this booking' USING ERRCODE='WH005'; END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR p_amount_minor > r.amount_minor THEN
    RAISE EXCEPTION 'Fee exceeds the wallet reservation' USING ERRCODE='WH007'; END IF;
  IF r.status='captured' THEN
    IF r.captured_minor=p_amount_minor THEN RETURN; END IF;
    RAISE EXCEPTION 'A different fee was already captured for this booking' USING ERRCODE='WH008'; END IF;
  IF r.status<>'reserved' THEN RAISE EXCEPTION 'Wallet reservation is not active' USING ERRCODE='WH009'; END IF;
  v_hold := (r.amount_minor::numeric / (10::numeric ^ public.wallet_currency_minor_exponent(r.currency_code)))::numeric(12,2);
  v_fee  := (p_amount_minor::numeric / (10::numeric ^ public.wallet_currency_minor_exponent(r.currency_code)))::numeric(12,2);
  v_rest := v_hold - v_fee;
  SELECT * INTO w FROM public.wallets WHERE id=r.wallet_id FOR UPDATE;
  IF NOT FOUND OR w.reserved_balance < v_hold THEN
    RAISE EXCEPTION 'Reserved balance is inconsistent with this hold' USING ERRCODE='WH006'; END IF;
  UPDATE public.wallets SET available_balance=available_balance+v_rest, reserved_balance=reserved_balance-v_hold, updated_at=now() WHERE id=w.id;
  UPDATE public.cash_wallet_hold_reservations_v1e SET status='captured', captured_minor=p_amount_minor, updated_at=now() WHERE job_id=r.job_id;
  INSERT INTO public.wallet_transactions(wallet_id,user_id,job_id,transaction_type,amount,
      balance_before_available,balance_after_available,balance_before_reserved,balance_after_reserved,
      description,metadata,tenant_id,currency_code,amount_minor,balance_purpose,provider_reference,event_key)
    SELECT w.id,r.customer_id,r.job_id,'settlement',v_fee,
      w.available_balance,w.available_balance+v_rest,w.reserved_balance,w.reserved_balance-v_hold,
      'Cash ride cancellation fee captured','{}'::jsonb,j.tenant_id,r.currency_code,p_amount_minor,'platform_funding',p_reference,'cash-wallet-capture:'||r.job_id::text
    FROM public.jobs j WHERE j.id=r.job_id;
END $$;

-- Read-only status for verifyAuthorised/inspectCaptured.
CREATE OR REPLACE FUNCTION public.cash_wallet_hold_status(p_job_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public' AS $$
  SELECT coalesce((SELECT r.status FROM public.cash_wallet_hold_reservations_v1e r WHERE r.job_id=p_job_id),'none') $$;

REVOKE ALL ON FUNCTION public.cash_wallet_reserve_hold(uuid,uuid,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_wallet_release_hold(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_wallet_capture_hold(uuid,text,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cash_wallet_hold_status(uuid) FROM PUBLIC;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT EXECUTE ON FUNCTION public.cash_wallet_reserve_hold(uuid,uuid,bigint,text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.cash_wallet_release_hold(uuid,text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.cash_wallet_capture_hold(uuid,text,bigint) TO service_role;
    GRANT EXECUTE ON FUNCTION public.cash_wallet_hold_status(uuid) TO service_role;
  END IF;
END $g$;
COMMIT;
