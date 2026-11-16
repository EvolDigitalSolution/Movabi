-- API tenant binding and P8 activate under the SAME outer transaction. No global/foreign switch.
DO $binding$ DECLARE t uuid; BEGIN
 FOR t IN SELECT tenant_id FROM gb_tenants LOOP
  PERFORM pg_temp.set_market_key(t,'quote_tenant_binding','GB','{"enabled":true,"policy":"P8"}'::jsonb);
 END LOOP;
END $binding$;
INSERT INTO public.audit_logs(user_id,action,entity_type,entity_id,metadata)
 SELECT NULL,'admin_develop_quote_tenant_activation','marketplace_setting',s.id,
 jsonb_build_object('source','gb-p8-reconciliation-2026-11-16','approval','P8 approved 2026-11-14',
  'operator',session_user,'transaction',txid_current(),'tenant',s.tenant_id,'before',b.row,'after',to_jsonb(s),
  'reason','bind signed-in GB quote to existing native tenant; client payload omits tenantId')
 FROM public.marketplace_settings s LEFT JOIN p8_activation_before b ON b.kind='setting' AND b.id=s.id::text
 WHERE s.key='quote_tenant_binding' AND s.tenant_id IN(SELECT tenant_id FROM gb_tenants);
