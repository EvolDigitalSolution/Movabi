#!/usr/bin/env bash
# Restore rehearsal for the develop deployment package — disposable only.
#
# Mirrors the RUNBOOK §0/§1 host procedure exactly, on a throwaway postgres:
#   1. restore a develop schema dump (the "current develop" fixture),
#   2. bring it to expected develop state: every pending repo migration
#      EXCEPT this package's files, best-effort (what develop already has
#      skips; what it needs applies — the same set a real develop would hold),
#   3. run the SHIPPED preflight-schema-check.sql (read-only inventory),
#   4. apply ONLY the shipped package migrations, in runbook order, strict —
#      this proves the archived bytes, not just the repo copies,
#   5. re-run the shipped preflight (every required object must be present),
#   6. run both shipped real-db rehearsal scripts, tear down.
#
# Usage:
#   BASELINE=develop_live_public_schema_20261112.sql bash package/rehearse-restore.sh
#
# Env:
#   PG_IMAGE   postgres image (default supabase/postgres:15.1.1.78 — the host engine)
#   BASELINE   file in supabase/baseline (default develop_live_public_schema_20261112.sql)
#   PSQL_USER  superuser for apply/tests (default supabase_admin for the supabase image)
set -euo pipefail
export MSYS_NO_PATHCONV=1
pkg="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$pkg/../../.." && pwd)"
pg_image="${PG_IMAGE:-supabase/postgres:15.1.1.78}"
baseline="${BASELINE:-develop_live_public_schema_20261112.sql}"
pguser="${PSQL_USER:-supabase_admin}"
id="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
db="vaydu-restore-$id"; auth="$db-auth"; net="$db-net"; name=movabi_develop
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
SQL
docker run -d --rm --network "$net" --name "$auth" \
 -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL=http://localhost:9999 -e GOTRUE_SITE_URL=http://localhost:3000 \
 -e GOTRUE_DB_NAMESPACE=auth -e GOTRUE_DB_DRIVER=postgres \
 -e "GOTRUE_DB_DATABASE_URL=postgres://postgres:isolated-test@$db:5432/$name?sslmode=disable&options=-csearch_path%3Dauth%2Cpublic" \
 -e GOTRUE_JWT_SECRET=synthetic-disposable-jwt-secret-minimum-40-characters -e GOTRUE_JWT_AUD=authenticated \
 supabase/gotrue:v2.132.3 >/dev/null
for _ in $(seq 1 120); do [ "$(q -c "select to_regclass('auth.users') is not null and exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.proname='uid')")" = t ] && break; sleep 0.5; done
sleep 2; docker rm -f "$auth" >/dev/null
q -c "CREATE TABLE IF NOT EXISTS auth.job_messages (id uuid); CREATE OR REPLACE FUNCTION auth.debug_errand_insert() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NEW; END \$\$;"

echo "== restore: $baseline"
sed 's/CREATE SCHEMA public;/CREATE SCHEMA IF NOT EXISTS public;/; s/CREATE EXTENSION /CREATE EXTENSION IF NOT EXISTS /' "$root/supabase/baseline/$baseline" | q >/dev/null
q < "$root/supabase/baseline/candidate/001_tenants.sql" >/dev/null
echo "restored."

pkg_names=" 20261270500000_errand_purchase_payer 20261270600000_customer_wallet_booking_bridge 20261270700000_driver_wallet_settlement 20261270800000_driver_settlement_policy 20261270900000_kora_payout_adapter 20261271000000_customer_collection_account_binding 20261271100000_kora_settle_reference "

echo "== step 1: bring restore to expected develop state (all repo migrations EXCEPT the package tail)"
skipped=0; applied_n=0
for f in "$root"/supabase/migrations/*.sql; do
  m="$(basename "$f" .sql)"; case "$m" in *.down) continue;; esac
  case "$pkg_names" in *" $m "*) continue;; esac
  out="$(q -1 < "$f" 2>&1 || true)"
  if echo "$out" | grep -qE '^(ERROR|FATAL)'; then skipped=$((skipped+1)); else applied_n=$((applied_n+1)); fi
done
echo "   develop-state chain: $applied_n applied, $skipped already-live/skipped"

echo "== step 2 (read-only): shipped preflight-schema-check BEFORE package"
q -F ' | ' < "$pkg/preflight-schema-check.sql" | grep -c " missing" | xargs -I{} echo "   {} required objects missing (expected)"
q -F ' | ' < "$pkg/preflight-schema-check.sql" | grep " missing" | grep -v "prereq" | head -5

echo "== step 3: apply ONLY the SHIPPED package migrations, runbook order, strict"
for m in 20261270500000_errand_purchase_payer 20261270600000_customer_wallet_booking_bridge          20261270700000_driver_wallet_settlement 20261270800000_driver_settlement_policy          20261270900000_kora_payout_adapter 20261271000000_customer_collection_account_binding          20261271100000_kora_settle_reference; do
  docker exec -i -e PGPASSWORD=isolated-test "$db" psql -X -U "$pguser" -d "$name" -v ON_ERROR_STOP=1 -1 < "$pkg/$m.sql" >/dev/null     && echo "   APPLIED $m" || { echo "   FAILED $m — abort (strict apply, nothing past this point)"; exit 1; }
done

echo "== step 4: preflight-schema-check AFTER package — all required objects present"
remaining="$(q -F ' | ' < "$pkg/preflight-schema-check.sql" | grep -c " missing" || true)"
echo "   missing after apply: $remaining"
[ "$remaining" = "0" ] || { echo "   REHEARSAL FAILED: required objects still missing"; exit 1; }

run_test(){ local file="$1" out; out="$(q -F ' | ' < "$pkg/$file")" || { echo "ERROR running $file"; exit 1; }
 echo "== $file"; echo "$out" | grep -E '\| (PASS|FAIL) \|' | sed 's/^/   /'
 local summary; summary="$(echo "$out" | tail -1)"; echo "   failures | checks = $summary"
 [ "${summary%% *}" = 0 ] || exit 1; }
run_test realdb-errand-purchase-payer-test.sql
run_test realdb-customer-funding-chain-test.sql
echo "RESTORE REHEARSAL PASSED: restore -> preflight -> strict package apply -> preflight clean -> shipped tests green"
