BEGIN;
DO $preflight$
BEGIN
 IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'Expected movabi_develop'; END IF;
 IF to_regclass('public.system_configs') IS NULL OR to_regclass('public.market_payment_routes') IS NULL
  OR to_regprocedure('public.guard_market_payment_route_v23()') IS NULL THEN RAISE EXCEPTION 'Existing Settings and database payment-route migrations required'; END IF;
END
$preflight$;
CREATE FUNCTION public.configured_payment_countries_v23()
RETURNS TABLE(country_code text,currency_code text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $countries$
DECLARE countries jsonb;matches bigint;
BEGIN
 SELECT count(*) INTO matches FROM public.system_configs WHERE coalesce(key,config_key)='countries';
 IF matches<>1 THEN RAISE EXCEPTION 'Exactly one saved countries setting required'; END IF;
 SELECT coalesce(nullif(value,'null'::jsonb),config_value) INTO countries FROM public.system_configs WHERE coalesce(key,config_key)='countries';
 IF jsonb_typeof(countries) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Saved countries must be a JSON array'; END IF;
 IF jsonb_array_length(countries)>1000 THEN RAISE EXCEPTION 'Saved countries list is too large'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(countries) e WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
  OR coalesce(upper(btrim(e->>'code')),'') !~ '^[A-Z]{2}$' OR coalesce(upper(btrim(e->>'currency')),'') !~ '^[A-Z]{3}$')
 THEN RAISE EXCEPTION 'Invalid saved country or fiat currency code'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(countries) e GROUP BY upper(btrim(e->>'code')) HAVING count(*)>1)
 THEN RAISE EXCEPTION 'Duplicate saved country codes require review'; END IF;
 RETURN QUERY SELECT upper(btrim(e->>'code')),upper(btrim(e->>'currency')) FROM jsonb_array_elements(countries) e;
END
$countries$;
CREATE FUNCTION public.recommended_country_payment_provider_v23(p_country text,p_currency text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $provider$
 SELECT CASE
 WHEN p_country IN('NG','GH','KE','ZA','TZ','EG','CM','CI','SN') AND p_currency=ANY(ARRAY['NGN','KES','GHS','ZAR','XOF','XAF','EGP','TZS','USD','GBP']::text[]) THEN 'kora'
 WHEN p_country ~ '^[A-Z]{2}$' AND p_currency=ANY(ARRAY['USD','AED','AFN','ALL','AMD','ANG','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT','BIF','BMD','BND','BOB','BRL','BSD','BWP','BYN','BZD','CAD','CDF','CHF','CLP','CNY','COP','CRC','CVE','CZK','DJF','DKK','DOP','DZD','EGP','ETB','EUR','FJD','FKP','GBP','GEL','GIP','GMD','GNF','GTQ','GYD','HKD','HNL','HTG','HUF','IDR','ILS','INR','ISK','JMD','JPY','KES','KGS','KHR','KMF','KRW','KYD','KZT','LAK','LBP','LKR','LRD','LSL','MAD','MDL','MGA','MKD','MMK','MNT','MOP','MUR','MVR','MWK','MXN','MYR','MZN','NAD','NGN','NIO','NOK','NPR','NZD','PAB','PEN','PGK','PHP','PKR','PLN','PYG','QAR','RON','RSD','RUB','RWF','SAR','SBD','SCR','SEK','SGD','SHP','SLE','SOS','SRD','STD','SZL','THB','TJS','TOP','TRY','TTD','TWD','TZS','UAH','UGX','UYU','UZS','VND','VUV','WST','XAF','XCD','XCG','XOF','XPF','YER','ZAR','ZMW']::text[]) THEN 'stripe'
 ELSE NULL END
$provider$;
CREATE OR REPLACE FUNCTION public.guard_market_payment_route_v23() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $guard$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payment route history must be retained; retire a route instead'; END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM public.market_availability m WHERE m.country_code=NEW.country_code AND m.supported_currency=NEW.currency_code)
  AND NOT EXISTS(SELECT 1 FROM public.configured_payment_countries_v23() c WHERE c.country_code=NEW.country_code AND c.currency_code=NEW.currency_code) THEN
  RAISE EXCEPTION 'Payment route must reference a saved country/currency or existing service market';
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

CREATE FUNCTION public.sync_configured_country_payment_routes_v23() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $sync$
DECLARE added integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('vaydu-country-provider-sync-v23'));
 INSERT INTO public.market_payment_routes(country_code,currency_code,method,provider,merchant_account_ref)
 SELECT c.country_code,c.currency_code,'card',p.provider,CASE WHEN p.provider='stripe' THEN 'stripe-platform' ELSE NULL END
 FROM public.configured_payment_countries_v23() c
 CROSS JOIN LATERAL(SELECT public.recommended_country_payment_provider_v23(c.country_code,c.currency_code) AS provider) p
 WHERE p.provider IS NOT NULL
 ON CONFLICT(country_code,currency_code,method) WHERE preferred DO NOTHING;
 GET DIAGNOSTICS added=ROW_COUNT;
 RETURN added;
END
$sync$;
CREATE FUNCTION public.sync_country_settings_payment_routes_v23() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $settings$
BEGIN
 IF coalesce(NEW.key,NEW.config_key)='countries' THEN PERFORM public.sync_configured_country_payment_routes_v23(); END IF;
 RETURN NEW;
END
$settings$;
REVOKE ALL ON FUNCTION public.configured_payment_countries_v23(),public.recommended_country_payment_provider_v23(text,text),public.sync_configured_country_payment_routes_v23(),public.sync_country_settings_payment_routes_v23() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.configured_payment_countries_v23() TO service_role;
CREATE TRIGGER sync_country_settings_payment_routes_v23 AFTER INSERT OR UPDATE ON public.system_configs
 FOR EACH ROW EXECUTE FUNCTION public.sync_country_settings_payment_routes_v23();
CREATE VIEW public.country_payment_assignments_v23 AS
 SELECT c.country_code,c.currency_code,r.provider,(r.id IS NOT NULL) AS assigned,
 coalesce(r.enabled,false) AS enabled,coalesce(r.merchant_approved,false) AS merchant_approved,
 coalesce(r.adapter_ready,false) AS adapter_ready
 FROM public.configured_payment_countries_v23() c
 LEFT JOIN public.market_payment_routes r ON r.country_code=c.country_code AND r.currency_code=c.currency_code AND r.method='card' AND r.preferred;
REVOKE ALL ON public.country_payment_assignments_v23 FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.country_payment_assignments_v23 TO service_role;
-- Assert that a bulk sync does not rewrite any current identity or approval.
CREATE TEMP TABLE country_route_before_v23 ON COMMIT DROP AS SELECT id,to_jsonb(r) AS snapshot FROM public.market_payment_routes r;
SELECT public.sync_configured_country_payment_routes_v23() AS country_routes_added;
DO $verify$
BEGIN
 IF EXISTS(SELECT 1 FROM country_route_before_v23 b LEFT JOIN public.market_payment_routes r ON r.id=b.id WHERE to_jsonb(r) IS DISTINCT FROM b.snapshot)
 THEN RAISE EXCEPTION 'Country sync changed a pre-existing route'; END IF;
 IF EXISTS(SELECT 1 FROM public.country_payment_assignments_v23 WHERE NOT assigned)
 THEN RAISE EXCEPTION 'A configured country has no provider preference; review its currency before applying'; END IF;
END
$verify$;
NOTIFY pgrst,'reload schema';
COMMIT;
