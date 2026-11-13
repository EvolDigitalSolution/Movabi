#!/usr/bin/env bash
# Develop release — database steps. Run on the develop host from the extracted, checksum-verified bundle.
#   bash host-db-release.sh <bundle-dir> backup            pg_dump -Fc + globals + exact row counts (no change)
#   bash host-db-release.sh <bundle-dir> drill <dump>      restore the dump into a THROWAWAY container (no network),
#                                                         compare row counts, then rehearse the release on that copy
#                                                         with real data: PREREQ, release-up, VERIFY, behaviour
#                                                         suites, release-down (exact schema), then remove it
#   bash host-db-release.sh <bundle-dir> prereq           read-only gate on develop
#   bash host-db-release.sh <bundle-dir> dryrun           release on develop's real data, ends in ROLLBACK
#   bash host-db-release.sh <bundle-dir> apply            PREREQ -> release-up.sql (one transaction) -> VERIFY
#   bash host-db-release.sh <bundle-dir> verify           read-only VERIFY on develop
#   bash host-db-release.sh <bundle-dir> rollback         release-down.sql (one transaction) -> PREREQ must pass again
# Never prints credentials. Exit code 0 only on success.
set -euo pipefail
export LC_ALL=C
B="$(cd "$1" && pwd)"; CMD="${2:-}"
DB=movabi-develop-db; DBNAME=movabi_develop
(cd "$B" && sha256sum -c --quiet RELEASE-MIGRATIONS.sha256) || { echo "FATAL: release SQL checksum mismatch"; exit 1; }
for f in PREREQ.sql VERIFY.sql release-up.sql release-dryrun.sql release-down.sql; do [ -f "$B/$f" ] || { echo "FATAL: $f missing"; exit 1; }; done
SRC=$(cat "$B/SOURCE_SHA")
psql_dev(){ docker exec -i "$DB" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -P pager=off'; }
COUNTS_SQL="select table_schema||'.'||table_name||chr(9)||(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text from information_schema.tables where table_schema in ('public','auth','storage') and table_type='BASE TABLE' order by 1;"
stamp(){ date -u +%Y%m%dT%H%M%SZ; }

case "$CMD" in
backup)
  mkdir -p "$HOME/vaydu-develop-backups"; S=$(stamp); F="$HOME/vaydu-develop-backups/develop-before-release-$SRC-$S.dump"
  docker exec "$DB" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U supabase_admin -d movabi_develop -Fc' > "$F"
  docker exec "$DB" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dumpall -U supabase_admin --globals-only --no-role-passwords' > "$F.globals.sql"
  echo "$COUNTS_SQL" | docker exec -i "$DB" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -tA' > "$F.counts.tsv"
  docker inspect -f '{{.Config.Image}}' "$DB" > "$F.image"
  sha256sum "$F" "$F.globals.sql" "$F.counts.tsv" | tee "$F.sha256"
  n=$(docker exec -i "$DB" pg_restore --list < "$F" | grep -c 'TABLE DATA'); [ "$n" -gt 0 ] || { echo "FATAL: archive lists no table data"; exit 1; }
  echo "BACKUP_OK $F  size=$(stat -c %s "$F")  table-data-entries=$n  tables-counted=$(wc -l < "$F.counts.tsv")  db-image=$(cat "$F.image")"
  ;;
drill)
  F="${3:?dump path}"; sha256sum -c --quiet "$F.sha256" || { echo "FATAL: backup checksum mismatch"; exit 1; }
  IMG=$(cat "$F.image"); N="vaydu-restore-drill-$(stamp | tr 'TZ' 'tz')"; PW="drill-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  trap 'docker rm -f "$N" >/dev/null 2>&1 || true' EXIT
  docker run -d --rm --name "$N" --network none -e POSTGRES_PASSWORD="$PW" "$IMG" >/dev/null
  for _ in $(seq 1 180); do docker exec "$N" pg_isready -q 2>/dev/null && break; sleep 1; done; sleep 5
  D(){ docker exec -i -e PGPASSWORD="$PW" "$N" psql -X -h 127.0.0.1 -U supabase_admin -d "${1:-movabi_develop}" -v ON_ERROR_STOP=1 -P pager=off "${@:2}"; }
  D postgres -qc "CREATE DATABASE movabi_develop;" || { echo "FATAL: cannot create the drill database"; exit 1; }
  docker exec -i -e PGPASSWORD="$PW" "$N" psql -X -h 127.0.0.1 -U supabase_admin -d postgres -q < "$F.globals.sql" > /tmp/$N-globals.log 2>&1 || true
  docker exec -i -e PGPASSWORD="$PW" "$N" pg_restore -h 127.0.0.1 -U supabase_admin -d movabi_develop < "$F" > /tmp/$N-restore.log 2>&1 || true
  echo "pg_restore reported $(grep -c 'error:' /tmp/$N-restore.log || true) error line(s) (listed below if any)"; grep 'error:' /tmp/$N-restore.log | head -15 || true
  echo "$COUNTS_SQL" | D movabi_develop -tA > /tmp/$N-counts.tsv
  if diff "$F.counts.tsv" /tmp/$N-counts.tsv > /tmp/$N-counts.diff; then echo "PASS: restored row counts equal the backup's ($(wc -l < /tmp/$N-counts.tsv) tables)"; else echo "FAIL: row counts differ:"; head -20 /tmp/$N-counts.diff; exit 1; fi
  docker exec -e PGPASSWORD="$PW" "$N" pg_dump -h 127.0.0.1 -U supabase_admin -d movabi_develop -s -n public > /tmp/$N-before.sql
  D movabi_develop -q < "$B/PREREQ.sql" && echo "PASS: PREREQ on the restored copy"
  D movabi_develop -q < "$B/release-up.sql" && echo "PASS: release-up.sql on the restored copy (real data)"
  D movabi_develop -q < "$B/VERIFY.sql" && echo "PASS: VERIFY on the restored copy"
  for t in "$B"/tests/*.sql; do
    out=$(D movabi_develop -qAt -F ' | ' < "$t" 2>&1) || { echo "FAIL: $(basename "$t") errored"; echo "$out" | tail -4; continue; }
    s=$(echo "$out" | tail -1); [ "${s%% *}" = 0 ] && echo "PASS: $(basename "$t") ($s)" || { echo "FAIL: $(basename "$t") ($s)"; echo "$out" | grep '| FAIL |' | head -5; }
  done
  D movabi_develop -q < "$B/release-down.sql" && echo "PASS: release-down.sql on the restored copy"
  docker exec -e PGPASSWORD="$PW" "$N" pg_dump -h 127.0.0.1 -U supabase_admin -d movabi_develop -s -n public > /tmp/$N-after-down.sql
  if diff -q /tmp/$N-before.sql /tmp/$N-after-down.sql >/dev/null; then echo "PASS: rollback restored the exact pre-release schema on real data"; else echo "FAIL: schema after rollback differs"; diff /tmp/$N-before.sql /tmp/$N-after-down.sql | head -20; exit 1; fi
  echo "DRILL_DONE (throwaway container removed on exit)"
  ;;
prereq)  psql_dev -q < "$B/PREREQ.sql" ;;
verify)  psql_dev -q < "$B/VERIFY.sql" ;;
dryrun)  psql_dev -q < "$B/PREREQ.sql"; psql_dev -q < "$B/release-dryrun.sql" && echo "DRYRUN_OK (rolled back; develop unchanged)"; psql_dev -q < "$B/PREREQ.sql" >/dev/null && echo "PASS: develop still in the pre-release state" ;;
apply)   psql_dev -q < "$B/PREREQ.sql"; psql_dev -q < "$B/release-up.sql" && echo "RELEASE_APPLIED $(date -u)"; psql_dev -q < "$B/VERIFY.sql" ;;
rollback) psql_dev -q < "$B/release-down.sql" && echo "RELEASE_ROLLED_BACK $(date -u)"; psql_dev -q < "$B/PREREQ.sql" ;;
*) echo "usage: $0 <bundle-dir> backup|drill <dump>|prereq|dryrun|apply|verify|rollback"; exit 2 ;;
esac
