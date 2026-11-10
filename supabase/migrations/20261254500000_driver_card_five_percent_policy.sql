-- Shared CARD fee approval, 2026-10-27. No market/provider/driver is activated.
BEGIN;
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
COMMIT;
