#!/usr/bin/env bash
# Real-PostgreSQL proof for 20261269000000_merge_cash_pilot_with_roadmap_cash.
# Builds two disposable databases on the committed deployed develop schema:
#   A = roadmap chain -> cash-ride chain -> merge
#   B = cash-ride chain -> roadmap chain -> merge      (the expected develop order: 635a285 first)
# Proves: both orders give the identical public schema; the merge behaviour test passes; the existing
# cash-ride real-PG suites pass on the merged schema; the merge rollback restores the roadmap-final
# bodies exactly (CRLF-insensitive); re-applying the merge is idempotent. Never accepts a database URL.
# Usage: bash scripts/migration-merge/verify-merge.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1
root="$(cd "$(dirname "$0")/../.." && pwd)"
# The roadmap chain only: the rehearsal list minus the cash-ride chain, the merge, and later unrelated migrations.
chain="$(sed -n '/for (const migration of \[/,/\]) {/p' "$root/src/testing/bike-authenticated-routes.integration.spec.ts" | grep -oE "'[^']+\.sql'" | tr -d "'" | grep -Ev '^(20261266|20261267|20261268|20261269)')"
cash="20261266000000_driver_cash_credit_market_pilot.sql 20261266100000_cash_ride_booking_fee_hold.sql 20261266200000_cash_ride_activation.sql 20261266300000_cash_ride_completion.sql"
merge="20261269000000_merge_cash_pilot_with_roadmap_cash.sql"
tmp="$(mktemp -d)"; fail=0; dbs=()
cleanup(){ for d in "${dbs[@]:-}"; do [ -n "$d" ] && { docker rm -f "$d" "$d-auth" >/dev/null 2>&1 || true; docker network rm "$d-net" >/dev/null 2>&1 || true; }; done; rm -rf "$tmp"; }
trap cleanup EXIT
check(){ if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (got '$2', expected '$3')"; fail=1; fi; }
qd(){ local db="$1"; shift; docker exec -i -e PGPASSWORD=isolated-test "$db" psql -X -U postgres -d merge_test -v ON_ERROR_STOP=1 -qAt "$@"; }
dump(){ docker exec -e PGPASSWORD=isolated-test "$1" pg_dump -U postgres -d merge_test -s -n public --no-owner | grep -v '^\\\(un\)\?restrict ' | tr -d '\r'; }
apply_list(){ local db="$1" list="$2" m src; for m in $list; do case "$m" in candidate/*) src="$root/supabase/baseline/$m" ;; *) src="$root/supabase/migrations/$m" ;; esac
  qd "$db" < "$src" >/dev/null 2>"$tmp/err" || { echo "FAILED applying $m on $db"; tail -3 "$tmp/err"; return 1; }; done; }
bootstrap(){ # $1 db name
  local db="$1" net="$1-net" auth="$1-auth"; dbs+=("$db")
  docker network create "$net" >/dev/null
  docker run -d --rm --name "$db" --network "$net" -e POSTGRES_PASSWORD=isolated-test -e POSTGRES_DB=merge_test postgres:16.15 >/dev/null
  for _ in $(seq 1 120); do [ "$(docker logs "$db" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break; sleep 0.5; done
  qd "$db" <<'SQL'
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
   -e "GOTRUE_DB_DATABASE_URL=postgres://postgres:isolated-test@$db:5432/merge_test?sslmode=disable&options=-csearch_path%3Dauth%2Cpublic" \
   -e GOTRUE_JWT_SECRET=synthetic-disposable-jwt-secret-minimum-40-characters -e GOTRUE_JWT_AUD=authenticated supabase/gotrue:v2.132.3 >/dev/null
  for _ in $(seq 1 120); do [ "$(qd "$db" -c "select to_regclass('auth.users') is not null and exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.proname='uid')")" = t ] && break; sleep 0.5; done
  sleep 2; docker rm -f "$auth" >/dev/null
  qd "$db" -c "CREATE TABLE IF NOT EXISTS auth.job_messages (id uuid); CREATE OR REPLACE FUNCTION auth.debug_errand_insert() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NEW; END \$\$;"
  sed 's/CREATE SCHEMA public;/CREATE SCHEMA IF NOT EXISTS public;/; s/CREATE EXTENSION /CREATE EXTENSION IF NOT EXISTS /' "$root/supabase/baseline/deployed_public_schema.sql" | qd "$db" >/dev/null
  qd "$db" < "$root/supabase/baseline/candidate/001_tenants.sql" >/dev/null 2>&1
  qd "$db" -c "INSERT INTO public.system_configs(key,value) VALUES('countries','[{\"code\":\"GB\",\"currency\":\"GBP\"},{\"code\":\"NG\",\"currency\":\"NGN\"}]'::jsonb) ON CONFLICT DO NOTHING;" >/dev/null
}
run_sql_test(){ # $1 db, $2 file, $3 label
  local out summary; out="$(qd "$1" -F ' | ' < "$2" 2>&1)" || { echo "ERROR running $3"; echo "$out" | tail -5; fail=1; return; }
  echo "== $3"; echo "$out" | grep -E '\| (PASS|FAIL) \|' | sed 's/^/   /'
  summary="$(echo "$out" | tail -1)"; echo "   failures | checks = $summary"; [ "${summary%% *}" = 0 ] || fail=1; }

id="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
A="vaydu-mergeA-$id"; B="vaydu-mergeB-$id"
bootstrap "$A"; apply_list "$A" "$chain"; echo "A: roadmap chain applied"; apply_list "$A" "$cash"; echo "A: cash chain applied"
roadmap_then_cash="$(qd "$A" -c "select md5(string_agg(pg_get_functiondef(p.oid),'' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('enforce_ride_cash_credit_v1e','reserve_cash_job_credit_v1e','enforce_job_payment_eligibility')")"
apply_list "$A" "$merge"; echo "A: merge applied"
bootstrap "$B"; apply_list "$B" "$cash"; echo "B: cash chain applied"; apply_list "$B" "$chain"; echo "B: roadmap chain applied"
mkdir -p "$tmp/roadmapfinal"
for f in enforce_ride_cash_credit_v1e reserve_cash_job_credit_v1e enforce_job_payment_eligibility; do qd "$B" -c "select pg_get_functiondef('public.$f'::regproc)" | tr -d '\r' > "$tmp/roadmapfinal/$f.sql"; done
apply_list "$B" "$merge"; echo "B: merge applied"

check "both orders converge to the identical public schema" "$(diff -q <(dump "$A") <(dump "$B") >/dev/null && echo same || echo differs)" same
diff <(dump "$A") <(dump "$B") | head -20 || true
check "before the merge, order A (cash last) had different bodies than the merged result (the conflict is real)" \
  "$([ "$roadmap_then_cash" != "$(qd "$A" -c "select md5(string_agg(pg_get_functiondef(p.oid),'' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('enforce_ride_cash_credit_v1e','reserve_cash_job_credit_v1e','enforce_job_payment_eligibility')")" ] && echo yes || echo no)" yes

run_sql_test "$A" "$root/scripts/migration-merge/realdb-merge-test.sql" "merge behaviour (order A)"
run_sql_test "$B" "$root/scripts/migration-merge/realdb-merge-test.sql" "merge behaviour (order B)"
for t in realdb-market-pilot-test.sql realdb-cash-booking-acquisition-test.sql realdb-cash-booking-chain-test.sql realdb-cash-ride-lifecycle-test.sql; do
  run_sql_test "$B" "$root/deploy/vaydu-cash-ride-market-pilot/$t" "cash-ride suite on the merged schema: $t"
done

merged="$(mktemp)"; dump "$B" > "$merged"
qd "$B" < "$root/supabase/migrations/$merge" >/dev/null && echo "B: merge re-applied"
check "re-applying the merge is idempotent" "$(diff -q "$merged" <(dump "$B") >/dev/null && echo same || echo differs)" same
qd "$B" < "$root/scripts/migration-merge/${merge%.sql}.down.sql" >/dev/null && echo "B: merge rolled back"
for f in enforce_ride_cash_credit_v1e reserve_cash_job_credit_v1e enforce_job_payment_eligibility; do
  check "rollback restores the roadmap-final $f exactly" "$(diff -q <(qd "$B" -c "select pg_get_functiondef('public.$f'::regproc)" | tr -d '\r') "$tmp/roadmapfinal/$f.sql" >/dev/null && echo same || echo differs)" same
done
check "rollback removes the merge helpers and courier_enabled" "$(qd "$B" -c "select (to_regprocedure('public.cash_service_enabled_v1e(text,text,text)') is null and to_regprocedure('public.cash_acquisition_allowed_v1e(public.jobs)') is null and not exists(select 1 from information_schema.columns where table_name='driver_cash_credit_markets_v1e' and column_name='courier_enabled'))::text")" true
rm -f "$merged"
[ $fail = 0 ] && echo "ALL MERGE CHECKS PASSED" || { echo "MERGE CHECKS FAILED"; exit 1; }
