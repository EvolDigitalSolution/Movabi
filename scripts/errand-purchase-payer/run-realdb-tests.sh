#!/usr/bin/env bash
# Reproducible real-PostgreSQL evidence for:
#   20261270500000_errand_purchase_payer.sql
#   20261270600000_customer_wallet_booking_bridge.sql
#
# Disposable containers only: a pinned postgres image + pinned GoTrue (creates the real auth
# schema), then a committed baseline schema export. The pending migrations are applied in order,
# then the tests (each one transaction that ROLLS BACK). Never accepts a database URL.
#
# Usage:
#   bash scripts/errand-purchase-payer/run-realdb-tests.sh
#   PG_IMAGE=supabase/postgres:15.1.1.78 BASELINE=develop_live_public_schema_20261112 \
#     bash scripts/errand-purchase-payer/run-realdb-tests.sh
#
# Env:
#   PG_IMAGE  postgres image (default postgres:16.15; use supabase/postgres:15.1.1.78 to rehearse
#             against the host's engine version)
#   BASELINE  file in supabase/baseline (default deployed_public_schema.sql; use
#             develop_live_public_schema_20261112.sql to mirror the live develop schema, which
#             already contains the batch-2 collection objects the funding-chain test exercises)
#   PSQL_USER superuser for schema apply/tests (default postgres; on supabase/postgres images
#             postgres is NOT a superuser — use supabase_admin)
set -euo pipefail
export MSYS_NO_PATHCONV=1
root="$(cd "$(dirname "$0")/../.." && pwd)"
pg_image="${PG_IMAGE:-postgres:16.15}"
baseline="${BASELINE:-deployed_public_schema.sql}"
pguser="${PSQL_USER:-postgres}"
id="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
db="vaydu-errandpp-test-$id"; auth="$db-auth"; net="$db-net"; name=errandpp_test
tests="$root/deploy/vaydu-errand-purchase-payer"
cleanup(){ docker rm -f "$auth" "$db" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
trap cleanup EXIT
q(){ docker exec -i -e PGPASSWORD=isolated-test "$db" psql -X -U "$pguser" -d "$name" -v ON_ERROR_STOP=1 -qAt "$@"; }

docker network create "$net" >/dev/null
docker run -d --rm --name "$db" --network "$net" -e POSTGRES_PASSWORD=isolated-test -e POSTGRES_DB="$name" "$pg_image" >/dev/null
for _ in $(seq 1 120); do [ "$(docker logs "$db" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break; sleep 0.5; done
q <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
END $$;
-- On images where the applying role is not already privileged, grant the admin roles so the
-- baseline's OWNER/GRANT statements succeed. No-op where postgres is a plain role (supabase
-- image: run with PSQL_USER=supabase_admin, which already IS the superuser).
DO $$ BEGIN
  IF current_user = 'postgres' AND (SELECT rolsuper FROM pg_roles WHERE rolname='postgres') THEN
    EXECUTE 'GRANT supabase_admin, supabase_auth_admin TO postgres';
  END IF; END $$;
SQL
docker run -d --rm --network "$net" --name "$auth" \
 -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL=http://localhost:9999 -e GOTRUE_SITE_URL=http://localhost:3000 \
 -e GOTRUE_DB_NAMESPACE=auth -e GOTRUE_DB_DRIVER=postgres \
 -e "GOTRUE_DB_DATABASE_URL=postgres://postgres:isolated-test@$db:5432/$name?sslmode=disable&options=-csearch_path%3Dauth%2Cpublic" \
 -e GOTRUE_JWT_SECRET=synthetic-disposable-jwt-secret-minimum-40-characters -e GOTRUE_JWT_AUD=authenticated \
 supabase/gotrue:v2.132.3 >/dev/null
for _ in $(seq 1 120); do [ "$(q -c "select to_regclass('auth.users') is not null and exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.proname='uid')")" = t ] && break; sleep 0.5; done
sleep 2; docker rm -f "$auth" >/dev/null
# Shims for two auth objects the public export references but GoTrue does not create (never exercised).
q -c "CREATE TABLE IF NOT EXISTS auth.job_messages (id uuid); CREATE OR REPLACE FUNCTION auth.debug_errand_insert() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NEW; END \$\$;"
sed 's/CREATE SCHEMA public;/CREATE SCHEMA IF NOT EXISTS public;/; s/CREATE EXTENSION /CREATE EXTENSION IF NOT EXISTS /' "$root/supabase/baseline/$baseline" | q >/dev/null
q < "$root/supabase/baseline/candidate/001_tenants.sql" >/dev/null

fail=0
apply(){ q < "$root/supabase/migrations/$1.sql" >/dev/null && echo "APPLIED $1" || { echo "FAILED to apply $1"; fail=1; }; }
run_test(){ local file="$1" out; out="$(q -F ' | ' < "$tests/$file")" || { echo "ERROR running $file"; fail=1; return; }
 echo "== $file"; echo "$out" | grep -E '\| (PASS|FAIL) \|' | sed 's/^/   /'
 local summary; summary="$(echo "$out" | tail -1)"; echo "   failures | checks = $summary"
 [ "${summary%% *}" = 0 ] || fail=1; }

# The pending 202612700..202612704 migrations capture live-develop drift (inspection/pin/referral/
# receivables objects that exist on live develop but not in the deployed baseline export); they do
# not apply there and touch none of the errand purchase-payer objects. The errand and bridge
# migrations apply directly on the baselines they were written against.
apply 20261270500000_errand_purchase_payer
apply 20261270600000_customer_wallet_booking_bridge
run_test realdb-errand-purchase-payer-test.sql

# The customer-funding chain exercises the batch-2 collection objects
# (freeze_wallet_topup_fee / confirm_wallet_topup_with_total / fee schedules). Those exist on the
# live-develop baseline; the older deployed export predates them, so the chain is only exercised
# where its prerequisites exist — which is also the schema the host actually runs.
if [ "$(q -c "select to_regprocedure('public.freeze_wallet_topup_fee(uuid,text)') is not null and to_regprocedure('public.confirm_wallet_topup_with_total(uuid,text,text,text,bigint,text)') is not null and to_regclass('public.wallet_topup_fee_schedules') is not null")" = t ]; then
  run_test realdb-customer-funding-chain-test.sql
else
  echo "SKIP realdb-customer-funding-chain-test.sql (baseline predates batch-2 collection objects)"
fi

[ $fail = 0 ] && echo "ALL ERRAND PURCHASE-PAYER REAL-POSTGRES CHECKS PASSED" || { echo "ERRAND PURCHASE-PAYER REAL-POSTGRES CHECKS FAILED"; exit 1; }
