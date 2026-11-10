-- Additive prerequisite for Batch 2A on the inspected develop schema.
-- Only widen the provider enum; no route, capability or approval is enabled.
BEGIN;
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_constraintdef(c.oid) INTO definition FROM pg_constraint c
 WHERE c.conrelid='public.market_payment_routes'::regclass AND c.conname='market_payment_routes_provider_check' AND c.contype='c';
 IF definition IS NULL THEN
   RAISE EXCEPTION 'Expected market provider constraint missing; inspect schema before deployment';
 END IF;
 IF definition NOT IN (
   'CHECK ((provider = ANY (ARRAY[''stripe''::text, ''kora''::text, ''fincra''::text])))',
   'CHECK ((provider = ANY (ARRAY[''stripe''::text, ''kora''::text, ''fincra''::text, ''flutterwave''::text])))'
 ) THEN RAISE EXCEPTION 'Unexpected market provider constraint; refusing replacement'; END IF;
END $$;
ALTER TABLE public.market_payment_routes DROP CONSTRAINT market_payment_routes_provider_check;
ALTER TABLE public.market_payment_routes ADD CONSTRAINT market_payment_routes_provider_check
 CHECK(provider IN ('stripe','kora','fincra','flutterwave'));
COMMIT;
