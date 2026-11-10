BEGIN;
CREATE TABLE IF NOT EXISTS public.driver_vehicle_mot_checks (
 vehicle_id uuid PRIMARY KEY REFERENCES public.vehicles(id) ON DELETE CASCADE,
 registration text NOT NULL, status text NOT NULL CHECK(status IN ('valid','expired','dangerous_failure','unknown')),
 expires_on date, checked_at timestamptz NOT NULL
);
ALTER TABLE public.driver_vehicle_mot_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_vehicle_mot_checks FROM anon, authenticated;
GRANT ALL ON public.driver_vehicle_mot_checks TO service_role;
CREATE TABLE IF NOT EXISTS public.gb_mot_night_runs(day date PRIMARY KEY, lease_until timestamptz NOT NULL, completed boolean NOT NULL DEFAULT false);
ALTER TABLE public.gb_mot_night_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gb_mot_night_runs FROM anon,authenticated;
GRANT ALL ON public.gb_mot_night_runs TO service_role;
CREATE OR REPLACE FUNCTION public.claim_gb_mot_night(p_day date) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE claimed date;
BEGIN
 INSERT INTO gb_mot_night_runs(day,lease_until) VALUES(p_day,now()+interval '2 hours')
 ON CONFLICT(day) DO UPDATE SET lease_until=EXCLUDED.lease_until WHERE NOT gb_mot_night_runs.completed AND gb_mot_night_runs.lease_until<now()
 RETURNING day INTO claimed;
 RETURN claimed IS NOT NULL;
END;$$;
CREATE OR REPLACE FUNCTION public.gb_driver_mot_blocked(p_driver uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM profiles p JOIN vehicles v ON v.user_id=p.id JOIN driver_vehicle_mot_checks m ON m.vehicle_id=v.id
 WHERE p.id=p_driver AND upper(p.country_code)='GB' AND lower(v.type) NOT IN ('motorcycle','bicycle','bike')
 AND m.registration=upper(regexp_replace(v.license_plate,'\s','','g'))
 AND (m.status IN ('expired','dangerous_failure','unknown') OR m.expires_on < (now() AT TIME ZONE 'Europe/London')::date));
$$;
CREATE OR REPLACE FUNCTION public.expire_gb_mot_online() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 UPDATE profiles SET is_online=false,is_available=false WHERE (is_online OR is_available) AND gb_driver_mot_blocked(id);
$$;
CREATE OR REPLACE FUNCTION public.record_gb_vehicle_mot(p_vehicle_id uuid,p_registration text,p_status text,p_expiry date,p_checked_at timestamptz) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE driver uuid;
BEGIN
 SELECT v.user_id INTO driver FROM vehicles v JOIN profiles p ON p.id=v.user_id
 WHERE v.id=p_vehicle_id AND upper(p.country_code)='GB' AND lower(v.type) NOT IN ('motorcycle','bicycle','bike')
 AND upper(regexp_replace(v.license_plate,'\s','','g'))=p_registration FOR UPDATE OF v;
 IF driver IS NULL THEN RETURN; END IF;
 INSERT INTO driver_vehicle_mot_checks VALUES(p_vehicle_id,p_registration,p_status,p_expiry,p_checked_at)
 ON CONFLICT(vehicle_id) DO UPDATE SET registration=EXCLUDED.registration,
 status=CASE WHEN EXCLUDED.status='unknown' AND driver_vehicle_mot_checks.registration=EXCLUDED.registration AND driver_vehicle_mot_checks.status IN ('expired','dangerous_failure') THEN driver_vehicle_mot_checks.status ELSE EXCLUDED.status END,
 expires_on=EXCLUDED.expires_on,checked_at=EXCLUDED.checked_at
 WHERE EXCLUDED.checked_at>driver_vehicle_mot_checks.checked_at;
 IF gb_driver_mot_blocked(driver) THEN UPDATE profiles SET is_online=false,is_available=false WHERE id=driver; END IF;
END;$$;
CREATE OR REPLACE FUNCTION public.enforce_gb_mot_online() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF (NEW.is_online OR NEW.is_available) AND gb_driver_mot_blocked(NEW.id) THEN
  RAISE EXCEPTION 'MOT_EXPIRED_OR_UNVERIFIED: Renew your MOT and recheck your registration before going online.' USING ERRCODE='P0001';
 END IF;RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS trg_gb_mot_online ON public.profiles;
CREATE TRIGGER trg_gb_mot_online BEFORE UPDATE OF is_online,is_available ON public.profiles FOR EACH ROW EXECUTE FUNCTION enforce_gb_mot_online();
CREATE OR REPLACE FUNCTION public.enforce_gb_mot_acquisition() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE driver uuid; previous uuid;
BEGIN
 driver=(to_jsonb(NEW)->>TG_ARGV[0])::uuid;
 IF TG_OP='UPDATE' THEN previous=(to_jsonb(OLD)->>TG_ARGV[0])::uuid; END IF;
 IF driver IS NOT NULL AND driver IS DISTINCT FROM previous AND gb_driver_mot_blocked(driver) THEN
  RAISE EXCEPTION 'MOT_EXPIRED_OR_UNVERIFIED: A valid MOT is required to take new work.' USING ERRCODE='P0001';
 END IF;RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS trg_gb_mot_job ON public.jobs;
CREATE TRIGGER trg_gb_mot_job BEFORE INSERT OR UPDATE OF driver_id ON public.jobs FOR EACH ROW EXECUTE FUNCTION enforce_gb_mot_acquisition('driver_id');
DROP TRIGGER IF EXISTS trg_gb_mot_negotiation ON public.marketplace_negotiation_sessions;
CREATE TRIGGER trg_gb_mot_negotiation BEFORE INSERT OR UPDATE OF active_driver_id ON public.marketplace_negotiation_sessions FOR EACH ROW EXECUTE FUNCTION enforce_gb_mot_acquisition('active_driver_id');
REVOKE ALL ON FUNCTION public.expire_gb_mot_online(),public.claim_gb_mot_night(date),public.record_gb_vehicle_mot(uuid,text,text,date,timestamptz),public.gb_driver_mot_blocked(uuid),public.enforce_gb_mot_online(),public.enforce_gb_mot_acquisition() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.expire_gb_mot_online(),public.claim_gb_mot_night(date),public.record_gb_vehicle_mot(uuid,text,text,date,timestamptz),public.gb_driver_mot_blocked(uuid) TO service_role;
COMMIT;
