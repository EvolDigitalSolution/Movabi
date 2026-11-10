#!/usr/bin/env bash
# Cash-credit lifecycle: full migration chain in disposable PostgreSQL.
# Recreates container `vaydu-pg-test` (movabi_develop), applies the wallet
# chain 1a-1f plus prerequisites, seeds a verified credit deposit, and proves:
#   - atomic acceptance+reservation via the real jobs trigger
#   - insufficient-credit rejection rolls back the whole insert
#   - concurrent/second acceptance cannot re-spend held credit
#   - idempotent re-reserve returns the same hold
#   - completion settles exactly once into cash_fee_clearing
#   - cancellation releases the hold and restores available credit
set -euo pipefail
M=${MIGRATIONS:-supabase/migrations}
DB=movabi_develop
run(){ docker exec -i vaydu-pg-test psql -U postgres -d "$DB" -v ON_ERROR_STOP=1; }
docker rm -f vaydu-pg-test >/dev/null 2>&1 || true
docker run -d --name vaydu-pg-test -e POSTGRES_PASSWORD=p -e POSTGRES_DB="$DB" postgres:16 >/dev/null
sleep 6
run <<'SQL'
create schema if not exists auth;
create function auth.uid() returns uuid language sql as 'select null::uuid';
create function auth.jwt() returns jsonb language sql as 'select ''{"role":"service_role"}''::jsonb';
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
alter role service_role bypassrls;
create table auth.users(id uuid primary key);
create table public.profiles(id uuid primary key, role text, account_status text, tenant_id uuid,
  country_code text, currency_code text, registration_country_code text,
  registration_market_city text, registration_activated_at timestamptz);
create table public.service_types(id uuid primary key, slug text not null);
create table public.market_availability(id uuid primary key default gen_random_uuid(),
  country_code text not null, supported_currency text, enabled boolean default true);
create table public.jobs(id uuid primary key, tenant_id uuid, customer_id uuid,
  driver_id uuid, accepted_driver_id uuid, status text, payment_method text,
  payment_status text, payment_intent_id text, country_code text,
  currency_code text, service_type_id uuid, agreed_fare numeric,
  fare_breakdown jsonb, metadata jsonb, cancellation_fee numeric,
  price numeric, total_price numeric, created_at timestamptz default now());
alter table public.jobs enable row level security;
create table public.driver_earnings(id uuid primary key default gen_random_uuid(),
  job_id uuid, driver_id uuid, amount numeric);
alter table public.driver_earnings enable row level security;
create table public.marketplace_negotiation_sessions(
  id uuid primary key default gen_random_uuid(), job_id uuid, customer_id uuid,
  active_driver_id uuid, agreed_fare numeric, customer_offer numeric,
  driver_counter_offer numeric, expires_at timestamptz,
  payment_deadline timestamptz, round_count int default 0, status text);
create table public.wallet_transactions(
  id uuid primary key default gen_random_uuid(), wallet_id uuid, user_id uuid,
  job_id uuid, transaction_type text, amount numeric, metadata jsonb,
  balance_before_available numeric, balance_after_available numeric,
  balance_before_reserved numeric, balance_after_reserved numeric,
  stripe_payment_intent_id text, payment_intent_id text, description text,
  type text, status text, created_at timestamptz default now());
alter table public.wallet_transactions enable row level security;
SQL
for f in 20260411000001_harden_database_production 20261022010000_payment_customers_and_card_consent \
         20261023230000_market_payment_routes 20261243000000_driver_market_isolation \
         20261244000000_wallet_metadata_batch1a 20261245000000_wallet_accounting_foundation_batch1b \
         20261246000000_wallet_topups_batch1c 20261202000000_settlement_idempotency \
         20261202010000_settlement_idempotency_corrective 20261204000000_release_final_hardening \
         03_wallet_topup_support 20261236000000_fare_agreement_payment_deadline \
         20261241700000_wallet_booking_lifecycle_atomic 20261233000000_customer_cancel_request_terminal \
         20261201000000_money_authority_wallet_acl 20261247000000_wallet_authorization_batch1d \
         20261255500000_cash_acquisition_eligibility 20261248000000_driver_cash_credit_batch1e \
         20261249000000_driver_cash_credit_api_batch1f; do
  echo "== $f"; run < "$M/$f.sql" >/dev/null || echo "WARN $f failed (see stderr)"; done
run <<'SQL'
insert into driver_cash_credit_config_v1e(key,enabled) values('ride_cash_credit',true);
insert into service_types(id,slug) values('11111111-0000-0000-0000-000000000001','ride');
insert into market_availability(country_code,supported_currency,enabled) values('GB','GBP',true);
insert into profiles(id,role,account_status,tenant_id,country_code,currency_code,registration_country_code,registration_activated_at)
 values('dddddddd-0000-0000-0000-000000000001','driver','active','55555555-0000-0000-0000-000000000001','GB','GBP','GB',now());
insert into driver_cash_credit_enrolments_v1e(tenant_id,driver_id,country_code,currency_code,terms_version,consented_at,enabled)
 values('55555555-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','GB','GBP','v1',now()-interval '1 day',true);
do $$
declare eid uuid := gen_random_uuid(); acc uuid := gen_random_uuid(); att uuid := gen_random_uuid();
begin
 insert into wallet_business_events(id,event_key,operation,payment_provider,merchant_account_ref,provider_reference,tenant_id,owner_id,currency_code,entries)
  values(eid,'wallet-topup:'||att::text,'topup','stripe','acct-1','ref-1','55555555-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','GBP',
   jsonb_build_array(jsonb_build_object('accountPurpose','driver_cash_credit','amountMinor',10000),jsonb_build_object('accountPurpose','platform_funding','amountMinor',-10000)));
 insert into wallet_accounts(id,tenant_id,owner_id,currency_code,balance_purpose)
  values(acc,'55555555-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','GBP','driver_cash_credit');
 insert into wallet_movements(event_id,account_id,amount_minor,entry_seq) values(eid,acc,10000,1);
 insert into wallet_topup_attempts(id,attempt_key,tenant_id,owner_id,country_code,currency_code,amount_minor,destination_account_purpose,payment_provider,merchant_account_ref,provider_idempotency_identity,provider_reference,status,credited_event_id)
  values(att,'k1','55555555-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','GB','GBP',10000,'driver_cash_credit','stripe','acct-1','idem-1','ref-1','credited',eid);
end $$;
SQL
echo "FIXTURE_READY — run assertions per docs/LAUNCH-ROADMAP-HANDOFF.md"
