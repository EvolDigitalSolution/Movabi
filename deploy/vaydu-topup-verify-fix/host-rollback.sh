#!/usr/bin/env bash
# Application rollback for the top-up fix. No schema change was shipped, so none is reverted.
# Usage: ./host-rollback.sh ~/vaydu-topup-fix-predeploy-<stamp> [api|web|both]
set -euo pipefail
export LC_ALL=C
DIR="$1"; WHAT="${2:-both}"
case "$WHAT" in api|web|both) ;; *) echo "FATAL: second argument must be api, web or both"; exit 1 ;; esac
source "$DIR/previous.env"
WORKDIR=/srv/movabi/develop
OVR="$HOME/vaydu-develop-overrides/release-override.yml"; WALLET="$HOME/vaydu-develop-overrides/docker-compose.develop-wallet.override.yml"
ARGS=(); IFS=',' read -r -a FILES <<< "$CONFIG_FILES"
for f in "${FILES[@]}"; do [ "$(basename "$f")" = release-override.yml ] && continue; [ "$(basename "$f")" = "$(basename "$WALLET")" ] && continue; ARGS+=(-f "$f"); done

# 1. Checks first, before anything is written: the recorded tags of the service(s) being
#    rolled back must still resolve to the recorded image IDs.
if [ "$WHAT" != web ]; then [ "$(docker image inspect -f '{{.Id}}' "$API_IMAGE")" = "$API_IMAGE_ID" ] || { echo "FATAL: $API_IMAGE no longer points at $API_IMAGE_ID; docker tag $API_IMAGE_ID $API_IMAGE first"; exit 1; }; fi
if [ "$WHAT" != api ]; then [ "$(docker image inspect -f '{{.Id}}' "$WEB_IMAGE")" = "$WEB_IMAGE_ID" ] || { echo "FATAL: $WEB_IMAGE no longer points at $WEB_IMAGE_ID; docker tag $WEB_IMAGE_ID $WEB_IMAGE first"; exit 1; }; fi
RUN_API=$(docker inspect -f '{{.Config.Image}}' movabi-develop-api)
WEB_NOW=$(docker ps --filter label=com.docker.compose.project=movabi-develop --filter label=com.docker.compose.service=web -q | head -1)
[ -n "$WEB_NOW" ] || { echo "FATAL: develop web container not found"; exit 1; }
RUN_WEB=$(docker inspect -f '{{.Config.Image}}' "$WEB_NOW")

# 2. Pin the rolled-back service(s) to the images recorded before the rollout. A service that is
#    NOT rolled back stays pinned to the image it runs now, so a later `compose up` of it cannot
#    silently revert it. No build sections.
PIN_API=$RUN_API; PIN_WEB=$RUN_WEB
case "$WHAT" in api) PIN_API=$API_IMAGE ;; web) PIN_WEB=$WEB_IMAGE ;; both) PIN_API=$API_IMAGE; PIN_WEB=$WEB_IMAGE ;; esac
cp "$OVR" "$DIR/release-override.yml.at-rollback" 2>/dev/null || true
cat > "$OVR" <<YAML
services:
  api:
    image: $PIN_API
  web:
    image: $PIN_WEB
YAML
echo "override: api=$PIN_API web=$PIN_WEB (previous override saved to $DIR/release-override.yml.at-rollback)"

# 3. Recreate only the service(s) being rolled back, from existing images.
cd "$WORKDIR"
if [ "$WHAT" != web ]; then docker compose "${ARGS[@]}" -f "$OVR" -f "$WALLET" up -d --no-deps --no-build api; fi
if [ "$WHAT" != api ]; then docker compose "${ARGS[@]}" -f "$OVR" up -d --no-deps --no-build web; fi
docker inspect -f '{{.Name}} {{.Config.Image}} {{.Image}}' movabi-develop-api "$(docker ps --filter label=com.docker.compose.project=movabi-develop --filter label=com.docker.compose.service=web -q | head -1)"
echo "Rolled back ($WHAT). Attempts discarded under the fix stay 'failed' with their Stripe PaymentIntents cancelled (consistent; no credit owed)."
