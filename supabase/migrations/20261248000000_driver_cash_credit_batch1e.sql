-- Batch 1E: disabled cash-RIDE credit pilot. No provider collection is enabled,
-- no legacy wallet balance is imported, and no financial RPC body is replaced.
BEGIN;
SET LOCAL search_path=pg_catalog,public;
DO $$ BEGIN
 IF to_regclass('public.wallet_topup_attempts') IS NULL
 OR to_regprocedure('public.post_wallet_event(text,text,uuid,uuid,text,jsonb,text,text,text,uuid)') IS NULL
 OR to_regprocedure('public.driver_job_market_matches_v23(jsonb,jsonb)') IS NULL
 OR to_regclass('public.profiles') IS NULL THEN RAISE EXCEPTION 'Batch 1E: applied prerequisites missing'; END IF;
 IF public.wallet_collection_enabled() IS DISTINCT FROM false THEN RAISE EXCEPTION 'Batch 1E: collection must remain disabled'; END IF;
 IF has_function_privilege('authenticated','public.pay_job_from_wallet(uuid,uuid,numeric,text,uuid)','EXECUTE')
 OR has_table_privilege('authenticated','public.driver_earnings','TRUNCATE') THEN RAISE EXCEPTION 'Batch 1E: Batch 1D authorization required'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.driver_cash_credit_config_v1e(key text PRIMARY KEY,enabled boolean NOT NULL);
CREATE TABLE IF NOT EXISTS public.driver_cash_credit_enrolments_v1e(
 tenant_id uuid NOT NULL,driver_id uuid NOT NULL REFERENCES public.profiles(id),
 country_code text NOT NULL CHECK(country_code ~ '^[A-Z]{2}$'),
 currency_code text NOT NULL CHECK(currency_code ~ '^[A-Z]{3}$'),
 terms_version text NOT NULL CHECK(length(btrim(terms_version)) BETWEEN 1 AND 100),
 consented_at timestamptz NOT NULL,enabled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,driver_id,country_code,currency_code)
);
CREATE TABLE IF NOT EXISTS public.driver_cash_credit_holds_v1e(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid NOT NULL UNIQUE REFERENCES public.jobs(id),
 tenant_id uuid NOT NULL,driver_id uuid NOT NULL REFERENCES public.profiles(id),
 country_code text NOT NULL,currency_code text NOT NULL,fare_snapshot jsonb NOT NULL,
 enrolment_terms_version text NOT NULL,enrolment_consented_at timestamptz NOT NULL,
 customer_charge_minor bigint NOT NULL CHECK(customer_charge_minor>0),
 commission_minor bigint NOT NULL CHECK(commission_minor>=0),platform_fee_minor bigint NOT NULL CHECK(platform_fee_minor>=0),
 driver_entitlement_minor bigint NOT NULL CHECK(driver_entitlement_minor>0),
 required_credit_minor bigint NOT NULL CHECK(required_credit_minor>=0),
 status text NOT NULL DEFAULT 'held' CHECK(status IN ('held','released','settled')),
 reserve_event_id uuid UNIQUE REFERENCES public.wallet_business_events(id),
 resolution_event_id uuid UNIQUE REFERENCES public.wallet_business_events(id),
 created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz,
 CHECK(required_credit_minor::numeric=commission_minor::numeric+platform_fee_minor::numeric),
 CHECK(customer_charge_minor::numeric=driver_entitlement_minor::numeric+required_credit_minor::numeric),
 CHECK((required_credit_minor=0 AND reserve_event_id IS NULL) OR (required_credit_minor>0 AND reserve_event_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS driver_cash_credit_holds_scope_v1e ON public.driver_cash_credit_holds_v1e(tenant_id,driver_id,currency_code,status);


-- Exact server-parsed table/index templates; incompatible reruns fail atomically.
CREATE TEMP TABLE _b1e_driver_cash_credit_config_v1e(key text PRIMARY KEY,enabled boolean NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE _b1e_driver_cash_credit_enrolments_v1e(
 tenant_id uuid NOT NULL,driver_id uuid NOT NULL,
 country_code text NOT NULL CHECK(country_code ~ '^[A-Z]{2}$'),
 currency_code text NOT NULL CHECK(currency_code ~ '^[A-Z]{3}$'),
 terms_version text NOT NULL CHECK(length(btrim(terms_version)) BETWEEN 1 AND 100),
 consented_at timestamptz NOT NULL,enabled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,driver_id,country_code,currency_code)
) ON COMMIT DROP;
CREATE TEMP TABLE _b1e_driver_cash_credit_holds_v1e(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid NOT NULL UNIQUE,
 tenant_id uuid NOT NULL,driver_id uuid NOT NULL,
 country_code text NOT NULL,currency_code text NOT NULL,fare_snapshot jsonb NOT NULL,
 enrolment_terms_version text NOT NULL,enrolment_consented_at timestamptz NOT NULL,
 customer_charge_minor bigint NOT NULL CHECK(customer_charge_minor>0),
 commission_minor bigint NOT NULL CHECK(commission_minor>=0),platform_fee_minor bigint NOT NULL CHECK(platform_fee_minor>=0),
 driver_entitlement_minor bigint NOT NULL CHECK(driver_entitlement_minor>0),
 required_credit_minor bigint NOT NULL CHECK(required_credit_minor>=0),
 status text NOT NULL DEFAULT 'held' CHECK(status IN ('held','released','settled')),
 reserve_event_id uuid UNIQUE,
 resolution_event_id uuid UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz,
 CHECK(required_credit_minor::numeric=commission_minor::numeric+platform_fee_minor::numeric),
 CHECK(customer_charge_minor::numeric=driver_entitlement_minor::numeric+required_credit_minor::numeric),
 CHECK((required_credit_minor=0 AND reserve_event_id IS NULL) OR (required_credit_minor>0 AND reserve_event_id IS NOT NULL))
) ON COMMIT DROP;
CREATE INDEX _b1e_scope ON _b1e_driver_cash_credit_holds_v1e(tenant_id,driver_id,currency_code,status);
CREATE OR REPLACE FUNCTION pg_temp._b1e_assert_table(a regclass, e regclass)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=a AND relkind='r' AND relpersistence='p' AND pg_get_userbyid(relowner) IN ('postgres','supabase_admin')) THEN
   RAISE EXCEPTION 'Batch 1E: incompatible persistent table %',a;
 END IF;
 IF EXISTS (
   WITH actual AS (SELECT attnum,attname,atttypid,atttypmod,attnotnull,attcollation,attidentity,attgenerated,
      pg_get_expr(d.adbin,d.adrelid) AS def
      FROM pg_attribute x LEFT JOIN pg_attrdef d ON d.adrelid=x.attrelid AND d.adnum=x.attnum
      WHERE x.attrelid=a AND attnum>0 AND NOT attisdropped),
   expected AS (SELECT attnum,attname,atttypid,atttypmod,attnotnull,attcollation,attidentity,attgenerated,
      pg_get_expr(d.adbin,d.adrelid) AS def
      FROM pg_attribute x LEFT JOIN pg_attrdef d ON d.adrelid=x.attrelid AND d.adnum=x.attnum
      WHERE x.attrelid=e AND attnum>0 AND NOT attisdropped)
   (SELECT * FROM actual EXCEPT SELECT * FROM expected) UNION ALL
   (SELECT * FROM expected EXCEPT SELECT * FROM actual)
 ) THEN RAISE EXCEPTION 'Batch 1E: incompatible table columns %',a; END IF;
 IF EXISTS (
   WITH actual AS (SELECT contype,convalidated,condeferrable,condeferred,connoinherit,pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conrelid=a AND contype<>'f'),
   expected AS (SELECT contype,convalidated,condeferrable,condeferred,connoinherit,pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conrelid=e)
   (SELECT * FROM actual EXCEPT SELECT * FROM expected) UNION ALL
   (SELECT * FROM expected EXCEPT SELECT * FROM actual)
 ) THEN RAISE EXCEPTION 'Batch 1E: incompatible table constraints %',a; END IF;
END $$;
CREATE OR REPLACE FUNCTION pg_temp._b1e_assert_index(a regclass, e regclass, t regclass)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF a IS NULL OR NOT EXISTS (
   SELECT 1 FROM pg_index x JOIN pg_class xc ON xc.oid=x.indexrelid,
      pg_index y JOIN pg_class yc ON yc.oid=y.indexrelid
   WHERE x.indexrelid=a AND y.indexrelid=e AND x.indrelid=t
     AND xc.relkind='i' AND xc.relam=yc.relam
     AND x.indisunique=y.indisunique AND x.indisprimary=y.indisprimary
     AND x.indisvalid AND x.indisready AND x.indislive
     AND x.indimmediate=y.indimmediate AND x.indnullsnotdistinct=y.indnullsnotdistinct
     AND x.indnkeyatts=y.indnkeyatts AND x.indnatts=y.indnatts
     AND x.indkey=y.indkey AND x.indclass=y.indclass
     AND x.indcollation=y.indcollation AND x.indoption=y.indoption
     AND pg_get_expr(x.indexprs,x.indrelid) IS NOT DISTINCT FROM pg_get_expr(y.indexprs,y.indrelid)
     AND pg_get_expr(x.indpred,x.indrelid) IS NOT DISTINCT FROM pg_get_expr(y.indpred,y.indrelid)
 ) THEN RAISE EXCEPTION 'Batch 1E: incompatible index %',a; END IF;
END $$;
DO $$
DECLARE t text; x record; n integer;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_policy WHERE polrelid IN ('public.driver_cash_credit_config_v1e'::regclass,'public.driver_cash_credit_enrolments_v1e'::regclass,'public.driver_cash_credit_holds_v1e'::regclass)) THEN RAISE EXCEPTION 'Batch 1E: unexpected cash-credit policy'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.driver_cash_credit_config_v1e'::regclass,'public.driver_cash_credit_enrolments_v1e'::regclass,'public.driver_cash_credit_holds_v1e'::regclass) AND tgname<>'guard_cash_credit_hold_v1e') THEN RAISE EXCEPTION 'Batch 1E: unexpected cash-credit trigger'; END IF;
 FOREACH t IN ARRAY ARRAY['driver_cash_credit_config_v1e','driver_cash_credit_enrolments_v1e','driver_cash_credit_holds_v1e'] LOOP
  PERFORM pg_temp._b1e_assert_table(('public.'||t)::regclass,('pg_temp._b1e_'||t)::regclass);
  FOR x IN SELECT a.conindid,e.conindid AS expected FROM pg_constraint a JOIN pg_constraint e
    ON a.contype=e.contype AND pg_get_constraintdef(a.oid)=pg_get_constraintdef(e.oid)
    WHERE a.conrelid=('public.'||t)::regclass AND e.conrelid=('pg_temp._b1e_'||t)::regclass AND a.contype IN ('p','u')
  LOOP PERFORM pg_temp._b1e_assert_index(x.conindid,x.expected,('public.'||t)::regclass); END LOOP;
 END LOOP;
 PERFORM pg_temp._b1e_assert_index(to_regclass('public.driver_cash_credit_holds_scope_v1e'),'pg_temp._b1e_scope','public.driver_cash_credit_holds_v1e');
 FOR x IN SELECT * FROM (VALUES
  ('driver_cash_credit_enrolments_v1e','driver_id','profiles'),
  ('driver_cash_credit_holds_v1e','driver_id','profiles'),
  ('driver_cash_credit_holds_v1e','job_id','jobs'),
  ('driver_cash_credit_holds_v1e','reserve_event_id','wallet_business_events'),
  ('driver_cash_credit_holds_v1e','resolution_event_id','wallet_business_events')) AS f(tab,col,ref)
 LOOP
  SELECT count(*) INTO n FROM pg_constraint c WHERE c.conrelid=('public.'||x.tab)::regclass AND c.contype='f'
   AND c.confrelid=('public.'||x.ref)::regclass AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
   AND c.confupdtype='a' AND c.confdeltype='a' AND c.confmatchtype='s'
   AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname=x.col)]::smallint[]
   AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='id')]::smallint[];
  IF n<>1 THEN RAISE EXCEPTION 'Batch 1E: incompatible foreign key %.%',x.tab,x.col; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.driver_cash_credit_enrolments_v1e'::regclass AND contype='f')<>1
 OR (SELECT count(*) FROM pg_constraint WHERE conrelid='public.driver_cash_credit_holds_v1e'::regclass AND contype='f')<>4 THEN
  RAISE EXCEPTION 'Batch 1E: unexpected foreign keys'; END IF;
END $$;
CREATE OR REPLACE FUNCTION pg_temp._b1e_assert_trigger(rel regclass,n name,fn regprocedure,typ integer,cols text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE x record; actual_cols text[];
BEGIN
 SELECT * INTO x FROM pg_trigger WHERE tgrelid=rel AND tgname=n;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT coalesce(array_agg(a.attname::text ORDER BY a.attname),ARRAY[]::text[]) INTO actual_cols
 FROM unnest(x.tgattr::smallint[]) u(num) JOIN pg_attribute a ON a.attrelid=rel AND a.attnum=u.num;
 IF x.tgfoid<>fn::oid OR x.tgtype<>typ OR x.tgenabled<>'O' OR x.tgisinternal OR x.tgqual IS NOT NULL OR length(x.tgargs)<>0
    OR actual_cols IS DISTINCT FROM ARRAY(SELECT unnest(cols) ORDER BY 1) THEN
  RAISE EXCEPTION 'Batch 1E: incompatible trigger %',n;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.driver_cash_credit_enabled_v1e() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT enabled FROM public.driver_cash_credit_config_v1e WHERE key='ride_cash_credit'),false) $$;
CREATE OR REPLACE FUNCTION public.driver_cash_credit_lock_v1e(t uuid,d uuid,c text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF t IS NULL OR d IS NULL OR c IS NULL OR c!~'^[A-Z]{3}$' THEN RAISE EXCEPTION 'Invalid credit scope' USING ERRCODE='CE003'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('cash-credit-v1e:'||t::text||':'||d::text||':'||c,0));
END $$;
-- All new ledger events take the same scope lock BEFORE account row locks. This
-- includes existing top-up/reversal routines without changing their bodies.
CREATE OR REPLACE FUNCTION public.serialize_cash_credit_ledger_v1e() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.driver_cash_credit_lock_v1e(NEW.tenant_id,NEW.owner_id,NEW.currency_code); RETURN NEW; END $$;
SELECT pg_temp._b1e_assert_trigger('public.wallet_business_events','serialize_cash_credit_ledger_v1e','public.serialize_cash_credit_ledger_v1e()',7,ARRAY[]::text[]);
DROP TRIGGER IF EXISTS serialize_cash_credit_ledger_v1e ON public.wallet_business_events;
CREATE TRIGGER serialize_cash_credit_ledger_v1e BEFORE INSERT ON public.wallet_business_events
FOR EACH ROW EXECUTE FUNCTION public.serialize_cash_credit_ledger_v1e();

CREATE OR REPLACE FUNCTION public.cash_credit_minor_v1e(v jsonb,c text) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n numeric; factor numeric;
BEGIN
 IF v IS NULL OR jsonb_typeof(v) NOT IN ('number','string') OR (v#>>'{}') !~ '^[0-9]+(\.[0-9]+)?$' THEN
  RAISE EXCEPTION 'Invalid frozen money value' USING ERRCODE='CE003'; END IF;
 factor:=power(10::numeric,public.wallet_currency_minor_exponent(c));
 n:=(v#>>'{}')::numeric*factor;
 IF n IS NULL OR n<>trunc(n) OR n<0 OR n>9223372036854775807 THEN
  RAISE EXCEPTION 'Frozen money is not representable in currency minor units' USING ERRCODE='CE003'; END IF;
 RETURN n::bigint;
END $$;
CREATE OR REPLACE FUNCTION public.cash_credit_terms_v1e(b jsonb,c text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE base bigint; charge bigint; fee bigint; commission bigint; net bigint; rate numeric;
BEGIN
 IF b->>'policyVersion' IS DISTINCT FROM 'fare-split-v1' OR b->>'currency' IS DISTINCT FROM c
 OR b->>'platformFeeType' IS DISTINCT FROM 'percentage' THEN
  RAISE EXCEPTION 'Canonical percentage-mode frozen fare required' USING ERRCODE='CE003'; END IF;
 base:=public.cash_credit_minor_v1e(b->'driverBase',c);
 charge:=public.cash_credit_minor_v1e(b->'customerCharge',c);
 fee:=public.cash_credit_minor_v1e(b->'platformFeeAmount',c);
 commission:=public.cash_credit_minor_v1e(b->'driverCommissionAmount',c);
 net:=public.cash_credit_minor_v1e(b->'driverEntitlement',c);
 IF base<=0 OR net<=0 OR charge::numeric<>base::numeric+fee::numeric OR net::numeric+commission::numeric<>base::numeric THEN
  RAISE EXCEPTION 'Unbalanced frozen cash fare' USING ERRCODE='CE003'; END IF;
 IF b->>'commissionPercent' IS NULL OR b->>'platformFeePercent' IS NULL
 OR b->>'commissionPercent' !~ '^[0-9]+(\.[0-9]+)?$' OR b->>'platformFeePercent' !~ '^[0-9]+(\.[0-9]+)?$' THEN
  RAISE EXCEPTION 'Frozen fee percentages missing' USING ERRCODE='CE003'; END IF;
 IF (b->>'commissionPercent')::numeric>=100 OR (b->>'platformFeePercent')::numeric>=100
 OR public.cash_credit_minor_v1e(b->'platformFeeFixed',c)<>0 THEN
  RAISE EXCEPTION 'Invalid percentage fee policy' USING ERRCODE='CE003'; END IF;
 IF b ? 'driverCommissionPolicy' AND b->'driverCommissionPolicy'->>'frozen' IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'Driver-specific commission must be frozen before cash acceptance' USING ERRCODE='CE003'; END IF;
 RETURN jsonb_build_object('charge',charge,'commission',commission,'fee',fee,'net',net,'required',commission::numeric+fee::numeric);
END $$;

-- Only linked, unreversed, credited 1C driver deposits can authorize cash credit.
-- Diagnostic movements, legacy wallets, earnings and promotions are not deposits.
CREATE OR REPLACE FUNCTION public.driver_cash_credit_balance_v1e(t uuid,d uuid,c text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE eligible numeric; used numeric; held numeric; ledger_available numeric; ledger_reserved numeric; available numeric; deficit numeric;
BEGIN
 PERFORM public.driver_cash_credit_lock_v1e(t,d,c);
 SELECT coalesce(sum(a.amount_minor::numeric),0) INTO eligible
 FROM public.wallet_topup_attempts a JOIN public.wallet_business_events e ON e.id=a.credited_event_id
 WHERE a.tenant_id=t AND a.owner_id=d AND a.currency_code=c AND a.status='credited'
 AND a.destination_account_purpose='driver_cash_credit' AND e.operation='topup'
 AND e.event_key='wallet-topup:'||a.id::text AND e.tenant_id=t AND e.owner_id=d AND e.currency_code=c
 AND e.payment_provider=a.payment_provider AND e.merchant_account_ref=a.merchant_account_ref AND e.provider_reference=a.provider_reference
 AND e.entries=jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit','amountMinor',a.amount_minor),jsonb_build_object('accountPurpose','platform_funding','amountMinor',-a.amount_minor))
 AND NOT EXISTS(SELECT 1 FROM public.wallet_business_events r WHERE r.reverses_event_id=e.id);
 SELECT coalesce(sum(required_credit_minor::numeric) FILTER(WHERE status IN ('held','settled')),0),
        coalesce(sum(required_credit_minor::numeric) FILTER(WHERE status='held'),0)
 INTO used,held FROM public.driver_cash_credit_holds_v1e WHERE tenant_id=t AND driver_id=d AND currency_code=c;
 SELECT coalesce(sum(m.amount_minor::numeric) FILTER(WHERE a.balance_purpose='driver_cash_credit'),0),
        coalesce(sum(m.amount_minor::numeric) FILTER(WHERE a.balance_purpose='driver_cash_credit_reserved'),0)
 INTO ledger_available,ledger_reserved FROM public.wallet_accounts a JOIN public.wallet_movements m ON m.account_id=a.id
 WHERE a.tenant_id=t AND a.owner_id=d AND a.currency_code=c;
 available:=greatest(least(eligible-used,ledger_available),0);
 deficit:=greatest(used-eligible,-ledger_available,0);
 RETURN jsonb_build_object('eligibleDepositsMinor',eligible::text,'availableMinor',available::text,'heldMinor',held::text,
 'deficitMinor',deficit::text,'consistent',held=ledger_reserved,'currency',c);
END $$;

CREATE OR REPLACE FUNCTION public.guard_cash_credit_hold_v1e() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cash credit history cannot be deleted' USING ERRCODE='CE005'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','resolution_event_id','resolved_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','resolution_event_id','resolved_at'])
 OR OLD.status<>'held' OR NEW.status NOT IN ('released','settled') THEN
  RAISE EXCEPTION 'Cash credit terms/history are frozen' USING ERRCODE='CE005'; END IF;
 RETURN NEW;
END $$;
SELECT pg_temp._b1e_assert_trigger('public.driver_cash_credit_holds_v1e','guard_cash_credit_hold_v1e','public.guard_cash_credit_hold_v1e()',27,ARRAY[]::text[]);
DROP TRIGGER IF EXISTS guard_cash_credit_hold_v1e ON public.driver_cash_credit_holds_v1e;
CREATE TRIGGER guard_cash_credit_hold_v1e BEFORE UPDATE OR DELETE ON public.driver_cash_credit_holds_v1e
FOR EACH ROW EXECUTE FUNCTION public.guard_cash_credit_hold_v1e();

CREATE OR REPLACE FUNCTION public.reserve_cash_job_credit_v1e(p_job_id uuid,p_driver_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.jobs%ROWTYPE; enrol public.driver_cash_credit_enrolments_v1e%ROWTYPE; p jsonb; terms jsonb; balance jsonb; h public.driver_cash_credit_holds_v1e%ROWTYPE; v_id uuid; event uuid; need bigint; driver uuid;
BEGIN
 IF NOT public.driver_cash_credit_enabled_v1e() THEN RAISE EXCEPTION 'Cash credit pilot disabled' USING ERRCODE='CE001'; END IF;
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 driver:=coalesce(j.driver_id,j.accepted_driver_id);
 IF driver IS DISTINCT FROM p_driver_id OR p_driver_id IS NULL OR (j.driver_id IS NOT NULL AND j.accepted_driver_id IS NOT NULL AND j.driver_id<>j.accepted_driver_id)
 OR j.payment_method IS DISTINCT FROM 'cash' OR j.status IS NULL OR j.status NOT IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived','in_progress','completed','delivered','settled') THEN
  RAISE EXCEPTION 'Cash booking/driver is not eligible' USING ERRCODE='CE002'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.service_types WHERE id=j.service_type_id AND slug='ride') THEN
  RAISE EXCEPTION 'Cash credit pilot supports Ride only' USING ERRCODE='CE002'; END IF;
 PERFORM public.driver_cash_credit_lock_v1e(j.tenant_id,p_driver_id,j.currency_code);
 SELECT to_jsonb(x) INTO p FROM public.profiles x WHERE id=p_driver_id;
 SELECT * INTO enrol FROM public.driver_cash_credit_enrolments_v1e WHERE tenant_id=j.tenant_id AND driver_id=p_driver_id AND country_code=j.country_code AND currency_code=j.currency_code FOR SHARE;
 IF p IS NULL OR p->>'role' IS DISTINCT FROM 'driver' OR NULLIF(p->>'registration_activated_at','') IS NULL
 OR NOT public.driver_job_market_matches_v23(p,to_jsonb(j))
 OR NOT EXISTS(SELECT 1 FROM public.market_availability m WHERE m.country_code=j.country_code AND upper(m.supported_currency)=j.currency_code)
 OR enrol.driver_id IS NULL OR NOT enrol.enabled OR enrol.consented_at>now() THEN
  RAISE EXCEPTION 'Driver cash credit is not approved for this tenant/market' USING ERRCODE='CE002'; END IF;
 terms:=public.cash_credit_terms_v1e(j.fare_breakdown,j.currency_code);need:=(terms->>'required')::bigint;
 IF j.fare_breakdown ? 'driverCommissionPolicy' AND j.fare_breakdown->'driverCommissionPolicy'->>'driverId' IS DISTINCT FROM p_driver_id::text THEN
  RAISE EXCEPTION 'Frozen commission belongs to another driver' USING ERRCODE='CE003'; END IF;
 IF j.agreed_fare IS NOT NULL AND public.cash_credit_minor_v1e(to_jsonb(j.agreed_fare),j.currency_code)<>(terms->>'charge')::bigint THEN
  RAISE EXCEPTION 'Agreed fare does not match frozen cash terms' USING ERRCODE='CE003'; END IF;
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=j.id FOR UPDATE;
 IF FOUND THEN
  IF h.driver_id<>p_driver_id OR h.tenant_id<>j.tenant_id OR h.currency_code<>j.currency_code OR h.country_code<>j.country_code OR h.fare_snapshot IS DISTINCT FROM j.fare_breakdown OR h.status='released' THEN
   RAISE EXCEPTION 'Cash reservation replay terms changed' USING ERRCODE='CE005'; END IF;
  RETURN h.id;
 END IF;
 IF j.metadata->>'cash_collection_mode' IS DISTINCT FROM 'full_customer_charge' OR j.payment_intent_id IS NOT NULL OR j.payment_status IS NULL OR j.payment_status NOT IN ('pending','cash_due','cash_pending') THEN
  RAISE EXCEPTION 'Explicit full-cash custody and no digital payment required' USING ERRCODE='CE002'; END IF;
 IF j.status IN ('completed','delivered','settled') THEN RAISE EXCEPTION 'Cannot create a new cash hold after completion' USING ERRCODE='CE006'; END IF;
 balance:=public.driver_cash_credit_balance_v1e(j.tenant_id,p_driver_id,j.currency_code);
 IF NOT (balance->>'consistent')::boolean OR (balance->>'deficitMinor')::numeric>0 THEN RAISE EXCEPTION 'Cash credit requires reconciliation' USING ERRCODE='CE006'; END IF;
 IF (balance->>'availableMinor')::numeric<need THEN RAISE EXCEPTION 'Top up driver cash credit before accepting this cash ride' USING ERRCODE='CE004'; END IF;
 v_id:=gen_random_uuid();
 IF need>0 THEN
  event:=public.post_wallet_event('cash-hold:'||v_id::text,'cash_credit_reserve',j.tenant_id,p_driver_id,j.currency_code,
   jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit','amountMinor',-need),jsonb_build_object('accountPurpose','driver_cash_credit_reserved','amountMinor',need)));
 END IF;
 INSERT INTO public.driver_cash_credit_holds_v1e(id,job_id,tenant_id,driver_id,country_code,currency_code,fare_snapshot,enrolment_terms_version,enrolment_consented_at,customer_charge_minor,commission_minor,platform_fee_minor,driver_entitlement_minor,required_credit_minor,reserve_event_id)
 VALUES(v_id,j.id,j.tenant_id,p_driver_id,j.country_code,j.currency_code,j.fare_breakdown,enrol.terms_version,enrol.consented_at,(terms->>'charge')::bigint,(terms->>'commission')::bigint,(terms->>'fee')::bigint,(terms->>'net')::bigint,need,event);
 RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_cash_job_credit_v1e(p_job_id uuid,p_outcome text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.jobs%ROWTYPE; h public.driver_cash_credit_holds_v1e%ROWTYPE; event uuid; reserved numeric;
BEGIN
 SELECT * INTO STRICT j FROM public.jobs WHERE id=p_job_id FOR UPDATE;
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=p_job_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cash hold missing' USING ERRCODE='CE006'; END IF;
 PERFORM public.driver_cash_credit_lock_v1e(h.tenant_id,h.driver_id,h.currency_code);
 IF p_outcome IS NULL OR p_outcome NOT IN ('released','settled') THEN RAISE EXCEPTION 'Invalid cash resolution' USING ERRCODE='CE003'; END IF;
 IF p_outcome='released' AND (j.status IS NULL OR j.status NOT IN ('cancelled','canceled','expired','failed','no_driver_found')) THEN RAISE EXCEPTION 'Only cancelled/failed cash rides release credit' USING ERRCODE='CE006'; END IF;
 IF p_outcome='settled' AND (j.status IS NULL OR j.status NOT IN ('completed','delivered','settled') OR coalesce(j.driver_id,j.accepted_driver_id) IS DISTINCT FROM h.driver_id OR j.payment_method IS DISTINCT FROM 'cash' OR j.fare_breakdown IS DISTINCT FROM h.fare_snapshot OR j.tenant_id<>h.tenant_id OR j.currency_code<>h.currency_code OR j.country_code<>h.country_code) THEN
  RAISE EXCEPTION 'Cash completion terms/state mismatch' USING ERRCODE='CE006'; END IF;
 IF h.status=p_outcome THEN RETURN h.id; END IF;
 IF h.status<>'held' THEN RAISE EXCEPTION 'Cash hold already resolved differently' USING ERRCODE='CE005'; END IF;
 SELECT coalesce(sum(m.amount_minor::numeric),0) INTO reserved FROM public.wallet_accounts a JOIN public.wallet_movements m ON m.account_id=a.id
 WHERE a.tenant_id=h.tenant_id AND a.owner_id=h.driver_id AND a.currency_code=h.currency_code AND a.balance_purpose='driver_cash_credit_reserved';
 IF reserved IS DISTINCT FROM (SELECT coalesce(sum(required_credit_minor::numeric),0) FROM public.driver_cash_credit_holds_v1e WHERE tenant_id=h.tenant_id AND driver_id=h.driver_id AND currency_code=h.currency_code AND status='held') OR reserved<h.required_credit_minor THEN RAISE EXCEPTION 'Cash reserved ledger requires reconciliation' USING ERRCODE='CE006'; END IF;
 IF h.required_credit_minor>0 THEN
  IF p_outcome='released' THEN event:=public.post_wallet_reversal('cash-hold:'||h.id::text,'cash-hold:'||h.id::text||':release');
  ELSE event:=public.post_wallet_event('cash-hold:'||h.id::text||':settle','cash_credit_settle',h.tenant_id,h.driver_id,h.currency_code,
    jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit_reserved','amountMinor',-h.required_credit_minor),jsonb_build_object('accountPurpose','cash_fee_clearing','amountMinor',h.required_credit_minor)));
  END IF;
 END IF;
 UPDATE public.driver_cash_credit_holds_v1e SET status=p_outcome,resolution_event_id=event,resolved_at=now() WHERE id=h.id;
 RETURN h.id;
END $$;

-- AFTER existing fare/commission BEFORE triggers: final driver-specific fees win.
CREATE OR REPLACE FUNCTION public.cash_credit_service_writer_v1e() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT current_setting('role',true)='service_role' OR
  (session_user IN ('postgres','supabase_admin') AND current_setting('role',true) IN ('none','postgres','supabase_admin')) $$;
CREATE OR REPLACE FUNCTION public.enforce_ride_cash_credit_v1e() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h public.driver_cash_credit_holds_v1e%ROWTYPE; driver uuid; slug text;
BEGIN
 SELECT * INTO h FROM public.driver_cash_credit_holds_v1e WHERE job_id=NEW.id;
 IF FOUND THEN
  IF NOT public.cash_credit_service_writer_v1e() THEN RAISE EXCEPTION 'Cash transitions require the server role' USING ERRCODE='CE002'; END IF;
  IF NEW.status IS NULL THEN RAISE EXCEPTION 'Cash booking status missing' USING ERRCODE='CE006'; END IF;
  IF NEW.status IN ('cancelled','canceled','expired','failed','no_driver_found') THEN
   IF h.status='settled' THEN RAISE EXCEPTION 'Settled cash ride requires refund review' USING ERRCODE='CE005'; END IF;
   IF h.status='held' THEN PERFORM public.resolve_cash_job_credit_v1e(NEW.id,'released'); END IF;
   RETURN NEW;
  END IF;
  IF h.status='released' OR (h.status='settled' AND NEW.status NOT IN ('completed','delivered','settled')) THEN RAISE EXCEPTION 'Resolved cash ride cannot reopen' USING ERRCODE='CE005'; END IF;
  IF NEW.driver_id IS NOT NULL AND NEW.accepted_driver_id IS NOT NULL AND NEW.driver_id<>NEW.accepted_driver_id THEN RAISE EXCEPTION 'Conflicting accepted drivers' USING ERRCODE='CE005'; END IF;
  IF NEW.metadata->>'cash_collection_mode' IS DISTINCT FROM 'full_customer_charge' OR NEW.payment_intent_id IS NOT NULL THEN RAISE EXCEPTION 'Cash custody/payment mode changed' USING ERRCODE='CE005'; END IF;
  IF NEW.payment_method IS DISTINCT FROM 'cash' OR NEW.fare_breakdown IS DISTINCT FROM h.fare_snapshot
     OR NEW.tenant_id IS DISTINCT FROM h.tenant_id OR NEW.currency_code IS DISTINCT FROM h.currency_code
     OR NEW.country_code IS DISTINCT FROM h.country_code OR coalesce(NEW.driver_id,NEW.accepted_driver_id) IS DISTINCT FROM h.driver_id THEN
   RAISE EXCEPTION 'Cash reservation requires explicit reconciliation before changing terms' USING ERRCODE='CE005'; END IF;
  IF NEW.status IN ('completed','delivered','settled') AND h.status='held' THEN PERFORM public.resolve_cash_job_credit_v1e(NEW.id,'settled'); END IF;
  RETURN NEW;
 END IF;
 IF NOT public.driver_cash_credit_enabled_v1e() OR NEW.payment_method IS DISTINCT FROM 'cash' THEN RETURN NEW; END IF;
 SELECT st.slug INTO slug FROM public.service_types st WHERE st.id=NEW.service_type_id;
 IF slug IS DISTINCT FROM 'ride' THEN RETURN NEW; END IF;
 IF NOT public.cash_credit_service_writer_v1e() THEN RAISE EXCEPTION 'Cash acceptance requires the server role' USING ERRCODE='CE002'; END IF;
 driver:=coalesce(NEW.driver_id,NEW.accepted_driver_id);
 IF driver IS NOT NULL AND NEW.status IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived','in_progress','completed','delivered','settled') THEN
  PERFORM public.reserve_cash_job_credit_v1e(NEW.id,driver);
 END IF;
 RETURN NEW;
END $$;
SELECT pg_temp._b1e_assert_trigger('public.jobs','enforce_ride_cash_credit_v1e','public.enforce_ride_cash_credit_v1e()',21,ARRAY['driver_id','accepted_driver_id','status','payment_method','payment_intent_id','metadata','fare_breakdown','tenant_id','country_code','currency_code']);
DROP TRIGGER IF EXISTS enforce_ride_cash_credit_v1e ON public.jobs;
CREATE TRIGGER enforce_ride_cash_credit_v1e AFTER INSERT OR UPDATE OF driver_id,accepted_driver_id,status,payment_method,payment_intent_id,metadata,fare_breakdown,tenant_id,country_code,currency_code
ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.enforce_ride_cash_credit_v1e();

ALTER TABLE public.driver_cash_credit_config_v1e ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_cash_credit_enrolments_v1e ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_cash_credit_holds_v1e ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_cash_credit_config_v1e,public.driver_cash_credit_enrolments_v1e,public.driver_cash_credit_holds_v1e FROM PUBLIC,anon,authenticated,service_role;
DO $$ DECLARE t text;x record; BEGIN
 FOREACH t IN ARRAY ARRAY['driver_cash_credit_config_v1e','driver_cash_credit_enrolments_v1e','driver_cash_credit_holds_v1e'] LOOP
  FOR x IN SELECT attname FROM pg_attribute WHERE attrelid=('public.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE SELECT(%I),INSERT(%I),UPDATE(%I),REFERENCES(%I) ON public.%I FROM PUBLIC,anon,authenticated,service_role',x.attname,x.attname,x.attname,x.attname,t);
  END LOOP;
 END LOOP;
END $$;
GRANT SELECT ON public.driver_cash_credit_holds_v1e TO service_role;
DO $$ DECLARE sig text; BEGIN
 FOREACH sig IN ARRAY ARRAY[
 'driver_cash_credit_enabled_v1e()','driver_cash_credit_lock_v1e(uuid,uuid,text)',
 'serialize_cash_credit_ledger_v1e()','cash_credit_minor_v1e(jsonb,text)',
 'cash_credit_terms_v1e(jsonb,text)','driver_cash_credit_balance_v1e(uuid,uuid,text)',
 'guard_cash_credit_hold_v1e()','reserve_cash_job_credit_v1e(uuid,uuid)',
 'resolve_cash_job_credit_v1e(uuid,text)','enforce_ride_cash_credit_v1e()','cash_credit_service_writer_v1e()'] LOOP
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND p.proname=split_part(sig,'(',1) AND p.oid<>to_regprocedure('public.'||sig)) THEN RAISE EXCEPTION 'Batch 1E: unexpected overload %',sig; END IF;
  IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=to_regprocedure('public.'||sig)) NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION 'Batch 1E: untrusted function owner'; END IF;
  EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role',sig);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.driver_cash_credit_enabled_v1e(),public.driver_cash_credit_balance_v1e(uuid,uuid,text),public.reserve_cash_job_credit_v1e(uuid,uuid),public.resolve_cash_job_credit_v1e(uuid,text) TO service_role;
DO $$ DECLARE r text;t text;f record;x record; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  FOREACH t IN ARRAY ARRAY['driver_cash_credit_config_v1e','driver_cash_credit_enrolments_v1e','driver_cash_credit_holds_v1e'] LOOP
   IF has_table_privilege(r,'public.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN RAISE EXCEPTION 'Batch 1E: unexpected inherited client table access'; END IF;
   FOR x IN SELECT attname FROM pg_attribute WHERE attrelid=('public.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
    IF has_column_privilege(r,'public.'||t,x.attname,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Batch 1E: unexpected inherited client column access'; END IF;
   END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND right(p.proname,4)='_v1e' AND p.proname IN
   ('driver_cash_credit_enabled_v1e','driver_cash_credit_lock_v1e','serialize_cash_credit_ledger_v1e','cash_credit_minor_v1e','cash_credit_terms_v1e','driver_cash_credit_balance_v1e','guard_cash_credit_hold_v1e','reserve_cash_job_credit_v1e','resolve_cash_job_credit_v1e','enforce_ride_cash_credit_v1e','cash_credit_service_writer_v1e')
  LOOP IF has_function_privilege(r,f.oid,'EXECUTE') THEN RAISE EXCEPTION 'Batch 1E: unexpected inherited client RPC access'; END IF; END LOOP;
 END LOOP;
 IF public.wallet_collection_enabled() IS DISTINCT FROM false THEN RAISE EXCEPTION 'Batch 1E: collection must remain disabled'; END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
