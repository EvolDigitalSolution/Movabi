#!/usr/bin/env bash
# Deploy ONLY the paired quote-tenant API candidate, before the P8 data transaction enables it.
# Existing real-backup and full SQL/activation preflight gates are checked first. No web rollout.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
(cd "$HERE" && sha256sum -c --quiet P8_SHA256SUMS)
P8_REQUIRE_RESTORE_GATE=true bash "$HERE/reconcile-gb-p8.sh" --inspect
SHA=$(cat "$HERE/SOURCE_SHA"); ARCHIVE="vaydu-develop-$SHA-release-linux.tar.gz"
(cd "$HERE" && sha256sum -c "$ARCHIVE.sha256")
if [[ "$(docker exec movabi-develop-api cat /app/SOURCE_SHA)" = "$SHA" ]] && docker exec -i -w /app movabi-develop-api sha256sum -c --quiet < "$HERE/P8_API_SHA256SUMS"; then
  echo 'P8_API_ALREADY_READY: no restart or deployment performed'; exit 0
fi
printf '%s  %s\n' 54de2e6be3bad38ede117414fd6ca5480b110b10541c4c5b4e81c7ed34c6675d /home/edsadmin/rollout-develop-52097ef.sh | sha256sum -c -
for f in "$ARCHIVE" "$ARCHIVE.sha256"; do
  if [[ -e "/home/edsadmin/$f" ]]; then cmp -s "$HERE/$f" "/home/edsadmin/$f" || { echo "refusing to overwrite unrelated $f"; exit 1; }
  else cp "$HERE/$f" "/home/edsadmin/$f"; fi
done
mapfile -t WEB < <(docker ps --filter label=com.docker.compose.service=web --filter label=com.docker.compose.project=movabi-develop --format '{{.Image}}')
[[ "${#WEB[@]}" = 1 && "${WEB[0]}" = movabi-web:* ]] || { echo 'cannot establish the existing web image'; exit 1; }
E=$(mktemp -d /home/edsadmin/vaydu-p8-api.XXXXXX)
echo "P8_API_EVIDENCE=$E"
docker inspect -f '{{.Config.Image}} {{.State.Status}}' movabi-develop-api | tee "$E/api-before.txt"
printf '%s\n' "${WEB[0]}" > "$E/web-before.txt"
export ARCHIVE BUNDLE_DIR="vaydu-develop-$SHA-release-linux" EXPECTED_SOURCE_SHA="$SHA"
export API_TAG="release-$SHA-p8-tenant" WEB_TAG="${WEB[0]#movabi-web:}"
cd /home/edsadmin
bash rollout-develop-52097ef.sh --deploy-api-only --preflight 2>&1 | tee "$E/preflight.log"
bash rollout-develop-52097ef.sh --deploy-api-only 2>&1 | tee "$E/deploy.log"
[[ "$(docker exec movabi-develop-api cat /app/SOURCE_SHA)" = "$SHA" ]]
docker exec -i -w /app movabi-develop-api sha256sum -c < "$HERE/P8_API_SHA256SUMS"
mapfile -t AFTER < <(docker ps --filter label=com.docker.compose.service=web --filter label=com.docker.compose.project=movabi-develop --format '{{.Image}}')
[[ "${#AFTER[@]}" = 1 && "${AFTER[0]}" = "${WEB[0]}" ]] || { echo 'web image drifted; stop'; exit 1; }
curl -fsS --retry 5 --retry-connrefused --retry-delay 2 https://movabi-api-develop.apps.evolsolution.com/health | tee "$E/health.json"
echo 'P8_API_DEPLOYED: reviewed f949a14 base + GB session-tenant binding only; web unchanged; binding waits for atomic GB data switch'
