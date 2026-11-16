-- DEVELOP ONLY. P8 approved 2026-11-14. Snapshot the FOUR existing GB/GBP strategy IDs.
-- Only maximum_surge_multiplier, normal_demand_multiplier and busy_multiplier may change.
-- NULL busy_multiplier removes the fixed-price override and uses the existing demand/supply
-- calculation. Normal demand stays 1.0; the strategy ceiling is 1.5. No new surge formula.
-- Usage: psql -v expected_strategies_json='<full four-row JSON snapshot>' -f this.sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='10s';
DO $guard$ BEGIN IF current_database()<>'movabi_develop' THEN RAISE EXCEPTION 'develop only'; END IF; END $guard$;
LOCK TABLE public.market_pricing_strategies IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE p8_expected ON COMMIT DROP AS
  SELECT * FROM jsonb_populate_recordset(NULL::public.market_pricing_strategies, :'expected_strategies_json'::jsonb);
CREATE TEMP TABLE p8_before ON COMMIT DROP AS SELECT id,to_jsonb(s) AS row FROM public.market_pricing_strategies s;
CREATE TEMP TABLE p8_ai_before ON COMMIT DROP AS SELECT country_code,to_jsonb(m) AS row FROM public.pricing_markets m;
CREATE TEMP TABLE p8_triggers_before ON COMMIT DROP AS SELECT oid,tgenabled,pg_get_triggerdef(oid) AS definition
  FROM pg_trigger WHERE tgrelid='public.market_pricing_strategies'::regclass AND NOT tgisinternal;
DO $check$ DECLARE desired jsonb := '{"maximum_surge_multiplier":1.5,"normal_demand_multiplier":1.0,"busy_multiplier":null}'; BEGIN
  IF (SELECT count(*) FROM p8_expected)<>4 OR (SELECT count(DISTINCT id) FROM p8_expected)<>4
     OR (SELECT array_agg(service_type::text ORDER BY service_type) FROM p8_expected)
        IS DISTINCT FROM ARRAY['delivery','errand','ride','van-moving']::text[]
     OR EXISTS(SELECT 1 FROM p8_expected WHERE country_code<>'GB' OR currency<>'GBP') THEN
    RAISE EXCEPTION 'expected exactly the four captured GB/GBP strategies, one per canonical service';
  END IF;
  IF EXISTS(SELECT 1 FROM public.market_pricing_strategies s WHERE upper(s.country_code)='GB' AND s.id NOT IN(SELECT id FROM p8_expected)) THEN
    RAISE EXCEPTION 'additional GB strategies exist; inspect precedence and all scopes before correction';
  END IF;
  IF EXISTS(SELECT 1 FROM p8_expected e LEFT JOIN public.market_pricing_strategies s USING(id)
    WHERE s.id IS NULL OR (to_jsonb(s) IS DISTINCT FROM to_jsonb(e) AND to_jsonb(s) IS DISTINCT FROM (to_jsonb(e)||desired))) THEN
    RAISE EXCEPTION 'strategy changed since snapshot (or only partially reconciled); nothing changed';
  END IF;
  IF EXISTS(SELECT 1 FROM public.pricing_markets WHERE country_code='GB' AND NOT shadow_mode_enabled) THEN
    RAISE EXCEPTION 'GB AI shadow mode is not retained; inspect before correcting P8';
  END IF;
END $check$;
UPDATE public.market_pricing_strategies s
 SET maximum_surge_multiplier=1.5, normal_demand_multiplier=1.0, busy_multiplier=NULL
 WHERE s.id IN(SELECT id FROM p8_expected)
   AND (maximum_surge_multiplier IS DISTINCT FROM 1.5 OR normal_demand_multiplier IS DISTINCT FROM 1.0 OR busy_multiplier IS NOT NULL);
DO $verify$ DECLARE desired jsonb := '{"maximum_surge_multiplier":1.5,"normal_demand_multiplier":1.0,"busy_multiplier":null}'; BEGIN
  IF EXISTS(SELECT 1 FROM public.market_pricing_strategies s JOIN p8_expected e USING(id)
    WHERE to_jsonb(s) IS DISTINCT FROM (to_jsonb(e)||desired)) THEN
    RAISE EXCEPTION 'unrelated strategy fields changed (including timestamp or scope); rolling back';
  END IF;
  IF EXISTS(SELECT 1 FROM p8_before b FULL JOIN public.market_pricing_strategies s USING(id)
    WHERE coalesce(b.id,s.id) NOT IN(SELECT id FROM p8_expected) AND b.row IS DISTINCT FROM to_jsonb(s)) THEN
    RAISE EXCEPTION 'NG/other-market strategy changed; rolling back';
  END IF;
  IF EXISTS(SELECT 1 FROM p8_ai_before b FULL JOIN public.pricing_markets m USING(country_code) WHERE b.row IS DISTINCT FROM to_jsonb(m)) THEN
    RAISE EXCEPTION 'AI market configuration changed; rolling back';
  END IF;
  IF EXISTS((SELECT * FROM p8_triggers_before EXCEPT SELECT oid,tgenabled,pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.market_pricing_strategies'::regclass AND NOT tgisinternal)
    UNION ALL (SELECT oid,tgenabled,pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.market_pricing_strategies'::regclass AND NOT tgisinternal EXCEPT SELECT * FROM p8_triggers_before)) THEN
    RAISE EXCEPTION 'strategy trigger state changed; rolling back';
  END IF;
  INSERT INTO public.audit_logs(user_id,action,entity_type,entity_id,metadata)
  SELECT NULL,'admin_develop_p8_reconciliation','market_pricing_strategy',s.id,
    jsonb_build_object('source','gb-p8-reconciliation-2026-11-16','approval','P8 approved 2026-11-14',
      'operator',session_user,'transaction',txid_current(),'before',to_jsonb(e),'after',to_jsonb(s),
      'demand_supply','existing algorithm; fixed busy override removed','traffic','display only via markets.GB activation setting')
    FROM public.market_pricing_strategies s JOIN p8_expected e USING(id)
    WHERE NOT EXISTS(SELECT 1 FROM public.audit_logs a WHERE a.action='admin_develop_p8_reconciliation' AND a.entity_id=s.id
      AND a.metadata->>'source'='gb-p8-reconciliation-2026-11-16' AND a.metadata->'before'=to_jsonb(e) AND a.metadata->'after'=to_jsonb(s));
  RAISE NOTICE 'P8_STRATEGIES_OK: four captured IDs; cap 1.5, normal 1.0, fixed busy override removed; all unrelated fields and AI/other markets preserved';
END $verify$;
COMMIT;
