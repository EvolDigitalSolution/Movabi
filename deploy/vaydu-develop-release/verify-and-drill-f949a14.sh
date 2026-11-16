#!/usr/bin/env bash
# Upload this file and the named archive to /home/edsadmin, then run:
# bash /home/edsadmin/verify-and-drill-f949a14.sh
# Read-only develop inventory plus disposable restore drill; never deploys or activates.
set -euo pipefail
cd /home/edsadmin
A=/home/edsadmin/vaydu-develop-f949a14-release-linux.tar.gz
D=/home/edsadmin/vaydu-develop-backups/develop-before-release-e4a64c1-20261114T201704Z.dump
printf '%s  %s\n' 58dcdbaf0b27769bcf15bfbfa584e4e64002c4ab27ada42cd4f5f57cc089488a "$A" | sha256sum -c -
for f in "$D" "$D.sha256" "$D.globals.sql" "$D.counts.tsv" "$D.image"; do test -s "$f"; done
sha256sum -c "$D.sha256"
E=$(mktemp -d /home/edsadmin/vaydu-f949a14-drill.XXXXXX)
tar -xzf "$A" -C "$E"
B="$E/vaydu-develop-f949a14-release-linux"
(
  cd "$B"
  sha256sum -c --quiet SHA256SUMS
  sha256sum -c --quiet ALL_SHA256SUMS
  sha256sum -c --quiet RELEASE-MIGRATIONS.sha256
  test "$(cat SOURCE_SHA)" = f949a14
)
echo BUNDLE_OK
bash "$B/test-host-drill-restore.sh" "$B/host-db-release.sh"

# Fresh baseline: user-reported API c972037 and web 3c91991. Stop on any drift.
docker inspect -f '{{.Config.Image}} {{.State.Status}}' movabi-develop-api
test "$(docker inspect -f '{{.State.Status}}' movabi-develop-api)" = running
API_SOURCE=$(docker exec movabi-develop-api cat /app/SOURCE_SHA)
printf 'API_SOURCE=%s\n' "$API_SOURCE"
test "${API_SOURCE:0:7}" = c972037
mapfile -t WEB < <(docker ps --filter label=com.docker.compose.service=web --filter label=com.docker.compose.project=movabi-develop --format '{{.Image}}')
test "${#WEB[@]}" -eq 1
printf 'WEB_IMAGE=%s\n' "${WEB[0]}"
test "${WEB[0]}" = movabi-web:release-3c91991-linux
bash "$B/host-db-release.sh" "$B" prereq
(cd "$B" && bash host-live-config.sh) > "$E/live-config-before.txt" 2>&1

cat > "$E/expected-suites.txt" <<'SUITES'
realdb-cancellation-fee-test.sql
realdb-cash-booking-acquisition-test.sql
realdb-cash-booking-chain-test.sql
realdb-cash-ride-lifecycle-test.sql
realdb-completion-pin-test.sql
realdb-driver-metrics-test.sql
realdb-market-pilot-test.sql
realdb-merge-test.sql
realdb-referral-units-test.sql
SUITES
sed 's/\r$//' "$B/tests/SUITES.txt" | sed '/^#/d; /^[[:space:]]*$/d' > "$E/actual-suites.txt"
diff -u "$E/expected-suites.txt" "$E/actual-suites.txt"

set +e
bash "$B/host-db-release.sh" "$B" drill "$D" 2>&1 | tee "$E/drill.log"
statuses=("${PIPESTATUS[@]}")
set -e
printf 'DRILL_EXIT=%s LOG_EXIT=%s\n' "${statuses[0]}" "${statuses[1]}"
test "${statuses[0]}" -eq 0
test "${statuses[1]}" -eq 0
while IFS= read -r suite; do grep -Fq "PASS: $suite (" "$E/drill.log"; done < "$E/expected-suites.txt"
for required in \
  'PASS: globals restore exited 0' \
  'PASS: pg_restore exited 0' \
  'PASS: restored row counts equal' \
  'PASS: PREREQ on the restored copy' \
  'PASS: release-up.sql on the restored copy' \
  'PASS: VERIFY on the restored copy' \
  'suites passed: 9 of 9' \
  'PASS: restored data byte-identical after the suites' \
  'PASS: preamble left nothing behind' \
  'PASS: release-down.sql on the restored copy' \
  'PASS: rollback restored the exact pre-release schema' \
  'PASS: PREREQ passes again after rollback' \
  'PASS: restored data byte-identical to before the release' \
  'DRILL_OK: restore, release, 9 of 9 suites'; do
  grep -Fq "$required" "$E/drill.log"
done
if grep -Eq 'FAIL:|DRILL_FAILED|FATAL:' "$E/drill.log"; then exit 1; fi
printf 'HOST_DRILL_GATE_PASSED evidence=%s\nNo deployment or activation performed.\n' "$E"
