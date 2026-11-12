#!/usr/bin/env bash
# Extracts the definitions of the objects BOTH the roadmap chain and the cash-ride chain replace, from
# three disposable databases built on the committed deployed develop schema:
#   base    = deployed schema
#   roadmap = deployed + the upgraded-clone rehearsal chain (list read from that spec: one source of truth)
#   cash    = deployed + 20261266000000..20261266300000
# Output: <outdir>/{base,roadmap,cash}/<object>.sql  (pg_get_functiondef / constraint / policy text)
# Usage: bash scripts/migration-merge/extract-shared-objects.sh <outdir>
set -euo pipefail
export MSYS_NO_PATHCONV=1
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="${1:?usage: extract-shared-objects.sh <outdir>}"; mkdir -p "$out"
FUNCS="enforce_job_payment_eligibility enforce_ride_cash_credit_v1e reserve_cash_job_credit_v1e driver_cash_credit_status_v1f"
# The roadmap chain only: the rehearsal list minus the cash-ride chain, the merge, and later unrelated migrations.
chain="$(sed -n '/for (const migration of \[/,/\]) {/p' "$root/src/testing/bike-authenticated-routes.integration.spec.ts" | grep -oE "'[^']+\.sql'" | tr -d "'" | grep -Ev '^(20261266|20261267|20261268|20261269)')"
cash="20261266000000_driver_cash_credit_market_pilot.sql 20261266100000_cash_ride_booking_fee_hold.sql 20261266200000_cash_ride_activation.sql 20261266300000_cash_ride_completion.sql"

build(){ # $1 variant, $2 migration list
  local variant="$1" list="$2" id db auth net name=merge_test
  id="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"; db="vaydu-merge-$variant-$id"; auth="$db-auth"; net="$db-net"
  q(){ docker exec -i -e PGPASSWORD=isolated-test "$db" psql -X -U postgres -d "$name" -v ON_ERROR_STOP=1 -qAt "$@"; }
  trap 'docker rm -f "$auth" "$db" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true' RETURN
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
   -e GOTRUE_JWT_SECRET=synthetic-disposable-jwt-secret-minimum-40-characters -e GOTRUE_JWT_AUD=authenticated supabase/gotrue:v2.132.3 >/dev/null
  for _ in $(seq 1 120); do [ "$(q -c "select to_regclass('auth.users') is not null and exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.proname='uid')")" = t ] && break; sleep 0.5; done
  sleep 2; docker rm -f "$auth" >/dev/null
  q -c "CREATE TABLE IF NOT EXISTS auth.job_messages (id uuid); CREATE OR REPLACE FUNCTION auth.debug_errand_insert() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NEW; END \$\$;"
  sed 's/CREATE SCHEMA public;/CREATE SCHEMA IF NOT EXISTS public;/; s/CREATE EXTENSION /CREATE EXTENSION IF NOT EXISTS /' "$root/supabase/baseline/deployed_public_schema.sql" | q >/dev/null
  q < "$root/supabase/baseline/candidate/001_tenants.sql" >/dev/null 2>&1
  q -c "INSERT INTO public.system_configs(key,value) VALUES('countries','[{\"code\":\"GB\",\"currency\":\"GBP\"},{\"code\":\"NG\",\"currency\":\"NGN\"}]'::jsonb) ON CONFLICT DO NOTHING;" >/dev/null
  for m in $list; do
    case "$m" in candidate/*) src="$root/supabase/baseline/$m" ;; *) src="$root/supabase/migrations/$m" ;; esac
    q < "$src" >/dev/null 2>&1 || { echo "FAILED applying $m ($variant)"; q < "$src" 2>&1 | tail -3; return 1; }
  done
  mkdir -p "$out/$variant"
  for f in $FUNCS; do q -c "select pg_get_functiondef('public.$f'::regproc)" > "$out/$variant/$f.sql"; done
  q -c "select pg_get_constraintdef(oid) from pg_constraint where conname='jobs_payment_status_check'" > "$out/$variant/jobs_payment_status_check.sql"
  q -c "select 'USING ('||qual||')' from pg_policies where tablename='jobs' and policyname='Users can view relevant jobs'" > "$out/$variant/policy_view_jobs.sql"
  echo "extracted $variant"
}
build base ""
build roadmap "$chain"
build cash "$cash"
