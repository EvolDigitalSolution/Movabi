-- Run after the UNCHANGED activation body, before the outer COMMIT or ROLLBACK.
CREATE TEMP TABLE p8_activation_after(kind text,id text,row jsonb) ON COMMIT DROP;
INSERT INTO p8_activation_after
 SELECT 'strategy',id::text,to_jsonb(s) FROM public.market_pricing_strategies s UNION ALL
 SELECT 'pricing',id::text,to_jsonb(p) FROM public.pricing_config p UNION ALL
 SELECT 'ai',country_code,to_jsonb(m) FROM public.pricing_markets m UNION ALL
 SELECT 'setting',id::text,to_jsonb(s) FROM public.marketplace_settings s UNION ALL
 SELECT 'profile',id::text,to_jsonb(p) FROM public.profiles p UNION ALL
 SELECT 'campaign',id::text,to_jsonb(c) FROM public.campaigns c UNION ALL
 SELECT 'policy',id::text,to_jsonb(c) FROM public.cancellation_policies c;
DO $isolation$ DECLARE b record; a jsonb; allowed boolean; inherited jsonb; BEGIN
 FOR b IN SELECT * FROM p8_activation_before LOOP
  SELECT row INTO a FROM p8_activation_after WHERE kind=b.kind AND id=b.id;
  IF a IS NULL THEN RAISE EXCEPTION 'activation deleted pre-existing % row %',b.kind,b.id; END IF;
  IF b.kind='strategy' AND (b.row->>'id')::uuid IN(SELECT id FROM p8_expected) THEN
    IF a IS DISTINCT FROM (b.row||'{"maximum_surge_multiplier":1.5,"normal_demand_multiplier":1,"busy_multiplier":null}'::jsonb) THEN RAISE EXCEPTION 'unrelated GB strategy fields changed'; END IF;
  ELSIF b.kind='pricing' AND nullif(btrim(b.row->>'country_code'),'') IS NULL AND a->>'country_code'='GB' THEN
    -- The separate reviewed four-ID scope correction already asserts its manifest; no other
    -- pricing fields may change here, and an unreviewed promotion is refused below.
    IF to_regclass('pg_temp.intended_uk') IS NULL THEN RAISE EXCEPTION 'unreviewed pricing country correction'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_temp.intended_uk WHERE id=(b.row->>'id')::uuid) OR (a-'country_code') IS DISTINCT FROM (b.row-'country_code') THEN RAISE EXCEPTION 'pricing correction escaped its captured IDs/fields'; END IF;
  ELSIF b.kind='setting' AND (b.row->>'tenant_id')::uuid IN(SELECT tenant_id FROM gb_tenants)
    AND b.row->>'key' IN('completion_pin_policy','smart_matching','dynamic_pricing','quote_tenant_binding') THEN
    IF (a-ARRAY['value','updated_at']) IS DISTINCT FROM (b.row-ARRAY['value','updated_at'])
      OR ((a->'value')-'markets') IS DISTINCT FROM ((b.row->'value')-'markets')
      OR (coalesce(a#>'{value,markets}','{}')-'GB') IS DISTINCT FROM (coalesce(b.row#>'{value,markets}','{}')-'GB') THEN
      RAISE EXCEPTION 'settings change escaped markets.GB';
    END IF;
  ELSIF b.kind='campaign' AND b.row->>'market_code'='GB' AND (b.row->>'tenant_id')::uuid IN(SELECT tenant_id FROM gb_tenants)
    AND b.row->>'code' IN('FIRST5GB','REFERGB') THEN
    IF (a-ARRAY['enabled','paused']) IS DISTINCT FROM (b.row-ARRAY['enabled','paused']) THEN RAISE EXCEPTION 'existing campaign money/history changed'; END IF;
  ELSIF b.row IS DISTINCT FROM a THEN
    RAISE EXCEPTION 'unrelated % row % changed (includes NG, AI, profiles and pricing)',b.kind,b.id;
  END IF;
 END LOOP;
 FOR b IN SELECT x.* FROM p8_activation_after x LEFT JOIN p8_activation_before y USING(kind,id) WHERE y.id IS NULL LOOP
  allowed:= b.kind IN('setting','campaign','policy') AND (b.row->>'tenant_id')::uuid IN(SELECT tenant_id FROM gb_tenants);
  IF b.kind IN('campaign','policy') THEN allowed:=allowed AND b.row->>'market_code'='GB'; END IF;
  IF b.kind='setting' THEN
    SELECT value INTO inherited FROM p8_inherited_settings WHERE new_id=(b.row->>'id')::uuid;
    inherited:=coalesce(inherited,'{}'::jsonb);
    allowed:=allowed AND b.row->>'key' IN('completion_pin_policy','smart_matching','dynamic_pricing','quote_tenant_binding')
      AND (b.row->'value') ? 'markets' AND (b.row#>'{value,markets}') ? 'GB'
      AND ((b.row->'value')-'markets') IS NOT DISTINCT FROM (inherited-'markets')
      AND ((b.row#>'{value,markets}')-'GB') IS NOT DISTINCT FROM (coalesce(inherited->'markets','{}'::jsonb)-'GB');
  END IF;
  IF allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'unrelated new % row %',b.kind,b.id; END IF;
 END LOOP;
 RAISE NOTICE 'P8_ACTIVATION_ISOLATION_OK: other markets, profiles, AI shadow and all unrelated fields unchanged';
END $isolation$;
