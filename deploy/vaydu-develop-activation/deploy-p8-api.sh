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
E=$(mktemp -d /home/edsadmin/vaydu-p8-api.XXXXXX)
echo "P8_API_EVIDENCE=$E"
bash "$HERE/verify-p8-web.sh" "$E"
docker inspect -f '{{.Config.Image}} {{.State.Status}}' movabi-develop-api | tee "$E/api-before.txt"
docker inspect -f '{{.Image}}' movabi-develop-api > "$E/api-before-image-id.txt"
docker exec movabi-develop-api cat /app/SOURCE_SHA > "$E/api-before-source.txt"
[[ "$(cat "$E/api-before-source.txt")" = f949a14 ]] || { echo 'BLOCK: only verified f949a14 API may be replaced'; exit 1; }
docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' movabi-develop-api > "$E/api-compose-files.txt"
docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' movabi-develop-api > "$E/api-workdir.txt"
docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' movabi-develop-api > "$E/api-project.txt"
# Retain the exact old image through normal dangling-image cleanup; never overwrite a tag.
PIN="movabi-api:p8-recovery-$(basename "$E")"
if docker image inspect "$PIN" >/dev/null 2>&1; then echo 'BLOCK: recovery image tag already exists'; exit 1; fi
docker image tag "$(cat "$E/api-before-image-id.txt")" "$PIN"
printf '%s\n' "$PIN" > "$E/api-recovery-tag.txt"
printf 'services:\n  api:\n    image: %s\n' "$(cat "$E/api-before-image-id.txt")" > "$E/api-recovery.compose.yml"
echo "P8_RECOVERY: exact previous API/web image IDs retained in $E; see P8-RECOVERY.md"
export ARCHIVE BUNDLE_DIR="vaydu-develop-$SHA-release-linux" EXPECTED_SOURCE_SHA="$SHA"
export API_TAG="release-$SHA-p8-tenant" WEB_TAG="$(cat "$E/web-image.txt")"
WEB_TAG="${WEB_TAG#movabi-web:}"
cd /home/edsadmin
bash rollout-develop-52097ef.sh --deploy-api-only --preflight 2>&1 | tee "$E/preflight.log"
bash rollout-develop-52097ef.sh --deploy-api-only 2>&1 | tee "$E/deploy.log"
[[ "$(docker exec movabi-develop-api cat /app/SOURCE_SHA)" = "$SHA" ]]
docker exec -i -w /app movabi-develop-api sha256sum -c < "$HERE/P8_API_SHA256SUMS"
mkdir "$E/web-after"
bash "$HERE/verify-p8-web.sh" "$E/web-after"
for f in web-image.txt web-image-id.txt web-container-id.txt; do cmp "$E/$f" "$E/web-after/$f" || { echo 'web tag/image ID/container drifted; stop'; exit 1; }; done
curl -fsS --retry 5 --retry-connrefused --retry-delay 2 https://movabi-api-develop.apps.evolsolution.com/health | tee "$E/health.json"
echo 'P8_API_DEPLOYED: reviewed f949a14 base + GB session-tenant binding only; web unchanged; binding waits for atomic GB data switch'
