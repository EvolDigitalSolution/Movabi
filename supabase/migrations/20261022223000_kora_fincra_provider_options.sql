BEGIN;
-- Additive: preserve legacy providers and immutable historical payment bindings.
-- This migration neither enables a market nor converts a provider reference.
ALTER TABLE public.payment_customers DROP CONSTRAINT payment_customers_provider_check;
ALTER TABLE public.payment_customers ADD CONSTRAINT payment_customers_provider_check
 CHECK (provider IN ('stripe','kora','fincra','flutterwave','paystack'));
ALTER TABLE public.job_payment_bindings DROP CONSTRAINT job_payment_bindings_provider_check;
ALTER TABLE public.job_payment_bindings ADD CONSTRAINT job_payment_bindings_provider_check
 CHECK (provider IN ('stripe','kora','fincra','flutterwave','paystack'));
COMMIT;
