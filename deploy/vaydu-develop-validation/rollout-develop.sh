#!/usr/bin/env bash
# Develop rollout for the frozen release vaydu-develop-35b2590.
#
# The 39 migrations are ALREADY applied. This script's default path applies
# migrations, but `--resume-app` is the application-only resume: it validates the
# archive and DB state, records current containers/images, builds the release
# images, and recreates ONLY web+api (+ the separate develop Admin) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â it never
# replays migrations and never recreates Supabase.
#
# The preserved Compose overrides resolve to image-only services. This script
# generates a final develop-only release override that selects the validated
# build contexts/Dockerfiles and unique release image tags for API/web.
set -euo pipefail

PREFLIGHT_ONLY=0
RESUME_APP=0
DEPLOY_API_ONLY=0
DEPLOY_WEB_ONLY=0
SELF_CHECK=0
for a in "$@"; do
  case "$a" in
    --preflight|-p) PREFLIGHT_ONLY=1 ;;
    --resume-app|-r) RESUME_APP=1 ;;
    --deploy-api-only|-a) DEPLOY_API_ONLY=1 ;;
    --deploy-web-only|-w) DEPLOY_WEB_ONLY=1 ;;
    --self-check) SELF_CHECK=1 ;;
  esac
done

API_CONTAINER="movabi-develop-api"
DB_CONTAINER="movabi-develop-db"
ADMIN_CONTAINER="${ADMIN_CONTAINER:-}"
ADMIN_HOSTNAME="movabi-admin-develop.apps.evolsolution.com"
ADMIN_PREPARE_DIR="/srv/movabi/develop-admin"
ARCHIVE="vaydu-develop-35b2590-r5.tar.gz"
ARCHIVE_SHA256="b7474acec5c935ed51d783678a6e5c1b5284d79f1977c7ca28337e952efbe315"
BUNDLE_DIR="vaydu-develop-35b2590"
API_TAG="release-35b2590-r3"       # API unchanged since r3 (payment-account isolation)
WEB_TAG="release-35b2590-r5"       # frontends rebuilt (map + wallet fixes)
RELEASE_ROOT="${HOME}/vaydu-develop-35b2590-release"   # extraction (deleted + recreated)
BACKUP_ROOT="${HOME}/vaydu-develop-backups"             # backups (NEVER deleted)
OVERRIDE_DIR="${HOME}/vaydu-develop-overrides"          # persistent, outside cleanup dirs
OVERRIDE="$OVERRIDE_DIR/release-override.yml"

log(){ printf '\n== %s ==\n' "$*"; }
fail(){ echo "FATAL: $*" >&2; exit 1; }

# Resolve the operational compose files from the container's config_files label.
# Drops ONLY the script-generated release-override.yml (by basename); any OTHER
# missing file is fatal. Echoes the surviving comma-separated list on stdout.
resolve_compose_config() {
  local raw="$1" f list="" base
  IFS=',' read -r -a arr <<< "$raw"
  for f in "${arr[@]}"; do
    [ -n "$f" ] || continue
    base="$(basename "$f")"
    if [ "$base" = "release-override.yml" ]; then
      echo "ignoring generated release override: $f" >&2
      continue
    fi
    if [ ! -f "$f" ]; then
      echo "FATAL: operational compose file missing: $f" >&2
      return 1
    fi
    list="${list:+$list,}$f"
  done
  echo "$list"
}

# Regression check for the missing generated override (does not touch Docker).
if [ "$SELF_CHECK" = "1" ]; then
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  touch "$TMP/compose.yml" "$TMP/override.yml"
  # Case 1: a missing generated release-override.yml is dropped; valid files kept.
  got=$(resolve_compose_config "missing:/does/not/exist/release-override.yml,$TMP/compose.yml,$TMP/override.yml") \
    || { echo "SELF_CHECK_FAIL: case1 returned nonzero"; exit 1; }
  [ "$got" = "$TMP/compose.yml,$TMP/override.yml" ] \
    || { echo "SELF_CHECK_FAIL: case1 got '$got'"; exit 1; }
  # Case 2: a missing NON-override file must be fatal (not silently dropped).
  if resolve_compose_config "missing:/does/not/exist/operational.yml,$TMP/compose.yml" >/dev/null 2>&1; then
    echo "SELF_CHECK_FAIL: case2 did not fail on missing operational file"; exit 1
  fi
  echo "SELF_CHECK_OK"
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. API container + Compose chain (REQUIRED identity, no fallback)
# ---------------------------------------------------------------------------
docker inspect "$API_CONTAINER" >/dev/null 2>&1 || fail "API container '$API_CONTAINER' not found"
PROJECT=$(docker inspect "$API_CONTAINER" --format '{{ index .Config.Labels "com.docker.compose.project" }}')
WORKDIR=$(docker inspect "$API_CONTAINER" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}')
CONFIG_FILES=$(docker inspect "$API_CONTAINER" --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}')
[ "$PROJECT"  = "movabi-develop"     ] || fail "Compose project is '$PROJECT', expected 'movabi-develop'"
[ "$WORKDIR"   = "/srv/movabi/develop" ] || fail "Compose working dir is '$WORKDIR', expected '/srv/movabi/develop'"
[ -n "$CONFIG_FILES" ] || fail "no config_files label on $API_CONTAINER"
CFG_RESOLVED=$(resolve_compose_config "$CONFIG_FILES") || fail "failed to resolve compose chain"
IFS=',' read -r -a CFG_ARRAY <<< "$CFG_RESOLVED"
COMPOSE_ARGS=()
for f in "${CFG_ARRAY[@]}"; do COMPOSE_ARGS+=(-f "$f"); done
SERVICES=$(cd "$WORKDIR" && docker compose "${COMPOSE_ARGS[@]}" config --services)
WEB_CONTAINER=$(cd "$WORKDIR" && docker compose "${COMPOSE_ARGS[@]}" ps -q web 2>/dev/null | head -1 || true)

# ---------------------------------------------------------------------------
# 2. Database (OUTSIDE the Compose chain) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â resolve, verify, validate identity
# ---------------------------------------------------------------------------
docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || fail "DB container '$DB_CONTAINER' not found"
DB_PASSWORD=$(docker inspect "$DB_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)
[ -n "$DB_PASSWORD" ] || fail "no POSTGRES_PASSWORD in $DB_CONTAINER env"
db_psql(){ docker exec -e PGPASSWORD="$DB_PASSWORD" "$DB_CONTAINER" psql -U supabase_admin -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"; }

DB_NAME=""
if docker exec -e PGPASSWORD="$DB_PASSWORD" "$DB_CONTAINER" psql -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='movabi_develop'" 2>/dev/null | grep -q 1; then
  DB_NAME="movabi_develop"
fi
[ -n "$DB_NAME" ] || fail "database 'movabi_develop' not found in $DB_CONTAINER"

DB_NETWORK=$(docker inspect "$DB_CONTAINER" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr -s ' ')
DB_VOLUMES=$(docker inspect "$DB_CONTAINER" --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' | tr -s ' ')
echo "$DB_NETWORK" | grep -qi 'develop' || fail "DB network '$DB_NETWORK' has no 'develop' identity"
echo "$DB_VOLUMES" | grep -qi 'develop' || fail "DB volume(s) '$DB_VOLUMES' have no 'develop' identity"

# ---------------------------------------------------------------------------
# 3. Admin ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â separate, DEVELOP-ONLY chain (never movabi-admin / current)
# ---------------------------------------------------------------------------
ADMIN_RESOLVED=""
ADMIN_PROJECT=""; ADMIN_WORKDIR=""; ADMIN_CONFIG_FILES=""
ADMIN_PREPARE_NEEDED=0

if [ -z "$ADMIN_CONTAINER" ]; then
  for c in $(docker ps --format '{{.Names}}' | grep -Ei 'admin'); do
    p=$(docker inspect "$c" --format '{{ index .Config.Labels "com.docker.compose.project" }}' 2>/dev/null || true)
    w=$(docker inspect "$c" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' 2>/dev/null || true)
    if printf '%s %s\n' "$p" "$w" | grep -Eqi 'develop'; then
      ADMIN_CONTAINER="$c"; break
    fi
  done
fi

if [ -n "$ADMIN_CONTAINER" ]; then
  docker inspect "$ADMIN_CONTAINER" >/dev/null 2>&1 || fail "admin container '$ADMIN_CONTAINER' not found"
  ADMIN_PROJECT=$(docker inspect "$ADMIN_CONTAINER" --format '{{ index .Config.Labels "com.docker.compose.project" }}')
  ADMIN_WORKDIR=$(docker inspect "$ADMIN_CONTAINER" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}')
  ADMIN_CONFIG_FILES=$(docker inspect "$ADMIN_CONTAINER" --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}')
  [ "$ADMIN_CONTAINER" != "movabi-admin" ] || fail "refusing production admin container 'movabi-admin'"
  echo "$ADMIN_PROJECT" | grep -qi 'develop' || fail "admin project '$ADMIN_PROJECT' is not develop"
  echo "$ADMIN_WORKDIR" | grep -qi 'develop' || fail "admin workdir '$ADMIN_WORKDIR' is not develop"
  echo "$ADMIN_PROJECT" | grep -qi 'current' && fail "refusing 'current' admin project '$ADMIN_PROJECT'"
  echo "$ADMIN_WORKDIR" | grep -qi 'current' && fail "refusing 'current' admin workdir '$ADMIN_WORKDIR'"
  IFS=',' read -r -a ADMIN_CFG_ARRAY <<< "$ADMIN_CONFIG_FILES"
  ADMIN_COMPOSE_ARGS=()
  for f in "${ADMIN_CFG_ARRAY[@]}"; do ADMIN_COMPOSE_ARGS+=(-f "$f"); done
  ADMIN_RESOLVED="$ADMIN_CONTAINER (project=$ADMIN_PROJECT workdir=$ADMIN_WORKDIR files=${ADMIN_CFG_ARRAY[*]})"
else
  ADMIN_PREPARE_NEEDED=1
fi

# ---------------------------------------------------------------------------
# 4. Mount check ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a bind/volume over the app path hides the new build.
# ---------------------------------------------------------------------------
API_MOUNTS=$(docker inspect "$API_CONTAINER" --format '{{range .Mounts}}{{.Destination}} {{end}}' 2>/dev/null || true)
WEB_MOUNTS=$(docker inspect "${WEB_CONTAINER:-}" --format '{{range .Mounts}}{{.Destination}} {{end}}' 2>/dev/null || true)
echo "$API_MOUNTS" | grep -qE '(^| )/app( |$)' && fail "API mounts '$API_MOUNTS' hide the new /app build"
echo "$WEB_MOUNTS" | grep -qE '(^| )/usr/share/nginx/html( |$)' && fail "web mounts '$WEB_MOUNTS' hide the new /usr/share/nginx/html build"

# ---------------------------------------------------------------------------
# 5. Preflight report (read-only)
# ---------------------------------------------------------------------------
log "Preflight"
echo "Mode:             $([ "$DEPLOY_API_ONLY" = "1" ] && echo api-only || { [ "$DEPLOY_WEB_ONLY" = "1" ] && echo web-only || { [ "$RESUME_APP" = "1" ] && echo resume-app || echo full-rollout; }; })"
echo "API container:    $API_CONTAINER"
echo "Web container:    ${WEB_CONTAINER:-<not running>}"
echo "Compose project:  $PROJECT   workdir: $WORKDIR"
echo "Compose files:    ${CFG_ARRAY[*]}"
echo "Compose services: $(echo $SERVICES | tr '\n' ' ')"
echo "DB container:     $DB_CONTAINER   db: $DB_NAME"
echo "DB network:       $DB_NETWORK"
echo "DB volumes:       $DB_VOLUMES"
echo "Migration user:   supabase_admin (credential stays inside the container)"
echo "Admin:            $([ "$ADMIN_PREPARE_NEEDED" = "1" ] && echo "NOT FOUND ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â prepare movabi-develop-admin @ $ADMIN_HOSTNAME" || echo "$ADMIN_RESOLVED")"
echo "Release override: $OVERRIDE (api tag movabi-api:$API_TAG, web tag movabi-web:$WEB_TAG)"
echo "API build inputs: server/ + src/app/shared/ + deploy/vaydu-payment-account-setup/api/ + package.json + package-lock.json (validated)"
echo "Web build inputs: mobile/browser/ (validated) + generated Dockerfile + default.conf"
echo "Archive:          $ARCHIVE ($ARCHIVE_SHA256)"
echo "Release root:     $RELEASE_ROOT"
echo "Backup root:      $BACKUP_ROOT"
if [ "$PREFLIGHT_ONLY" = "1" ]; then
  echo "PREFLIGHT_ONLY: resolved targets reported; exiting before backup/migration/deployment."
  exit 0
fi

# ---------------------------------------------------------------------------
# 6. Validate archive + all-file checksums, then stage the web build inputs.
# ---------------------------------------------------------------------------
log "Validating archive"
echo "$ARCHIVE_SHA256  $ARCHIVE" | sha256sum -c -
rm -rf "$RELEASE_ROOT"; mkdir -p "$RELEASE_ROOT"
tar -xzf "$ARCHIVE" -C "$RELEASE_ROOT"
BUNDLE="$RELEASE_ROOT/$BUNDLE_DIR"
(cd "$BUNDLE" && sha256sum -c SHA256SUMS && sha256sum -c ALL_SHA256SUMS)

# The bundle ships the pre-built mobile/browser (validated) but not the web
# Dockerfile/nginx config. Generate those into the extracted bundle so the web
# build context is complete and self-contained (no archive rebuild required).
mkdir -p "$BUNDLE/docker/frontend"
cat > "$BUNDLE/docker/frontend/Dockerfile.serve" <<'DOCKERFILE'
FROM nginx:stable-alpine
RUN rm -rf /usr/share/nginx/html/*
COPY mobile/browser /usr/share/nginx/html
COPY docker/frontend/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
DOCKERFILE
cat > "$BUNDLE/docker/frontend/default.conf" <<'NGINX'
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;
  location = /index.html { add_header Cache-Control "no-store, no-cache, must-revalidate"; }
  location / { try_files $uri $uri/ /index.html; add_header Cache-Control "no-store, no-cache, must-revalidate"; }
  location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|map)$ { try_files $uri =404; expires 30d; add_header Cache-Control "public, immutable"; }
}
NGINX

# Final develop-only release override: image-only services gain explicit
# validated build contexts/Dockerfiles and unique release image tags.
# Stored OUTSIDE the extraction/cleanup dir so the running container's
# config_files label never points at a deleted file.
mkdir -p "$OVERRIDE_DIR"
cat > "$OVERRIDE" <<YAML
services:
  api:
    image: movabi-api:$API_TAG
    build:
      context: $BUNDLE
      dockerfile: server/Dockerfile
  web:
    image: movabi-web:$WEB_TAG
    build:
      context: $BUNDLE
      dockerfile: docker/frontend/Dockerfile.serve
YAML

# ---------------------------------------------------------------------------
# 7. DB state / migration handling
# ---------------------------------------------------------------------------
if [ "$RESUME_APP" = "1" ] || [ "$DEPLOY_API_ONLY" = "1" ] || [ "$DEPLOY_WEB_ONLY" = "1" ]; then
  log "Verify database state (migrations already applied; no replay)"
  docker cp "$BUNDLE/VERIFY.sql" "$DB_CONTAINER":/tmp/VERIFY.sql
  db_psql -q -f /tmp/VERIFY.sql
else
  log "Backup + migrate"
  mkdir -p "$BACKUP_ROOT"
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  BACKUP="$BACKUP_ROOT/develop-before-$STAMP.dump"
  docker exec "$DB_CONTAINER" pg_dump -U postgres -d "$DB_NAME" -Fc > "$BACKUP"
  docker exec -i "$DB_CONTAINER" pg_restore --list < "$BACKUP" | grep -c 'TABLE DATA' >/dev/null \
    && echo "backup verified (container pg_restore): $BACKUP"

  docker cp "$BUNDLE/PREREQ.sql" "$DB_CONTAINER":/tmp/PREREQ.sql
  db_psql -q -f /tmp/PREREQ.sql
  while read -r step; do
    [ -n "$step" ] || continue
    stepfile="$(basename "$step")"
    docker cp "$BUNDLE/migrations/$stepfile" "$DB_CONTAINER":/tmp/"$stepfile"
    db_psql -q -f /tmp/"$stepfile" || fail "migration failed at $step"
    echo "applied $step"
  done < "$BUNDLE/ORDER.txt"
  docker cp "$BUNDLE/VERIFY.sql" "$DB_CONTAINER":/tmp/VERIFY.sql
  db_psql -q -f /tmp/VERIFY.sql
fi

# ---------------------------------------------------------------------------
# 8. Record images, build release images, recreate ONLY web+api (+ Admin)
# ---------------------------------------------------------------------------
log "Recording current images"
for s in $SERVICES; do
  docker compose "${COMPOSE_ARGS[@]}" images "$s" --format '{{.Repository}}:{{.Tag}} {{.ID}}' >> "$RELEASE_ROOT/previous-images.txt" 2>/dev/null || true
done

log "Building release image(s) (validated contexts + unique tags)"
cd "$WORKDIR"
if [ "$DEPLOY_API_ONLY" = "1" ]; then
  docker compose "${COMPOSE_ARGS[@]}" -f "$OVERRIDE" build api
  log "Recreating the API service only (no web rebuild, no Supabase)"
  docker compose "${COMPOSE_ARGS[@]}" -f "$OVERRIDE" up -d --no-deps api
elif [ "$DEPLOY_WEB_ONLY" = "1" ]; then
  docker compose "${COMPOSE_ARGS[@]}" -f "$OVERRIDE" build web
  log "Recreating the web service only (API and Supabase preserved)"
  docker compose "${COMPOSE_ARGS[@]}" -f "$OVERRIDE" up -d --no-deps web
else
  docker compose "${COMPOSE_ARGS[@]}" -f "$OVERRIDE" build api web
  log "Recreating application services only (web + api; no Supabase)"
  docker compose "${COMPOSE_ARGS[@]}" -f "$OVERRIDE" up -d --no-deps web api
fi

# ---------------------------------------------------------------------------
# 9. Admin ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â deploy the existing develop Admin, or prepare a distinct one.
# ---------------------------------------------------------------------------
if [ -n "$ADMIN_RESOLVED" ]; then
  log "Deploying develop Admin ($ADMIN_RESOLVED)"
  mkdir -p "$ADMIN_WORKDIR/dist/admin"
  cp -a "$BUNDLE/admin/." "$ADMIN_WORKDIR/dist/admin/"
  (cd "$ADMIN_WORKDIR" && docker compose "${ADMIN_COMPOSE_ARGS[@]}" build && docker compose "${ADMIN_COMPOSE_ARGS[@]}" up -d)
else
  log "Preparing a distinct develop-only Admin service"
  mkdir -p "$ADMIN_PREPARE_DIR/html"
  cp -a "$BUNDLE/admin/browser/." "$ADMIN_PREPARE_DIR/html/"
  cat > "$ADMIN_PREPARE_DIR/nginx.conf" <<'NGINX'
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;
  location / { try_files $uri $uri/ /index.html; }
}
NGINX
  cat > "$ADMIN_PREPARE_DIR/docker-compose.yml" <<'YAML'
services:
  admin:
    image: nginx:1.27-alpine
    container_name: movabi-develop-admin
    restart: unless-stopped
    environment:
      VIRTUAL_HOST: movabi-admin-develop.apps.evolsolution.com
      LETSENCRYPT_HOST: movabi-admin-develop.apps.evolsolution.com
      LETSENCRYPT_EMAIL: ${LETSENCRYPT_EMAIL:-ops@movabi.apps.evolsolution.com}
      VIRTUAL_PORT: "80"
    volumes:
      - ./html:/usr/share/nginx/html:ro
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    networks:
      - web
    labels:
      com.docker.compose.project: movabi-develop-admin
      com.docker.compose.project.working_dir: /srv/movabi/develop-admin
networks:
  web:
    external: true
    name: web
YAML
  (cd "$ADMIN_PREPARE_DIR" && docker compose up -d)
fi

log "Rollout applied"
echo "Previous image IDs: $RELEASE_ROOT/previous-images.txt"
[ -n "${BACKUP:-}" ] && echo "Backup:             $BACKUP"
echo "Recovery:"
echo "  application rollback -> docker compose ${COMPOSE_ARGS[*]} up -d (previous tags) WITHOUT touching the schema."
echo "  database restore (disaster only, never auto-rollback) -> pg_restore -d <drill_db> <backup> ; never erase live traffic."
