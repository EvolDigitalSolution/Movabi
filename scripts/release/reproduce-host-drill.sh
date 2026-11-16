#!/usr/bin/env bash
# Local reproduction of the HOST restore drill, through the SHIPPED commands of a bundle:
#   bash scripts/release/reproduce-host-drill.sh <extracted-bundle-dir>
# Builds a local container named movabi-develop-db on develop's exact image (supabase/postgres:15.1.1.78),
# with GoTrue's auth schema, develop's live public schema, release 1 and SYNTHETIC develop-like data
# (scripts/release/develop-like-data.sql: develop's auth trigger, market rows, service types, users,
# jobs, vehicles, settings). Then runs, exactly as on the host:
#   host-db-release.sh <bundle> backup      and      host-db-release.sh <bundle> drill <dump>
# HOME is a temporary directory, so no real backup folder is touched. Everything is removed on exit.
# Prints the drill output and its exit code. Never accepts a database URL; never touches develop.
set -uo pipefail
export MSYS_NO_PATHCONV=1
root="$(cd "$(dirname "$0")/../.." && pwd)"
B="$(cd "$1" && pwd)"
IMG=supabase/postgres:15.1.1.78
DB=movabi-develop-db; AUTH="vaydu-repro-auth-$$"; NET="vaydu-repro-net-$$"
PW="repro-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
tmp="$(mktemp -d)"
owned_db=0; owned_auth=0; owned_net=0
cleanup(){
  [ "$owned_auth" = 0 ] || docker rm -f "$AUTH" >/dev/null 2>&1 || true
  [ "$owned_db" = 0 ] || docker rm -f "$DB" >/dev/null 2>&1 || true
  [ "$owned_net" = 0 ] || docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
if docker ps -a --format '{{.Names}}' | grep -qx "$DB"; then echo "FATAL: a container named $DB already exists locally; refusing to touch it"; exit 2; fi
docker network create "$NET" >/dev/null || exit 2; owned_net=1
docker run -d --name "$DB" --network "$NET" -e POSTGRES_PASSWORD="$PW" "$IMG" >/dev/null || exit 2; owned_db=1
for _ in $(seq 1 180); do docker exec "$DB" pg_isready -q -U postgres 2>/dev/null && break; sleep 1; done; sleep 8
S(){ docker exec -i -e PGPASSWORD="$PW" "$DB" psql -X -h 127.0.0.1 -U supabase_admin -d "${1:-movabi_develop}" -v ON_ERROR_STOP=1 -qAt "${@:2}"; }
S postgres -c "CREATE DATABASE movabi_develop;"
S movabi_develop -c "CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS extensions;"
# GoTrue builds the real auth schema (as on develop).
docker run -d --rm --network "$NET" --name "$AUTH" \
 -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL=http://localhost:9999 -e GOTRUE_SITE_URL=http://localhost:3000 \
 -e GOTRUE_DB_NAMESPACE=auth -e GOTRUE_DB_DRIVER=postgres \
 -e "GOTRUE_DB_DATABASE_URL=postgres://supabase_admin:$PW@$DB:5432/movabi_develop?sslmode=disable&options=-csearch_path%3Dauth%2Cpublic" \
 -e GOTRUE_JWT_SECRET=synthetic-disposable-jwt-secret-minimum-40-characters -e GOTRUE_JWT_AUD=authenticated \
 supabase/gotrue:v2.132.3 >/dev/null || exit 2
owned_auth=1
for _ in $(seq 1 120); do [ "$(S movabi_develop -c "select to_regclass('auth.users') is not null and exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.proname='uid')" 2>/dev/null)" = t ] && break; sleep 1; done
sleep 2; docker rm -f "$AUTH" >/dev/null
S movabi_develop -c "CREATE SCHEMA IF NOT EXISTS storage; CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], owner uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()); CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), last_accessed_at timestamptz DEFAULT now());"
S movabi_develop -c "CREATE TABLE IF NOT EXISTS auth.job_messages (id uuid); CREATE OR REPLACE FUNCTION auth.debug_errand_insert() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NEW; END \$\$;"
py=python3; command -v python3 >/dev/null 2>&1 && python3 -c 1 >/dev/null 2>&1 || py=python
"$py" -c 'import sys;d=sys.stdin.buffer.read();sys.stdout.buffer.write(d.replace(b"CREATE SCHEMA public;",b"CREATE SCHEMA IF NOT EXISTS public;").replace(b"CREATE EXTENSION ",b"CREATE EXTENSION IF NOT EXISTS "))' \
  < "$root/supabase/baseline/develop_live_public_schema_20261112.sql" | S movabi_develop > "$tmp/load.log" 2>&1 || true
echo "live schema loaded: $(S movabi_develop -c "select count(*) from pg_tables where schemaname='public'") public tables"
S movabi_develop < "$root/deploy/vaydu-develop-release/release-up.sql" > "$tmp/r1.log" 2>&1 || { echo "FATAL: release 1 did not apply"; tail -5 "$tmp/r1.log"; exit 2; }
S movabi_develop < "$root/deploy/vaydu-develop-release/VERIFY.sql" >/dev/null 2>&1 && echo "develop state: release 1 applied (VERIFY 1 OK)"
S movabi_develop < "$root/scripts/release/develop-like-data.sql" > "$tmp/data.log" 2>&1 || { echo "FATAL: develop-like data"; tail -5 "$tmp/data.log"; exit 2; }
for x in ${EXTRA_SQL:-}; do S movabi_develop < "$x" > "$tmp/extra.log" 2>&1 && echo "extra state applied: $(basename "$x")" || { echo "FATAL: $x"; tail -5 "$tmp/extra.log"; exit 2; }; done
echo "develop-like data: $(S movabi_develop -c "select (select count(*) from public.jobs)||' jobs, '||(select count(*) from public.profiles)||' profiles, '||(select count(*) from public.market_availability)||' market rows, '||(select count(*) from public.service_types)||' service types'")"
if [ "${DIAG_MERGE:-0}" = 1 ]; then
  # Separate the merge-suite causes: same restored-like data + release 2, merge suite with growing isolation.
  echo "===== merge-suite diagnosis ====="
  S postgres -c "CREATE DATABASE diag TEMPLATE movabi_develop;"
  S diag < "$B/release-up.sql" >/dev/null 2>&1 || echo "release 2 did not apply to diag"
  variant(){ awk -v pre="$1" 'BEGIN{done=0} { print } !done && $0 ~ /^BEGIN;[ 	]*$/ { print pre; done=1 }' "$root/scripts/migration-merge/realdb-merge-test.sql"; }
  for v in "raw|"            "auth trigger off + develop market rows cleared|ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created; DELETE FROM public.market_availability;"            "+ develop service-type slugs renamed|ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created; DELETE FROM public.market_availability; UPDATE public.service_types SET slug = slug || '-predrill';"; do
    label="${v%%|*}"; pre="${v#*|}"
    out="$(variant "$pre" | docker exec -i -e PGPASSWORD="$PW" "$DB" psql -X -h 127.0.0.1 -U supabase_admin -d diag -qAt -F ' | ' 2>&1)"
    echo "-- merge suite, $label: $(echo "$out" | tail -1)"; echo "$out" | grep '| FAIL |' | cut -c1-200 | sed 's/^/     /'
  done
  S postgres -c "DROP DATABASE diag;"
fi
echo "===== host-db-release.sh backup ====="
mkdir -p "$tmp/home"
HOME="$tmp/home" bash "$B/host-db-release.sh" "$B" backup; echo "backup exit $?"
DUMP="$(ls -t "$tmp/home/vaydu-develop-backups/"*.dump | head -1)"
echo "===== host-db-release.sh drill ====="
HOME="$tmp/home" bash "$B/host-db-release.sh" "$B" drill "$DUMP"; rc=$?
echo "DRILL_EXIT_CODE=$rc"
exit $rc
