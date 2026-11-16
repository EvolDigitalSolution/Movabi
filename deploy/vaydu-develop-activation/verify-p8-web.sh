#!/usr/bin/env bash
# Read-only verification against the immutable f949a14 web payload, not just a tag.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; E="${1:?evidence directory}"
[[ -d "$E" ]] || exit 2
mapfile -t containers < <(docker ps --filter label=com.docker.compose.service=web --filter label=com.docker.compose.project=movabi-develop --format '{{.ID}}')
[[ "${#containers[@]}" = 1 ]] || { echo 'BLOCK: expected exactly one develop web container'; exit 1; }
C="${containers[0]}"
docker inspect -f '{{.Config.Image}}' "$C" > "$E/web-image.txt"
docker inspect -f '{{.Image}}' "$C" > "$E/web-image-id.txt"
docker inspect -f '{{.Id}}' "$C" > "$E/web-container-id.txt"
[[ "$(cat "$E/web-image.txt")" = movabi-web:release-f949a14-linux ]] || { echo 'BLOCK: expected movabi-web:release-f949a14-linux'; exit 1; }
[[ "$(docker image inspect -f '{{.Id}}' movabi-web:release-f949a14-linux)" = "$(cat "$E/web-image-id.txt")" ]] || { echo 'BLOCK: web tag no longer names the actual running image ID'; exit 1; }
docker exec -i -w /usr/share/nginx/html "$C" sha256sum -c < "$HERE/P8_WEB_f949a14_SHA256SUMS" > "$E/web-integrity.txt" 2>&1 || { cat "$E/web-integrity.txt"; echo 'BLOCK: running web differs from f949a14 bundle'; exit 1; }
docker exec -w /usr/share/nginx/html "$C" sh -c 'find . ! -type d | LC_ALL=C sort' > "$E/web-files.txt"
diff -u "$HERE/P8_WEB_f949a14_FILES.txt" "$E/web-files.txt" || { echo 'BLOCK: web file inventory differs from f949a14 bundle'; exit 1; }
printf 'P8_WEB_BASELINE_VERIFIED: f949a14 payload; tag=%s image=%s container=%s\n' "$(cat "$E/web-image.txt")" "$(cat "$E/web-image-id.txt")" "$(cat "$E/web-container-id.txt")"
