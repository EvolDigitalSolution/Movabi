-- Additive develop-only preparation. No approvals, gates, credentials or transfers.
BEGIN;
DO $$ BEGIN
 IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'Develop database required'; END IF;
 IF to_regclass('public.market_payment_routes') IS NULL OR to_regclass('public.job_payout_queue') IS NULL
 THEN RAISE EXCEPTION 'Payment routes and payout outbox required'; END IF;
END $$;

CREATE TABLE public.driver_payout_markets(
 country_code text NOT NULL,currency_code text NOT NULL,provider text NOT NULL CHECK(provider IN('stripe','flutterwave','kora','fincra')),
 merchant_account_ref text,enabled boolean NOT NULL DEFAULT false,merchant_approved boolean NOT NULL DEFAULT false,
 adapter_ready boolean NOT NULL DEFAULT false,capability_verified_at timestamptz,
 capability_evidence_ref text,merchant_mode text NOT NULL DEFAULT 'test' CHECK(merchant_mode='test'),
 sandbox_driver_id uuid,sandbox_tenant_id uuid,
 PRIMARY KEY(country_code,currency_code),
 CHECK(NOT enabled OR (merchant_approved AND adapter_ready AND merchant_account_ref IS NOT NULL AND capability_verified_at IS NOT NULL AND capability_evidence_ref IS NOT NULL
  AND sandbox_driver_id IS NOT NULL AND sandbox_tenant_id IS NOT NULL)),
 CHECK(provider<>'flutterwave' OR NOT enabled OR (country_code='NG' AND currency_code='NGN'))
);
CREATE TABLE public.driver_payment_accounts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),driver_id uuid NOT NULL REFERENCES public.profiles(id),tenant_id uuid NOT NULL,
 country_code text NOT NULL,currency_code text NOT NULL,provider text NOT NULL DEFAULT 'flutterwave' CHECK(provider='flutterwave'),
 merchant_account_ref text NOT NULL,state text NOT NULL CHECK(state IN('not_started','in_progress','action_required','completed','unavailable')),
 beneficiary_id text,bank_code text,last4 text CHECK(last4 ~ '^\d{4}$'),fingerprint text,
 setup_token uuid NOT NULL DEFAULT gen_random_uuid(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(driver_id,tenant_id,country_code,currency_code,merchant_account_ref),
 CHECK(state<>'completed' OR (beneficiary_id IS NOT NULL AND fingerprint IS NOT NULL AND beneficiary_id ~ '^\d+$' AND bank_code IS NOT NULL AND last4 IS NOT NULL AND fingerprint ~ '^[a-f0-9]{64}$'))
);
ALTER TABLE public.driver_payout_markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_payment_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_payout_markets,public.driver_payment_accounts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.driver_payout_markets TO service_role;
GRANT SELECT,UPDATE ON public.driver_payment_accounts TO service_role;
CREATE FUNCTION public.guard_driver_payment_account_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retain payment account history'; END IF;
 IF (NEW.id,NEW.driver_id,NEW.tenant_id,NEW.country_code,NEW.currency_code,NEW.provider,NEW.merchant_account_ref)
  IS DISTINCT FROM (OLD.id,OLD.driver_id,OLD.tenant_id,OLD.country_code,OLD.currency_code,OLD.provider,OLD.merchant_account_ref)
  OR (OLD.state='completed' AND (NEW.beneficiary_id,NEW.bank_code,NEW.last4,NEW.fingerprint,NEW.state)
   IS DISTINCT FROM (OLD.beneficiary_id,OLD.bank_code,OLD.last4,OLD.fingerprint,OLD.state))
 THEN RAISE EXCEPTION 'Frozen payment account identity cannot change'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_driver_payment_account_identity BEFORE UPDATE OR DELETE ON public.driver_payment_accounts
 FOR EACH ROW EXECUTE FUNCTION public.guard_driver_payment_account_identity();
REVOKE ALL ON FUNCTION public.guard_driver_payment_account_identity() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.claim_driver_payment_setup(p_driver uuid,p_tenant uuid,p_country text,p_currency text,p_merchant text)
RETURNS SETOF public.driver_payment_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.driver_payout_markets m JOIN public.profiles p ON p.id=p_driver
  WHERE m.country_code=p_country AND m.currency_code=p_currency AND m.provider='flutterwave' AND m.enabled AND m.merchant_approved AND m.adapter_ready
  AND m.capability_verified_at IS NOT NULL AND m.capability_evidence_ref IS NOT NULL AND m.merchant_mode='test' AND m.merchant_account_ref=p_merchant AND m.sandbox_driver_id=p_driver AND m.sandbox_tenant_id=p_tenant
  AND p.tenant_id=p_tenant AND p.role='driver' AND p.registration_activated_at IS NOT NULL
  AND coalesce(p.registration_country_code,p.country_code)=p_country)
 THEN RAISE EXCEPTION 'Approved sandbox driver market required'; END IF;
 RETURN QUERY INSERT INTO public.driver_payment_accounts(driver_id,tenant_id,country_code,currency_code,merchant_account_ref,state)
 VALUES(p_driver,p_tenant,p_country,p_currency,p_merchant,'in_progress')
 ON CONFLICT(driver_id,tenant_id,country_code,currency_code,merchant_account_ref) DO UPDATE
 SET state='in_progress',setup_token=gen_random_uuid(),updated_at=now()
 WHERE driver_payment_accounts.state IN('not_started','action_required')
 OR (driver_payment_accounts.state='in_progress' AND driver_payment_accounts.updated_at<now()-interval '5 minutes') RETURNING *;
END $$;
REVOKE ALL ON FUNCTION public.claim_driver_payment_setup(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_driver_payment_setup(uuid,uuid,text,text,text) TO service_role;

-- Explicit repository African catalogue, never 'anything outside GB'.
CREATE TEMP TABLE african_defaults(country text,currency text) ON COMMIT DROP;
INSERT INTO african_defaults VALUES('NG','NGN'),('GH','GHS'),('KE','KES'),('ZA','ZAR'),('UG','UGX'),('TZ','TZS'),('RW','RWF'),('MW','MWK'),('EG','EGP'),('CM','XAF'),('CI','XOF'),('SN','XOF'),('ZM','ZMW');
INSERT INTO public.driver_payout_markets(country_code,currency_code,provider)
 SELECT a.country,a.currency,'flutterwave' FROM african_defaults a
 WHERE EXISTS(SELECT 1 FROM public.market_availability m WHERE m.country_code=a.country AND m.supported_currency=a.currency);
INSERT INTO public.driver_payout_markets(country_code,currency_code,provider)
 SELECT 'GB','GBP','stripe' WHERE EXISTS(SELECT 1 FROM public.market_availability WHERE country_code='GB' AND supported_currency='GBP');

-- Only untouched disabled placeholders receive the new collection default. The existing
-- guard/audit triggers and partial unique preferred index remain in force.
DO $$ DECLARE a record;r record;target uuid; BEGIN
 FOR a IN SELECT * FROM african_defaults LOOP
  IF NOT EXISTS(SELECT 1 FROM public.market_availability WHERE country_code=a.country AND supported_currency=a.currency) THEN CONTINUE; END IF;
  SELECT * INTO r FROM public.market_payment_routes WHERE country_code=a.country AND currency_code=a.currency AND method='card' AND preferred;
  IF FOUND AND (r.provider='flutterwave' OR r.merchant_account_ref IS NOT NULL OR r.enabled OR r.merchant_approved OR r.adapter_ready OR r.payout_approved
   OR cardinality(r.capabilities)>0 OR EXISTS(SELECT 1 FROM public.market_payment_route_audit WHERE route_id=r.id AND old_values IS NOT NULL)) THEN
   RAISE NOTICE 'Preserved configured/preferred override for %/% route %',a.country,a.currency,r.id;CONTINUE;
  END IF;
  IF EXISTS(SELECT 1 FROM public.market_payment_routes WHERE country_code=a.country AND currency_code=a.currency AND method='card' AND provider='flutterwave') THEN
   RAISE NOTICE 'Review existing nonpreferred Flutterwave route for %/%',a.country,a.currency;CONTINUE;
  END IF;
  UPDATE public.market_payment_routes SET preferred=false WHERE country_code=a.country AND currency_code=a.currency AND method='card' AND preferred;
  INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,preferred)
   VALUES(a.country,a.currency,'card','flutterwave',true);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
