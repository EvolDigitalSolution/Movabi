CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE TABLE public.profiles(id uuid PRIMARY KEY,tenant_id uuid,role text,registration_country_code text,country_code text,registration_activated_at timestamptz);
CREATE TABLE public.market_availability(country_code text,supported_currency text);
INSERT INTO public.market_availability VALUES('GB','GBP'),('NG','NGN'),('GH','GHS');
CREATE TABLE public.job_payment_bindings(id uuid);
CREATE TABLE public.jobs(id uuid PRIMARY KEY,driver_id uuid,accepted_driver_id uuid,tenant_id uuid,country_code text,currency_code text,
 status text,payment_status text,payment_method text,settlement_status text,stripe_transfer_id text,stripe_transfer_status text,
 completed_at timestamptz,transferred_at timestamptz,driver_payout numeric,platform_fee numeric,commission_fee numeric,commission_rate_used numeric,
 price numeric,total_price numeric,metadata jsonb,updated_at timestamptz,agreed_fare numeric,fare_breakdown jsonb);
CREATE TABLE public.driver_earnings(job_id uuid UNIQUE,driver_id uuid,amount numeric,platform_fee numeric,gross_amount numeric,status text,currency_code text,country_code text,stripe_transfer_id text,settled_at timestamptz);
CREATE TABLE public.errand_funding(job_id uuid,over_budget_status text,item_budget numeric,amount_reserved numeric);
CREATE TABLE public.refund_operations(job_id uuid);
CREATE FUNCTION public.settle_job_wallet_reservation(uuid,numeric) RETURNS void LANGUAGE plpgsql AS $$BEGIN END $$;
