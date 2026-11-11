#!/usr/bin/env bash
# Application rollback for the top-up fix. No schema change was shipped, so none is reverted.
# Usage: ./host-rollback.sh ~/vaydu-topup-fix-predeploy-<stamp> [api|web|both]
set -euo pipefail
export LC_ALL=C
DIR="$1"; WHAT="${2:-both}"; source "$DIR/previous.env"
WORKDIR=/srv/movabi/develop
OVR="$HOME/vaydu-develop-overrides/release-override.yml"; WALLET="$HOME/vaydu-develop-overrides/docker-compose.develop-wallet.override.yml"
ARGS=(); IFS=',' read -r -a FILES <<< "$CONFIG_FILES"
for f in "${FILES[@]}"; do [ "$(basename "$f")" = release-override.yml ] && continue; [ "$(basename "$f")" = "$(basename "$WALLET")" ] && continue; ARGS+=(-f "$f"); done
cp "$OVR" "$DIR/release-override.yml.at-rollback" 2>/dev/null || true
# Pin both services to the images recorded before the rollout; no build sections.
cat > "$OVR" <<YAML
services:
  api:
    image: $API_IMAGE
  web:
    image: $WEB_IMAGE
YAML
# The recorded tags must still resolve to the recorded image IDs.
[ "$(docker image inspect -f '{{.Id}}' "$API_IMAGE")" = "$API_IMAGE_ID" ] || { echo "FATAL: $API_IMAGE no longer points at $API_IMAGE_ID; docker tag $API_IMAGE_ID $API_IMAGE first"; exit 1; }
[ "$(docker image inspect -f '{{.Id}}' "$WEB_IMAGE")" = "$WEB_IMAGE_ID" ] || { echo "FATAL: $WEB_IMAGE no longer points at $WEB_IMAGE_ID; docker tag $WEB_IMAGE_ID $WEB_IMAGE first"; exit 1; }
cd "$WORKDIR"
case "$WHAT" in
  api|both) docker compose "${ARGS[@]}" -f "$OVR" -f "$WALLET" up -d --no-deps --no-build api ;;& 
  web|both) docker compose "${ARGS[@]}" -f "$OVR" up -d --no-deps --no-build web ;;
esac
docker inspect -f '{{.Name}} {{.Config.Image}} {{.Image}}' movabi-develop-api
echo "Rolled back ($WHAT). Attempts discarded under the fix stay 'failed' with their Stripe PaymentIntents cancelled (consistent; no credit owed)."
