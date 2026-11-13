-- READ-ONLY trace of one driver's saved inspection evidence (2026-11-13).
-- Usage on the develop host (the email is passed at run time, never stored):
--   docker exec -i movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -P pager=off -v email="YOUR_DRIVER_EMAIL"' < trace-driver-inspection.sql
-- Prints ids, statuses, slots and counts only: no documents, no photo contents, no addresses.
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
SELECT coalesce((SELECT u.id::text FROM auth.users u WHERE lower(u.email)=lower(:'email') LIMIT 1),'00000000-0000-0000-0000-000000000000') AS me_id \gset
\echo 'driver id: ' :me_id
\echo '== profile'
SELECT p.id, p.role, p.tenant_id IS NOT NULL AS has_tenant, p.inspection_market_code, p.registration_country_code, p.country_code,
       p.verification_status, p.driver_review_status, p.is_verified, p.onboarding_completed,
       EXISTS (SELECT 1 FROM unnest(coalesce(p.verification_items,'{}')) i WHERE i LIKE '%bike_inspection_approved%') AS has_bike_inspection_flag
  FROM public.profiles p WHERE p.id = :'me_id';
\echo '== saved vehicles (the readiness response uses the single current one)'
SELECT v.id, v.type, v.capacity, v.vehicle_subtype, v.inspection_revision, v.updated_at
  FROM public.vehicles v WHERE v.user_id = :'me_id' ORDER BY v.created_at DESC;
\echo '== every inspection photo row (current revision = the vehicle''s inspection_revision)'
SELECT ph.slot, ph.status, ph.vehicle_revision = v.inspection_revision AS current_revision, ph.vehicle_id = v.id AS current_vehicle, count(*), max(ph.created_at) AS latest
  FROM public.driver_vehicle_inspection_photos ph
  LEFT JOIN public.vehicles v ON v.user_id=ph.driver_id
 WHERE ph.driver_id = :'me_id'
 GROUP BY 1,2,3,4 ORDER BY 1,2;
\echo '== per required slot, as the new readiness logic sees it (bike: front/rear/side; otherwise 6 slots)'
WITH veh AS (SELECT v.* FROM public.vehicles v WHERE v.user_id = :'me_id' ORDER BY v.created_at DESC LIMIT 1),
cls AS (SELECT veh.*, (lower(coalesce(nullif(veh.capacity,''),veh.type,'')) ~ '(bike|bicycle|cycle|scooter|moped)') AS bike FROM veh),
req AS (SELECT cls.id AS vehicle_id, cls.inspection_revision, s.slot FROM cls
        CROSS JOIN LATERAL unnest(CASE WHEN cls.bike THEN ARRAY['front','rear','side'] ELSE ARRAY['front','rear','dashboard','seats_interior','left_side','right_side'] END) AS s(slot))
SELECT req.slot,
       coalesce((SELECT CASE max(CASE ph.status WHEN 'approved' THEN 4 WHEN 'under_review' THEN 3 WHEN 'uploaded' THEN 3 WHEN 'rejected' THEN 2 WHEN 'replacement_required' THEN 2 END)
                          WHEN 4 THEN 'approved' WHEN 3 THEN 'awaiting_review' WHEN 2 THEN 'rejected' END
                 FROM public.driver_vehicle_inspection_photos ph
                 WHERE ph.driver_id = :'me_id' AND ph.vehicle_id=req.vehicle_id AND ph.vehicle_revision=req.inspection_revision AND ph.slot=req.slot AND ph.status<>'replaced'),'missing') AS state
  FROM req ORDER BY 1;
ROLLBACK;
