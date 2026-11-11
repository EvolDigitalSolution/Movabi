#!/usr/bin/env bash
# Run on the develop host BEFORE rollout. Read-only. Records the images to roll back to and
# shows exactly which API/web files the new bundle would change versus what is running now.
# Usage: ./host-predeploy.sh vaydu-develop-<sha>-topup.tar.gz
set -euo pipefail
export LC_ALL=C
ARCHIVE="$1"; NAME="${ARCHIVE%.tar.gz}"
sha256sum -c "${ARCHIVE}.sha256"
STAMP=$(date -u +%Y%m%dT%H%M%SZ); DIR="$HOME/vaydu-topup-fix-predeploy-$STAMP"; mkdir -p "$DIR"
API=movabi-develop-api
WEB=$(docker ps --filter label=com.docker.compose.project=movabi-develop --filter label=com.docker.compose.service=web -q | head -1)
[ -n "$WEB" ] || { echo "FATAL: develop web container not found"; exit 1; }
{ echo "API_IMAGE=$(docker inspect -f '{{.Config.Image}}' $API)"; echo "API_IMAGE_ID=$(docker inspect -f '{{.Image}}' $API)";
  echo "WEB_CONTAINER=$WEB"; echo "WEB_IMAGE=$(docker inspect -f '{{.Config.Image}}' $WEB)"; echo "WEB_IMAGE_ID=$(docker inspect -f '{{.Image}}' $WEB)";
  echo "CONFIG_FILES=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' $API)"; } | tee "$DIR/previous.env"
cp "$HOME/vaydu-develop-overrides/release-override.yml" "$DIR/release-override.yml.before" 2>/dev/null || true
mkdir -p "$DIR/bundle" && tar -xzf "$ARCHIVE" -C "$DIR/bundle"
(cd "$DIR/bundle/$NAME" && sha256sum -c --quiet SHA256SUMS && sha256sum -c --quiet ALL_SHA256SUMS && echo "bundle checksums OK")
# Running API source vs bundle: every path the API image is built from (make-bundle.sh PATHS).
# A path missing on one side shows up as ADDED/REMOVED rather than aborting the check.
# Hashes ignore CR bytes: earlier bundles built on Windows may hold CRLF copies of LF sources, and a
# line-ending-only difference is not a code change.
API_PATHS='server src/app/shared deploy/vaydu-payment-account-setup/api package.json package-lock.json'
LIST='for p in '"$API_PATHS"'; do [ -e "$p" ] && find "$p" -type f; done | sort | while IFS= read -r f; do printf "%s  %s\n" "$(tr -d "\r" < "$f" | sha256sum | cut -d" " -f1)" "$f"; done'
docker exec $API sh -c "cd /app && $LIST" | sort -k2 > "$DIR/running-api.sha"
(cd "$DIR/bundle/$NAME" && sh -c "$LIST" | sort -k2) > "$DIR/bundle-api.sha"
echo "running API files hashed: $(wc -l < "$DIR/running-api.sha")   bundle API files: $(wc -l < "$DIR/bundle-api.sha")"
docker exec $API sh -c 'cat /app/SOURCE_SHA 2>/dev/null' > "$DIR/running-source-sha.txt" || true
RUNNING_SHA=$(tr -d '[:space:]' < "$DIR/running-source-sha.txt" 2>/dev/null || true)
echo "running API SOURCE_SHA (if its bundle shipped one): ${RUNNING_SHA:-unknown}"
join -1 2 -2 2 -a1 -a2 -e MISSING -o 0,1.1,2.1 "$DIR/running-api.sha" "$DIR/bundle-api.sha" | awk '$2!=$3{print $1, ($2=="MISSING"?"ADDED":($3=="MISSING"?"REMOVED":"CHANGED"))}' > "$DIR/api-changes.txt"
echo "== API files that would change ($DIR/api-changes.txt):"; cat "$DIR/api-changes.txt"
echo "Expected (fix only): server/routes/driver-wallet-topup.routes.ts, server/services/payments/{driver-card-topup-contracts,driver-wallet-topup,stripe-driver-topup-sandbox}.ts,"
echo "  src/app/shared/ui/driver-wallet-topup.component.ts, src/app/shared/utils/driver-topup-verify-outcome.ts (ADDED)."
echo "Fix base is the running release-2385da7 (2385da7). Anything else (including any ADDED deploy/vaydu-payment-account-setup/api file)"
echo "  means the running API is not 2385da7: STOP and review before deploying."
echo "Saved to $DIR"
