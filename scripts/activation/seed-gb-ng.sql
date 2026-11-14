-- Rehearsal fixture (disposable database only): a GB tenant and an NG tenant, as on develop, with the
-- active ride price rows the activation reads. Committed so activate-gb.sql runs exactly as on the host.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.tenants(id,name,slug) VALUES ('6b000000-0000-4000-8000-0000000000aa','gb','act-gb'),('6b000000-0000-4000-8000-0000000000bb','ng','act-ng');
INSERT INTO auth.users(id,email) VALUES ('6c000000-0000-4000-8000-0000000000c1','gb-c1@act.test'),('6c000000-0000-4000-8000-0000000000c2','gb-c2@act.test'),('6d000000-0000-4000-8000-0000000000d1','gb-driver@act.test'),('6e000000-0000-4000-8000-0000000000e1','ng-customer@act.test');
INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_country_code) VALUES
 ('6c000000-0000-4000-8000-0000000000c1','6b000000-0000-4000-8000-0000000000aa','customer','GB','GB'),
 ('6c000000-0000-4000-8000-0000000000c2','6b000000-0000-4000-8000-0000000000aa','customer','GB','GB'),
 ('6d000000-0000-4000-8000-0000000000d1','6b000000-0000-4000-8000-0000000000aa','driver','GB','GB'),
 ('6e000000-0000-4000-8000-0000000000e1','6b000000-0000-4000-8000-0000000000bb','customer','NG','NG');
INSERT INTO public.market_availability(country_code,launch_status,supported_currency,enabled) VALUES ('GB','live','GBP',true),('NG','live','NGN',true) ON CONFLICT DO NOTHING;
INSERT INTO public.pricing_config(service_type,base_fare,per_km,per_min,service_fee,minimum_fare,currency_code,is_active,country_code)
 VALUES ('ride',2.50,1.20,0.20,0.50,3.00,'GBP',true,'GB'),('ride',500,150,30,100,1500,'NGN',true,'NG');
-- An NG tenant's existing PIN setting that must survive untouched.
INSERT INTO public.marketplace_settings(tenant_id,key,value) VALUES ('6b000000-0000-4000-8000-0000000000bb','completion_pin_policy','{"markets":{"NG":"optional"}}');
COMMIT;
