-- SYNTHETIC develop-like application data for the local reproduction of the host restore drill.
-- No real data. It recreates the conditions develop's data creates for the behaviour suites:
--   * the on_auth_user_created trigger on auth.users (creates a profile per new user),
--   * develop's own market_availability rows (GB city + country, NG),
--   * develop's own service types owning the ride / delivery / errand / van-moving slugs,
--   * tenants, users and profiles (customers, drivers, an admin), vehicles, inspection photos,
--     jobs in many statuses (80, like develop), pricing rows, settings, wallets,
--   * no cash-market or cash-config rows (develop has none: inventory 2026-11-12, VERIFY output).
\set ON_ERROR_STOP on
BEGIN;
DO $t$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='on_auth_user_created') THEN
    CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
  END IF;
END $t$;
INSERT INTO public.tenants(id,name,slug) VALUES ('7e000000-0000-4000-8000-000000000001','Movabi Global','movabi-global');
INSERT INTO public.market_availability(country_code,market_city,supported_currency,launch_status,enabled,quote_enabled,booking_enabled,payment_enabled,driver_online_enabled,driver_registration_enabled,customer_registration_enabled,customer_app_enabled,timezone)
 VALUES ('GB','London','GBP','live',true,true,true,true,true,true,true,true,'Europe/London'),
        ('GB',NULL,'GBP','live',true,true,true,true,true,true,true,true,'Europe/London'),
        ('NG',NULL,'NGN','live',true,true,true,true,true,true,true,true,'Africa/Lagos');
INSERT INTO public.service_types(id,slug,name) VALUES
 ('7e100000-0000-4000-8000-000000000001','ride','Ride'),('7e100000-0000-4000-8000-000000000002','delivery','Delivery'),
 ('7e100000-0000-4000-8000-000000000003','errand','Errand'),('7e100000-0000-4000-8000-000000000004','van-moving','Van moving')
 ON CONFLICT DO NOTHING;
INSERT INTO public.pricing_config(service_type,base_fare,per_km,per_min,service_fee,minimum_fare,currency_code,is_active,country_code)
 VALUES ('ride',2.50,1.20,0.20,0.50,6.00,'GBP',true,'GB'),('delivery',3.00,1.10,0.15,0.50,7.00,'GBP',true,'GB'),('ride',500,150,30,100,1500,'NGN',true,'NG');
-- 40 users through the real trigger path (profiles created by handle_new_user), then given roles/markets.
INSERT INTO auth.users(id,email,raw_user_meta_data)
 SELECT ('7e200000-0000-4000-8000-0000000000'||lpad(g::text,2,'0'))::uuid, 'dev-user-'||g||'@example.test', '{}'::jsonb FROM generate_series(1,40) g;
UPDATE public.profiles p SET tenant_id='7e000000-0000-4000-8000-000000000001',
   role = CASE WHEN n <= 24 THEN 'customer' WHEN n <= 39 THEN 'driver' ELSE 'admin' END,
   country_code = CASE WHEN n % 5 = 0 THEN 'NG' ELSE 'GB' END,
   registration_country_code = CASE WHEN n % 5 = 0 THEN 'NG' ELSE 'GB' END,
   registration_activated_at = CASE WHEN n BETWEEN 25 AND 39 THEN now()-interval '20 days' END
  FROM (SELECT ('7e200000-0000-4000-8000-0000000000'||lpad(g::text,2,'0'))::uuid AS id, g AS n FROM generate_series(1,40) g) x WHERE p.id=x.id;
INSERT INTO public.vehicles(user_id,type,make,model,color,year,license_plate)
 SELECT ('7e200000-0000-4000-8000-0000000000'||lpad(g::text,2,'0'))::uuid,'car','Toyota','Prius','Silver','2020','DEV '||g FROM generate_series(25,39) g;
INSERT INTO public.driver_vehicle_inspection_photos(driver_id,tenant_id,vehicle_id,vehicle_revision,slot,storage_path,status,byte_size,content_type)
 SELECT v.user_id,'7e000000-0000-4000-8000-000000000001',v.id,v.inspection_revision,s.slot,'inspection/'||v.user_id||'/'||s.slot||'.jpg','approved',1000,'image/jpeg'
   FROM public.vehicles v CROSS JOIN (VALUES ('front'),('rear'),('dashboard'),('seats_interior'),('left_side'),('right_side')) s(slot)
  WHERE v.license_plate IN ('DEV 25','DEV 26');
-- 80 jobs across statuses (inserted as data, like a restore: no triggers fire).
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs(tenant_id,customer_id,driver_id,accepted_driver_id,pickup_address,dropoff_address,scheduled_time,service_type_id,payment_method,payment_status,country_code,currency_code,status,price,total_price,metadata,created_at)
 SELECT '7e000000-0000-4000-8000-000000000001',('7e200000-0000-4000-8000-0000000000'||lpad((1+g%24)::text,2,'0'))::uuid,
        CASE WHEN g%4=1 THEN ('7e200000-0000-4000-8000-0000000000'||lpad((25+g%15)::text,2,'0'))::uuid END,
        CASE WHEN g%4=1 THEN ('7e200000-0000-4000-8000-0000000000'||lpad((25+g%15)::text,2,'0'))::uuid END,
        'pickup '||g,'dropoff '||g,now()-make_interval(days=>g%30),
        (ARRAY['7e100000-0000-4000-8000-000000000001','7e100000-0000-4000-8000-000000000002','7e100000-0000-4000-8000-000000000003']::uuid[])[1+g%3],
        'card',(ARRAY['paid','authorized','refunded','pending'])[1+g%4],'GB','GBP',
        (ARRAY['completed','cancelled','expired','no_driver_found','completed','cancelled','expired','completed'])[1+g%8],
        12.50+g,12.50+g,'{"completion_pin_required":true}'::jsonb,now()-make_interval(days=>g%30)
   FROM generate_series(1,80) g;
SET LOCAL session_replication_role = origin;
INSERT INTO public.marketplace_settings(tenant_id,key,value) VALUES (NULL,'market_pricing_enabled','true'::jsonb)
 ON CONFLICT DO NOTHING;
COMMIT;
