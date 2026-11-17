#!/usr/bin/env bash
# Restore rehearsal for the develop release archive — disposable only.
#
# Rehearses the RUNBOOK host procedure exactly, on an isolated throwaway
# postgres container, using ONLY the files inside this archive:
#
#   1. restore a FULL develop backup (pg_dump custom/tar or plain .sql)
#      supplied by the caller — never a partial schema or a repository
#      migration sweep;
#   2. run the shipped db/preflight-schema-check.sql (read-only inventory);
#   3. apply ONLY the explicitly reviewed chain — a db/prerequisites/ file
#      ONLY when the preflight reports its group missing (and, for 547, only
#      after the deployed function definition it patches is verified), then
#      a db/migrations/ file ONLY when its group is missing, in APPLY-ORDER;
#   4. re-run the shipped preflight — zero package objects may be missing;
#   5. prove restored data preserved: every pre-existing table row count and
#      every public function definition identical to the post-restore
#      snapshot, except functions the applied files are reviewed to declare;
#   6. compatibility: GB Stripe payout identity anchor intact; cash-credit
#      and PIN-policy functions unchanged;
#   7. run BOTH shipped behaviour suites; a nonzero failure count aborts.
#
# Every step checks its own exit status. Nothing here suppresses errors, and
# no repository migration outside the reviewed chain is ever applied.
#
# Usage (from the extracted archive root):
#   runbook/rehearse-restore.sh /path/to/movabi_develop_full_backup.dump
#   runbook/rehearse-restore.sh /path/to/movabi_develop_full_backup.sql
#
# Env:
#   PG_IMAGE    postgres image   (default supabase/postgres:15.1.1.78 — host engine)
#   PSQL_USER   superuser        (default supabase_admin for the supabase image)
#   KEEP_DB=1   leave container running for inspection (prints its name)
set -euo pipefail
export MSYS_NO_PATHCONV=1

die(){ echo "REHEARSAL FAIL: $*" >&2; exit 1; }
step(){ echo; echo "== $*"; }
found(){ grep -qE "$1" && return 0 || return 1; }

[ $# -eq 1 ] || die "usage: $0 <full-develop-backup (.sql plain or pg_dump custom/tar)>"
backup_src="$1"; [ -f "$backup_src" ] || die "backup not found: $backup_src"
backup="$(cd "$(dirname "$backup_src")" && pwd)/$(basename "$backup_src")"

# Resolve the archive root: this script lives at <archive>/runbook/.
runbook_dir="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$runbook_dir/.." && pwd)"
for f in db/preflight-schema-check.sql db/migrations/APPLY-ORDER.txt \
         db/prerequisites/20261254700000_flutterwave_payout_outbox.sql \
         db/prerequisites/20261254800000_flutterwave_collection_subaccounts.sql \
         db/tests/realdb-errand-purchase-payer-test.sql \
         db/tests/realdb-customer-funding-chain-test.sql; do
  [ -f "$root/$f" ] || die "archive incomplete — missing $f"
done

pg_image="${PG_IMAGE:-supabase/postgres:15.1.1.78}"
pguser="${PSQL_USER:-supabase_admin}"
id="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
db="vaydu-restore-$id"; name=movabi_develop
cleanup(){ [ "${KEEP_DB:-}" = "1" ] || docker rm -f "$db" >/dev/null 2>&1 || true; }
trap cleanup EXIT
q(){ docker exec -i -e PGPASSWORD=isolated-test "$db" psql -X -U "$pguser" -d "$name" -v ON_ERROR_STOP=1 "$@"; }
tmp=/tmp/vaydu-rehearse-$id; mkdir -p "$tmp"
rm_tmp(){ rm -rf "$tmp"; }
trap 'rm_tmp; cleanup' EXIT

step "container: $pg_image (disposable)"
docker run -d --rm --name "$db" -e POSTGRES_PASSWORD=isolated-test -e POSTGRES_DB="$name" "$pg_image" >/dev/null \
  || die "docker run failed"
ready=0
# The supabase image starts a temporary bootstrap server, initialises roles,
# then restarts — readiness is the SECOND 'ready to accept connections'.
for _ in $(seq 1 240); do
  if [ "$(docker logs "$db" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ]; then ready=1; break; fi
  sleep 0.5
done
[ "$ready" = 1 ] || die "postgres container never became ready"
sleep 2

# Supabase roles the dump's GRANTs expect. Environment plumbing only — not a
# migration; every statement is IF NOT EXISTS.
q -qAt <<'SQL' || die "role bootstrap failed"
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
END $$;
SQL

# auth schema materialisation: a full develop backup carries auth.* itself,
# but a schema-only dump does not — and the dump's DDL references auth types.
# GoTrue builds the auth schema exactly as on develop; skipped automatically
# when the restore already contains auth.users (the fixture check below runs
# again after restore). Disposable plumbing, never a repository migration.
auth="$db-auth"; net="$db-net"
rm_net(){ docker rm -f "$auth" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
trap 'rm_tmp; rm_net; cleanup' EXIT
docker network create "$net" >/dev/null || die "docker network create failed"
docker network connect "$net" "$db" || die "docker network connect failed"
q -qAt -c "CREATE SCHEMA IF NOT EXISTS auth;" >/dev/null || die "auth schema create failed"
docker run -d --rm --network "$net" --name "$auth" \
  -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL=http://localhost:9999 -e GOTRUE_SITE_URL=http://localhost:3000 \
  -e GOTRUE_DB_NAMESPACE=auth -e GOTRUE_DB_DRIVER=postgres \
  -e "GOTRUE_DB_DATABASE_URL=postgres://postgres:isolated-test@$db:5432/$name?sslmode=disable&options=-csearch_path%3Dauth%2Cpublic" \
  -e GOTRUE_JWT_SECRET=synthetic-disposable-jwt-secret-minimum-40-characters -e GOTRUE_JWT_AUD=authenticated \
  "${GOTRUE_IMAGE:-supabase/gotrue:v2.132.3}" >/dev/null || die "gotrue container failed to start"
auth_ready=0
for _ in $(seq 1 240); do
  if [ "$(q -qAt -c "select to_regclass('auth.users') is not null and exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.proname='uid')" 2>/dev/null || true)" = t ]; then auth_ready=1; break; fi
  sleep 0.5
done
docker rm -f "$auth" >/dev/null || die "gotrue teardown failed"
[ "$auth_ready" = 1 ] || die "GoTrue never materialised the auth schema"
# Disposable fixtures the behaviour suites hook into (idempotent).
q -qAt <<'SQL' >/dev/null || die "auth fixture bootstrap failed"
CREATE TABLE IF NOT EXISTS auth.job_messages (id uuid);
CREATE OR REPLACE FUNCTION auth.debug_errand_insert() RETURNS trigger
LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$;
SQL

step "restore: $(basename "$backup")"
docker exec -i "$db" sh -c 'cat > /tmp/develop-backup' < "$backup" || die "failed to stage backup into container"
if [ "$(head -c 5 "$backup")" = "PGDMP" ]; then
  docker exec -i -e PGPASSWORD=isolated-test "$db" \
    pg_restore -U "$pguser" -d "$name" --exit-on-error --no-owner --no-privileges /tmp/develop-backup \
    > "$tmp/restore.log" 2>&1 \
    || { tail -20 "$tmp/restore.log"; die "pg_restore reported errors — fix the backup before rehearsing"; }
else
  # Normalise dump boilerplate only (schema/extension guards); every other
  # statement still aborts the restore on error via ON_ERROR_STOP.
  sed 's/CREATE SCHEMA public;/CREATE SCHEMA IF NOT EXISTS public;/; s/CREATE EXTENSION /CREATE EXTENSION IF NOT EXISTS /' "$backup" \
    | docker exec -i -e PGPASSWORD=isolated-test "$db" \
      psql -X -U "$pguser" -d "$name" -v ON_ERROR_STOP=1 -q -f - > "$tmp/restore.log" 2>&1 \
    || { tail -20 "$tmp/restore.log"; die "plain restore reported errors — fix the backup before rehearsing"; }
fi
if grep -qE "ERROR:|FATAL:|pg_restore: (error|fatal)" "$tmp/restore.log"; then
  tail -20 "$tmp/restore.log"; die "restore log contains errors — fix the backup before rehearsing"
fi
echo "restored cleanly."

# `tenants` is the reviewed additive baseline supplement (the deployed
# snapshot came from a divergent clone missing it); IF NOT EXISTS so a full
# backup that already carries it is untouched. Not a repository migration.
q -qAt <<'SQL' || die "supplemental bootstrap failed"
CREATE TABLE IF NOT EXISTS public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now());
SQL

step "snapshot restored state (function definitions + all table row counts)"
q -qAt <<'SQL' > "$tmp/fn-before.txt" || die "function snapshot failed"
SELECT p.proname||'('||oidvectortypes(p.proargtypes)||')'||'|'||md5(pg_get_functiondef(p.oid))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' ORDER BY 1;
SQL
q -qAt -c "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1" > "$tmp/tables.txt" \
  || die "table list failed"
: > "$tmp/rows-before.txt"
while IFS= read -r t; do
  [ -n "$t" ] || continue
  c="$(q -qAt -c "SELECT count(*) FROM public.\"$t\"" </dev/null)" || die "row count failed on $t"
  printf '%s|%s\n' "$t" "$c" >> "$tmp/rows-before.txt"
done < "$tmp/tables.txt"

step "preflight (read-only inventory of the restore)"
pre_out="$(docker exec -i -e PGPASSWORD=isolated-test "$db" \
  psql -X -U "$pguser" -d "$name" -v ON_ERROR_STOP=1 -qAt -F'|' \
  -f - < "$root/db/preflight-schema-check.sql")" || die "preflight failed to run"
echo "$pre_out"

# STOP conditions — from definitions + records, not object presence alone.
if ! printf '%s\n' "$pre_out" | found '\|missing$|\|DEFINITION-DIFFERS$'; then
  die "preflight reports nothing missing and no definition drift — this restore already carries the release; nothing to rehearse"
fi
if printf '%s\n' "$pre_out" | found '^prereq/baseline\|.*\|missing$'; then
  die "baseline prerequisite objects are missing — this is not the reviewed develop state; STOP"
fi
if printf '%s\n' "$pre_out" | found '^prereq/collection\|.*\|missing$'; then
  die "collection-chain prerequisites are missing — no shipped file is authorised to fix them; STOP"
fi
pt="$(printf '%s\n' "$pre_out" | grep -E '^patch-target/547\|' | awk -F'|' '{print $3}')"
[ "$pt" = 'definition-verified' ] \
  || die "patch-target/547 reports '${pt:-missing row}' — deployed complete_job_with_pending_payout must carry the reviewed Stripe anchor before anything is applied"
if printf '%s\n' "$pre_out" | found '\.sql\|recorded-applied\|[1-9]'; then
  die "a recorded-applied migration reports missing objects — schema drift; STOP"
fi

grp_state(){ printf '%s\n' "$pre_out" | grep -cE "^$1\\|.*\\|$2\$"; }
file_recorded(){ printf '%s\n' "$pre_out" | grep -qE "^[^|]*$1[^|]*\.sql\|recorded-applied\|"; }

step "apply list — reviewed chain only, gated on definitions + records"
apply_list=()
for spec in "prereq/547 db/prerequisites/20261254700000_flutterwave_payout_outbox.sql 20261254700000" \
            "prereq/548 db/prerequisites/20261254800000_flutterwave_collection_subaccounts.sql 20261254800000"; do
  grp="$(cut -d' ' -f1 <<<"$spec")"; file="$(cut -d' ' -f2 <<<"$spec")"; ver="$(cut -d' ' -f3 <<<"$spec")"
  if [ "$(grp_state "$grp" missing)" -gt 0 ]; then
    if file_recorded "$ver"; then die "drift: $ver recorded-applied but objects missing"; fi
    apply_list+=("$file")
  elif [ "$(grp_state "$grp" 'DEFINITION-DIFFERS')" -gt 0 ]; then
    die "drift: a deployed $grp function has a foreign definition — reconcile before applying anything"
  elif printf '%s\n' "$pre_out" | grep -qE "^[^|]*$ver[^|]*\.sql\|(not-recorded|unknown)\|0$"; then
    die "drift: $ver objects present but unrecorded — reconcile provenance first"
  else
    echo "  skip $file ($grp verified present)"
  fi
done
while IFS= read -r mig; do
  [ -n "$mig" ] || continue
  grp="${mig:0:9}"; file="db/migrations/$mig.sql"; ver="${mig:0:14}"
  needs=0
  if [ "$(grp_state "$grp" missing)" -gt 0 ]; then needs=1; fi
  if [ "$(grp_state "$grp" 'DEFINITION-DIFFERS')" -gt 0 ]; then needs=1; fi
  if [ "$needs" = 1 ]; then
    if file_recorded "$ver"; then die "drift: $ver recorded-applied but needs apply"; fi
    apply_list+=("$file")
  else
    if printf '%s\n' "$pre_out" | grep -qE "^[^|]*$ver[^|]*\.sql\|not-recorded\|0$"; then
      die "drift: $ver objects present and definitions verified but unrecorded"
    fi
    echo "  skip $file (verified present)"
  fi
done < <(grep -oE '^2026127[0-9]{7}_[a-z_]+' "$root/db/migrations/APPLY-ORDER.txt")
[ "${#apply_list[@]}" -gt 0 ] || die "nothing eligible to apply after gating"

step "apply: ${apply_list[*]}"
allowed_fn="$tmp/allowed-fn.txt"; : > "$allowed_fn"
for rel in "${apply_list[@]}"; do
  [ -f "$root/$rel" ] || die "apply list references missing file: $rel"
  grep -oiE 'CREATE (OR REPLACE )?FUNCTION public\.[a-z_0-9]+' "$root/$rel" \
    | sed 's/.*public\.//I' | tr 'A-Z' 'a-z' >> "$allowed_fn"
  echo "-- apply $rel"
  q -f - < "$root/$rel" >/dev/null || die "migration failed: $rel — aborted; nothing after it was attempted"
done
sort -u "$allowed_fn" -o "$allowed_fn"

step "post-apply preflight — zero objects may be missing, zero definitions may differ"
post_out="$(docker exec -i -e PGPASSWORD=isolated-test "$db" \
  psql -X -U "$pguser" -d "$name" -v ON_ERROR_STOP=1 -qAt -F'|' \
  -f - < "$root/db/preflight-schema-check.sql")" || die "post-apply preflight failed to run"
if printf '%s\n' "$post_out" | found '\|missing$'; then
  printf '%s\n' "$post_out" | grep -E '\|missing$'
  die "required objects still missing after apply"
fi
if printf '%s\n' "$post_out" | found 'DEFINITION-DIFFERS|function-absent'; then
  die "definition drift after apply"
fi

step "preserved-data check — restored rows and functions unchanged"
q -qAt <<'SQL' > "$tmp/fn-after.txt" || die "post function snapshot failed"
SELECT p.proname||'('||oidvectortypes(p.proargtypes)||')'||'|'||md5(pg_get_functiondef(p.oid))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' ORDER BY 1;
SQL
fail=0
while IFS='|' read -r sig h; do
  fname="${sig%%(*}"
  if ! grep -qF "$sig" "$tmp/fn-after.txt"; then
    if grep -q "^$fname(" "$tmp/fn-after.txt"; then
      grep -qx "$fname" "$allowed_fn" || { echo "  CHANGED outside review: $sig"; fail=1; }
    else
      echo "  DROPPED function: $sig"; fail=1
    fi
  fi
done < "$tmp/fn-before.txt"
while IFS='|' read -r sig h; do
  fname="${sig%%(*}"
  grep -q "^$fname(" "$tmp/fn-before.txt" || grep -qx "$fname" "$allowed_fn" \
    || { echo "  UNEXPECTED new function: $sig"; fail=1; }
done < "$tmp/fn-after.txt"
[ "$fail" = 0 ] || die "function definitions changed outside the reviewed chain"
echo "function definitions: unchanged outside the reviewed chain"

while IFS='|' read -r t c; do
  [ -n "$t" ] || continue
  n="$(q -qAt -c "SELECT count(*) FROM public.\"$t\"" </dev/null)" || die "row count failed on $t"
  [ "$n" = "$c" ] || { echo "  ROW COUNT CHANGED: $t  $c -> $n"; fail=1; }
done < "$tmp/rows-before.txt"
[ "$fail" = 0 ] || die "restored data was altered by the chain"
echo "row counts: all $(wc -l < "$tmp/rows-before.txt") pre-existing tables preserved"

step "compatibility — GB Stripe identity, cash credit, PIN policy"
q -qAt -c "SELECT coalesce(position('Invalid payout identity' IN pg_get_functiondef(p.oid))>0
            AND position('acct_%' IN pg_get_functiondef(p.oid))>0,false)
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='complete_job_with_pending_payout'
             AND oidvectortypes(p.proargtypes)='uuid, uuid, jsonb, jsonb'" \
  | grep -qx t || die "GB Stripe payout identity anchor lost after apply"
echo "GB Stripe: payout identity anchor intact"
for pat in cash pin; do
  echo "$pat-* functions: before=$(grep -icE "$pat" "$tmp/fn-before.txt") after=$(grep -icE "$pat" "$tmp/fn-after.txt") (definition diff above already rejects any change)"
done

step "behaviour suites (shipped files only)"
for t in realdb-errand-purchase-payer-test.sql realdb-customer-funding-chain-test.sql; do
  out="$(q -f - < "$root/db/tests/$t")" || die "$t errored"
  printf '%s\n' "$out" | tail -12
  fails="$(printf '%s\n' "$out" | awk -F'|' '/^ *[0-9]+ *\| *[0-9]+ *$/ {gsub(/ /,"",$1); print $1}' | tail -1)"
  [ "${fails:-1}" = "0" ] || die "$t reported failures"
  echo "$t: PASSED"
done

rm_tmp
echo
echo "RESTORE REHEARSAL PASSED: full backup -> preflight -> reviewed chain only -> preflight clean -> data preserved -> compat intact -> both suites green"
[ "${KEEP_DB:-}" = "1" ] && echo "container kept: $db (docker exec -it $db psql -U $pguser -d $name)" || true
