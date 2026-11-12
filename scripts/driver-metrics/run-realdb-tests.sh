#!/usr/bin/env bash
# Real-PostgreSQL evidence for driver cancellation attribution (policy D9) and
# driver_offer_metrics_v2. Disposable containers only (postgres:16.15 + pinned GoTrue for the real
# auth schema), committed deployed develop schema, then 20261101000000_driver_offer_events and
# 20261267000000_driver_cancellation_attribution. The test is one transaction that rolls back.
# The rollback file must restore the pre-migration schema exactly. Never accepts a database URL.
# Usage: bash scripts/driver-metrics/run-realdb-tests.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1
root="$(cd "$(dirname "$0")/../.." && pwd)"
id="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
db="vaydu-metrics-test-$id"; auth="$db-auth"; net="$db-net"; name=metrics_test
cleanup(){ docker rm -f "$auth" "$db" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
trap cleanup EXIT
q(){ docker exec -i -e PGPASSWORD=isolated-test "$db" psql -X -U postgres -d "$name" -v ON_ERROR_STOP=1 -qAt "$@"; }
dump(){ docker exec -e PGPASSWORD=isolated-test "$db" pg_dump -U postgres -d "$name" -s -n public --no-owner | grep -v '^\\\(un\)\?restrict '; }

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
q -c "CREATE TABLE IF NOT EXISTS auth.job_messages (id uuid); CREATE OR REPLACE FUNCTION auth.debug_errand_insert() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NEW; END \$\$;"
sed 's/CREATE SCHEMA public;/CREATE SCHEMA IF NOT EXISTS public;/; s/CREATE EXTENSION /CREATE EXTENSION IF NOT EXISTS /' "$root/supabase/baseline/deployed_public_schema.sql" | q >/dev/null
q < "$root/supabase/baseline/candidate/001_tenants.sql" >/dev/null 2>&1
q < "$root/supabase/migrations/20261101000000_driver_offer_events.sql" >/dev/null && echo "APPLIED 20261101000000_driver_offer_events"
before="$(mktemp)"; dump > "$before"
q < "$root/supabase/migrations/20261267000000_driver_cancellation_attribution.sql" >/dev/null && echo "APPLIED 20261267000000_driver_cancellation_attribution"

fail=0
out="$(q -F ' | ' < "$root/scripts/driver-metrics/realdb-driver-metrics-test.sql")" || { echo "ERROR running test"; echo "$out"; exit 1; }
echo "$out" | grep -E '\| (PASS|FAIL) \|' | sed 's/^/   /'
summary="$(echo "$out" | tail -1)"; echo "   failures | checks = $summary"
[ "${summary%% *}" = 0 ] || fail=1

check(){ if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (got '$2', expected '$3')"; fail=1; fi; }
after="$(mktemp)"; dump > "$after"
q < "$root/supabase/migrations/20261267000000_driver_cancellation_attribution.sql" >/dev/null && echo "RE-APPLIED 20261267000000"
check "re-applying the migration is idempotent (schema unchanged)" "$(diff -q "$after" <(dump) >/dev/null && echo same || echo differs)" same

q < "$root/scripts/driver-metrics/20261267000000_driver_cancellation_attribution.down.sql" >/dev/null && echo "ROLLED BACK 20261267000000"
if diff -q "$before" <(dump) >/dev/null; then echo "PASS: schema after rollback identical to before the migration"; else echo "FAIL: schema differs after rollback"; diff "$before" <(dump) | head -30; fail=1; fi

# After rollback: an API that calls cancel_job_with_actor fails closed and changes nothing; the
# previous API path (cancel_job_safely) keeps working. Committed job, then probes in rolled-back txns.
q -c "SET session_replication_role = replica; INSERT INTO public.tenants(id,name,slug) VALUES ('22222222-2222-4222-8222-222222222222','r','r'); INSERT INTO auth.users(id) VALUES ('c1000000-0000-4000-8000-0000000000c1'); INSERT INTO public.profiles(id,tenant_id,role) VALUES ('c1000000-0000-4000-8000-0000000000c1','22222222-2222-4222-8222-222222222222','customer'); INSERT INTO public.jobs(id,tenant_id,customer_id,pickup_address,dropoff_address,scheduled_time,payment_method,payment_status,country_code,currency_code,status) VALUES ('00000000-0000-4000-8000-0000000000ff','22222222-2222-4222-8222-222222222222','c1000000-0000-4000-8000-0000000000c1','a','b',now(),'card','authorized','GB','GBP','searching');" >/dev/null
st="$(docker exec -i -e PGPASSWORD=isolated-test "$db" psql -X -U postgres -d "$name" -qAt -c "SELECT public.cancel_job_with_actor('00000000-0000-4000-8000-0000000000ff','x','c1000000-0000-4000-8000-0000000000c1','customer')" 2>&1 | grep -o 'function public.cancel_job_with_actor(.*) does not exist' | head -1 || true)"
check "after rollback the new cancel function is absent (API calling it is refused)" "${st:+absent}" absent
check "after rollback the refused call left the job unchanged" "$(q -c "select status||'|'||coalesce(metadata->>'cancelled_by','none') from public.jobs where id='00000000-0000-4000-8000-0000000000ff'")" "searching|none"
check "after rollback the previous API path (cancel_job_safely) still cancels" "$(q -c "begin; select public.cancel_job_safely('00000000-0000-4000-8000-0000000000ff','x'); rollback;")" "t"
q < "$root/supabase/migrations/20261267000000_driver_cancellation_attribution.sql" >/dev/null && echo "RE-APPLIED after rollback"
reapplied="$(mktemp)"; dump > "$reapplied"
check "re-apply after rollback restores the migrated schema" "$(diff -q "$after" "$reapplied" >/dev/null && echo same || echo differs)" same
diff "$after" "$reapplied" | head -40 || true; rm -f "$reapplied"
rm -f "$before" "$after"
[ $fail = 0 ] && echo "ALL DRIVER-METRICS REAL-POSTGRES CHECKS PASSED" || { echo "DRIVER-METRICS REAL-POSTGRES CHECKS FAILED"; exit 1; }
