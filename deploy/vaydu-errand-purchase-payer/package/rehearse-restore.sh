#!/usr/bin/env bash
# Restore rehearsal for the develop release archive — disposable only.
#
# Rehearses the RUNBOOK host procedure exactly, on an isolated throwaway
# postgres container, using ONLY the files inside this archive:
#
#   1. restore a FULL develop backup (pg_dump custom/tar or plain .sql)
#      supplied by the caller — never a partial schema or a repository
#      migration sweep. The dump carries its own auth schema, ownership and
#      grants: no GoTrue materialisation or test fixtures are created before
#      the restore. (A plain .sql that lacks the auth schema gets it from
#      GoTrue first — the only case where pre-restore plumbing is needed.)
#   2. verify restored ownership + grants (roles, public-schema privileges,
#      object owners, function EXECUTE grants).
#   3. snapshot the preservation baseline: every public function's
#      signature|definition-hash, and every public table's column list +
#      count + order-independent row-content hash.
#   4. add test-only fixtures (idempotent, marked below) — AFTER the
#      preservation snapshot so they can never mask a preservation defect.
#   5. run the shipped db/preflight-schema-check.sql; apply ONLY the
#      explicitly reviewed chain per its gates.
#   6. prove preserved state: every pre-existing function signature|hash is
#      identical or in the reviewed-apply allowlist — dropped signatures and
#      unexpected definition changes fail; cash/PIN records must be byte
#      identical. Every pre-existing table's count + content hash over its
#      own snapshot columns is unchanged; new columns must each trace to an
#      ADD COLUMN in an applied file; any other column delta fails.
#   7. compatibility: GB Stripe payout identity anchor intact.
#   8. run BOTH shipped behaviour suites (each is BEGIN..ROLLBACK);
#      afterwards re-verify the preservation snapshot is byte-identical —
#      the suites may leave no persistent changes.
#
# Every step checks its own exit status. Nothing suppresses errors, and no
# repository migration outside the reviewed chain is ever applied.
#
# Usage (from the extracted archive root):
#   runbook/rehearse-restore.sh /path/to/movabi_develop_full_backup.dump
#   runbook/rehearse-restore.sh /path/to/movabi_develop_full_backup.sql
#
# Env:
#   PG_IMAGE    postgres image (default supabase/postgres:15.1.1.78 — host engine)
#   PSQL_USER   superuser      (default supabase_admin for the supabase image)
#   KEEP_DB=1   leave container running for inspection (prints its name)
set -euo pipefail
export MSYS_NO_PATHCONV=1

die(){ echo "REHEARSAL FAIL: $*" >&2; exit 1; }
step(){ echo; echo "== $*"; }
found(){ grep -qE "$1" && return 0 || return 1; }

[ $# -eq 1 ] || die "usage: $0 <full-develop-backup (.sql plain or pg_dump custom/tar)>"
backup_src="$1"; [ -f "$backup_src" ] || die "backup not found: $backup_src"
backup="$(cd "$(dirname "$backup_src")" && pwd)/$(basename "$backup_src")"

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
tmp=/tmp/vaydu-rehearse-$id; mkdir -p "$tmp"
cleanup(){ rm -rf "$tmp"; docker rm -f "$db" "$db-auth" >/dev/null 2>&1 || true; docker network rm "$db-net" >/dev/null 2>&1 || true; }
[ "${KEEP_DB:-}" = "1" ] && cleanup(){ rm -rf "$tmp"; docker rm -f "$db-auth" >/dev/null 2>&1 || true; docker network rm "$db-net" >/dev/null 2>&1 || true; }
trap cleanup EXIT
q(){ docker exec -i -e PGPASSWORD=isolated-test "$db" psql -X -U "$pguser" -d "$name" -v ON_ERROR_STOP=1 "$@"; }

step "container: $pg_image (disposable)"
# POSTGRES_DB=postgres keeps the image's bootstrap objects (auth/storage
# schemas etc.) out of the restore target: movabi_develop is then created
# from the PRISTINE template0 — a clean database, like a fresh host target.
docker run -d --rm --name "$db" -e POSTGRES_PASSWORD=isolated-test -e POSTGRES_DB=postgres "$pg_image" >/dev/null \
  || die "docker run failed"
ready=0
for _ in $(seq 1 240); do
  if [ "$(docker logs "$db" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ]; then ready=1; break; fi
  sleep 0.5
done
[ "$ready" = 1 ] || die "postgres container never became ready"
sleep 2

# Roles the dump's OWNER/GRANT statements expect — environment plumbing only,
# every statement IF NOT EXISTS. Roles are cluster-level, created via the
# `postgres` db before movabi_develop exists.
docker exec -i -e PGPASSWORD=isolated-test "$db" psql -X -U "$pguser" -d postgres -v ON_ERROR_STOP=1 -qAt <<'SQL' || die "role bootstrap failed"
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','authenticator','supabase_admin',
   'supabase_auth_admin','supabase_storage_admin','supabase_functions_admin','supabase_read_only_user',
   'pgbouncer','supabase_replication_admin','dashboard_user'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',r); END IF;
 END LOOP;
END $$;
SQL

# Clean restore target — template0, not the image's pre-seeded database.
docker exec -i -e PGPASSWORD=isolated-test "$db" psql -X -U "$pguser" -d postgres -v ON_ERROR_STOP=1 -qAt \
  -c "CREATE DATABASE \"$name\" TEMPLATE template0" || die "failed to create clean $name from template0"

# auth schema: a full custom-format backup carries auth.* (objects, ownership,
# grants) itself — restoring it faithfully needs NO pre-created GoTrue schema.
# A plain .sql that lacks `CREATE SCHEMA auth` is the ONLY case where GoTrue
# materialises it first (identical to how develop built it).
custom=0; [ "$(head -c 5 "$backup")" = "PGDMP" ] && custom=1
if [ "$custom" = 0 ] && ! grep -qE 'CREATE SCHEMA (IF NOT EXISTS )?auth' "$backup"; then
  step "plain dump without auth schema — GoTrue materialises auth.* first"
  auth="$db-auth"; net="$db-net"
  docker network create "$net" >/dev/null || die "docker network create failed"
  docker network connect "$net" "$db" || die "docker network connect failed"
  q -qAt -c "CREATE SCHEMA IF NOT EXISTS auth; ALTER SCHEMA auth OWNER TO postgres; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";" >/dev/null || die "auth schema create failed"
  docker run -d --rm --network "$net" --name "$auth" \
    -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL=http://localhost:9999 -e GOTRUE_SITE_URL=http://localhost:3000 \
    -e GOTRUE_DB_NAMESPACE=auth -e GOTRUE_DB_DRIVER=postgres \
    -e "GOTRUE_DB_DATABASE_URL=postgres://postgres:isolated-test@$db:5432/$name?sslmode=disable&options=-csearch_path%3Dauth%2Cpublic" \
    -e GOTRUE_JWT_SECRET=synthetic-disposable-jwt-secret-minimum-40-characters -e GOTRUE_JWT_AUD=authenticated \
    "${GOTRUE_IMAGE:-supabase/gotrue:v2.132.3}" >/dev/null || die "gotrue container failed to start"
  auth_ready=0
  for _ in $(seq 1 240); do
    if [ "$(q -qAt -c "select to_regclass('auth.users') is not null" 2>/dev/null || true)" = t ]; then auth_ready=1; break; fi
    sleep 0.5
  done
  docker rm -f "$auth" >/dev/null || die "gotrue teardown failed"
  [ "$auth_ready" = 1 ] || die "GoTrue never materialised the auth schema"
fi

step "restore: $(basename "$backup")"
docker exec -i "$db" sh -c 'cat > /tmp/develop-backup' < "$backup" || die "failed to stage backup into container"
if [ "$custom" = 1 ]; then
  # Faithful restore: ownership + privileges come from the dump (roles were
  # bootstrapped above so OWNER/GRANT resolves).
  docker exec -i -e PGPASSWORD=isolated-test "$db" \
    pg_restore -U "$pguser" -d "$name" --exit-on-error /tmp/develop-backup \
    > "$tmp/restore.log" 2>&1 \
    || { tail -20 "$tmp/restore.log"; die "pg_restore reported errors — fix the backup before rehearsing"; }
else
  sed 's/CREATE SCHEMA public;/CREATE SCHEMA IF NOT EXISTS public;/; s/CREATE EXTENSION /CREATE EXTENSION IF NOT EXISTS /' "$backup" \
    | docker exec -i -e PGPASSWORD=isolated-test "$db" \
      psql -X -U "$pguser" -d "$name" -v ON_ERROR_STOP=1 -q -f - > "$tmp/restore.log" 2>&1 \
    || { tail -20 "$tmp/restore.log"; die "plain restore reported errors — fix the backup before rehearsing"; }
fi
if grep -qE "ERROR:|FATAL:|pg_restore: (error|fatal)" "$tmp/restore.log"; then
  tail -20 "$tmp/restore.log"; die "restore log contains errors — fix the backup before rehearsing"
fi
echo "restored cleanly."

step "verify restored ownership + grants"
own_out="$(q -qAt <<'SQL'
SELECT 'role|'||rolname FROM pg_roles WHERE rolname IN
 ('anon','authenticated','service_role','authenticator','supabase_admin','supabase_auth_admin') ORDER BY 1;
SELECT 'schema-grant|'||r||'|'||has_schema_privilege(r,'public','USAGE')
 FROM (VALUES('anon'),('authenticated'),('service_role'),('authenticator')) v(r) ORDER BY 1;
SELECT 'owner|'||pg_get_userbyid(c.relowner)||'|'||count(*) FROM pg_class c
 JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r' GROUP BY c.relowner ORDER BY 1;
SELECT 'fn-grant|service_role|auth.uid|'||has_function_privilege('service_role','auth.uid()','EXECUTE')
 WHERE to_regprocedure('auth.uid()') IS NOT NULL;
SQL
)" || die "ownership/grant probe failed"
echo "$own_out"
for r in anon authenticated service_role authenticator supabase_admin supabase_auth_admin; do
  printf '%s\n' "$own_out" | grep -qx "role|$r" || die "required role missing after restore: $r"
done
for r in anon authenticated service_role; do
  printf '%s\n' "$own_out" | grep -qx "schema-grant|$r|true" || die "public-schema USAGE grant missing for $r after restore"
done
printf '%s\n' "$own_out" | grep -E '^owner\|' | awk -F'|' '{print $2}' | sort -u > "$tmp/owners.txt"
if grep -vE '^(postgres|supabase_admin|pg_database_owner)$' "$tmp/owners.txt" | grep -q .; then
  echo "public-table owners outside the expected set:"; grep -vE '^(postgres|supabase_admin|pg_database_owner)$' "$tmp/owners.txt"
  die "unexpected object ownership after restore — reconcile before rehearsing"
fi
[ "$(q -qAt -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'" 2>/dev/null || echo 0)" -gt 0 ] \
  || die "restore produced no public tables — this is not a develop backup"

# Constant-memory, order-independent row-content record: count plus two
# seeded bit_xor aggregates of per-row extended hashes over the pinned
# column list. Detects inserts/deletes/updates on snapshot columns without
# materialising the table (a string_agg of per-row hashes OOMs on large tables).
rowhash(){
  local t="$1" cols="$2"
  q -qAt <<SQL
SELECT count(*)||'|'||coalesce(bit_xor(hashtextextended(s::text,0)),0)||'|'||coalesce(bit_xor(hashtextextended(s::text,1)),0)
 FROM (SELECT $cols FROM public."$t") s;
SQL
}

snapshot(){ # $1 = prefix: before|after|final
  q -qAt <<'SQL' > "$tmp/$1.functions.txt"
SELECT p.proname||'('||oidvectortypes(p.proargtypes)||')'||'|'||md5(pg_get_functiondef(p.oid))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' ORDER BY 1;
SQL
  [ -s "$tmp/$1.functions.txt" ] || die "function snapshot empty ($1)"
  q -qAt -c "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1" > "$tmp/$1.tables.txt" || die "table list failed ($1)"
  : > "$tmp/$1.cols.txt"; : > "$tmp/$1.rows.txt"
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    cols="$(q -qAt -c "SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) FROM pg_attribute WHERE attrelid='public.\"$t\"'::regclass AND attnum>0 AND NOT attisdropped" </dev/null)" \
      || die "column list failed on $t"
    printf '%s|%s\n' "$t" "$cols" >> "$tmp/$1.cols.txt"
    rec="$(rowhash "$t" "$cols")" || die "row hash failed on $t"
    printf '%s|%s\n' "$t" "$rec" >> "$tmp/$1.rows.txt"
  done < "$tmp/$1.tables.txt"
}

compare_state(){ # $1 = before-file tag, $2 = after-file tag, $3 = allow-new-tables file or /dev/null
  local fail=0
  while IFS='|' read -r sig h; do
    fname="${sig%%(*}"
    if ! grep -qF "$sig" "$tmp/$2.functions.txt"; then
      if grep -q "^$fname(" "$tmp/$2.functions.txt"; then
        grep -qxF "$fname" "$tmp/allowed-fn.txt" 2>/dev/null || { echo "  DEFINITION CHANGED outside review: $sig"; fail=1; }
      else
        echo "  DROPPED signature: $sig"; fail=1
      fi
    else
      ah="$(grep -F "$sig" "$tmp/$2.functions.txt" | head -1 | awk -F'|' '{print $NF}')"
      if [ "$ah" != "$h" ]; then
        grep -qxF "$fname" "$tmp/allowed-fn.txt" 2>/dev/null || { echo "  HASH CHANGED outside review: $sig"; fail=1; }
      fi
    fi
  done < "$tmp/$1.functions.txt"
  while IFS='|' read -r sig h; do
    fname="${sig%%(*}"
    grep -q "^$fname(" "$tmp/$1.functions.txt" || grep -qxF "$fname" "$tmp/allowed-fn.txt" 2>/dev/null \
      || { echo "  UNEXPECTED new function: $sig"; fail=1; }
  done < "$tmp/$2.functions.txt"
  [ "$fail" = 0 ] || return 1
  return 0
}

step "preservation baseline snapshot (functions + column-pinned row hashes)"
snapshot before

step "test-only fixtures (post-snapshot; idempotent; never part of the dump)"
q -qAt <<'SQL' >/dev/null || die "fixture bootstrap failed"
CREATE TABLE IF NOT EXISTS auth.job_messages (id uuid);
CREATE OR REPLACE FUNCTION auth.debug_errand_insert() RETURNS trigger
LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$;
CREATE TABLE IF NOT EXISTS public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now());
SQL

step "preflight (read-only inventory of the restore)"
pre_out="$(q -qAt -F'|' -f - < "$root/db/preflight-schema-check.sql")" || die "preflight failed to run"
echo "$pre_out"
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
allowed_cols="$tmp/allowed-cols.txt"; : > "$allowed_cols"
for rel in "${apply_list[@]}"; do
  [ -f "$root/$rel" ] || die "apply list references missing file: $rel"
  # A file may declare no functions or no new columns — absence is expected,
  # so grep's no-match status is not an apply failure.
  grep -oiE 'CREATE (OR REPLACE )?FUNCTION public\.[a-z_0-9]+' "$root/$rel" \
    | sed 's/.*public\.//I' | tr 'A-Z' 'a-z' >> "$allowed_fn" || true
  grep -oiE 'ADD COLUMN (IF NOT EXISTS )?[a-z_0-9]+' "$root/$rel" \
    | sed -E 's/ADD COLUMN (IF NOT EXISTS )?//I' | tr 'A-Z' 'a-z' >> "$allowed_cols" || true
  echo "-- apply $rel"
  q -f - < "$root/$rel" >/dev/null || die "migration failed: $rel — aborted; nothing after it was attempted"
done
sort -u "$allowed_fn" -o "$allowed_fn"; sort -u "$allowed_cols" -o "$allowed_cols"

step "post-apply preflight — zero objects may be missing, zero definitions may differ"
post_out="$(q -qAt -F'|' -f - < "$root/db/preflight-schema-check.sql")" || die "post-apply preflight failed to run"
if printf '%s\n' "$post_out" | found '\|missing$'; then
  printf '%s\n' "$post_out" | grep -E '\|missing$'
  die "required objects still missing after apply"
fi
if printf '%s\n' "$post_out" | found 'DEFINITION-DIFFERS|function-absent'; then
  die "definition drift after apply"
fi

step "preserved-state check — signature|hash functions + column-pinned row content"
snapshot after
compare_state before after || die "function signature/hash records changed outside the reviewed chain"
echo "function records: unchanged outside the reviewed chain"

# Cash/PIN definitions: explicit byte-identical requirement.
for pat in 'cash' 'pin'; do
  grep -iE "$pat" "$tmp/before.functions.txt" | sort > "$tmp/$pat-before.txt"
  grep -iE "$pat" "$tmp/after.functions.txt" | sort > "$tmp/$pat-after.txt"
  diff -q "$tmp/$pat-before.txt" "$tmp/$pat-after.txt" >/dev/null \
    || { diff "$tmp/$pat-before.txt" "$tmp/$pat-after.txt" | head -10; die "$pat function definitions changed"; }
  echo "$pat definitions: byte-identical ($(wc -l < "$tmp/$pat-before.txt") functions)"
done

# Row content: count + content hash over each table's OWN snapshot columns.
# Column set deltas must each trace to an ADD COLUMN in an applied file;
# content-hash changes on pre-existing columns are never allowed.
rfail=0
while IFS='|' read -r t cols; do
  [ -n "$t" ] || continue
  acols="$(grep -E "^${t}\\|" "$tmp/after.cols.txt" | head -1 | cut -d'|' -f2-)" || true
  if ! grep -q "^$t|" "$tmp/after.cols.txt"; then echo "  DROPPED TABLE: $t"; rfail=1; continue; fi
  bset="$(tr ',' '\n' <<<"$cols" | sed 's/"//g' | sort -u)"
  aset="$(tr ',' '\n' <<<"$acols" | sed 's/"//g' | sort -u)"
  comm -13 <(echo "$bset") <(echo "$aset") > "$tmp/newcols.txt"
  comm -23 <(echo "$bset") <(echo "$aset") > "$tmp/droppedcols.txt"
  if [ -s "$tmp/droppedcols.txt" ]; then echo "  DROPPED COLUMNS on $t: $(tr '\n' ' ' < "$tmp/droppedcols.txt")"; rfail=1; fi
  while IFS= read -r nc; do
    [ -n "$nc" ] || continue
    grep -qxF "$nc" "$allowed_cols" || { echo "  UNREVIEWED NEW COLUMN: $t.$nc"; rfail=1; }
  done < "$tmp/newcols.txt"
  rec="$(rowhash "$t" "$cols")" || die "row hash failed on $t"
  before_rec="$(grep -E "^${t}\\|" "$tmp/before.rows.txt" | head -1 | cut -d'|' -f2-)"
  if [ "$rec" != "$before_rec" ]; then
    echo "  ROW CONTENT CHANGED: $t  $before_rec -> $rec"; rfail=1
  fi
done < "$tmp/before.cols.txt"
[ "$rfail" = 0 ] || die "restored data was altered by the chain"
echo "row content: all $(wc -l < "$tmp/before.rows.txt") pre-existing tables preserved (counts + content hashes over snapshot columns)"

step "compatibility — GB Stripe payout identity anchor"
q -qAt -c "SELECT coalesce(position('Invalid payout identity' IN pg_get_functiondef(p.oid))>0
            AND position('acct_%' IN pg_get_functiondef(p.oid))>0,false)
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='complete_job_with_pending_payout'
             AND oidvectortypes(p.proargtypes)='uuid, uuid, jsonb, jsonb'" \
  | grep -qx t || die "GB Stripe payout identity anchor lost after apply"
echo "GB Stripe: payout identity anchor intact"

step "behaviour suites (shipped files only)"
for t in realdb-errand-purchase-payer-test.sql realdb-customer-funding-chain-test.sql; do
  out="$(q -f - < "$root/db/tests/$t")" || die "$t errored"
  printf '%s\n' "$out" | tail -12
  fails="$(printf '%s\n' "$out" | awk -F'|' '/^ *[0-9]+ *\| *[0-9]+ *$/ {gsub(/ /,"",$1); print $1}' | tail -1)"
  [ "${fails:-1}" = "0" ] || die "$t reported failures"
  echo "$t: PASSED"
done

step "post-suite persistence — suites may leave no persistent changes"
snapshot final
: > "$tmp/allowed-fn.txt"   # no new function may appear after apply
compare_state after final || die "behaviour suites left persistent function changes"
wfail=0
while IFS='|' read -r t rec; do
  [ -n "$t" ] || continue
  cols="$(grep -E "^${t}\\|" "$tmp/after.cols.txt" | head -1 | cut -d'|' -f2-)"
  frec="$(rowhash "$t" "$cols")" || die "final row hash failed on $t"
  [ "$frec" = "$rec" ] || { echo "  PERSISTENT SUITE WRITE: $t  $rec -> $frec"; wfail=1; }
done < "$tmp/after.rows.txt"
diff -u "$tmp/after.cols.txt" "$tmp/final.cols.txt" | grep -E '^[+-][a-z]' && wfail=1 || true
if comm -13 <(sort "$tmp/after.tables.txt") <(sort "$tmp/final.tables.txt") | grep -q .; then
  echo "  PERSISTENT SUITE OBJECT:"; comm -13 <(sort "$tmp/after.tables.txt") <(sort "$tmp/final.tables.txt"); wfail=1
fi
if comm -23 <(sort "$tmp/after.tables.txt") <(sort "$tmp/final.tables.txt") | grep -q .; then
  echo "  SUITE DROPPED TABLE:"; comm -23 <(sort "$tmp/after.tables.txt") <(sort "$tmp/final.tables.txt"); wfail=1
fi
[ "$wfail" = 0 ] || die "behaviour suites left persistent changes"
echo "post-suite state: byte-identical to post-apply state — no persistent changes"

echo
echo "RESTORE REHEARSAL PASSED: full backup -> ownership/grants verified -> baseline snapshot -> fixtures -> reviewed chain only -> functions+rows preserved (content hashes, explicit allowances) -> compat intact -> both suites green -> no persistent suite changes"
[ "${KEEP_DB:-}" = "1" ] && echo "container kept: $db (docker exec -it $db psql -U $pguser -d $name)" || true
