BEGIN;
CREATE TABLE IF NOT EXISTS public.payment_customers (
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK (provider IN ('stripe','flutterwave','paystack')),
 merchant_account_ref text NOT NULL,
 customer_reference text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,provider,merchant_account_ref),
 UNIQUE(provider,merchant_account_ref,customer_reference)
);
CREATE TABLE IF NOT EXISTS public.payment_card_consents (
 job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 provider text NOT NULL,
 merchant_account_ref text NOT NULL,
 version text NOT NULL,
 accepted_at timestamptz NOT NULL
);
ALTER TABLE public.payment_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_card_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_customers, public.payment_card_consents FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.payment_customers, public.payment_card_consents TO service_role;
CREATE TABLE IF NOT EXISTS public.job_payment_bindings (
 job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE RESTRICT,
 provider text NOT NULL CHECK(provider IN ('stripe','flutterwave','paystack')),
 merchant_account_ref text NOT NULL,
 country text NOT NULL CHECK(country ~ '^[A-Z]{2}$'),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 payment_reference text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,merchant_account_ref,payment_reference)
);
ALTER TABLE public.job_payment_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_payment_bindings FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.job_payment_bindings TO service_role;
CREATE TABLE IF NOT EXISTS public.payment_checkout_attempts (
 reference text PRIMARY KEY,
 request jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('started','submitted','unknown')) DEFAULT 'started',
 checkout_url text,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.payment_checkout_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_checkout_attempts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.payment_checkout_attempts TO service_role;
COMMIT;
