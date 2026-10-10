-- New quote configuration only. Existing frozen quotes, jobs and payouts are untouched.
BEGIN;
LOCK TABLE public.marketplace_settings IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.marketplace_commission_overrides IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.market_pricing_strategies IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM public.marketplace_commission_overrides WHERE is_active) THEN
  RAISE EXCEPTION 'Active commission overrides need explicit review';
 END IF;
 IF EXISTS (SELECT 1 FROM public.marketplace_settings WHERE tenant_id IS NOT NULL AND key IN ('commission','platform_fee')) THEN
  RAISE EXCEPTION 'Tenant fee policies need explicit review';
 END IF;
 IF (SELECT count(*) FROM public.marketplace_settings WHERE tenant_id IS NULL AND key='commission') <> 1 THEN
  RAISE EXCEPTION 'Expected one global commission setting';
 END IF;
 IF EXISTS (SELECT 1 FROM public.marketplace_settings WHERE tenant_id IS NULL AND key='commission'
  AND NOT (value @> '{"percent":10,"platformFeePercent":2,"enabled":true}'::jsonb OR
           value @> '{"percent":15,"platformFeePercent":5,"enabled":true}'::jsonb)) THEN
  RAISE EXCEPTION 'Commission policy changed since inspection';
 END IF;
 IF EXISTS (SELECT 1 FROM public.marketplace_settings WHERE tenant_id IS NULL AND key='platform_fee'
  AND value->>'configVersion' IS DISTINCT FROM 'standard-fees-v2') THEN
  RAISE EXCEPTION 'An explicit platform fee exists; review before replacing';
 END IF;
END $$;
UPDATE public.marketplace_settings
 SET value=value || '{"percent":15,"platformFeePercent":5,"enabled":true,"configVersion":"standard-fees-v2"}'::jsonb, updated_at=now()
 WHERE tenant_id IS NULL AND key='commission';
INSERT INTO public.marketplace_settings(tenant_id,key,value)
 VALUES(NULL,'platform_fee','{"enabled":true,"type":"percentage","percent":5,"fixedAmount":0,"minFee":0,"maxFee":null,"applyToServices":[],"configVersion":"standard-fees-v2"}'::jsonb)
 ON CONFLICT (key) WHERE tenant_id IS NULL DO UPDATE SET value=excluded.value,updated_at=now();
-- Strategies take precedence over global commission, so align standard rates.
UPDATE public.market_pricing_strategies SET commission_percent=15, updated_at=now()
 WHERE enabled AND commission_percent IS DISTINCT FROM 15;
-- Do not enable unverified competitor benchmarks or change driver protection floors.
NOTIFY pgrst, 'reload schema';
COMMIT;
