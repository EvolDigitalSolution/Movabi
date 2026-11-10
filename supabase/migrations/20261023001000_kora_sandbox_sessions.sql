BEGIN;
-- Diagnostic sandbox payments only. No job, wallet or payout side effects.
CREATE TABLE public.kora_sandbox_sessions (
 reference text PRIMARY KEY CHECK(reference ~ '^vaydu-kora-test-[a-f0-9]{64}$'),
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
 merchant_account_ref text NOT NULL CHECK(length(merchant_account_ref)>0),
 currency text NOT NULL DEFAULT 'NGN' CHECK(currency='NGN'),
 amount_minor integer NOT NULL DEFAULT 10000 CHECK(amount_minor=10000),
 state text NOT NULL DEFAULT 'started' CHECK(state IN ('started','submitted','unknown','verified')),
 checkout_url text,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.kora_sandbox_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kora_sandbox_sessions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.kora_sandbox_sessions TO service_role;
COMMIT;
