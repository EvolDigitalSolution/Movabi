#!/usr/bin/env bash
# Coordinated rollout: API + Mobile + Admin + 3 inspection migrations for e026d20.
# ALL verification, staging, backup and confirmation run BEFORE any DB or app
# change. Database: movabi-develop-db / movabi_develop. Fail-fast throughout.
set -euo pipefail

SRC_SHA="e026d204c35604c7b7e0f5577b0e931ae8d62c2c"
API_ARCHIVE="vaydu-api-e026d20.tar.gz"
MOBILE_ARCHIVE="vaydu-web-e026d20.tar.gz"
ADMIN_ARCHIVE="vaydu-admin-e026d20.tar.gz"
API_BUNDLE="vr-api"; WEB_BUNDLE="vr-web"; ADMIN_BUNDLE="vr-admin"
DB_CONTAINER="movabi-develop-db"; DB_NAME="movabi_develop"
ADMIN_HTML="/srv/movabi/develop-admin/html"
ADMIN_CONTAINER="movabi-develop-admin"
API_CONTAINER="movabi-develop-api"; WEB_CONTAINER="movabi-develop-web"
STAMP="$(date +%Y%m%d%H%M%S)"
die() { echo "FATAL: $*" >&2; exit 1; }

echo "== 1/8 checksum + extraction =="
for pair in "api:$API_ARCHIVE:$API_BUNDLE" "web:$MOBILE_ARCHIVE:$WEB_BUNDLE" "admin:$ADMIN_ARCHIVE:$ADMIN_BUNDLE"; do
  IFS=: read -r k A B <<<"$pair"
  [ -f "$A" ] || die "missing $A"
  sha256sum -c "${A}.sha256" || die "checksum fail $A"
  rm -rf "$B" && mkdir "$B.tmp"
  tar xzf "$A" -C "$B.tmp" && mv "$B.tmp/$B" "$B" && rm -rf "$B.tmp" || die "extract fail $A"
  (cd "$B" && sha256sum -c SHA256SUMS >/dev/null && [ "$(cat SOURCE_SHA)" = "$SRC_SHA" ]) \
    || die "manifest/SOURCE_SHA fail $k"
  echo "  $k verified"
done

echo "== 2/8 layout vs rollout script =="
[ -f "$API_BUNDLE/server/index.ts" ]                                          || die "api bundle missing server/index.ts"
[ -f "$API_BUNDLE/supabase/migrations/20261265000000_driver_submission_authority.sql" ] || die "missing migration 1"
[ -f "$API_BUNDLE/supabase/migrations/20261265100000_driver_inspection_photos.sql" ]    || die "missing migration 2"
[ -f "$API_BUNDLE/supabase/migrations/20261265200000_driver_inspection_repair.sql" ]    || die "missing repair migration"
[ -d "$WEB_BUNDLE/mobile/browser" ]                                           || die "web bundle missing mobile/browser"
[ -d "$ADMIN_BUNDLE/browser" ]                                                || die "admin bundle missing browser"
echo "  layouts OK"

echo "== 3/8 host pre-flight =="
docker inspect "$DB_CONTAINER" "$API_CONTAINER" "$WEB_CONTAINER" "$ADMIN_CONTAINER" >/dev/null 2>&1 \
  || die "one or more containers missing"
[ -d "$ADMIN_HTML" ] || die "admin html dir missing: $ADMIN_HTML"
echo "  host OK"

echo "== 4/8 backups + dump verification =="
docker ps --format '{{.Names}} {{.Image}}' > "$HOME/pre-insp-images-$STAMP.txt"
docker exec "$DB_CONTAINER" pg_dump -U supabase_admin -Fc -d "$DB_NAME" \
  > "$HOME/pre-insp-$STAMP.dump" || die "DB backup failed"
docker exec -i "$DB_CONTAINER" sh -c 'cat > /tmp/pre-insp-verify.dump' < "$HOME/pre-insp-$STAMP.dump" \
  && docker exec "$DB_CONTAINER" pg_restore --list /tmp/pre-insp-verify.dump >/dev/null \
  || die "pg_restore --list cannot read the dump"
cp -r "$ADMIN_HTML" "${ADMIN_HTML}.bak-$STAMP" || die "admin file backup failed"
echo "  backups verified"

echo "== 5/8 capture original definitions (fail if capture breaks) =="
for fn in register_driver_inspection_photo submit_driver_with_current_inspection \
          submit_inspection_photo protect_inspection_tenant rotate_vehicle_inspection_revision; do
  docker exec "$DB_CONTAINER" psql -U supabase_admin -d "$DB_NAME" -At \
    -c "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='$fn'" \
    >> "$HOME/pre-insp-functions-$STAMP.sql" || die "function capture failed: $fn"
done
docker exec "$DB_CONTAINER" psql -U supabase_admin -d "$DB_NAME" -At \
  -c "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname IN
        ('protect_inspection_tenant','rotate_vehicle_inspection_revision')" \
  >> "$HOME/pre-insp-triggers-$STAMP.sql" || die "trigger capture failed"
echo "  definitions captured"

echo "== 6/8 Admin staged + verified =="
mkdir -p "$HOME/admin-stage-$STAMP"
cp -rf "$ADMIN_BUNDLE/browser/." "$HOME/admin-stage-$STAMP/"
[ -f "$HOME/admin-stage-$STAMP/index.html" ] || die "admin stage missing index.html"
echo "  admin staged"

echo "== 7/8 pre-change confirmation =="
echo "Will apply 3 migrations + switch API/Mobile/Admin to $SRC_SHA."
echo "Rollback assets: ~/pre-insp-$STAMP.dump · ~/pre-insp-images-$STAMP.txt"
echo "                 ~/pre-insp-functions-$STAMP.sql · ~/pre-insp-triggers-$STAMP.sql"
echo "                 ${ADMIN_HTML}.bak-$STAMP"
read -r -p "Proceed? [y/N] " ok
[ "$ok" = "y" ] || { echo "Aborted before any change."; exit 0; }

echo "== 8/8 migrations + app switch =="
docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  < "$API_BUNDLE/supabase/migrations/20261265000000_driver_submission_authority.sql"
docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  < "$API_BUNDLE/supabase/migrations/20261265100000_driver_inspection_photos.sql"
docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  < "$API_BUNDLE/supabase/migrations/20261265200000_driver_inspection_repair.sql"
EXPECTED_SOURCE_SHA="$SRC_SHA" ARCHIVE="$API_ARCHIVE" BUNDLE_DIR="$API_BUNDLE" \
  API_TAG="release-${SRC_SHA:0:7}" bash "$HOME/rollout-develop-52097ef.sh" --deploy-api-only
EXPECTED_SOURCE_SHA="$SRC_SHA" ARCHIVE="$MOBILE_ARCHIVE" BUNDLE_DIR="$WEB_BUNDLE" \
  WEB_TAG="release-${SRC_SHA:0:7}" bash "$HOME/rollout-develop-52097ef.sh" --deploy-web-only
rsync -a --delete "$HOME/admin-stage-$STAMP/" "$ADMIN_HTML/"
docker restart "$ADMIN_CONTAINER"

echo "DONE $STAMP — verify:"
echo "  curl -sS -o /dev/null -w '%{http_code}\\n' https://movabi-api-develop.apps.evolsolution.com/health"
echo "  docker inspect $API_CONTAINER --format '{{.Config.Image}}'"

# --- compatibility rollback (objects + data preserved) ---
# App images: re-point compose to tags in ~/pre-insp-images-$STAMP.txt
# Admin files: rsync -a --delete ${ADMIN_HTML}.bak-$STAMP/ $ADMIN_HTML/ ; docker restart $ADMIN_CONTAINER
# Functions/triggers only: docker exec -i movabi-develop-db psql -U supabase_admin -d movabi_develop \
#   < ~/pre-insp-functions-$STAMP.sql  (and pre-insp-triggers-$STAMP.sql)
# Pre-existing columns/data untouched — no drops.
