#!/usr/bin/env bash
# Develop applications only. No SQL, policy, enrolment, backup or SSH changes.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
(cd "$HERE" && sha256sum -c --quiet SHA256SUMS)
[[ -n "${RESTORE_DRILL_LOG:-}" && -f "$RESTORE_DRILL_LOG" ]] || { echo 'Set RESTORE_DRILL_LOG to the existing passing real-backup drill log'; exit 1; }
for line in 'PASS: globals restore exited 0' 'PASS: pg_restore exited 0' 'suites passed: 9 of 9' \
 'PASS: restored data byte-identical after the suites' 'PASS: preamble left nothing behind' \
 'PASS: rollback restored the exact pre-release schema' 'PASS: PREREQ passes again after rollback' \
 'PASS: restored data byte-identical to before the release' 'DRILL_OK: restore, release, 9 of 9 suites'; do
 grep -Fq "$line" "$RESTORE_DRILL_LOG" || { echo "Restore evidence missing: $line"; exit 1; }
done
if grep -Eq 'FAIL:|DRILL_FAILED|FATAL:' "$RESTORE_DRILL_LOG"; then echo 'Restore evidence contains a failure'; exit 1; fi
E=$(mktemp -d /home/edsadmin/vaydu-booking-cash.XXXXXX)
echo "BOOKING_CASH_EVIDENCE=$E"
sha256sum "$RESTORE_DRILL_LOG" > "$E/restore-drill.sha256"
printf '%s\n' "$RESTORE_DRILL_LOG" > "$E/restore-drill-path.txt"
bash "$HERE/verify-p8-web.sh" "$E"
OLD=$(docker exec movabi-develop-api cat /app/SOURCE_SHA)
case "$OLD" in f949a14|eef726b) ;; *) echo "BLOCK: unreviewed current API source $OLD; preserve it for review"; exit 1;; esac
docker exec -i -w /app movabi-develop-api sha256sum -c < "$HERE/BASE_API_${OLD}_SHA256SUMS" > "$E/api-before-integrity.log"
docker exec movabi-develop-api printenv VAYDU_CASH_RIDE_BOOKING | grep -qx true
docker inspect -f '{{.Image}}' movabi-develop-api > "$E/api-before-image-id.txt"
docker inspect -f '{{.Config.Image}}' movabi-develop-api > "$E/api-before-image.txt"
printf '%s\n' "$OLD" > "$E/api-before-source.txt"
# Retain both actual images; no existing image tag, override or work directory is replaced.
for service in api web; do
 if [[ "$service" = api ]]; then id=$(cat "$E/api-before-image-id.txt"); else id=$(cat "$E/web-image-id.txt"); fi
 tag="movabi-$service:booking-recovery-$(basename "$E")"
 if docker image inspect "$tag" >/dev/null 2>&1; then echo 'Recovery tag exists'; exit 1; fi
 docker image tag "$id" "$tag"
done
docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' movabi-develop-api > "$E/compose-files.txt"
docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' movabi-develop-api > "$E/compose-workdir.txt"
docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' movabi-develop-api > "$E/compose-project.txt"
[[ "$(cat "$E/compose-project.txt")" = movabi-develop ]] || { echo 'Develop compose project required'; exit 1; }
IFS=',' read -r -a originals < "$E/compose-files.txt"
args=(--project-name movabi-develop --project-directory "$(cat "$E/compose-workdir.txt")")
for f in "${originals[@]}"; do [[ -f "$f" ]] || { echo "Missing existing compose file: $f"; exit 1; }; args+=(-f "$f"); done
printf 'services:\n  api:\n    image: %s\n  web:\n    image: %s\n' "$(cat "$E/api-before-image-id.txt")" "$(cat "$E/web-image-id.txt")" > "$E/recovery.compose.yml"
cp "$HERE/DEPLOYMENT.md" "$E/DEPLOYMENT.md"
SHA=$(cat "$HERE/SOURCE_SHA")
API="movabi-api:release-$SHA-booking-cash"; WEB="movabi-web:release-$SHA-booking-cash"
for image in "$API" "$WEB"; do if docker image inspect "$image" >/dev/null 2>&1; then echo "Refusing to overwrite $image"; exit 1; fi; done
tar -xzf "$HERE/app.tar.gz" -C "$E"
B="$E/app"
(cd "$B" && sha256sum -c --quiet ALL_SHA256SUMS)
cp "$HERE/default.conf" "$B/booking-default.conf"
cp "$HERE/Dockerfile.web" "$E/Dockerfile.web"
docker build -t "$API" -f "$B/server/Dockerfile" "$B" 2>&1 | tee "$E/api-build.log"
docker build -t "$WEB" -f "$E/Dockerfile.web" "$B" 2>&1 | tee "$E/web-build.log"
printf 'services:\n  api:\n    image: %s\n  web:\n    image: %s\n' "$API" "$WEB" > "$E/candidate.compose.yml"
docker compose "${args[@]}" -f "$E/candidate.compose.yml" up -d --no-deps --no-build api
curl -fsS --retry 10 --retry-connrefused --retry-delay 2 https://movabi-api-develop.apps.evolsolution.com/health > "$E/health.json"
docker exec movabi-develop-api printenv VAYDU_CASH_RIDE_BOOKING | grep -qx true
docker exec -i -w /app movabi-develop-api sha256sum -c < "$HERE/CANDIDATE_API_SHA256SUMS" > "$E/api-after-integrity.log"
docker compose "${args[@]}" -f "$E/candidate.compose.yml" up -d --no-deps --no-build web
mapfile -t web < <(docker ps --filter label=com.docker.compose.service=web --filter label=com.docker.compose.project=movabi-develop --format '{{.ID}}')
[[ "${#web[@]}" = 1 ]]
docker exec -i -w /usr/share/nginx/html "${web[0]}" sha256sum -c < "$HERE/CANDIDATE_WEB_SHA256SUMS" > "$E/web-after-integrity.log"
docker exec -w /usr/share/nginx/html "${web[0]}" sh -c 'find . ! -type d | LC_ALL=C sort' > "$E/web-after-files.txt"
diff -u "$HERE/CANDIDATE_WEB_FILES.txt" "$E/web-after-files.txt"
echo "BOOKING_CASH_APPLICATIONS_DEPLOYED evidence=$E"
echo 'Real customer quote/choices, Card+Cash submissions, enrolled-driver acquisition and provider/ledger completion still require authenticated journey verification.'
