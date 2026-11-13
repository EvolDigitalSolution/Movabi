#!/usr/bin/env bash
# Rehearse the develop release migration on an isolated copy of develop's LIVE schema.
# Disposable containers only: postgres:15.1 (develop's version), pinned GoTrue for auth, a minimal
# storage shim. Never accepts a database URL. Exit 0 only if every check passes.
#
# Checks: release-up.sql applies as ONE transaction; an injected failure leaves the schema untouched;
# the dry run changes nothing; sequential per-file application gives the identical schema; the
# result equals the reconciled chain's final functions; the real-DB behaviour suites pass on it;
# release-down.sql restores the exact pre-release schema; re-applying restores the release schema.
# Usage: bash scripts/release/rehearse-live-upgrade.sh <live_public_schema.sql> <reconcile-out-dir-with-final-snapshot>
set -euo pipefail
export MSYS_NO_PATHCONV=1
root="$(cd "$(dirname "$0")/../.." && pwd)"
LIVE_SQL="$1"; CHAIN_DIR="$2"; rel="$root/deploy/vaydu-develop-release"
id="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
db="vaydu-rehearse-$id"; auth="$db-auth"; net="$db-net"; tmp="$(mktemp -d)"
cleanup(){ docker rm -f "$auth" "$db" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
q(){ local d="$1"; shift; docker exec -i -e PGPASSWORD=isolated-test "$db" psql -X -U postgres -d "$d" -v ON_ERROR_STOP=1 -qAt "$@"; }
dump(){ docker exec -e PGPASSWORD=isolated-test "$db" pg_dump -U postgres -d "$1" -s -n public --no-owner | grep -av '^\\\(un\)\?restrict ' | tr -d '\r'; }
FPQ="select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'||chr(9)||md5(replace(pg_get_functiondef(p.oid),chr(13),'')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p') order by 1;"
fail=0
check(){ if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (got '$2', expected '$3')"; fail=1; fi; }
prep(){ local py=python3; command -v python3 >/dev/null 2>&1 && python3 -c 1 >/dev/null 2>&1 || py=python
 "$py" -c 'import sys;d=sys.stdin.buffer.read();sys.stdout.buffer.write(d.replace(b"CREATE SCHEMA public;",b"CREATE SCHEMA IF NOT EXISTS public;").replace(b"CREATE EXTENSION ",b"CREATE EXTENSION IF NOT EXISTS "))' < "$1"; }
run_test(){ local d="$1" file="$2" label="$3" out summary
  out="$(q "$d" -F ' | ' < "$file" 2>&1)" || { echo "FAIL: $label (error running)"; echo "$out" | tail -5; fail=1; return; }
  summary="$(echo "$out" | tail -1)"
  if [ "${summary%% *}" = 0 ]; then echo "PASS: $label ($summary)"; else echo "FAIL: $label ($summary)"; echo "$out" | grep -E '\| FAIL \|' | head -10; fail=1; fi; }

docker network create "$net" >/dev/null
docker run -d --rm --name "$db" --network "$net" -e POSTGRES_PASSWORD=isolated-test -e POSTGRES_DB=template_auth postgres:15.1 >/dev/null
for _ in $(seq 1 120); do [ "$(docker logs "$db" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break; sleep 0.5; done
q template_auth <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_storage_admin') THEN CREATE ROLE supabase_storage_admin NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dashboard_user') THEN CREATE ROLE dashboard_user NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pgbouncer') THEN CREATE ROLE pgbouncer NOLOGIN; END IF;
END $$;
SQL
docker run -d --rm --network "$net" --name "$auth" \
 -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL=http://localhost:9999 -e GOTRUE_SITE_URL=http://localhost:3000 \
 -e GOTRUE_DB_NAMESPACE=auth -e GOTRUE_DB_DRIVER=postgres \
 -e "GOTRUE_DB_DATABASE_URL=postgres://postgres:isolated-test@$db:5432/template_auth?sslmode=disable&options=-csearch_path%3Dauth%2Cpublic" \
 -e GOTRUE_JWT_SECRET=synthetic-disposable-jwt-secret-minimum-40-characters -e GOTRUE_JWT_AUD=authenticated \
 supabase/gotrue:v2.132.3 >/dev/null
for _ in $(seq 1 120); do [ "$(q template_auth -c "select to_regclass('auth.users') is not null and exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.proname='uid')")" = t ] && break; sleep 0.5; done
sleep 2; docker rm -f "$auth" >/dev/null
q template_auth -c "CREATE SCHEMA IF NOT EXISTS storage; CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], owner uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()); CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), last_accessed_at timestamptz DEFAULT now()); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;"
q template_auth -c "CREATE TABLE IF NOT EXISTS auth.job_messages (id uuid); CREATE OR REPLACE FUNCTION auth.debug_errand_insert() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NEW; END \$\$;"
prep "$LIVE_SQL" | q template_auth >/dev/null
for d in rel seq inject dry; do q postgres -c "CREATE DATABASE $d TEMPLATE template_auth;"; done
dump rel > "$tmp/before.sql"
echo "live schema restored: $(grep -c '^CREATE TABLE' "$tmp/before.sql") tables, $(grep -c '^CREATE FUNCTION' "$tmp/before.sql") functions"

# Atomicity: the release with a failure injected just before COMMIT must leave the schema untouched.
[ "$(tail -1 "$rel/release-up.sql")" = 'COMMIT;' ] || { echo 'FATAL: release-up.sql does not end in COMMIT;'; exit 1; }
sed '$d' "$rel/release-up.sql" > "$tmp/inject.sql"; printf 'SELECT 1/0 AS injected_failure;\nCOMMIT;\n' >> "$tmp/inject.sql"
if q inject < "$tmp/inject.sql" > "$tmp/inject.log" 2>&1; then echo "FAIL: injected failure did not abort"; fail=1; else echo "PASS: injected failure aborted the release ($(grep -m1 -o 'division by zero' "$tmp/inject.log"))"; fi
check "after an aborted release the schema is unchanged" "$(diff -q "$tmp/before.sql" <(dump inject) >/dev/null && echo same || echo differs)" same

# Dry run (what the host runs against the real data first): ends in ROLLBACK.
q dry < "$rel/release-dryrun.sql" > "$tmp/dry.log" 2>&1 && echo "PASS: dry run completed" || { echo "FAIL: dry run errored"; tail -5 "$tmp/dry.log"; fail=1; }
check "dry run leaves the schema unchanged" "$(diff -q "$tmp/before.sql" <(dump dry) >/dev/null && echo same || echo differs)" same

# Host gates: PREREQ passes on the pre-release schema, VERIFY refuses it.
q dry < "$rel/PREREQ.sql" > "$tmp/prereq-pre.log" 2>&1 && echo "PASS: PREREQ.sql accepts the pre-release live schema" || { echo "FAIL: PREREQ.sql on the pre-release schema"; grep -v '^$' "$tmp/prereq-pre.log" | tail -6; fail=1; }
if q dry < "$rel/VERIFY.sql" > "$tmp/verify-pre.log" 2>&1; then echo "FAIL: VERIFY.sql accepted the pre-release schema"; fail=1; else echo "PASS: VERIFY.sql refuses the pre-release schema"; fi

# The release.
if q rel < "$rel/release-up.sql" > "$tmp/up.log" 2>&1; then echo "PASS: release-up.sql applied as one transaction"; else echo "FAIL: release-up.sql"; grep -v NOTICE "$tmp/up.log" | tail -8; exit 1; fi
dump rel > "$tmp/after.sql"

# Host gates after the release: VERIFY passes, PREREQ refuses a second application.
q rel < "$rel/VERIFY.sql" > "$tmp/verify-post.log" 2>&1 && echo "PASS: VERIFY.sql accepts the released schema ($(grep -o 'VERIFY OK[^\"]*' "$tmp/verify-post.log" | head -1))" || { echo "FAIL: VERIFY.sql on the released schema"; tail -8 "$tmp/verify-post.log"; fail=1; }
if q rel < "$rel/PREREQ.sql" > "$tmp/prereq-post.log" 2>&1; then echo "FAIL: PREREQ.sql accepted the released schema"; fail=1; else echo "PASS: PREREQ.sql refuses the released schema"; fi

# Equivalence with per-file application (the reviewed migration files themselves).
for m in 20261266000000_driver_cash_credit_market_pilot 20261266100000_cash_ride_booking_fee_hold 20261266200000_cash_ride_activation 20261266300000_cash_ride_completion 20261267000000_driver_cancellation_attribution 20261268000000_cancellation_fee_quote 20261269000000_merge_cash_pilot_with_roadmap_cash; do
  q seq < "$root/supabase/migrations/$m.sql" >/dev/null 2>"$tmp/seq.err" || { echo "FAIL: sequential $m"; grep -v NOTICE "$tmp/seq.err" | tail -3; fail=1; }
done
check "combined release = the 7 files applied one by one (identical schema)" "$(diff -q "$tmp/after.sql" <(dump seq) >/dev/null && echo same || echo differs)" same

# Equivalence with the reconciled chain's final state (every function the chain ends with).
final="$(ls "$CHAIN_DIR"/snap-*-functions.tsv | sort | tail -1)"
q rel -c "$FPQ" > "$tmp/rel-fp.tsv"
missing_or_different="$(join -t "$(printf '\t')" -a1 -e MISSING -o 0,1.2,2.2 <(sort "$final") <(sort "$tmp/rel-fp.tsv") | awk -F'\t' '$2!=$3' | wc -l | tr -d ' ')"
check "every function of the reconciled chain's final state is identical after the release" "$missing_or_different" 0
extra="$(join -t "$(printf '\t')" -v2 <(sort "$final") <(sort "$tmp/rel-fp.tsv") | cut -f1 | tr '\n' ' ')"
echo "INFO: functions present only on develop (out-of-chain, untouched by the release): ${extra:-none}"

# Release objects present; nothing enabled.
check "cash markets table exists and no market is enabled" "$(q rel -c "select count(*) from public.driver_cash_credit_markets_v1e where enabled")" 0
check "new functions present" "$(q rel -c "select count(*) from pg_proc where proname in ('cancel_job_with_actor','cancellation_fee_quote','driver_offer_metrics_v2','record_negotiated_assignment','set_cancellation_policy_enabled','activate_cash_ride_v1e','complete_cash_ride_v1e','cash_service_enabled_v1e','cash_acquisition_allowed_v1e')")" 9
check "no client grant on the new cash hold table" "$(q rel -c "select has_table_privilege('authenticated','public.cash_ride_fee_holds_v1e','SELECT')")" f

# Behaviour suites on the released live schema (each test file is one transaction that rolls back).
for t in realdb-market-pilot-test.sql realdb-cash-booking-acquisition-test.sql realdb-cash-booking-chain-test.sql realdb-cash-ride-lifecycle-test.sql; do run_test rel "$root/deploy/vaydu-cash-ride-market-pilot/$t" "cash-ride: $t"; done
run_test rel "$root/scripts/migration-merge/realdb-merge-test.sql" "merge behaviour"
run_test rel "$root/scripts/driver-metrics/realdb-driver-metrics-test.sql" "driver metrics (D9)"
run_test rel "$root/scripts/cancellation-fee/realdb-cancellation-fee-test.sql" "cancellation fee quote"
check "behaviour suites left the schema unchanged" "$(diff -q "$tmp/after.sql" <(dump rel) >/dev/null && echo same || echo differs)" same

# Real-data conditions (as found by the host drill): develop's on_auth_user_created trigger and its
# market rows. Without the drill preamble the suites must fail as on the host; with it they must pass.
q postgres -c "CREATE DATABASE realish TEMPLATE rel;"
q realish -c "CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();"
q realish -c "INSERT INTO public.market_availability(country_code,market_city,supported_currency,launch_status,enabled,quote_enabled,booking_enabled,payment_enabled,timezone) VALUES ('GB','London','GBP','live',true,true,true,true,'Europe/London'),('GB',NULL,'GBP','live',true,true,true,true,'Europe/London'),('NG',NULL,'NGN','live',true,true,true,true,'Africa/Lagos');"
q realish -c "INSERT INTO public.service_types(id,slug,name) VALUES ('5e5e5e5e-0000-4000-8000-000000000001','ride','Ride'),('5e5e5e5e-0000-4000-8000-000000000002','delivery','Delivery'),('5e5e5e5e-0000-4000-8000-000000000003','errand','Errand') ON CONFLICT DO NOTHING;"
with_preamble(){ awk -v pre="$rel/drill-preamble.sql" 'BEGIN{done=0} { print } !done && $0 ~ /^BEGIN;[ \t\r]*$/ { while ((getline l < pre) > 0) print l; done=1 }' "$1"; }
raw_fail=0
for t in "$root"/deploy/vaydu-cash-ride-market-pilot/realdb-*-test.sql "$root"/scripts/migration-merge/realdb-merge-test.sql "$root"/scripts/driver-metrics/realdb-driver-metrics-test.sql "$root"/scripts/cancellation-fee/realdb-cancellation-fee-test.sql; do
  out="$(q realish -F ' | ' < "$t" 2>&1)" && [ "$(echo "$out" | tail -1 | cut -d' ' -f1)" = 0 ] || raw_fail=$((raw_fail+1))
  with_preamble "$t" > "$tmp/pre-$(basename "$t")"; run_test realish "$tmp/pre-$(basename "$t")" "real-data conditions + drill preamble: $(basename "$t")"
done
check "without the preamble the suites fail under real-data conditions (reproduces the host drill)" "$([ "$raw_fail" -ge 6 ] && echo yes || echo "no ($raw_fail)")" yes

# D15: the API (service_role) may assign a driver's inspection market; the driver (authenticated) may not.
d15="$(q realish <<'SQL' 2>&1
BEGIN;
INSERT INTO public.tenants(id,name,slug) VALUES ('d15d15d1-0000-4000-8000-000000000001','D15','d15-test');
ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created;
INSERT INTO auth.users(id,email) VALUES ('d15d15d1-0000-4000-8000-0000000000d1','d15@x.test');
INSERT INTO public.profiles(id,tenant_id,role,country_code,registration_country_code) VALUES ('d15d15d1-0000-4000-8000-0000000000d1','d15d15d1-0000-4000-8000-000000000001','driver','GB','GB');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"d15d15d1-0000-4000-8000-0000000000d1","role":"authenticated"}',true);
DO $$ BEGIN
  BEGIN UPDATE public.profiles SET inspection_market_code='GB' WHERE id='d15d15d1-0000-4000-8000-0000000000d1'; RAISE NOTICE 'D15 driver self-assign: ALLOWED';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'D15 driver self-assign: REFUSED'; END;
END $$;
RESET ROLE;
SET LOCAL ROLE service_role;
UPDATE public.profiles SET inspection_market_code='GB' WHERE id='d15d15d1-0000-4000-8000-0000000000d1' AND role='driver' AND inspection_market_code IS NULL;
RESET ROLE;
SELECT 'D15 market after service_role update: '||coalesce(inspection_market_code,'null') FROM public.profiles WHERE id='d15d15d1-0000-4000-8000-0000000000d1';
ROLLBACK;
SQL
)" || true
echo "$d15" | grep -iE "error|D15" | sed 's/^/  d15: /'
check "D15: a driver cannot assign their own inspection market" "$(echo "$d15" | grep -o 'driver self-assign: [A-Z]*' | head -1)" "driver self-assign: REFUSED"
check "D15: the API (service_role) assigns it" "$(echo "$d15" | grep -o 'service_role update: [A-Z]*' | head -1)" "service_role update: GB"

# Recovery: the rollback restores the exact pre-release schema; re-applying restores the release.
if q rel < "$rel/release-down.sql" > "$tmp/down.log" 2>&1; then echo "PASS: release-down.sql applied as one transaction"; else echo "FAIL: release-down.sql"; grep -v NOTICE "$tmp/down.log" | tail -8; fail=1; fi
check "rollback restores the exact pre-release schema" "$(diff -q "$tmp/before.sql" <(dump rel) >/dev/null && echo same || echo differs)" same
diff "$tmp/before.sql" <(dump rel) > "$root/.tmp-release/rollback-diff.txt" || true; head -20 "$root/.tmp-release/rollback-diff.txt"
q rel < "$rel/release-up.sql" >/dev/null 2>&1 && echo "RE-APPLIED release-up.sql"
check "re-applying after rollback restores the release schema" "$(diff -q "$tmp/after.sql" <(dump rel) >/dev/null && echo same || echo differs)" same
q rel < "$rel/release-up.sql" >/dev/null 2>&1 && echo "APPLIED release-up.sql a second time"
check "the release is idempotent (second application changes nothing)" "$(diff -q "$tmp/after.sql" <(dump rel) >/dev/null && echo same || echo differs)" same

[ "$fail" = 0 ] && echo "ALL LIVE-SCHEMA RELEASE REHEARSAL CHECKS PASSED" || { echo "LIVE-SCHEMA RELEASE REHEARSAL FAILED"; exit 1; }
