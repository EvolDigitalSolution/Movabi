#!/usr/bin/env bash
# Develop release — database steps. Run on the develop host from the extracted, checksum-verified bundle.
#   bash host-db-release.sh <bundle-dir> backup            pg_dump -Fc + globals + exact row counts (no change)
#   bash host-db-release.sh <bundle-dir> drill <dump>      restore the dump into a THROWAWAY container (no network)
#                                                         and rehearse the release on that copy with real data
#   bash host-db-release.sh <bundle-dir> prereq           read-only gate on develop
#   bash host-db-release.sh <bundle-dir> dryrun           release on develop's real data, ends in ROLLBACK
#   bash host-db-release.sh <bundle-dir> apply            PREREQ -> release-up.sql (one transaction) -> VERIFY
#   bash host-db-release.sh <bundle-dir> verify           read-only VERIFY on develop
#   bash host-db-release.sh <bundle-dir> rollback         release-down.sql (one transaction) -> PREREQ must pass again
# Never prints credentials. FAILS CLOSED: exit code 0 only when every step of the command succeeded.
#
# drill (2026-11-14): every step is checked and any failure makes the exit code 1, with DRILL_FAILED:
#   restore without error lines; restored row counts equal the backup's; PREREQ; release-up; VERIFY;
#   EVERY suite listed in tests/SUITES.txt (no more, no fewer) passes, each run with drill-preamble.sql inside
#   its own rolled-back transaction; the restored data is byte-identical after the suites; release-down
#   restores the exact pre-release schema; PREREQ passes again; the data is byte-identical to before the
#   release. DRILL_OK is printed only when all of that passed.
set -euo pipefail
export LC_ALL=C
B="$(cd "$1" && pwd)"; CMD="${2:-}"
DB=movabi-develop-db; DBNAME=movabi_develop
(cd "$B" && sha256sum -c --quiet RELEASE-MIGRATIONS.sha256) || { echo "FATAL: release SQL checksum mismatch"; exit 1; }
for f in PREREQ.sql VERIFY.sql release-up.sql release-dryrun.sql release-down.sql; do [ -f "$B/$f" ] || { echo "FATAL: $f missing"; exit 1; }; done
SRC=$(cat "$B/SOURCE_SHA")
psql_dev(){ docker exec -i "$DB" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -P pager=off'; }
COUNTS_SQL="select table_schema||'.'||table_name||chr(9)||(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text from information_schema.tables where table_schema in ('public','auth','storage') and table_type='BASE TABLE' order by 1;"
# Content fingerprint of every application table (rows in a canonical order): proves data is untouched.
DATA_SQL="select table_schema||'.'||table_name||chr(9)||(xpath('/row/c/text()', query_to_xml(format('select md5(coalesce(string_agg(t::text, chr(10) order by t::text), '''')) as c from %I.%I t', table_schema, table_name), false, true, '')))[1]::text from information_schema.tables where table_schema in ('public','auth','storage') and table_type='BASE TABLE' order by 1;"
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
  [ -f "$B/drill-preamble.sql" ] || { echo "FATAL: drill-preamble.sql missing from the bundle"; exit 1; }
  [ -f "$B/tests/SUITES.txt" ] || { echo "FATAL: tests/SUITES.txt missing from the bundle"; exit 1; }
  IMG=$(cat "$F.image"); N="vaydu-restore-drill-$(stamp | tr 'TZ' 'tz')"; PW="drill-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  T="$(mktemp -d)"; trap 'docker rm -f "$N" >/dev/null 2>&1 || true; rm -rf "$T"' EXIT
  fail=0; bad(){ echo "FAIL: $*"; fail=1; }
  docker run -d --rm --name "$N" --network none -e POSTGRES_PASSWORD="$PW" "$IMG" >/dev/null
  # The image restarts PostgreSQL once after its first-start scripts: wait for 5 consecutive good connections.
  ok=0; for _ in $(seq 1 300); do
    if docker exec -e PGPASSWORD="$PW" "$N" psql -X -h 127.0.0.1 -U supabase_admin -d postgres -qAtc 'select 1' >/dev/null 2>&1; then ok=$((ok+1)); [ "$ok" -ge 5 ] && break; else ok=0; fi; sleep 1; done
  [ "$ok" -ge 5 ] || { echo "FAIL: the throwaway database did not become ready"; echo "DRILL_FAILED"; exit 1; }
  D(){ docker exec -i -e PGPASSWORD="$PW" "$N" psql -X -h 127.0.0.1 -U supabase_admin -d "${1:-movabi_develop}" -v ON_ERROR_STOP=1 -P pager=off "${@:2}"; }
  D postgres -qc "CREATE DATABASE movabi_develop;" || { echo "FAIL: cannot create the drill database"; echo "DRILL_FAILED"; exit 1; }
  docker exec -i -e PGPASSWORD="$PW" "$N" psql -X -h 127.0.0.1 -U supabase_admin -d postgres -q < "$F.globals.sql" > "$T/globals.log" 2>&1 || true
  docker exec -i -e PGPASSWORD="$PW" "$N" pg_restore -h 127.0.0.1 -U supabase_admin -d movabi_develop < "$F" > "$T/restore.log" 2>&1 || true
  errs=$(grep -c 'error:' "$T/restore.log" || true)
  if [ "$errs" = 0 ]; then echo "PASS: pg_restore reported no errors"; else bad "pg_restore reported $errs error line(s):"; grep 'error:' "$T/restore.log" | head -20; fi
  echo "$COUNTS_SQL" | D movabi_develop -tA > "$T/counts.tsv" 2>&1 || bad "row counts could not be read"
  if diff "$F.counts.tsv" "$T/counts.tsv" > "$T/counts.diff"; then echo "PASS: restored row counts equal the backup's ($(wc -l < "$T/counts.tsv") tables)"; else bad "row counts differ from the backup:"; head -20 "$T/counts.diff"; fi
  if [ "$fail" != 0 ]; then echo "DRILL_FAILED (restore)"; exit 1; fi
  echo "$DATA_SQL" | D movabi_develop -tA > "$T/data-before.tsv" 2>&1 || bad "data fingerprint could not be read"
  docker exec -e PGPASSWORD="$PW" "$N" pg_dump -h 127.0.0.1 -U supabase_admin -d movabi_develop -s -n public > "$T/schema-before.sql" || bad "schema dump failed"
  if D movabi_develop -q < "$B/PREREQ.sql" > "$T/prereq.log" 2>&1; then echo "PASS: PREREQ on the restored copy"; else bad "PREREQ on the restored copy"; tail -6 "$T/prereq.log"; fi
  if [ "$fail" = 0 ] && D movabi_develop -q < "$B/release-up.sql" > "$T/up.log" 2>&1; then echo "PASS: release-up.sql on the restored copy (real data)"; else bad "release-up.sql on the restored copy"; tail -6 "$T/up.log"; fi
  if [ "$fail" = 0 ] && D movabi_develop -q < "$B/VERIFY.sql" > "$T/verify.log" 2>&1; then echo "PASS: VERIFY on the restored copy"; else bad "VERIFY on the restored copy"; tail -6 "$T/verify.log"; fi
  if [ "$fail" != 0 ]; then echo "DRILL_FAILED (release did not apply; suites not run)"; exit 1; fi
  echo "$DATA_SQL" | D movabi_develop -tA > "$T/data-released.tsv" 2>&1 || bad "data fingerprint could not be read"
  # Behaviour suites: exactly the listed set; each with the preamble inside its own rolled-back transaction.
  mapfile -t SUITES < <(grep -v '^#' "$B/tests/SUITES.txt" | sed 's/\r$//' | grep .)
  present=$(cd "$B/tests" && ls *.sql | sort | tr '\n' ' '); listed=$(printf '%s\n' "${SUITES[@]}" | sort | tr '\n' ' ')
  [ "$present" = "$listed" ] || bad "suites present ($present) differ from tests/SUITES.txt ($listed)"
  passed=0
  for s in "${SUITES[@]}"; do
    t="$B/tests/$s"; [ -f "$t" ] || { bad "$s missing"; continue; }
    grep -qE '^BEGIN;[[:space:]]*$' "$t" || { bad "$s has no BEGIN; line for the preamble"; continue; }
    awk -v pre="$B/drill-preamble.sql" 'BEGIN{done=0} { print } !done && $0 ~ /^BEGIN;[ \t\r]*$/ { while ((getline l < pre) > 0) print l; done=1 }' "$t" > "$T/suite.sql"
    out=$(D movabi_develop -qAt -F ' | ' < "$T/suite.sql" 2>&1) || { bad "$s errored"; echo "$out" | grep -E 'ERROR|DETAIL' | head -4; continue; }
    sm=$(echo "$out" | tail -1)
    if [ "${sm%% *}" = 0 ]; then echo "PASS: $s ($sm)"; passed=$((passed+1)); else bad "$s ($sm)"; echo "$out" | grep -E '\| FAIL( \||$)' | head -12; fi
  done
  echo "suites passed: $passed of ${#SUITES[@]}"
  [ "$passed" = "${#SUITES[@]}" ] && [ "${#SUITES[@]}" -gt 0 ] || bad "not every listed suite passed"
  echo "$DATA_SQL" | D movabi_develop -tA > "$T/data-after-suites.tsv" 2>&1 || bad "data fingerprint could not be read"
  if diff -q "$T/data-released.tsv" "$T/data-after-suites.tsv" >/dev/null; then echo "PASS: restored data byte-identical after the suites ($(wc -l < "$T/data-after-suites.tsv") tables)"; else bad "the suites changed restored data:"; diff "$T/data-released.tsv" "$T/data-after-suites.tsv" | head -10; fi
  st=$(D movabi_develop -qAt -c "select (select count(*) from pg_trigger where tgname='on_auth_user_created' and tgenabled='D')||'/'||(select count(*) from public.service_types where slug like '%-predrill')" 2>&1)
  [ "$st" = "0/0" ] && echo "PASS: preamble left nothing behind (auth trigger enabled state and slugs restored)" || bad "preamble left changes behind: $st"
  # Rollback: exact schema, PREREQ again, and the data as before the release.
  if D movabi_develop -q < "$B/release-down.sql" > "$T/down.log" 2>&1; then echo "PASS: release-down.sql on the restored copy"; else bad "release-down.sql"; tail -6 "$T/down.log"; fi
  docker exec -e PGPASSWORD="$PW" "$N" pg_dump -h 127.0.0.1 -U supabase_admin -d movabi_develop -s -n public > "$T/schema-after-down.sql" || bad "schema dump failed"
  if diff -q "$T/schema-before.sql" "$T/schema-after-down.sql" >/dev/null; then echo "PASS: rollback restored the exact pre-release schema on real data"; else bad "schema after rollback differs:"; diff "$T/schema-before.sql" "$T/schema-after-down.sql" | head -20; fi
  if D movabi_develop -q < "$B/PREREQ.sql" > "$T/prereq2.log" 2>&1; then echo "PASS: PREREQ passes again after rollback"; else bad "PREREQ after rollback"; tail -6 "$T/prereq2.log"; fi
  echo "$DATA_SQL" | D movabi_develop -tA > "$T/data-after-down.tsv" 2>&1 || bad "data fingerprint could not be read"
  if diff -q "$T/data-before.tsv" "$T/data-after-down.tsv" >/dev/null; then echo "PASS: restored data byte-identical to before the release"; else bad "data differs after release + rollback:"; diff "$T/data-before.tsv" "$T/data-after-down.tsv" | head -10; fi
  if [ "$fail" = 0 ]; then echo "DRILL_OK: restore, release, ${#SUITES[@]} of ${#SUITES[@]} suites, data preservation and rollback all passed (throwaway container removed on exit)"; exit 0
  else echo "DRILL_FAILED: see FAIL lines above (throwaway container removed on exit)"; exit 1; fi
  ;;
prereq)  psql_dev -q < "$B/PREREQ.sql" ;;
verify)  psql_dev -q < "$B/VERIFY.sql" ;;
dryrun)
  psql_dev -q < "$B/PREREQ.sql"
  psql_dev -q < "$B/release-dryrun.sql"; echo "DRYRUN_OK (rolled back; develop unchanged)"
  psql_dev -q < "$B/PREREQ.sql" >/dev/null; echo "PASS: develop still in the pre-release state" ;;
apply)
  psql_dev -q < "$B/PREREQ.sql"
  psql_dev -q < "$B/release-up.sql"; echo "RELEASE_APPLIED $(date -u)"
  psql_dev -q < "$B/VERIFY.sql" ;;
rollback)
  psql_dev -q < "$B/release-down.sql"; echo "RELEASE_ROLLED_BACK $(date -u)"
  psql_dev -q < "$B/PREREQ.sql" ;;
*) echo "usage: $0 <bundle-dir> backup|drill <dump>|prereq|dryrun|apply|verify|rollback"; exit 2 ;;
esac
