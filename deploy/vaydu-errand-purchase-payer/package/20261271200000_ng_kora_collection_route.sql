-- 20261271200000_ng_kora_collection_route.sql
-- Authorised scope (explicit instruction): relax market_payment_routes_check1
-- ONLY for the reviewed NG/NGN Kora card collection route.
--
-- Before: every kora/fincra row was forced to (NOT enabled, NOT adapter_ready,
--         NOT payout_approved, empty capabilities) — no collection route could
--         exist at all.
-- After:  a kora row may be configured ONLY when ALL of these hold:
--           country_code='NG' AND currency_code='NGN' AND method='card'
--           AND NOT payout_approved
--           AND capabilities is a non-empty subset of {'collect'}
--         Every other kora/fincra shape remains fully disabled as before.
--         Fincra is untouched. Payout capability stays forbidden on the
--         collection route (payout_approved=false and no payout capability).
BEGIN;
ALTER TABLE public.market_payment_routes DROP CONSTRAINT market_payment_routes_check1;
ALTER TABLE public.market_payment_routes ADD CONSTRAINT market_payment_routes_check1
CHECK (((provider <> ALL (ARRAY['kora'::text, 'fincra'::text]))
        OR ((NOT enabled) AND (NOT adapter_ready) AND (NOT payout_approved) AND (cardinality(capabilities) = 0))
        OR ((provider = 'kora'::text) AND (country_code = 'NG'::text) AND (currency_code = 'NGN'::text)
            AND (method = 'card'::text) AND (NOT payout_approved)
            AND (cardinality(capabilities) > 0) AND (capabilities <@ ARRAY['collect'::text]))));
COMMENT ON CONSTRAINT market_payment_routes_check1 ON public.market_payment_routes IS
 'Unreviewed providers stay off except the reviewed NG/NGN kora card collect route (no payout capability).';
COMMIT;
