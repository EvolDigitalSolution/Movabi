-- Customer collection provider-account binding (develop scope).
--
-- Gap found by the connected journey: StripeDriverTopupSandbox.account()
-- requires attempt.provider_account_id (the platform Stripe account the
-- merchant is bound to) but no code path populated it for customer_credit
-- attempts — the field was only ever set by the driver-card sandbox scope.
-- Every adapter call then fell through to PAYMENT_RECONCILIATION_REQUIRED.
--
-- Fix: the approved provider account lives on the market_payment_routes row —
-- the same service-role-owned merchant configuration the collection service
-- already resolves — and freeze_wallet_topup_fee binds it onto the attempt
-- before checkout. It is never client-supplied, and once set it is frozen
-- (driver_card_attempt_scope_freeze already refuses to change a non-null
-- value). Attempts that already carry a binding keep it untouched; attempts
-- whose route has no binding fail closed for stripe (the only provider whose
-- adapter requires it today) instead of reconciling later.
BEGIN;
DO $$ BEGIN
 IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'Develop database required'; END IF;
 IF to_regprocedure('public.freeze_wallet_topup_fee(uuid,text)') IS NULL
  OR to_regclass('public.market_payment_routes') IS NULL THEN
  RAISE EXCEPTION 'Collection account binding requires the batch-2 wallet collection chain'; END IF;
END $$;

ALTER TABLE public.market_payment_routes ADD COLUMN IF NOT EXISTS provider_account_id text;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='market_payment_routes_provider_account_check') THEN
  ALTER TABLE public.market_payment_routes ADD CONSTRAINT market_payment_routes_provider_account_check
   CHECK ((provider_account_id IS NULL) OR (btrim(provider_account_id)<>'' AND provider_account_id=btrim(provider_account_id)));
 END IF;
END $$;
COMMENT ON COLUMN public.market_payment_routes.provider_account_id IS
 'Approved provider-side account (e.g. Stripe acct_*) bound to this merchant route; service-role written, copied onto collection attempts at freeze time.';

CREATE OR REPLACE FUNCTION public.freeze_wallet_topup_fee(p_attempt_id uuid, p_fee_policy_version text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.wallet_topup_attempts%ROWTYPE; s public.driver_card_topup_sandbox_scopes%ROWTYPE;
 p public.wallet_topup_fee_schedules%ROWTYPE; r public.market_payment_routes%ROWTYPE;
BEGIN
 SELECT * INTO a FROM public.wallet_topup_attempts WHERE id=p_attempt_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Attempt missing' USING ERRCODE='BP003'; END IF;
 -- Customer collection: bind the approved provider account from the market
 -- route before any checkout. Exactly one eligible route must exist (STRICT
 -- raises otherwise). An already-bound attempt keeps its binding.
 IF a.destination_account_purpose='customer_credit' AND a.provider_account_id IS NULL THEN
  SELECT * INTO STRICT r FROM public.market_payment_routes
   WHERE country_code=a.country_code AND currency_code=a.currency_code AND method='card'
    AND preferred AND enabled AND merchant_approved AND adapter_ready
    AND capabilities @> ARRAY['collect']::text[]
    AND provider=a.payment_provider AND merchant_account_ref=a.merchant_account_ref
   FOR SHARE;
  IF r.provider='stripe' AND r.provider_account_id IS NULL THEN
   RAISE EXCEPTION 'Approved provider account binding required' USING ERRCODE='BP008'; END IF;
  UPDATE public.wallet_topup_attempts SET provider_account_id=r.provider_account_id
   WHERE id=a.id AND provider_account_id IS NULL;
 END IF;
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
REVOKE ALL ON FUNCTION public.freeze_wallet_topup_fee(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.freeze_wallet_topup_fee(uuid,text) TO service_role;
COMMIT;
