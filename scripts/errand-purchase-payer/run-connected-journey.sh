#!/usr/bin/env bash
# Connected sandbox journey on disposable infra: REAL GoTrue + PostgREST +
# migrated movabi_develop DB + REAL Express routers + real services/RPCs.
# Only provider HTTP boundaries are simulated (stripe package, flutterwave
# payout adapter, payout-eligibility). One customer-funded errand ends in a
# driver wallet credit and a confirmed sandbox withdrawal.
set -euo pipefail
export MSYS_NO_PATHCONV=1
root="$(cd "$(dirname "$0")/../.." && pwd)"
tests="$root/deploy/vaydu-errand-purchase-payer"
secret='synthetic-disposable-jwt-secret-minimum-40-characters'
id="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
db="vaydu-journey-$id"; auth="$db-auth"; rest="$db-rest"; net="$db-net"; name=movabi_develop
cleanup(){ docker rm -f "$auth" "$db" "$rest" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
trap cleanup EXIT
q(){ docker exec -i -e PGPASSWORD=isolated-test "$db" psql -X -U supabase_admin -d "$name" -v ON_ERROR_STOP=1 -qAt "$@"; }
qw(){ local n=0; until q "$@" >/dev/null 2>&1; do n=$((n+1)); [ "$n" -ge 30 ] && return 1; sleep 2; done; }
qs(){ local f="$1" n=0; until q < "$f" >/dev/null 2>&1; do n=$((n+1)); [ "$n" -ge 30 ] && return 1; sleep 2; done; }

docker network create "$net" >/dev/null
docker run -d --rm --name "$db" --network "$net" -e POSTGRES_PASSWORD=isolated-test -e POSTGRES_DB="$name" supabase/postgres:15.1.1.78 >/dev/null
for _ in $(seq 1 300); do [ "$(docker logs "$db" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break; sleep 1; done
qw -c 'select 1'
tmp="$(mktemp -d)"
cat > "$tmp/setup.sql" <<'SQL'
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
END $$;
DO $$ DECLARE e text; BEGIN
 FOR e IN SELECT evtname FROM pg_event_trigger LOOP EXECUTE format('ALTER EVENT TRIGGER %I DISABLE', e); END LOOP;
END $$;
GRANT anon, authenticated, service_role TO authenticator;
ALTER ROLE authenticator WITH LOGIN PASSWORD 'isolated-test';
SQL
qs "$tmp/setup.sql"

# GoTrue stays RUNNING this time: the journey signs in real users.
docker run -d --rm --network "$net" --name "$auth" -p 127.0.0.1::9999 \
 -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL=http://localhost:9999 -e GOTRUE_SITE_URL=http://localhost:3000 \
 -e GOTRUE_DB_NAMESPACE=auth -e GOTRUE_DB_DRIVER=postgres \
 -e "GOTRUE_DB_DATABASE_URL=postgres://postgres:isolated-test@$db:5432/$name?sslmode=disable&options=-csearch_path%3Dauth%2Cpublic" \
 -e GOTRUE_JWT_SECRET="$secret" -e GOTRUE_JWT_AUD=authenticated \
 supabase/gotrue:v2.132.3 >/dev/null
for _ in $(seq 1 120); do [ "$(q -c "select to_regclass('auth.users') is not null" 2>/dev/null)" = t ] && break; sleep 0.5; done
sleep 2
qw -c "CREATE TABLE IF NOT EXISTS auth.job_messages (id uuid); CREATE OR REPLACE FUNCTION auth.debug_errand_insert() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NEW; END \$\$;"

sed 's/CREATE SCHEMA public;/CREATE SCHEMA IF NOT EXISTS public;/; s/CREATE EXTENSION /CREATE EXTENSION IF NOT EXISTS /' "$root/supabase/baseline/develop_live_public_schema_20261112.sql" > "$tmp/baseline.sql"
qs "$tmp/baseline.sql"
qs "$root/supabase/baseline/candidate/001_tenants.sql"
for f in "$root"/supabase/migrations/*.sql; do
  m="$(basename "$f" .sql)"; case "$m" in *.down) continue;; esac
  q -1 < "$f" >/dev/null 2>&1 || true
done
echo "chain applied"

docker run -d --rm --network "$net" --name "$rest" -p 127.0.0.1::3000 \
 -e "PGRST_DB_URI=postgres://authenticator:isolated-test@$db:5432/$name" \
 -e PGRST_DB_SCHEMA=public -e PGRST_DB_ANON_ROLE=anon -e "PGRST_JWT_SECRET=$secret" \
 postgrest/postgrest:v12.2.0 >/dev/null
rest_port="$(docker port "$rest" 3000/tcp | sed 's/.*://')"
auth_port="$(docker port "$auth" 9999/tcp | sed 's/.*://')"
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$rest_port/" >/dev/null 2>&1 && break; sleep 0.5; done
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$auth_port/health" >/dev/null 2>&1 && break; sleep 0.5; done

cat > "$tmp/fixtures.sql" <<'SQL'
-- Tenant + NG live market + collection rails for the customer top-up leg.
INSERT INTO public.tenants(id,name,slug) VALUES ('11111111-1111-4111-8111-111111111111','Journey Tenant','journey-tenant') ON CONFLICT DO NOTHING;
INSERT INTO public.market_availability(country_code,launch_status,supported_currency,enabled,customer_app_enabled,quote_enabled,booking_enabled,payment_enabled)
 VALUES ('NG','live','NGN',true,true,true,true,true) ON CONFLICT DO NOTHING;
INSERT INTO public.service_types(id,name,slug) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddd02','Errand','errand') ON CONFLICT DO NOTHING;
INSERT INTO public.wallet_collection_config(key,value) VALUES ('enabled','true'),('max_amount_minor_NGN','1000000'),('customer_wallet_setup_enabled','true') ON CONFLICT DO NOTHING;
INSERT INTO public.market_payment_routes(country_code,currency_code,provider,method,preferred,enabled,merchant_approved,adapter_ready,capabilities,merchant_account_ref)
 VALUES ('NG','NGN','stripe','card',true,true,true,true,'{collect}','MERCHANT_NG_TEST') ON CONFLICT DO NOTHING;
INSERT INTO public.wallet_topup_fee_schedules(provider,country_code,currency_code,method,active,version,fee_basis,fee_basis_points,fee_fixed_minor,rounding,approved_by,approved_at,exponent)
 VALUES ('stripe','NG','NGN','card',true,'vaydu-customer-card-0fee-test-v1','wallet',0,0,'half_up','journey','2026-01-01T00:00:00Z',2) ON CONFLICT DO NOTHING;
-- Legacy fee authority (v1 freeze reads this table when the schedule-aware
-- redefinitions did not apply). The CHECK requires a non-zero term; the
-- harness consumes whatever total the frozen quote reports.
INSERT INTO public.wallet_topup_fee_policies(provider,country_code,currency_code,method,active,version,fee_basis_points,fee_fixed_minor,exponent)
 VALUES ('stripe','NG','NGN','card',true,'vaydu-customer-card-0fee-test-v1',0,100,2) ON CONFLICT DO NOTHING;
-- Driver-bound rows are seeded by the harness AFTER GoTrue creates the driver
-- auth user (FK: driver_payment_accounts.driver_id -> profiles.id).
SQL
qs "$tmp/fixtures.sql"

harness="$(cd "$tests" && { pwd -W 2>/dev/null || pwd; })/connected-journey.cjs"
SUPABASE_JWT_SECRET="$secret" PGRST_URL="http://127.0.0.1:$rest_port" GOTRUE_URL="http://127.0.0.1:$auth_port" \
 node "$harness"
