-- DEVELOP ONLY. Operator-reviewed snapshot of the FOUR legacy UK national rows described by
-- live evidence: blank country, GBP, one active row for each canonical service, ride min 3.35.
-- This is an explicit data correction, NEVER a currency-to-country rule or a price decision.
-- Usage: psql -v expected_rows_json='<full JSON array captured by the host wrapper>' -f this.sql
-- Only country_code changes. Includes updated_at preservation despite the existing timestamp trigger.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $guard$ BEGIN
  IF current_database() <> 'movabi_develop' THEN RAISE EXCEPTION 'develop only'; END IF;
END $guard$;
-- Blocks concurrent pricing writes while the timestamp trigger is transactionally disabled.
-- A competing writer cannot see or use the disabled-trigger state before it is restored.
LOCK TABLE public.pricing_config IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE intended_uk ON COMMIT DROP AS
  SELECT * FROM jsonb_populate_recordset(NULL::public.pricing_config, :'expected_rows_json'::jsonb);
CREATE TEMP TABLE pricing_before ON COMMIT DROP AS SELECT id, to_jsonb(p) AS row FROM public.pricing_config p;
CREATE TEMP TABLE pricing_triggers_before ON COMMIT DROP AS
  SELECT oid, tgenabled, pg_get_triggerdef(oid) AS definition FROM pg_trigger
   WHERE tgrelid='public.pricing_config'::regclass AND NOT tgisinternal;
DO $check$ BEGIN
  IF (SELECT count(*) FROM intended_uk) <> 4 OR (SELECT count(DISTINCT id) FROM intended_uk) <> 4
     OR (SELECT array_agg(service_type ORDER BY service_type) FROM intended_uk)
        IS DISTINCT FROM ARRAY['delivery','errand','ride','van-moving']::text[] THEN
    RAISE EXCEPTION 'snapshot must contain exactly four distinct intended UK rows, one per canonical service';
  END IF;
  IF EXISTS (SELECT 1 FROM intended_uk WHERE nullif(btrim(country_code),'') IS NOT NULL
      OR currency_code <> 'GBP' OR NOT is_active OR nullif(btrim(market_city),'') IS NOT NULL
      OR nullif(btrim(zone_id),'') IS NOT NULL)
     OR (SELECT minimum_fare FROM intended_uk WHERE service_type='ride') IS DISTINCT FROM 3.35::numeric THEN
    RAISE EXCEPTION 'snapshot differs from the live-evidenced legacy UK shape (including ride minimum 3.35); nothing changed';
  END IF;
  IF EXISTS (SELECT 1 FROM intended_uk e LEFT JOIN public.pricing_config p USING(id)
      WHERE p.id IS NULL OR (to_jsonb(p)-'country_code') IS DISTINCT FROM (to_jsonb(e)-'country_code')
        OR NOT (p.country_code IS NOT DISTINCT FROM e.country_code OR p.country_code='GB')) THEN
    RAISE EXCEPTION 'intended pricing row missing or changed since snapshot; nothing changed';
  END IF;
  -- Reject even case/whitespace variants of a conflicting GB national row, regardless of activity.
  -- The existing unique index does not normalise country whitespace/case and is not sufficient alone.
  IF EXISTS (SELECT 1 FROM public.pricing_config p
      WHERE upper(btrim(p.country_code))='GB' AND nullif(btrim(p.market_city),'') IS NULL
        AND nullif(btrim(p.zone_id),'') IS NULL AND p.service_type IN (SELECT service_type FROM intended_uk)
        AND p.id NOT IN (SELECT id FROM intended_uk)) THEN
    RAISE EXCEPTION 'conflicting explicit GB pricing row exists; nothing changed';
  END IF;
  IF (SELECT count(*) FROM public.pricing_config WHERE id IN(SELECT id FROM intended_uk) AND country_code='GB') NOT IN (0,4) THEN
    RAISE EXCEPTION 'mixed partially corrected pricing state; nothing changed';
  END IF;
  -- A rerun is accepted only when this exact correction already audited every intended row.
  IF EXISTS (SELECT 1 FROM public.pricing_config p JOIN intended_uk e USING(id)
      WHERE p.country_code='GB' AND NOT EXISTS(SELECT 1 FROM public.audit_logs a
        WHERE a.action='admin_develop_pricing_scope' AND a.entity_type='pricing_config' AND a.entity_id=p.id
          AND a.metadata->>'source'='legacy-gb-scope-2026-11-16'
          AND a.metadata->'before'=to_jsonb(e) AND a.metadata->'after'=to_jsonb(p))) THEN
    RAISE EXCEPTION 'explicit GB state is not the audited correction of this snapshot; nothing changed';
  END IF;
END $check$;

DO $correct$ DECLARE trigger_state "char"; changed integer; BEGIN
  SELECT tgenabled INTO trigger_state FROM pg_trigger
    WHERE tgrelid='public.pricing_config'::regclass AND tgname='trg_pricing_config_updated_at' AND NOT tgisinternal;
  IF trigger_state IS NOT NULL AND trigger_state <> 'D' THEN
    ALTER TABLE public.pricing_config DISABLE TRIGGER trg_pricing_config_updated_at;
  END IF;
  UPDATE public.pricing_config SET country_code='GB'
    WHERE id IN(SELECT id FROM intended_uk) AND nullif(btrim(country_code),'') IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed NOT IN (0,4) THEN RAISE EXCEPTION 'expected zero or four corrected rows, got %',changed; END IF;
  IF trigger_state='O' THEN ALTER TABLE public.pricing_config ENABLE TRIGGER trg_pricing_config_updated_at;
  ELSIF trigger_state='A' THEN ALTER TABLE public.pricing_config ENABLE ALWAYS TRIGGER trg_pricing_config_updated_at;
  ELSIF trigger_state='R' THEN ALTER TABLE public.pricing_config ENABLE REPLICA TRIGGER trg_pricing_config_updated_at;
  END IF;

  IF EXISTS(SELECT 1 FROM public.pricing_config p JOIN intended_uk e USING(id)
      WHERE p.country_code IS DISTINCT FROM 'GB'
        OR (to_jsonb(p)-'country_code') IS DISTINCT FROM (to_jsonb(e)-'country_code')) THEN
    RAISE EXCEPTION 'pricing fields other than country_code changed; rolling back';
  END IF;
  IF EXISTS(SELECT 1 FROM pricing_before b FULL JOIN public.pricing_config p USING(id)
      WHERE coalesce(p.id,b.id) NOT IN(SELECT id FROM intended_uk) AND b.row IS DISTINCT FROM to_jsonb(p)) THEN
    RAISE EXCEPTION 'unrelated pricing (including NG) changed; rolling back';
  END IF;
  IF EXISTS((SELECT oid,tgenabled,definition FROM pricing_triggers_before EXCEPT
      SELECT oid,tgenabled,pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.pricing_config'::regclass AND NOT tgisinternal)
    UNION ALL
    (SELECT oid,tgenabled,pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.pricing_config'::regclass AND NOT tgisinternal EXCEPT
      SELECT oid,tgenabled,definition FROM pricing_triggers_before)) THEN
    RAISE EXCEPTION 'pricing trigger state changed; rolling back';
  END IF;
  IF changed=4 THEN
    INSERT INTO public.audit_logs(user_id,action,entity_type,entity_id,metadata)
      SELECT NULL,'admin_develop_pricing_scope','pricing_config',p.id,
        jsonb_build_object('source','legacy-gb-scope-2026-11-16','reason','operator-confirmed legacy UK pricing scope',
          'operator',session_user,'transaction',txid_current(),'before',to_jsonb(e),'after',to_jsonb(p),
          'preserved','IDs, rates, minimum fare and all other fields including updated_at')
      FROM public.pricing_config p JOIN intended_uk e USING(id);
  END IF;
  RAISE NOTICE 'PRICING_SCOPE_CORRECTION_OK changed=%; all other pricing fields, NG rows and trigger state preserved',changed;
END $correct$;
SELECT id,service_type,country_code,currency_code,minimum_fare,updated_at
 FROM public.pricing_config WHERE id IN(SELECT id FROM intended_uk) ORDER BY service_type;
COMMIT;
