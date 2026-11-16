-- Before the UNCHANGED activation body creates a GB tenant setting: preserve its CURRENT
-- effective platform defaults for all other markets. No policy values or platform rows change.
-- getRawSetting uses tenant first, otherwise the newest platform row by created_at.
CREATE TEMP TABLE p8_inherit_tenants ON COMMIT DROP AS SELECT DISTINCT tenant_id FROM public.profiles
 WHERE tenant_id IS NOT NULL AND role IN('customer','driver')
 AND upper(coalesce(nullif(btrim(registration_country_code),''),nullif(btrim(country_code),''),''))='GB';
CREATE TEMP TABLE p8_inherited_settings ON COMMIT DROP AS
 SELECT t.tenant_id,s.id AS platform_id,s.key,s.value,gen_random_uuid() AS new_id
 FROM p8_inherit_tenants t CROSS JOIN LATERAL (
   SELECT DISTINCT ON(key) id,key,value FROM public.marketplace_settings WHERE tenant_id IS NULL
   AND key IN('completion_pin_policy','smart_matching','dynamic_pricing') ORDER BY key,created_at DESC
 ) s WHERE NOT EXISTS(SELECT 1 FROM public.marketplace_settings own WHERE own.tenant_id=t.tenant_id AND own.key=s.key);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM p8_inherited_settings WHERE jsonb_typeof(value)<>'object'
 OR (value ? 'markets' AND jsonb_typeof(value->'markets')<>'object')) THEN
 RAISE EXCEPTION 'platform defaults cannot be copied without changing unrelated semantics'; END IF; END $$;
INSERT INTO public.marketplace_settings(id,tenant_id,key,value)
 SELECT new_id,tenant_id,key,value FROM p8_inherited_settings;
INSERT INTO public.audit_logs(user_id,action,entity_type,entity_id,metadata)
 SELECT NULL,'admin_develop_gb_setting_inheritance','marketplace_setting',new_id,
 jsonb_build_object('source','gb-p8-reconciliation-2026-11-16','operator',session_user,'transaction',txid_current(),
  'tenant',tenant_id,'key',key,'effective_before',jsonb_build_object('scope','platform','row_id',platform_id,'value',value),
  'copied_value',value,'reason','preserve existing non-GB effective defaults before markets.GB activation') FROM p8_inherited_settings;
