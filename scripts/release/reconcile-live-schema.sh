#!/usr/bin/env bash
# Reconcile the release migration chain with the ACTUAL develop schema (host inventory dump).
# Disposable containers only (postgres:15.1 = develop's server version, + pinned GoTrue for auth).
# Never accepts a database URL.
#
#  1. live:     develop's live public schema; its function fingerprints must equal the host's.
#  2. chain:    the committed 10 Nov baseline, then the rehearsal chain one migration at a time,
#               fingerprinting functions/tables after each step.
#  3. 1E probe: the uncommitted batch-1E file applied to a copy of the baseline and of live: does it
#               change anything?
# Output: <out>/snap-*.tsv, live-*.tsv, batch1e-*.txt; classification by scripts/release/classify-live.cjs
# Usage: bash scripts/release/reconcile-live-schema.sh <live_public_schema.sql> <host function-fingerprints.tsv> <out-dir>
set -euo pipefail
export MSYS_NO_PATHCONV=1
root="$(cd "$(dirname "$0")/../.." && pwd)"
LIVE_SQL="$1"; HOST_FP="$2"; OUT="$3"; mkdir -p "$OUT"
id="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
db="vaydu-reconcile-$id"; auth="$db-auth"; net="$db-net"
cleanup(){ docker rm -f "$auth" "$db" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
trap cleanup EXIT
q(){ local d="$1"; shift; docker exec -i -e PGPASSWORD=isolated-test "$db" psql -X -U postgres -d "$d" -v ON_ERROR_STOP=1 -qAt "$@"; }
# Raw fingerprints (must equal the host's) and EOL-insensitive ones for classification: develop bodies
# were applied from CRLF files, so the same SQL differs only by CR bytes.
RAWQ="select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'||chr(9)||md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p') order by 1;"
FPQ="select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'||chr(9)||md5(replace(pg_get_functiondef(p.oid),chr(13),'')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p') order by 1;"
TPQ="select c.relname||chr(9)||md5(string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull, ',' order by a.attnum)) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped where n.nspname='public' and c.relkind in ('r','p','v','m') group by c.relname order by 1;"
TRQ="select tgrelid::regclass||'.'||tgname||chr(9)||md5(replace(pg_get_triggerdef(oid),chr(13),'')) from pg_trigger where not tgisinternal and tgrelid::regclass::text not like 'auth.%' order by 1;"
snap(){ q "$1" -c "$FPQ" > "$OUT/$2-functions.tsv"; q "$1" -c "$TPQ" > "$OUT/$2-tables.tsv"; q "$1" -c "$TRQ" > "$OUT/$2-triggers.tsv"; }

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
# Minimal Supabase storage shim (buckets/objects): inspection migrations register buckets and storage
# policies; never exercised further.
q template_auth -c "CREATE SCHEMA IF NOT EXISTS storage; CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], owner uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()); CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), last_accessed_at timestamptz DEFAULT now()); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;"
q template_auth -c "CREATE TABLE IF NOT EXISTS auth.job_messages (id uuid); CREATE OR REPLACE FUNCTION auth.debug_errand_insert() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NEW; END \$\$;"
for d in live chain base1e live1e; do q postgres -c "CREATE DATABASE $d TEMPLATE template_auth;"; done
# Byte-exact: develop function bodies contain CR bytes (Windows-authored migrations); never strip them.
prep(){ local py=python3; command -v python3 >/dev/null 2>&1 && python3 -c 1 >/dev/null 2>&1 || py=python
 "$py" -c 'import sys;d=sys.stdin.buffer.read();sys.stdout.buffer.write(d.replace(b"CREATE SCHEMA public;",b"CREATE SCHEMA IF NOT EXISTS public;").replace(b"CREATE EXTENSION ",b"CREATE EXTENSION IF NOT EXISTS "))' < "$1"; }

# 1. live
prep "$LIVE_SQL" | q live >/dev/null
snap live live
q live -c "$RAWQ" > "$OUT/live-functions-raw.tsv"
if diff <(sort "$HOST_FP" | tr '|' '\t' | tr -d '\r') <(sort "$OUT/live-functions-raw.tsv") >/dev/null; then echo "LIVE_FINGERPRINTS_MATCH_HOST=yes ($(wc -l < "$OUT/live-functions-raw.tsv") functions)"
else echo "LIVE_FINGERPRINTS_MATCH_HOST=NO"; diff <(sort "$HOST_FP" | tr '|' '\t' | tr -d '\r') <(sort "$OUT/live-functions.tsv") | head -20; exit 2; fi

# 2. chain on the committed baseline, snapshot after each step
prep "$root/supabase/baseline/deployed_public_schema.sql" | q chain >/dev/null
q chain < "$root/supabase/baseline/candidate/001_tenants.sql" >/dev/null
snap chain snap-000-baseline
i=0
while IFS= read -r m <&3; do
  [ -z "$m" ] && continue; i=$((i+1)); n=$(printf '%03d' "$i")
  case "$m" in candidate/*) src="$root/supabase/baseline/$m";; *) src="$root/supabase/migrations/$m";; esac
  if q chain < "$src" > "$OUT/apply-$n.log" 2>&1; then echo "APPLIED $n $m"; else echo "FAILED  $n $m (see apply-$n.log)"; exit 3; fi
  snap chain "snap-$n-$(basename "$m" .sql)"
done 3< "${CHAIN:-$root/scripts/release/rehearsal-chain.txt}"

# 3. batch-1E probe: does the uncommitted file change the baseline or live schema?
B1E="$root/supabase/migrations/20261248000000_driver_cash_credit_batch1e.sql"
prep "$root/supabase/baseline/deployed_public_schema.sql" | q base1e >/dev/null; q base1e < "$root/supabase/baseline/candidate/001_tenants.sql" >/dev/null
snap base1e base1e-before
if q base1e < "$B1E" > "$OUT/batch1e-on-baseline.log" 2>&1; then echo "BATCH1E_ON_BASELINE=applied"; else echo "BATCH1E_ON_BASELINE=error"; fi
snap base1e base1e-after
prep "$LIVE_SQL" | q live1e >/dev/null; snap live1e live1e-before
if q live1e < "$B1E" > "$OUT/batch1e-on-live.log" 2>&1; then echo "BATCH1E_ON_LIVE=applied"; else echo "BATCH1E_ON_LIVE=error"; fi
snap live1e live1e-after
echo "DONE $OUT"
