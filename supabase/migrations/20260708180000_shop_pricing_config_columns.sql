-- Shop/errand-specific pricing configuration columns
ALTER TABLE public.pricing_config
    ADD COLUMN IF NOT EXISTS free_included_items INTEGER DEFAULT 1,
    ADD COLUMN IF NOT EXISTS extra_item_fee NUMERIC DEFAULT 0.75,
    ADD COLUMN IF NOT EXISTS large_shopping_surcharge NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS large_shopping_threshold NUMERIC DEFAULT 50,
    ADD COLUMN IF NOT EXISTS peak_multiplier NUMERIC DEFAULT 1.0,
    ADD COLUMN IF NOT EXISTS weather_multiplier NUMERIC DEFAULT 1.0;

COMMENT ON COLUMN public.pricing_config.free_included_items IS 'Number of items included in the base shop/errand fee before extra_item_fee applies';
COMMENT ON COLUMN public.pricing_config.extra_item_fee IS 'Fee charged for each item beyond free_included_items';
COMMENT ON COLUMN public.pricing_config.large_shopping_surcharge IS 'Flat surcharge applied when the shopping budget exceeds large_shopping_threshold';
COMMENT ON COLUMN public.pricing_config.large_shopping_threshold IS 'Shopping budget threshold that triggers large_shopping_surcharge';
COMMENT ON COLUMN public.pricing_config.peak_multiplier IS 'Configurable peak-time multiplier applied on top of dynamic pricing';
COMMENT ON COLUMN public.pricing_config.weather_multiplier IS 'Configurable weather multiplier applied on top of dynamic pricing';
