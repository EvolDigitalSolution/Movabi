BEGIN;
DO $preflight$
BEGIN
 IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'Expected movabi_develop development database'; END IF;
 IF to_regclass('public.market_availability') IS NULL OR to_regclass('public.job_payment_bindings') IS NULL THEN RAISE EXCEPTION 'Market and payment binding tables required'; END IF;
END
$preflight$;
CREATE TABLE public.market_payment_routes(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 country_code varchar(2) NOT NULL CHECK(country_code ~ '^[A-Z]{2}$'),
 currency_code varchar(3) NOT NULL CHECK(currency_code ~ '^[A-Z]{3}$'),
 method text NOT NULL CHECK(method IN('card','bank_transfer','mobile_money')),
 provider text NOT NULL CHECK(provider IN('stripe','kora','fincra')),
 merchant_account_ref text CHECK(merchant_account_ref IS NULL OR (length(btrim(merchant_account_ref))>0 AND merchant_account_ref=btrim(merchant_account_ref))),
 preferred boolean NOT NULL DEFAULT true,enabled boolean NOT NULL DEFAULT false,
 merchant_approved boolean NOT NULL DEFAULT false,adapter_ready boolean NOT NULL DEFAULT false,payout_approved boolean NOT NULL DEFAULT false,
 capabilities text[] NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(capabilities <@ ARRAY['authorise','capture','release','refund','retrieve','payout']::text[] AND array_position(capabilities,NULL) IS NULL),
 CHECK(NOT enabled OR (merchant_approved AND adapter_ready AND merchant_account_ref IS NOT NULL AND cardinality(capabilities)>0)),
 -- Existing application adapters explicitly enforce this readiness restriction.
 CHECK(provider NOT IN('kora','fincra') OR (NOT enabled AND NOT adapter_ready AND NOT payout_approved AND cardinality(capabilities)=0))
);
CREATE UNIQUE INDEX market_payment_routes_preferred_unique ON public.market_payment_routes(country_code,currency_code,method) WHERE preferred;
CREATE UNIQUE INDEX market_payment_routes_identity_unique ON public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref) WHERE merchant_account_ref IS NOT NULL;
CREATE TABLE public.market_payment_route_audit(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,route_id uuid NOT NULL REFERENCES public.market_payment_routes(id),
 actor text NOT NULL,old_values jsonb,new_values jsonb NOT NULL,changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.market_payment_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_payment_route_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.market_payment_routes,public.market_payment_route_audit FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE public.market_payment_route_audit_id_seq FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.market_payment_routes TO service_role;
CREATE FUNCTION public.guard_market_payment_route_v23() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $guard$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payment route history must be retained; retire a route instead'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.market_availability m WHERE m.country_code=NEW.country_code AND m.supported_currency=NEW.currency_code) THEN
  RAISE EXCEPTION 'Payment route must reference an existing market country and currency';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.country_code IS DISTINCT FROM OLD.country_code OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
   OR NEW.method IS DISTINCT FROM OLD.method OR NEW.provider IS DISTINCT FROM OLD.provider
   OR (OLD.merchant_account_ref IS NOT NULL AND NEW.merchant_account_ref IS DISTINCT FROM OLD.merchant_account_ref)
  THEN RAISE EXCEPTION 'Route identity cannot change; retain the original route and add a new one'; END IF;
 END IF;
 NEW.updated_at:=clock_timestamp();RETURN NEW;
END
$guard$;
CREATE FUNCTION public.audit_market_payment_route_v23() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $audit$
BEGIN
 INSERT INTO public.market_payment_route_audit(route_id,actor,old_values,new_values)
 VALUES(NEW.id,session_user,CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,to_jsonb(NEW));
 RETURN NEW;
END
$audit$;
REVOKE ALL ON FUNCTION public.guard_market_payment_route_v23(),public.audit_market_payment_route_v23() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_market_payment_route_v23 BEFORE INSERT OR UPDATE OR DELETE ON public.market_payment_routes FOR EACH ROW EXECUTE FUNCTION public.guard_market_payment_route_v23();
CREATE TRIGGER audit_market_payment_route_v23 AFTER INSERT OR UPDATE ON public.market_payment_routes FOR EACH ROW EXECUTE FUNCTION public.audit_market_payment_route_v23();
-- Provider assignments only. Do not manufacture merchant approval or credentials.
INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref)
 SELECT DISTINCT country_code,supported_currency,'card',CASE WHEN country_code='GB' THEN 'stripe' ELSE 'kora' END,
 CASE WHEN country_code='GB' THEN 'stripe-platform' ELSE NULL END
 FROM public.market_availability WHERE (country_code,supported_currency) IN(('GB','GBP'),('NG','NGN'));
NOTIFY pgrst,'reload schema';
COMMIT;
