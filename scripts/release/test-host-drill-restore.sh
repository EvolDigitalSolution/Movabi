#!/usr/bin/env bash
# Exercise the actual drill entry point with Docker failures injected at its boundary.
# No Docker daemon, real credentials, network or host database is used.
# Usage: bash scripts/release/test-host-drill-restore.sh [host-db-release.sh]
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
script="${1:-$root/deploy/vaydu-develop-release-2/host-db-release.sh}"
script="$(cd "$(dirname "$script")" && pwd)/$(basename "$script")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bundle/tests"
for f in PREREQ.sql VERIFY.sql release-up.sql release-dryrun.sql release-down.sql drill-preamble.sql; do
  : > "$tmp/bundle/$f"
done
echo regression > "$tmp/bundle/SOURCE_SHA"
echo '# fixture only; restore must stop before suites' > "$tmp/bundle/tests/SUITES.txt"
(cd "$tmp/bundle" && sha256sum PREREQ.sql VERIFY.sql release-up.sql release-dryrun.sql release-down.sql > RELEASE-MIGRATIONS.sha256)
echo archive > "$tmp/backup.dump"
cat > "$tmp/backup.dump.globals.sql" <<'SQL'
CREATE ROLE supabase_admin;
ALTER ROLE supabase_admin WITH SUPERUSER;
CREATE ROLE "bootstrap role";
ALTER ROLE "bootstrap role" NOLOGIN;
CREATE ROLE custom_role;
GRANT custom_role TO supabase_admin;
SQL
: > "$tmp/backup.dump.counts.tsv"
echo synthetic-image > "$tmp/backup.dump.image"
(cd "$tmp" && sha256sum backup.dump backup.dump.globals.sql backup.dump.counts.tsv > backup.dump.sha256)

# Functions are inherited by the child bash running the unmodified drill script.
sleep(){ :; }
docker(){
  case " $* " in
    *' pg_restore '*)
      echo pg_restore >> "$CALLS"
      [[ " $* " == *' --exit-on-error '* ]] || return 77
      cat >/dev/null
      if [ "$SCENARIO" = archive-uppercase ]; then echo 'ERROR: injected archive failure' >&2; fi
      return 42
      ;;
    *' psql '*)
      if [[ "$*" == *"quote_ident(rolname)"* ]]; then
        [ "$SCENARIO" != inventory-silent ] || return 71
        printf 'CREATE ROLE supabase_admin;\nCREATE ROLE "bootstrap role";\n'
      elif [[ " $* " == *' -qAtc select 1 '* ]] || [[ "$*" == *'CREATE DATABASE movabi_develop;'* ]]; then
        return 0
      else
        echo globals >> "$CALLS"
        [[ " $* " == *' ON_ERROR_STOP=1 '* ]] || return 78
        sql=$(cat)
        # Only exact CREATEs for fresh bootstrap roles may disappear. All other SQL must survive.
        ! printf '%s\n' "$sql" | grep -qx 'CREATE ROLE supabase_admin;' || return 79
        ! printf '%s\n' "$sql" | grep -qx 'CREATE ROLE "bootstrap role";' || return 79
        for expected in 'ALTER ROLE supabase_admin WITH SUPERUSER;' 'ALTER ROLE "bootstrap role" NOLOGIN;' 'CREATE ROLE custom_role;' 'GRANT custom_role TO supabase_admin;'; do
          printf '%s\n' "$sql" | grep -Fxq "$expected" || return 80
        done
        if [ "$SCENARIO" = globals-uppercase ]; then echo 'ERROR: injected globals failure' >&2; fi
        case "$SCENARIO" in globals-*) return 43;; esac
      fi
      ;;
    *' run '*|*' rm '*) return 0;;
    *) echo "unexpected mock Docker invocation" >&2; return 90;;
  esac
}
export -f docker sleep
export CALLS="$tmp/calls"
for SCENARIO in inventory-silent globals-silent globals-uppercase archive-silent archive-uppercase; do
  export SCENARIO
  : > "$CALLS"
  set +e
  (cd "$tmp" && bash "$script" "$tmp/bundle" drill "$tmp/backup.dump") > "$tmp/output" 2>&1
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || { cat "$tmp/output"; echo "FAIL: $SCENARIO returned 0"; exit 1; }
  grep -q DRILL_FAILED "$tmp/output"
  ! grep -q DRILL_OK "$tmp/output"
  case "$SCENARIO" in
    inventory-*) grep -q 'bootstrap role inventory exited 71' "$tmp/output"; test ! -s "$CALLS";;
    globals-*) grep -q 'globals restore exited 43' "$tmp/output"; ! grep -q pg_restore "$CALLS";;
    archive-*) grep -q 'PASS: globals restore exited 0' "$tmp/output"; grep -q 'pg_restore exited 42' "$tmp/output";;
  esac
  case "$SCENARIO" in *-silent) ! grep -q 'error:' "$tmp/output";; esac
  echo "PASS: $SCENARIO returns nonzero ($rc), stops the drill and cannot print DRILL_OK"
done
echo 'RESTORE_REGRESSIONS_OK: 5/5'
