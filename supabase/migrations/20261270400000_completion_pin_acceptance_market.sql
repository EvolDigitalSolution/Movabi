-- Refresh only an unfrozen first assignment from the existing explicit market setting.
-- Run before the existing zz_stamp_completion_pin_policy: it still owns override precedence,
-- freezing and PIN minting. No completion/ownership/acquisition/settlement function is changed.
CREATE OR REPLACE FUNCTION public.refresh_completion_pin_market_on_acceptance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s jsonb; country text := upper(btrim(NEW.country_code)); policy text;
BEGIN
 IF NEW.driver_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.driver_id IS NOT DISTINCT FROM OLD.driver_id OR OLD.driver_id IS NOT NULL
    OR coalesce(OLD.metadata,'{}'::jsonb) ? 'completion_pin_effective' THEN RETURN NEW; END IF;
 END IF;
 -- Explicit repository African catalogue + GB. No currency or non-GB inference.
 IF country IS NULL OR country<>ALL(ARRAY['NG','GH','KE','ZA','UG','TZ','RW','MW','EG','CM','CI','SN','ZM','GB']) THEN RETURN NEW; END IF;
 SELECT value INTO s FROM public.marketplace_settings
  WHERE key='completion_pin_policy' AND tenant_id=NEW.tenant_id ORDER BY created_at DESC LIMIT 1;
 IF NOT FOUND OR jsonb_typeof(s->'markets') IS DISTINCT FROM 'object' OR NOT coalesce((s->'markets') ? country,false) THEN
  -- A tenant's explicit country policy wins; a generic/missing tenant value must not hide
  -- the approved platform COUNTRY default for a newly provisioned tenant.
  SELECT value INTO s FROM public.marketplace_settings
   WHERE key='completion_pin_policy' AND tenant_id IS NULL ORDER BY created_at DESC LIMIT 1;
 END IF;
 -- Use the existing resolver, including its fail-closed interpretation of bad values.
 -- Without an explicit entry, retain the booking snapshot, exactly as before this change.
 IF jsonb_typeof(s->'markets')='object' AND (s->'markets') ? country THEN
  policy:=public.completion_pin_market_policy(jsonb_build_object('completion_pin_market_policy',s#>ARRAY['markets',country]));
  NEW.metadata:=coalesce(NEW.metadata,'{}'::jsonb)||jsonb_build_object(
   'completion_pin_market_policy',policy,'completion_pin_required',policy<>'disabled',
   'completion_pin_policy_version','acceptance-market-v3');
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.refresh_completion_pin_market_on_acceptance() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS zy_refresh_completion_pin_market_on_acceptance ON public.jobs;
CREATE TRIGGER zy_refresh_completion_pin_market_on_acceptance BEFORE INSERT OR UPDATE OF driver_id ON public.jobs
 FOR EACH ROW EXECUTE FUNCTION public.refresh_completion_pin_market_on_acceptance();
