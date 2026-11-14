#!/usr/bin/env bash
# Rehearse develop RELEASE 2 (D12 capture + completion PIN) on develop's live schema + release 1.
# Disposable containers only: postgres:15.1 (develop's version), pinned GoTrue for auth, a minimal
# storage shim. Never accepts a database URL. Exit 0 only if every check passes.
#
# Checks: release-up.sql applies as ONE transaction; an injected failure leaves the schema untouched;
# the dry run changes nothing; sequential per-file application gives the identical schema; the
# result equals the reconciled chain's final functions; the real-DB behaviour suites pass on it;
# release-down.sql restores the exact pre-release schema; re-applying restores the release schema.
# Usage: bash scripts/release/rehearse-live-upgrade.sh <live_public_schema.sql> <reconcile-out-dir-with-final-snapshot>
# Checks: PREREQ accepts develop's current state and VERIFY refuses it; an injected failure and the
# dry run leave the schema untouched; release-up applies as one transaction; D12 changes no existing
# object on develop; VERIFY passes; the PIN real-DB suite passes; release-down restores the exact
# pre-release-2 schema; re-apply passes VERIFY; on an environment WITHOUT develop's drift the
# migration creates the column and the 6-argument function with develop's exact fingerprint.
# Usage: bash scripts/release/rehearse-release-2.sh supabase/baseline/develop_live_public_schema_20261112.sql
set -euo pipefail
export MSYS_NO_PATHCONV=1
root="$(cd "$(dirname "$0")/../.." && pwd)"
LIVE_SQL="$1"; r1="$root/deploy/vaydu-develop-release"; rel="$root/deploy/vaydu-develop-release-2"
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

q template_auth < "$r1/release-up.sql" > "$tmp/r1.log" 2>&1 || { echo "FATAL: release 1 did not apply to the live schema"; tail -5 "$tmp/r1.log"; exit 1; }
q template_auth < "$r1/VERIFY.sql" > /dev/null && echo "PASS: template = develop today (live schema + release 1, VERIFY 1 OK)"
# Existing inspection evidence and a storage policy, as on develop: photos in every status with review
# fields, on a current vehicle revision, plus an RLS policy on storage.objects for the inspection bucket.
q template_auth <<'SQL'
SET session_replication_role = replica;
INSERT INTO public.tenants(id,name,slug) VALUES ('5a5a5a5a-0000-4000-8000-000000000001','d12','d12-tenant');
INSERT INTO auth.users(id) VALUES ('5a5a5a5a-0000-4000-8000-0000000000d1'),('5a5a5a5a-0000-4000-8000-0000000000a1');
INSERT INTO public.profiles(id,tenant_id,role,country_code) VALUES ('5a5a5a5a-0000-4000-8000-0000000000d1','5a5a5a5a-0000-4000-8000-000000000001','driver','GB'),
 ('5a5a5a5a-0000-4000-8000-0000000000a1','5a5a5a5a-0000-4000-8000-000000000001','admin','GB');
INSERT INTO public.vehicles(id,user_id,type,make,model,color,year,license_plate) VALUES ('5a5a5a5a-0000-4000-8000-0000000000e1','5a5a5a5a-0000-4000-8000-0000000000d1','car','M','X','b','2020','D12 001');
INSERT INTO public.driver_vehicle_inspection_photos(driver_id,tenant_id,vehicle_id,vehicle_revision,slot,storage_path,status,byte_size,content_type,reviewed_by,reviewed_at,rejection_reason,reason)
SELECT '5a5a5a5a-0000-4000-8000-0000000000d1','5a5a5a5a-0000-4000-8000-000000000001',v.id,v.inspection_revision,x.slot,'inspection/d12/'||x.slot||'.jpg',x.status,1000,'image/jpeg',
       CASE WHEN x.status IN ('approved','rejected') THEN '5a5a5a5a-0000-4000-8000-0000000000a1'::uuid END, CASE WHEN x.status IN ('approved','rejected') THEN now() END,
       CASE WHEN x.status='rejected' THEN 'blurred' END, CASE WHEN x.slot='rear' THEN 'develop-only reason value' END
  FROM public.vehicles v, (VALUES ('front','approved'),('rear','approved'),('dashboard','under_review'),('seats_interior','rejected'),('left_side','replaced'),('right_side','uploaded')) x(slot,status)
 WHERE v.id='5a5a5a5a-0000-4000-8000-0000000000e1';
INSERT INTO storage.buckets(id,name) VALUES ('driver-inspection','driver-inspection') ON CONFLICT DO NOTHING;
CREATE POLICY "drivers read own inspection photos" ON storage.objects FOR SELECT TO authenticated USING (bucket_id='driver-inspection' AND owner = auth.uid());
SQL
for d in rel inject dry fresh; do q postgres -c "CREATE DATABASE $d TEMPLATE template_auth;"; done
PHOTOQ="select count(*)||':'||md5(string_agg(row_to_json(p)::text,'|' order by p.id)) from public.driver_vehicle_inspection_photos p"
APPROVEDQ="select string_agg(slot||'='||status,',' order by slot) from public.driver_vehicle_inspection_photos"
ACLQ="select coalesce(c.relacl::text,'')||'|'||c.relrowsecurity::text||'|'||coalesce((select string_agg(policyname||':'||cmd||':'||array_to_string(roles,',')||':'||coalesce(qual,'')||':'||coalesce(with_check,''),';' order by policyname) from pg_policies where schemaname='public' and tablename='driver_vehicle_inspection_photos'),'') from pg_class c where c.oid='public.driver_vehicle_inspection_photos'::regclass"
STORQ="select coalesce(string_agg(tablename||':'||policyname||':'||cmd||':'||coalesce(qual,''),';' order by tablename,policyname),'none')||'|'||(select coalesce(relacl::text,'') from pg_class where oid='storage.objects'::regclass) from pg_policies where schemaname='storage'"
FNACLQ="select string_agg(p.oid::regprocedure::text||'='||coalesce(p.proacl::text,''),';' order by p.oid::regprocedure::text) from pg_proc p where p.proname='register_driver_inspection_photo'"
for v in PHOTOQ ACLQ STORQ FNACLQ; do q rel -c "${!v}" > "$tmp/$v.before"; done
echo "seeded evidence: $(q rel -c "$APPROVEDQ")"
dump rel > "$tmp/before.sql"; q rel -c "$FPQ" > "$tmp/fp-before.tsv"
COLQ="select string_agg(column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,''),',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='driver_vehicle_inspection_photos'"
q rel -c "$COLQ" > "$tmp/cols-before.txt"
check "develop's 6-argument function fingerprint in the live schema (CR removed; raw 65e2f700... in the host inventory)" "$(grep -F 'public.register_driver_inspection_photo(p_driver uuid, p_tenant uuid, p_vehicle uuid, p_revision uuid, p_slot text, p_path text)' "$tmp/fp-before.tsv" | cut -f2)" f180b0b86f587154270a0493786d9838

if [ -f "$rel/PREREQ.sql" ]; then
 q dry < "$rel/PREREQ.sql" > "$tmp/p.log" 2>&1 && echo "PASS: PREREQ (release 2) accepts develop's current state" || { echo "FAIL: PREREQ on develop's state"; tail -4 "$tmp/p.log"; fail=1; }
 if q dry < "$rel/VERIFY.sql" > /dev/null 2>&1; then echo "FAIL: VERIFY (release 2) accepted the pre-release state"; fail=1; else echo "PASS: VERIFY (release 2) refuses the pre-release state"; fi
fi
sed '$d' "$rel/release-up.sql" > "$tmp/inject.sql"; printf 'SELECT 1/0 AS injected_failure;\nCOMMIT;\n' >> "$tmp/inject.sql"
if q inject < "$tmp/inject.sql" > "$tmp/inject.log" 2>&1; then echo "FAIL: injected failure did not abort"; fail=1; else echo "PASS: injected failure aborted release 2"; fi
check "after an aborted release the schema is unchanged" "$(diff -q "$tmp/before.sql" <(dump inject) >/dev/null && echo same || echo differs)" same
q dry < "$rel/release-dryrun.sql" > "$tmp/dry.log" 2>&1 && echo "PASS: dry run completed" || { echo "FAIL: dry run"; tail -5 "$tmp/dry.log"; fail=1; }
check "dry run leaves the schema unchanged" "$(diff -q "$tmp/before.sql" <(dump dry) >/dev/null && echo same || echo differs)" same

if q rel < "$rel/release-up.sql" > "$tmp/up.log" 2>&1; then echo "PASS: release-up.sql (release 2) applied as one transaction"; else echo "FAIL: release-up.sql"; grep -v NOTICE "$tmp/up.log" | tail -8; exit 1; fi
q rel -c "$FPQ" > "$tmp/fp-after.tsv"
check "every pre-existing function unchanged except the intended earn_referral fix" "$(comm -23 <(sort "$tmp/fp-before.tsv") <(sort "$tmp/fp-after.tsv") | cut -f1)" "public.earn_referral(p_referral uuid, p_job uuid)"
echo "earn_referral before: $(grep -F 'public.earn_referral(' "$tmp/fp-before.tsv" | cut -f2)  after: $(grep -F 'public.earn_referral(' "$tmp/fp-after.tsv" | cut -f2)"
check "D12 on develop: inspection photo columns unchanged" "$(q rel -c "$COLQ")" "$(cat "$tmp/cols-before.txt")"
check "D12 on develop: every inspection photo row (statuses, approvals, reviewers, reasons) unchanged" "$(q rel -c "$PHOTOQ")" "$(cat "$tmp/PHOTOQ.before")"
check "D12 on develop: photo table grants, RLS and policies unchanged" "$(q rel -c "$ACLQ")" "$(cat "$tmp/ACLQ.before")"
check "D12 on develop: storage policies and storage.objects grants unchanged" "$(q rel -c "$STORQ")" "$(cat "$tmp/STORQ.before")"
check "D12 on develop: both register_driver_inspection_photo grants unchanged" "$(q rel -c "$FNACLQ")" "$(cat "$tmp/FNACLQ.before")"
check "release 2 SQL never touches the storage schema" "$(grep -ciE 'storage\.' "$rel/release-up.sql")" 0
echo "new functions (for VERIFY):"; join -t "$(printf '\t')" -v2 <(sort "$tmp/fp-before.tsv") <(sort "$tmp/fp-after.tsv") | sed 's/^/  /'
[ -f "$rel/VERIFY.sql" ] && { q rel < "$rel/VERIFY.sql" > "$tmp/v.log" 2>&1 && echo "PASS: VERIFY (release 2) after apply" || { echo "FAIL: VERIFY after apply"; tail -4 "$tmp/v.log"; fail=1; }; }
q rel < "$r1/VERIFY.sql" > /dev/null 2>&1 && echo "PASS: release 1 VERIFY still passes" || { echo "FAIL: release 1 VERIFY after release 2"; fail=1; }
run_test rel "$root/scripts/completion-pin/realdb-completion-pin-test.sql" "completion PIN real-DB suite"
run_test rel "$root/scripts/referrals/realdb-referral-units-test.sql" "referral minor-units real-DB suite"
# Release 1's behaviour suites still pass with release 2 in place (the PIN trigger fires on every assignment).
for t in deploy/vaydu-cash-ride-market-pilot/realdb-market-pilot-test.sql deploy/vaydu-cash-ride-market-pilot/realdb-cash-booking-acquisition-test.sql          deploy/vaydu-cash-ride-market-pilot/realdb-cash-booking-chain-test.sql deploy/vaydu-cash-ride-market-pilot/realdb-cash-ride-lifecycle-test.sql          scripts/migration-merge/realdb-merge-test.sql scripts/driver-metrics/realdb-driver-metrics-test.sql scripts/cancellation-fee/realdb-cancellation-fee-test.sql; do
  run_test rel "$root/$t" "release 1 suite with release 2: $(basename "$t")"
done
q rel < "$rel/release-down.sql" > "$tmp/down.log" 2>&1 && echo "PASS: release-down.sql applied" || { echo "FAIL: release-down"; tail -5 "$tmp/down.log"; fail=1; }
check "rollback restores the exact pre-release-2 schema" "$(diff -q "$tmp/before.sql" <(dump rel) >/dev/null && echo same || echo differs)" same
q rel < "$rel/release-up.sql" > /dev/null 2>&1 && echo "PASS: re-apply after rollback" || { echo "FAIL: re-apply"; fail=1; }
[ -f "$rel/VERIFY.sql" ] && { q rel < "$rel/VERIFY.sql" > /dev/null 2>&1 && echo "PASS: VERIFY after re-apply" || { echo "FAIL: VERIFY after re-apply"; fail=1; }; }

# An environment built from the migrations, i.e. WITHOUT develop's out-of-band objects.
q fresh -c "DROP FUNCTION public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text); ALTER TABLE public.driver_vehicle_inspection_photos DROP COLUMN reason;"
q fresh < "$rel/release-up.sql" > "$tmp/fresh.log" 2>&1 && echo "PASS: release 2 on an environment without the drift" || { echo "FAIL: release 2 without the drift"; tail -5 "$tmp/fresh.log"; fail=1; }
check "captured 6-argument function = develop's fingerprint" "$(q fresh -c "select md5(replace(pg_get_functiondef('public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text)'::regprocedure),chr(13),''))")" f180b0b86f587154270a0493786d9838
check "captured column = develop's column" "$(q fresh -c "$COLQ")" "$(cat "$tmp/cols-before.txt")"
check "fresh install keeps existing photo rows (the dropped reason column comes back empty)" "$(q fresh -c "select count(*)||':'||count(*) filter (where reason is null)||':'||string_agg(slot||'='||status,',' order by slot) from public.driver_vehicle_inspection_photos")" "6:6:$(q rel -c "$APPROVEDQ")"
check "captured function grants = develop's (service_role only)" "$(q fresh -c "select has_function_privilege('service_role','public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text)','EXECUTE')::text||has_function_privilege('authenticated','public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text)','EXECUTE')::text||has_function_privilege('anon','public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text)','EXECUTE')::text")" "$(q rel -c "select has_function_privilege('service_role','public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text)','EXECUTE')::text||has_function_privilege('authenticated','public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text)','EXECUTE')::text||has_function_privilege('anon','public.register_driver_inspection_photo(uuid,uuid,uuid,uuid,text,text)','EXECUTE')::text")"
q fresh < "$rel/release-up.sql" > /dev/null 2>&1 && echo "PASS: release 2 is idempotent (second apply)" || { echo "FAIL: second apply"; fail=1; }
# GB activation of the approved values (deploy/vaydu-develop-activation), on develop's state + release 2.
q postgres -c "CREATE DATABASE movabi_develop TEMPLATE template_auth;"
q movabi_develop < "$rel/release-up.sql" > /dev/null 2>&1 && echo "PASS: release 2 applied to the activation copy" || { echo "FAIL: release 2 on the activation copy"; fail=1; }
q movabi_develop < "$root/scripts/activation/seed-gb-ng.sql" > /dev/null
act="$root/deploy/vaydu-develop-activation"
q movabi_develop < "$act/activate-gb.sql" > "$tmp/act1.log" 2>&1 && echo "PASS: activate-gb.sql" || { echo "FAIL: activate-gb.sql"; tail -5 "$tmp/act1.log"; fail=1; }
q movabi_develop < "$act/activate-gb.sql" > "$tmp/act2.log" 2>&1 && echo "PASS: activate-gb.sql again (idempotent)" || { echo "FAIL: second activation"; tail -5 "$tmp/act2.log"; fail=1; }
grep -E "^cancellation|^campaign|^pin|^non-GB" "$tmp/act2.log" | sed 's/^/  /'
run_test movabi_develop "$root/scripts/activation/check-activated.sql" "GB activation: approved values, GB only, money paths"
q movabi_develop < "$act/deactivate-gb.sql" > "$tmp/deact.log" 2>&1 && echo "PASS: deactivate-gb.sql" || { echo "FAIL: deactivate-gb.sql"; tail -5 "$tmp/deact.log"; fail=1; }
run_test movabi_develop "$root/scripts/activation/check-deactivated.sql" "GB deactivation: off, history kept, NG untouched"
q movabi_develop < "$act/activate-gb.sql" > /dev/null 2>&1 && echo "PASS: re-activation after deactivation" || { echo "FAIL: re-activation"; fail=1; }
# Cash (5b): one GB test driver; refused for a non-GB user; only GB/GBP enabled; then off again.
if q movabi_develop -v driver_email=ng-customer@act.test < "$act/activate-gb-cash.sql" > /dev/null 2>&1; then echo "FAIL: cash activation accepted a non-GB, non-driver account"; fail=1; else echo "PASS: cash activation refuses a non-GB / non-driver account"; fi
check "refused cash activation changed nothing" "$(q movabi_develop -c "select count(*) from public.driver_cash_credit_markets_v1e where enabled")" 0
q movabi_develop -v driver_email=gb-driver@act.test < "$act/activate-gb-cash.sql" > "$tmp/cash.log" 2>&1 && echo "PASS: activate-gb-cash.sql for the GB test driver" || { echo "FAIL: cash activation"; tail -5 "$tmp/cash.log"; fail=1; }
check "cash enabled exactly for GB/GBP" "$(q movabi_develop -c "select string_agg(country_code||'='||public.driver_cash_credit_market_enabled_v1e(country_code,supported_currency)::text,',' order by country_code) from public.market_availability")" "GB=true,NG=false"
check "enrolment uses the existing terms fare-split-v1" "$(q movabi_develop -c "select terms_version||'|'||enabled::text from public.driver_cash_credit_enrolments_v1e where driver_id='6d000000-0000-4000-8000-0000000000d1'")" "fare-split-v1|true"
q movabi_develop < "$rel/VERIFY.sql" > /dev/null 2>&1 && echo "PASS: VERIFY (release 2) accepts the approved GB/GBP cash market" || { echo "FAIL: VERIFY with GB cash on"; fail=1; }
q movabi_develop -c "INSERT INTO public.driver_cash_credit_markets_v1e(country_code,currency_code,enabled) VALUES ('NG','NGN',true);" >/dev/null
if q movabi_develop < "$rel/VERIFY.sql" > /dev/null 2>&1; then echo "FAIL: VERIFY accepted an NG cash market"; fail=1; else echo "PASS: VERIFY (release 2) refuses a cash market outside GB/GBP"; fi
q movabi_develop -c "DELETE FROM public.driver_cash_credit_markets_v1e WHERE country_code='NG';" >/dev/null
q movabi_develop < "$act/deactivate-gb-cash.sql" > /dev/null 2>&1 && echo "PASS: deactivate-gb-cash.sql" || { echo "FAIL: cash deactivation"; fail=1; }
check "cash off everywhere after deactivation, enrolment kept" "$(q movabi_develop -c "select (select count(*) from public.market_availability where public.driver_cash_credit_market_enabled_v1e(country_code,supported_currency))||'|'||(select count(*) from public.driver_cash_credit_enrolments_v1e)")" "0|1"
[ "$fail" = 0 ] && echo "REHEARSAL 2 PASSED" || { echo "REHEARSAL 2 FAILED"; exit 1; }
