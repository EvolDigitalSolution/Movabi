#!/usr/bin/env bash
# App-only deployment: API + Mobile + Admin, no database migrations.
# Verifies the required schema objects exist on shared develop before deploy —
# the inspection migrations must already be applied (see rollout-inspection-*).
set -euo pipefail

SRC_SHA="6b8966eb690c75cddb8064cd1c30e465cb77e75c"
API_ARCHIVE="vaydu-api-6b8966e.tar.gz"
MOBILE_ARCHIVE="vaydu-web-6b8966e.tar.gz"
ADMIN_ARCHIVE="vaydu-admin-6b8966e.tar.gz"
API_BUNDLE="vr-api"; WEB_BUNDLE="vr-web"; ADMIN_BUNDLE="vr-admin"
DB_CONTAINER="movabi-develop-db"; DB_NAME="movabi_develop"
ADMIN_HTML="/srv/movabi/develop-admin/html"; ADMIN_CONTAINER="movabi-develop-admin"
API_CONTAINER="movabi-develop-api"; WEB_CONTAINER="movabi-develop-web"
STAMP="$(date +%Y%m%d%H%M%S)"
die(){ echo "FATAL: $*" >&2; exit 1; }

echo "== 1/6 checksum + extraction =="
for pair in "api:$API_ARCHIVE:$API_BUNDLE" "web:$MOBILE_ARCHIVE:$WEB_BUNDLE" "admin:$ADMIN_ARCHIVE:$ADMIN_BUNDLE"; do
  IFS=: read -r k A B <<<"$pair"
  [ -f "$A" ] || die "missing $A"
  sha256sum -c "${A}.sha256" || die "checksum fail $A"
  rm -rf "$B" && mkdir "$B.tmp"
  tar xzf "$A" -C "$B.tmp" && mv "$B.tmp/$B" "$B" && rm -rf "$B.tmp" || die "extract fail $A"
  (cd "$B" && sha256sum -c SHA256SUMS >/dev/null && [ "$(cat SOURCE_SHA)" = "$SRC_SHA" ]) || die "manifest fail $k"
  echo "  $k verified"
done

echo "== 2/6 schema verification (no migration replay) =="
docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
do $$
begin
  -- inspection objects must already exist
  perform 1 from information_schema.columns where table_name='driver_vehicle_inspection_photos' and column_name='vehicle_revision';
  if not found then raise exception 'driver_vehicle_inspection_photos.vehicle_revision missing'; end if;
  perform 1 from information_schema.columns where table_name='profiles' and column_name='currency_code';
  if not found then raise exception 'profiles.currency_code missing'; end if;
  perform 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='submit_inspection_photo' and p.pronargs=7;
  if not found then raise exception 'submit_inspection_photo overload missing'; end if;
end$$;
SQL
echo "  schema verified"

echo "== 3/6 pre-flight =="
docker inspect "$DB_CONTAINER" "$API_CONTAINER" "$WEB_CONTAINER" "$ADMIN_CONTAINER" >/dev/null 2>&1 || die "containers missing"
[ -d "$ADMIN_HTML" ] || die "admin html dir missing"

echo "== 4/6 backups =="
docker ps --format '{{.Names}} {{.Image}}' > "$HOME/pre-app-images-$STAMP.txt"
cp -r "$ADMIN_HTML" "${ADMIN_HTML}.bak-$STAMP"
echo "  images + admin files captured"

echo "== 5/6 app switch =="
EXPECTED_SOURCE_SHA="$SRC_SHA" ARCHIVE="$API_ARCHIVE" BUNDLE_DIR="$API_BUNDLE" \
  API_TAG="release-${SRC_SHA:0:7}" bash "$HOME/rollout-develop-52097ef.sh" --deploy-api-only
EXPECTED_SOURCE_SHA="$SRC_SHA" ARCHIVE="$MOBILE_ARCHIVE" BUNDLE_DIR="$WEB_BUNDLE" \
  WEB_TAG="release-${SRC_SHA:0:7}" bash "$HOME/rollout-develop-52097ef.sh" --deploy-web-only
mkdir -p "$HOME/admin-stage-$STAMP" && cp -rf "$ADMIN_BUNDLE/browser/." "$HOME/admin-stage-$STAMP/"
rsync -a --delete --dry-run "$HOME/admin-stage-$STAMP/" "$ADMIN_HTML/" | head
read -r -p "Switch Admin files? [y/N] " ok
[ "$ok" = "y" ] || { echo "Skipped Admin switch."; exit 0; }
rsync -a --delete "$HOME/admin-stage-$STAMP/" "$ADMIN_HTML/"
docker restart "$ADMIN_CONTAINER"

echo "== 6/6 verify =="
curl -sS -o /dev/null -w 'API health: %{http_code}\n' https://movabi-api-develop.apps.evolsolution.com/health
echo "DONE $STAMP"
