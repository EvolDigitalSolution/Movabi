#!/usr/bin/env bash
# DB-only develop policy release. No API/web rollout, provider activation or backup.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; mode="${1:---inspect}"
[[ "$mode" = --inspect || "$mode" = --apply || "$mode" = --verify ]] || exit 2
(cd "$HERE" && sha256sum -c --quiet SHA256SUMS)
E=$(mktemp -d /home/edsadmin/vaydu-pin-policy.XXXXXX); echo "PIN_POLICY_EVIDENCE=$E"
P(){ docker exec -i movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -P pager=off'; }
docker inspect -f '{{.Image}} {{.Config.Image}}' movabi-develop-api | tee "$E/api-before.txt"
docker exec movabi-develop-api cat /app/SOURCE_SHA | tee "$E/api-source.txt"
case "$(cat "$E/api-source.txt")" in f949a14|eef726b) :;; *) echo 'BLOCK: review unexpected API baseline'; exit 1;; esac
docker exec -i -w /app movabi-develop-api sha256sum -c < "$HERE/API_PIN_SHA256SUMS" > "$E/api-pin-integrity.txt" 2>&1
bash "$HERE/verify-p8-web.sh" "$E"
P < "$HERE/RELEASE_VERIFY.sql" > "$E/release-verify.log" 2>&1
if [[ "$mode" != --verify ]]; then
  [[ "$(tail -1 "$HERE/policy.sql")" = 'COMMIT;' ]]
  sed '$s/^COMMIT;$/ROLLBACK;/' "$HERE/policy.sql" > "$E/dryrun.sql"
  P < "$E/dryrun.sql" 2>&1 | tee "$E/dryrun.log"
  echo 'PIN_POLICY_DRYRUN_OK: all changes rolled back'
fi
if [[ "$mode" = --inspect ]]; then exit 0; fi
if [[ "$mode" = --apply ]]; then
 passed(){
  [[ -f "$1" ]] || return 1
  for line in 'PASS: globals restore exited 0' 'PASS: pg_restore exited 0' 'suites passed: 9 of 9' \
   'PASS: restored data byte-identical after the suites' 'PASS: preamble left nothing behind' \
   'PASS: rollback restored the exact pre-release schema' 'PASS: PREREQ passes again after rollback' \
   'PASS: restored data byte-identical to before the release' 'DRILL_OK: restore, release, 9 of 9 suites'; do grep -Fq "$line" "$1" || return 1; done
  ! grep -Eq 'FAIL:|DRILL_FAILED|FATAL:' "$1"
 }
 if [[ -z "${RESTORE_DRILL_LOG:-}" ]]; then
  while IFS= read -r f; do if passed "$f"; then RESTORE_DRILL_LOG="$f"; break; fi; done < <(find /home/edsadmin -mindepth 2 -maxdepth 2 -type f -path '/home/edsadmin/vaydu-f949a14-drill.*/drill.log' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
 fi
 passed "${RESTORE_DRILL_LOG:-}" || { echo 'BLOCK: existing passed real-backup drill evidence required'; exit 1; }
 printf '%s\n' "$RESTORE_DRILL_LOG" > "$E/restore-drill-path.txt"; sha256sum "$RESTORE_DRILL_LOG" > "$E/restore-drill.sha256"
 P < "$HERE/policy.sql" 2>&1 | tee "$E/apply.log"
fi
P < "$HERE/verify.sql" 2>&1 | tee "$E/policy-verify.log"
P < "$HERE/RELEASE_VERIFY.sql" > "$E/release-verify-after.log" 2>&1
docker inspect -f '{{.Image}} {{.Config.Image}}' movabi-develop-api > "$E/api-after.txt"; cmp "$E/api-before.txt" "$E/api-after.txt"
mkdir "$E/web-after"; bash "$HERE/verify-p8-web.sh" "$E/web-after"
for f in web-image.txt web-image-id.txt web-container-id.txt; do cmp "$E/$f" "$E/web-after/$f"; done
echo "PIN_POLICY_DEPLOYMENT_VERIFIED: API/web IDs unchanged; evidence=$E"
