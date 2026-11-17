#!/usr/bin/env bash
# Develop deployment wrapper for vaydu-develop-release-dfff091.tar.gz
#
# Run on the develop host (edsadmin@87.106.64.25). Self-contained: verifies the
# archive, records recovery state, backs up movabi_develop, runs the shipped
# restore rehearsal, applies only the reviewed preflight-approved migration
# chain via stdin redirection, builds + deploys API/web under a candidate
# compose overlay (all existing compose files and overrides untouched), then
# verifies version, health, served assets and localhost CORS.
#
#   bash deploy-dfff091.sh /path/to/vaydu-develop-release-dfff091.tar.gz
#   bash deploy-dfff091.sh --rollback <evidence-dir>
#
# Guarantees:
#   - no compose/override file on the host is edited; image pins resolve through
#     an appended candidate overlay only
#   - VAYDU_CASH_RIDE_BOOKING=true and VAYDU_DRIVER_PAYOUT_TRANSFERS=false are
#     asserted before AND after; every VAYDU/STRIPE/KORA/FLUTTERWAVE/PAYSTACK env
#     var must be identical post-deploy; no payout gate is enabled
#   - every failure aborts before the next step; the evidence dir + recovery
#     overlay make rollback a single compose command
set -euo pipefail

die(){ echo "DEPLOY FAIL: $*" >&2; exit 1; }
step(){ echo; echo "== $*"; }
need(){ command -v "$1" >/dev/null || die "missing host tool: $1"; }

[ "${MSYSTEM:-}" ] && die "run on the develop host, not in a Windows shell"
need docker; need sha256sum; need tar; need curl
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing"
docker info >/dev/null 2>&1 || die "docker daemon unreachable"

if [ "${1:-}" = "--rollback" ]; then
  [ -d "${2:-}" ] || die "usage: $0 --rollback <evidence-dir>"
  E="$2"
  [ -f "$E/rollback.sh" ] || die "no rollback.sh in $E"
  exec bash "$E/rollback.sh"
fi

[ $# -eq 1 ] || die "usage: $0 <vaydu-develop-release-dfff091.tar.gz> | --rollback <dir>"
ARCH="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
[ -f "$ARCH" ] || die "archive not found: $ARCH"
[ -f "$ARCH.sha256" ] || die "checksum file missing: $ARCH.sha256 (upload it next to the archive)"
SRC_SHA="dfff091"
API_TAG="movabi-api:release-dfff091"
WEB_TAG="movabi-web:release-dfff091-linux"
EXPECTED_API_ENV_CASH="true"
EXPECTED_API_ENV_TRANSFERS="false"

step "0 archive integrity"
(cd "$(dirname "$ARCH")" && sha256sum -c --quiet "$(basename "$ARCH").sha256") || die "archive sha256 mismatch"
E=$(mktemp -d /home/edsadmin/vaydu-release-dfff091.XXXXXX)
echo "evidence: $E"
tar -xzf "$ARCH" -C "$E"
R="$E/vaydu-develop-release-dfff091"
[ -d "$R" ] || R="$(dirname "$(find "$E" -maxdepth 2 -name CHECKSUMS.sha256 | head -1)")"
(cd "$R" && sha256sum -c --quiet CHECKSUMS.sha256) || die "inner CHECKSUMS.sha256 mismatch"
for f in db/preflight-schema-check.sql runbook/rehearse-restore.sh runbook/RUNBOOK.md \
         db/prerequisites/20261254700000_flutterwave_payout_outbox.sql \
         db/prerequisites/20261254800000_flutterwave_collection_subaccounts.sql \
         db/migrations/APPLY-ORDER.txt \
         db/tests/realdb-errand-purchase-payer-test.sql \
         db/tests/realdb-customer-funding-chain-test.sql \
         api/server/Dockerfile api/package.json web/mobile/index.html; do
  [ -f "$R/$f" ] || die "archive layout unexpected — missing $f"
done
echo "archive verified at $R"

step "1 record recovery state (images, compose, env)"
docker ps --format '{{.Names}}' | grep -qx movabi-develop-api || die "movabi-develop-api not running"
docker ps --format '{{.Names}}' | grep -qx movabi-develop-db  || die "movabi-develop-db not running"
for svc in api web; do
  c="movabi-develop-$svc"
  [ "$svc" = web ] && c=$(docker ps --filter label=com.docker.compose.service=web \
    --filter label=com.docker.compose.project=movabi-develop --format '{{.Names}}' | head -1)
  [ -n "$c" ] || die "web container not found"
  echo "$c" > "$E/$svc-container.txt"
  docker inspect -f '{{.Image}}'       "$c" > "$E/$svc-image-id.txt"
  docker inspect -f '{{.Config.Image}}' "$c" > "$E/$svc-image-tag.txt"
done
echo "current api: $(cat "$E/api-image-tag.txt") ($(cat "$E/api-image-id.txt" | cut -c1-19))"
echo "current web: $(cat "$E/web-image-tag.txt") ($(cat "$E/web-image-id.txt" | cut -c1-19))"
docker exec "$(cat "$E/api-container.txt")" sh -c 'cat /app/SOURCE_SHA 2>/dev/null || echo unknown' \
  > "$E/api-before-source.txt"
docker exec "$(cat "$E/api-container.txt")" printenv | sort > "$E/api-env-before.txt"
grep -qx 'VAYDU_CASH_RIDE_BOOKING=true' "$E/api-env-before.txt" \
  || die "VAYDU_CASH_RIDE_BOOKING is not 'true' on the running API — refusing to proceed"
grep -qx 'VAYDU_DRIVER_PAYOUT_TRANSFERS=false' "$E/api-env-before.txt" \
  || die "VAYDU_DRIVER_PAYOUT_TRANSFERS is not 'false' on the running API — refusing to proceed"

# recovery tags — refuse to clobber an existing recovery record
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
for svc in api web; do
  tag="movabi-$svc:recovery-dfff091-$STAMP"
  docker image inspect "$tag" >/dev/null 2>&1 && die "recovery tag already exists: $tag"
  docker image tag "$(cat "$E/$svc-image-id.txt")" "$tag"
  echo "$tag" > "$E/$svc-recovery-tag.txt"
done

# compose identity — read from the running containers, never guessed
docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' \
  "$(cat "$E/api-container.txt")" > "$E/compose-files.txt"
docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' \
  "$(cat "$E/api-container.txt")" > "$E/compose-workdir.txt"
docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' \
  "$(cat "$E/api-container.txt")" > "$E/compose-project.txt"
[ "$(cat "$E/compose-project.txt")" = "movabi-develop" ] || die "unexpected compose project"
IFS=',' read -r -a CFILES < "$E/compose-files.txt"
CARGS=(--project-name movabi-develop --project-directory "$(cat "$E/compose-workdir.txt")")
for f in "${CFILES[@]}"; do
  [ -f "$f" ] || die "compose file recorded by container is missing: $f"
  CARGS+=(-f "$f")
done
printf 'services:\n  api:\n    image: %s\n  web:\n    image: %s\n' \
  "$(cat "$E/api-image-id.txt")" "$(cat "$E/web-image-id.txt")" > "$E/recovery.compose.yml"
printf 'services:\n  api:\n    image: %s\n  web:\n    image: %s\n' "$API_TAG" "$WEB_TAG" \
  > "$E/candidate.compose.yml"

cat > "$E/rollback.sh" <<RB
#!/usr/bin/env bash
set -euo pipefail
cd "$(cat "$E/compose-workdir.txt")"
docker compose $(printf '%q ' "${CARGS[@]}")-f $E/recovery.compose.yml up -d --no-deps --no-build api web
docker inspect -f '{{.Config.Image}}' movabi-develop-api
curl -fsS https://movabi-api-develop.apps.evolsolution.com/health
RB
chmod +x "$E/rollback.sh"
echo "recovery tags: $(cat "$E/api-recovery-tag.txt") / $(cat "$E/web-recovery-tag.txt")"
echo "rollback:      $E/rollback.sh (or: bash $0 --rollback $E)"

step "2 backup movabi_develop (full, custom format)"
B="$E/develop-before-dfff091-$STAMP.dump"
docker exec movabi-develop-db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U supabase_admin -d movabi_develop -Fc' > "$B"
[ -s "$B" ] || die "backup is empty"
sha256sum "$B" | tee "$B.sha256"
docker exec -i movabi-develop-db pg_restore --list < "$B" | grep -c 'TABLE DATA' \
  || die "backup lists no TABLE DATA"
echo "backup: $B"

step "3 shipped restore rehearsal against that backup"
(cd "$R" && bash runbook/rehearse-restore.sh "$B" 2>&1 | tee "$E/rehearsal.log") \
  || die "rehearsal failed — see $E/rehearsal.log"
grep -q "RESTORE REHEARSAL PASSED" "$E/rehearsal.log" \
  || die "rehearsal did not report RESTORE REHEARSAL PASSED"

# NOTE: flags must be inside the sh -c string — args after -c become positional
# params, not psql flags.
DBQ() { docker exec -i movabi-develop-db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -P pager=off'; }
DBQT() { docker exec -i movabi-develop-db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -P pager=off -qAt -F"|"'; }

step "4 preflight + reviewed chain via stdin redirect"
PRE="$E/preflight.txt"
DBQT < "$R/db/preflight-schema-check.sql" > "$PRE" || die "preflight failed"
cat "$PRE"
printf '%s\n' "$PRE" | grep -qE '\|missing$|\|DEFINITION-DIFFERS$' \
  || die "preflight shows nothing to apply — is this database already at the release?"
if printf '%s\n' "$PRE" | grep -qE '^prereq/baseline\|.*\|missing$'; then
  die "baseline prerequisites missing — not the reviewed develop state; STOP"
fi
if printf '%s\n' "$PRE" | grep -qE '^prereq/collection\|.*\|missing$'; then
  die "collection prerequisites missing — no shipped file fixes them; STOP"
fi
pt="$(awk -F'|' '/^patch-target\/547\|/{print $3}' "$PRE")"
[ "$pt" = "definition-verified" ] \
  || die "patch-target/547 = '${pt:-missing}' — deployed complete_job_with_pending_payout lacks the reviewed anchor; STOP"
if printf '%s\n' "$PRE" | grep -qE '\.sql\|recorded-applied\|[1-9]'; then
  die "a recorded-applied migration has missing objects — drift; STOP"
fi

grp_state(){ grep -cE "^$1\|.*\|$2\$" "$PRE" || true; }
file_recorded(){ grep -qE "^[^|]*$1[^|]*\.sql\|recorded-applied\|" "$PRE"; }
APPLY=()
for spec in "prereq/547 db/prerequisites/20261254700000_flutterwave_payout_outbox.sql 20261254700000" \
            "prereq/548 db/prerequisites/20261254800000_flutterwave_collection_subaccounts.sql 20261254800000"; do
  grp="${spec%% *}"; rest="${spec#* }"; file="${rest%% *}"; ver="${rest##* }"
  if [ "$(grp_state "$grp" missing)" -gt 0 ]; then
    if file_recorded "$ver"; then die "drift: $ver recorded-applied but objects missing"; fi
    APPLY+=("$file")
  elif [ "$(grp_state "$grp" 'DEFINITION-DIFFERS')" -gt 0 ]; then
    die "drift: deployed $grp function has a foreign definition; STOP"
  elif grep -qE "^[^|]*$ver[^|]*\.sql\|(not-recorded|unknown)\|0$" "$PRE"; then
    die "drift: $ver objects present but unrecorded; STOP"
  else
    echo "  skip $file (verified present)"
  fi
done
while IFS= read -r mig; do
  [ -n "$mig" ] || continue
  grp="${mig:0:9}"; file="db/migrations/$mig.sql"; ver="${mig:0:14}"
  needs=0
  [ "$(grp_state "$grp" missing)" -gt 0 ] && needs=1
  [ "$(grp_state "$grp" 'DEFINITION-DIFFERS')" -gt 0 ] && needs=1
  if [ "$needs" = 1 ]; then
    if file_recorded "$ver"; then die "drift: $ver recorded-applied but needs apply"; fi
    APPLY+=("$file")
  else
    if grep -qE "^[^|]*$ver[^|]*\.sql\|not-recorded\|0$" "$PRE"; then
      die "drift: $ver objects present/verified but unrecorded"
    fi
    echo "  skip $file (verified present)"
  fi
done < <(grep -oE '^2026127[0-9]{7}_[a-z_]+' "$R/db/migrations/APPLY-ORDER.txt")
[ "${#APPLY[@]}" -gt 0 ] || die "nothing eligible to apply"
echo "apply list: ${APPLY[*]}"
printf '%s\n' "${APPLY[@]}" > "$E/applied-migrations.txt"
for f in "${APPLY[@]}"; do
  echo "-- apply $f"
  DBQ < "$R/$f" > "$E/apply-$(basename "$f").log" || die "apply failed: $f (log in evidence dir)"
done
DBQT < "$R/db/preflight-schema-check.sql" > "$E/preflight-after.txt" || die "post-preflight failed"
cat "$E/preflight-after.txt"
if grep -qE '\|missing$|\|DEFINITION-DIFFERS$' "$E/preflight-after.txt"; then
  die "post-apply preflight still reports missing/different objects"
fi

step "5 build API + web images (candidate tags, no overwrite)"
for img in "$API_TAG" "$WEB_TAG"; do
  docker image inspect "$img" >/dev/null 2>&1 && die "image tag already exists: $img — refusing to overwrite"
done
printf '%s\n' "$SRC_SHA" > "$R/api/SOURCE_SHA"
docker build -t "$API_TAG" -f "$R/api/server/Dockerfile" "$R/api" 2>&1 | tee "$E/api-build.log"
# web: build FROM the currently-deployed web image so its nginx config is
# byte-identical; only the served bundle changes.
WEB_BASE="$(cat "$E/web-image-id.txt")"
printf 'FROM %s\nRUN rm -rf /usr/share/nginx/html/*\nCOPY web/mobile/ /usr/share/nginx/html/\n' \
  "$WEB_BASE" > "$E/Dockerfile.web"
docker build -t "$WEB_TAG" -f "$E/Dockerfile.web" "$R" 2>&1 | tee "$E/web-build.log"
(cd "$R/web/mobile" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) \
  > "$E/web-expected.sha256"

step "6 deploy via candidate overlay (existing compose files untouched)"
docker compose "${CARGS[@]}" -f "$E/candidate.compose.yml" up -d --no-deps --no-build api
docker compose "${CARGS[@]}" -f "$E/candidate.compose.yml" up -d --no-deps --no-build web

step "7 verify"
img_api="$(docker inspect -f '{{.Config.Image}}' movabi-develop-api)"
[ "$img_api" = "$API_TAG" ] || die "api is not running $API_TAG (got $img_api) — rollback: $E/rollback.sh"
webc="$(docker ps --filter label=com.docker.compose.service=web --filter label=com.docker.compose.project=movabi-develop --format '{{.Names}}' | head -1)"
[ "$(docker inspect -f '{{.Config.Image}}' "$webc")" = "$WEB_TAG" ] \
  || die "web is not running $WEB_TAG — rollback: $E/rollback.sh"
src="$(docker exec movabi-develop-api cat /app/SOURCE_SHA)"
[ "$src" = "$SRC_SHA" ] || die "api SOURCE_SHA '$src' != $SRC_SHA"
docker exec movabi-develop-api printenv | sort > "$E/api-env-after.txt"
diff <(grep -E '^(VAYDU|STRIPE|KORA|FLUTTERWAVE|PAYSTACK|SUPABASE)' "$E/api-env-before.txt") \
     <(grep -E '^(VAYDU|STRIPE|KORA|FLUTTERWAVE|PAYSTACK|SUPABASE)' "$E/api-env-after.txt") \
  || die "provider/Vaydu env changed by deploy — rollback: $E/rollback.sh"
grep -qx "VAYDU_CASH_RIDE_BOOKING=$EXPECTED_API_ENV_CASH" "$E/api-env-after.txt" || die "cash flag lost"
grep -qx "VAYDU_DRIVER_PAYOUT_TRANSFERS=$EXPECTED_API_ENV_TRANSFERS" "$E/api-env-after.txt" \
  || die "payout-transfers gate changed"

curl -fsS --retry 15 --retry-connrefused --retry-delay 2 \
  https://movabi-api-develop.apps.evolsolution.com/health | tee "$E/health.json" \
  || die "health check failed — rollback: $E/rollback.sh"
curl -fsS https://movabi-api-develop.apps.evolsolution.com/api/app/version \
  | tee "$E/app-version.json" >/dev/null || die "app/version failed"
docker exec -i -w /usr/share/nginx/html "$webc" sha256sum -c --quiet < "$E/web-expected.sha256" \
  || die "served web assets do not match the packaged bundle — rollback: $E/rollback.sh"
pref="$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS \
  https://movabi-api-develop.apps.evolsolution.com/api/customer-wallet/topup-readiness \
  -H 'Origin: http://localhost:3000' -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization,content-type')"
[ "$pref" = "204" ] || die "localhost:3000 CORS preflight returned $pref"
ao="$(curl -s -X OPTIONS https://movabi-api-develop.apps.evolsolution.com/api/customer-wallet/topup-readiness \
  -H 'Origin: http://localhost:3000' -H 'Access-Control-Request-Method: GET' \
  -D - -o /dev/null | tr -d '\r' | grep -i '^access-control-allow-origin:')"
echo "$ao" | grep -qi "http://localhost:3000" || die "allow-origin header missing for localhost:3000"
docker logs --since 5m movabi-develop-api 2>&1 | grep -iE 'fatal|unhandled' \
  && die "fatal errors in api log — inspect $E and consider rollback" || true

echo
echo "DEPLOY OK: api=$API_TAG web=$WEB_TAG source=$SRC_SHA"
echo "migrations applied: $(wc -l < "$E/applied-migrations.txt") (list in evidence dir)"
echo "evidence: $E    rollback: bash $0 --rollback $E"
echo "remaining: real-browser verification from http://localhost:3000 is the user's manual step"
