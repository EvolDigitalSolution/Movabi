#!/usr/bin/env bash
# Reproducible real-PostgreSQL evidence for 20261270500000_errand_purchase_payer.sql.
#
# Disposable containers only: postgres:16.15 + pinned GoTrue (creates the real auth schema), then the
# committed deployed develop schema export (supabase/baseline/deployed_public_schema.sql). The pending
# develop migrations that precede it are applied in order, then the errand purchase-payer migration,
# then the test (one transaction that ROLLS BACK). Never accepts a database URL.
#
# Usage: bash scripts/errand-purchase-payer/run-realdb-tests.sh    (exit 0 only if everything passed)
set -euo pipefail
export MSYS_NO_PATHCONV=1
root="$(cd "$(dirname "$0")/../.." && pwd)"
id="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
db="vaydu-errandpp-test-$id"; auth="$db-auth"; net="$db-net"; name=errandpp_test
tests="$root/deploy/vaydu-errand-purchase-payer"
cleanup(){ docker rm -f "$auth" "$db" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
trap cleanup EXIT
q(){ docker exec -i -e PGPASSWORD=isolated-test "$db" psql -X -U postgres -d "$name" -v ON_ERROR_STOP=1 -qAt "$@"; }

docker network create "$net" >/dev/null
docker run -d --rm --name "$db" --network "$net" -e POSTGRES_PASSWORD=isolated-test -e POSTGRES_DB="$name" postgres:16.15 >/dev/null
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
sed 's/CREATE SCHEMA public;/CREATE SCHEMA IF NOT EXISTS public;/; s/CREATE EXTENSION /CREATE EXTENSION IF NOT EXISTS /' "$root/supabase/baseline/deployed_public_schema.sql" | q >/dev/null
q < "$root/supabase/baseline/candidate/001_tenants.sql" >/dev/null

fail=0
apply(){ q < "$root/supabase/migrations/$1.sql" >/dev/null && echo "APPLIED $1" || { echo "FAILED to apply $1"; fail=1; }; }
run_test(){ local file="$1" out; out="$(q -F ' | ' < "$tests/$file")" || { echo "ERROR running $file"; fail=1; return; }
 echo "== $file"; echo "$out" | grep -E '\| (PASS|FAIL) \|' | sed 's/^/   /'
 local summary; summary="$(echo "$out" | tail -1)"; echo "   failures | checks = $summary"
 [ "${summary%% *}" = 0 ] || fail=1; }

# The pending 202612700..202612704 migrations capture live-develop drift (inspection/pin/referral/
# receivables objects that exist on live develop but not in this baseline export); they do not apply
# here and touch none of the errand purchase-payer objects. The errand migration applies directly
# on the deployed baseline it was written against.
apply 20261270500000_errand_purchase_payer
run_test realdb-errand-purchase-payer-test.sql

[ $fail = 0 ] && echo "ALL ERRAND PURCHASE-PAYER REAL-POSTGRES CHECKS PASSED" || { echo "ERRAND PURCHASE-PAYER REAL-POSTGRES CHECKS FAILED"; exit 1; }
