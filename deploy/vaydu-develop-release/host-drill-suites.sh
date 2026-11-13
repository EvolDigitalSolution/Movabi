#!/usr/bin/env bash
# Step 4b: rerun the 7 behaviour suites on a THROWAWAY restore of the backup (no network; develop untouched),
# after release-up.sql, with the real-data drill preamble inserted after each suite's own BEGIN.
# The preamble (also deploy/vaydu-develop-release/drill-preamble.sql) runs inside the suite's transaction
# and is rolled back with it. It disables develop's on_auth_user_created trigger, clears market rows and
# renames service-type slugs (referenced only by id), so the empty-database fixtures behave as written.
# None of these is behaviour under test.
#   bash host-drill-suites.sh <bundle-dir> <dump>
set -euo pipefail
export LC_ALL=C
B="$(cd "$1" && pwd)"; F="$2"
(cd "$B" && sha256sum -c --quiet RELEASE-MIGRATIONS.sha256) || { echo "FATAL: release SQL checksum mismatch"; exit 1; }
sha256sum -c --quiet "$F.sha256" || { echo "FATAL: backup checksum mismatch"; exit 1; }
IMG=$(cat "$F.image"); N="vaydu-drill-suites-$(date -u +%Y%m%dt%H%M%Sz)"; PW="drill-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
trap 'docker rm -f "$N" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$N" --network none -e POSTGRES_PASSWORD="$PW" "$IMG" >/dev/null
for _ in $(seq 1 180); do docker exec "$N" pg_isready -q 2>/dev/null && break; sleep 1; done; sleep 5
D(){ docker exec -i -e PGPASSWORD="$PW" "$N" psql -X -h 127.0.0.1 -U supabase_admin -d "${1:-movabi_develop}" -v ON_ERROR_STOP=1 -P pager=off "${@:2}"; }
D postgres -qc "CREATE DATABASE movabi_develop;"
docker exec -i -e PGPASSWORD="$PW" "$N" psql -X -h 127.0.0.1 -U supabase_admin -d postgres -q < "$F.globals.sql" > /dev/null 2>&1 || true
docker exec -i -e PGPASSWORD="$PW" "$N" pg_restore -h 127.0.0.1 -U supabase_admin -d movabi_develop < "$F" > /dev/null 2>&1 || true
D movabi_develop -q < "$B/release-up.sql" >/dev/null && echo "PASS: release-up.sql on the restored copy (real data)"
PRE=$(cat <<'PREAMBLE'
-- drill preamble (inside the suite transaction; rolled back with it)
ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created;
DELETE FROM public.market_availability;
UPDATE public.service_types SET slug = slug || '-predrill';
PREAMBLE
)
fail=0
for t in "$B"/tests/*.sql; do
  sql=$(awk -v pre="$PRE" 'BEGIN{done=0} { print } !done && $0 ~ /^BEGIN;[ \t\r]*$/ { print pre; done=1 }' "$t")
  out=$(printf '%s\n' "$sql" | D movabi_develop -qAt -F ' | ' 2>&1) || { echo "FAIL: $(basename "$t") errored"; echo "$out" | tail -4; fail=1; continue; }
  s=$(echo "$out" | tail -1)
  if [ "${s%% *}" = 0 ]; then echo "PASS: $(basename "$t") ($s)"; else echo "FAIL: $(basename "$t") ($s)"; echo "$out" | grep '| FAIL |' | head -8; fail=1; fi
done
D movabi_develop -qAt -c "select count(*) from pg_trigger where tgname='on_auth_user_created' and tgenabled<>'D'" | sed 's/^/auth trigger still enabled after the suites (expect 1): /'
D movabi_develop -qAt -c "select count(*) from public.market_availability" | sed 's/^/market rows still present after the suites (expect 3): /'
D movabi_develop -qAt -c "select count(*) from public.service_types where slug like '%-predrill'" | sed 's/^/renamed service-type slugs left after the suites (expect 0): /'
[ "$fail" = 0 ] && echo "SUITES_DONE: all passed on real data" || { echo "SUITES_DONE: failures above"; exit 1; }
