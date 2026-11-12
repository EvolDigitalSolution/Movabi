-- =============================================================================
-- Batch 1C — synthetic fixture (disposable DB only).
-- Roles + auth.uid() + market_availability + minimal market_payment_routes.
-- =============================================================================
\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
ALTER ROLE service_role BYPASSRLS; -- isolated fixture only

DROP TABLE IF EXISTS public.market_availability CASCADE;
CREATE TABLE public.market_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), country_code text, supported_currency text
);
INSERT INTO public.market_availability (country_code, supported_currency) VALUES
  ('GB','GBP'), ('NG','NGN'), ('KE','KES'), ('GH','GHS'), ('US','USD'), ('ZA','ZAR');

DROP TABLE IF EXISTS public.market_payment_routes CASCADE;
CREATE TABLE public.market_payment_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code text, currency_code text, method text, provider text,
  merchant_account_ref text,
  preferred boolean DEFAULT true, enabled boolean DEFAULT false,
  merchant_approved boolean DEFAULT false, adapter_ready boolean DEFAULT false, payout_approved boolean DEFAULT false,
  capabilities text[] DEFAULT '{}',
  CONSTRAINT market_payment_routes_capabilities_check
    CHECK (capabilities <@ ARRAY['authorise','capture','release','refund','retrieve','payout']::text[] AND array_position(capabilities,NULL) IS NULL),
  CONSTRAINT market_payment_routes_kora_guard
    CHECK (provider NOT IN ('kora','fincra') OR (NOT enabled AND NOT adapter_ready AND NOT payout_approved AND cardinality(capabilities)=0))
);
INSERT INTO public.market_payment_routes (country_code, currency_code, method, provider, merchant_account_ref) VALUES
  ('GB','GBP','card','stripe','stripe-platform'),
  ('NG','NGN','card','kora',NULL);

-- Minimal wallet_transactions (required by Batch 1A's preconditions + the
-- legacy chk_topup_requires_stripe comment).
DROP TABLE IF EXISTS public.wallet_transactions CASCADE;
CREATE TABLE public.wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid, user_id uuid, job_id uuid,
  transaction_type text NOT NULL, amount numeric NOT NULL,
  description text, metadata jsonb,
  balance_before_available numeric, balance_after_available numeric,
  balance_before_reserved numeric, balance_after_reserved numeric,
  stripe_payment_intent_id text, payment_intent_id text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT chk_wallet_transaction_type CHECK (transaction_type IN ('topup','reservation','release','settlement','refund','adjustment')),
  CONSTRAINT chk_wallet_transaction_amount_non_negative CHECK (amount >= 0),
  CONSTRAINT chk_topup_requires_stripe CHECK (transaction_type <> 'topup' OR stripe_payment_intent_id IS NOT NULL)
);
CREATE UNIQUE INDEX wallet_one_job_settlement ON public.wallet_transactions (job_id, user_id)
  WHERE transaction_type = 'settlement' AND job_id IS NOT NULL;
CREATE UNIQUE INDEX unique_payment_intent ON public.wallet_transactions (payment_intent_id);

\echo 'Batch 1C fixture ready'
