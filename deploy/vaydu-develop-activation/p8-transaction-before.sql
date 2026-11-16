-- Included once inside the outer correction/activation transaction, before either script.
SET LOCAL lock_timeout='10s';
LOCK TABLE public.market_pricing_strategies,public.pricing_config,public.pricing_markets,
 public.marketplace_settings,public.profiles,public.campaigns,public.cancellation_policies IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE p8_activation_before(kind text,id text,row jsonb) ON COMMIT DROP;
INSERT INTO p8_activation_before
 SELECT 'strategy',id::text,to_jsonb(s) FROM public.market_pricing_strategies s UNION ALL
 SELECT 'pricing',id::text,to_jsonb(p) FROM public.pricing_config p UNION ALL
 SELECT 'ai',country_code,to_jsonb(m) FROM public.pricing_markets m UNION ALL
 SELECT 'setting',id::text,to_jsonb(s) FROM public.marketplace_settings s UNION ALL
 SELECT 'profile',id::text,to_jsonb(p) FROM public.profiles p UNION ALL
 SELECT 'campaign',id::text,to_jsonb(c) FROM public.campaigns c UNION ALL
 SELECT 'policy',id::text,to_jsonb(c) FROM public.cancellation_policies c;
