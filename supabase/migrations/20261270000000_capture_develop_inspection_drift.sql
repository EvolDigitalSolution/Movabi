-- D12 (2026-11-13): capture the two inspection objects that exist only on develop (applied there
-- outside the migrations), so every environment built from the migrations matches develop.
-- Reviewed against the live schema (supabase/baseline/develop_live_public_schema_20261112.sql):
--   1. column public.driver_vehicle_inspection_photos.reason text (nullable, no default)
--   2. function public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text): the earlier
--      6-argument form, owner-executed, EXECUTE for service_role only.
-- On develop this is a no-op: both are created only when absent, and develop's definitions are never
-- replaced. Nothing is dropped (instruction: keep them).
--
-- Notes recorded by the review (behaviour is NOT changed here):
--   * No code calls the 6-argument form. Both callers (driver-onboarding.routes.ts and
--     verification.routes.ts) and the 20261265100000 wrappers pass all 8 arguments, which resolves to
--     the 8-argument form unambiguously. A call with exactly 6 arguments would be ambiguous between
--     the two forms, because the 8-argument form defaults its last two parameters.
--   * The 6-argument form inserts without byte_size, which is NOT NULL with no default, so it cannot
--     succeed against the current table. It is kept as-is for parity, not for use.
--   * No code reads or writes `reason` (rejections use rejection_reason).
-- Rollback: none needed. The objects pre-exist on develop and are kept everywhere; see the .down.sql.

ALTER TABLE public.driver_vehicle_inspection_photos ADD COLUMN IF NOT EXISTS reason text;

DO $capture$
BEGIN
  IF to_regprocedure('public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text)') IS NULL THEN
    EXECUTE $def$
CREATE FUNCTION public.register_driver_inspection_photo(p_driver uuid, p_tenant uuid, p_vehicle uuid, p_revision uuid, p_slot text, p_path text) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare photo uuid;
begin
  perform 1 from public.vehicles where id=p_vehicle and user_id=p_driver and inspection_revision=p_revision for update;
  if not found then raise exception 'Vehicle changed; reload before uploading'; end if;
  update public.driver_vehicle_inspection_photos set status='replaced'
    where vehicle_id=p_vehicle and vehicle_revision=p_revision and slot=p_slot and status<>'replaced';
  insert into public.driver_vehicle_inspection_photos(driver_id,tenant_id,vehicle_id,vehicle_revision,slot,storage_path)
    values(p_driver,p_tenant,p_vehicle,p_revision,p_slot,p_path) returning id into photo;
  return photo;
end;
$$
$def$;
    REVOKE ALL ON FUNCTION public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text) FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON FUNCTION public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text) FROM anon; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON FUNCTION public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text) FROM authenticated; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text) TO service_role; END IF;
  END IF;
END $capture$;

-- Compatibility checks: the captured objects match develop's definitions exactly (EOL-insensitive
-- fingerprint), and the 8-argument form the code calls is untouched.
DO $check$
DECLARE v text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='driver_vehicle_inspection_photos'
                 AND column_name='reason' AND data_type='text' AND is_nullable='YES' AND column_default IS NULL) THEN
    RAISE EXCEPTION 'D12: driver_vehicle_inspection_photos.reason is not the nullable text column develop has';
  END IF;
  SELECT md5(replace(pg_get_functiondef('public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text)'::regprocedure), chr(13), '')) INTO v;
  -- develop's fingerprint, EOL-insensitive like every release check. Develop's body has CRLF line
  -- endings (raw md5 65e2f7006a561212e7ec6e4d1ec1b751 in the 2026-11-12 host inventory); the captured
  -- body uses LF, which PL/pgSQL treats identically. With CR removed both are f180b0b8...
  IF v IS DISTINCT FROM 'f180b0b86f587154270a0493786d9838' THEN
    RAISE EXCEPTION 'D12: 6-argument register_driver_inspection_photo differs from develop (md5 %)', v;
  END IF;
  IF to_regprocedure('public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text,integer,text)') IS NULL THEN
    RAISE EXCEPTION 'D12: the 8-argument register_driver_inspection_photo (20261265100000) is missing';
  END IF;
END $check$;
