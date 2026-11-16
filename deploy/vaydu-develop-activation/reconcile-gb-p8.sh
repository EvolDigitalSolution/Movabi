#!/usr/bin/env bash
# --inspect (default): all prerequisites, then the complete projected correction/activation rolled back.
# --apply: requires the prior real-backup drill log; same exact transaction commits, then actual quotes.
# No SSH, backup, deployment, cash-cohort or API environment changes.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; MODE="${1:---inspect}"
[[ "$MODE" = --inspect || "$MODE" = --apply ]] || { echo 'usage: reconcile-gb-p8.sh --inspect|--apply'; exit 2; }
(cd "$HERE" && sha256sum -c --quiet P8_SHA256SUMS)
P(){ docker exec -i movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -P pager=off "$@"' sh "$@"; }
E=$(mktemp -d /home/edsadmin/vaydu-p8-reconciliation.XXXXXX); AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf 'P8_EVIDENCE=%s\n' "$E"
blocks=0; sql_ready=1; api_ready=1
if docker inspect -f '{{.Config.Image}} {{.State.Status}}' movabi-develop-api | tee "$E/api-image.txt"; then :;
else echo 'BLOCK: develop API inventory unavailable'; blocks=$((blocks+1)); fi
if docker exec movabi-develop-api cat /app/SOURCE_SHA | tee "$E/api-source.txt"; then :;
else echo 'BLOCK: develop API source marker unavailable'; blocks=$((blocks+1)); fi
if docker exec -i -w /app movabi-develop-api sha256sum -c < "$HERE/P8_API_SHA256SUMS" > "$E/api-integrity.txt" 2>&1; then
  echo 'PASS: installed P8 quote/resolver modules match reviewed source'
else cat "$E/api-integrity.txt"; echo 'CORRECTABLE: paired API tenant-binding update required before --apply'; api_ready=0; fi
if [[ "$api_ready" = 0 ]]; then
  case "$(cat "$E/api-source.txt")" in
    c972037|f949a14|"$(cat "$HERE/SOURCE_SHA")") echo 'PASS: API source is an approved baseline or paired candidate' ;;
    *) echo 'BLOCK: API source differs from the recorded c972037/reviewed f949a14 baseline; preserve it for review'; blocks=$((blocks+1)) ;;
  esac
  if printf '%s  %s\n' 54de2e6be3bad38ede117414fd6ca5480b110b10541c4c5b4e81c7ed34c6675d /home/edsadmin/rollout-develop-52097ef.sh | sha256sum -c -; then :;
  else echo 'BLOCK: approved API-only rollout helper is missing or changed'; blocks=$((blocks+1)); fi
fi
mapfile -t web_images < <(docker ps --filter label=com.docker.compose.service=web --filter label=com.docker.compose.project=movabi-develop --format '{{.Image}}')
printf '%s\n' "${web_images[@]}" | tee "$E/web-image.txt"
if [[ "${#web_images[@]}" = 1 && "${web_images[0]}" = movabi-web:*3c91991* ]]; then echo 'PASS: recorded 3c91991 web baseline retained';
else echo 'BLOCK: web baseline differs from recorded 3c91991; inspect before rollout'; blocks=$((blocks+1)); fi
if docker exec movabi-develop-api node -e 'const e=process.env;console.log(JSON.stringify({gbStripeTest:!!e.STRIPE_SECRET_KEY?.startsWith("sk_test_"),cashFlag:e.VAYDU_CASH_RIDE_BOOKING==="true",opsFlag:e.VAYDU_OPS_ALERTS==="true",opsRecipients:(e.VAYDU_OPS_ALERT_RECIPIENTS||"").split(",").filter(Boolean).length,smtpConfigured:!!(e.EMAIL_USER&&e.EMAIL_PASS),note:"cash/ops prerequisites are separate; this command changes neither"}))' | tee "$E/optional-environment.json"; then :;
else echo 'BLOCK: develop API environment inspection unavailable'; blocks=$((blocks+1)); fi
if P -q < "$HERE/P8_VERIFY.sql" > "$E/release-verify.log" 2>&1; then echo 'PASS: full unchanged release-2 VERIFY';
else cat "$E/release-verify.log"; echo 'BLOCK: full release-2 verification failed'; blocks=$((blocks+1)); sql_ready=0; fi
if P -qAt < "$HERE/activation-preflight.sql" > "$E/preflight.log" 2>&1; then
  grep '^ACTIVATION_PREFLIGHT_JSON=' "$E/preflight.log" | sed 's/^ACTIVATION_PREFLIGHT_JSON=//' > "$E/preflight.json"
  cat "$E/preflight.json"
  if docker exec -i movabi-develop-api node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const r=JSON.parse(s);for(const c of r.checks)console.log(c.status+": "+c.code+" "+JSON.stringify(c.detail));process.exitCode=r.blocks?1:0})' < "$E/preflight.json"; then :; else blocks=$((blocks+1)); sql_ready=0; fi
else cat "$E/preflight.log"; echo 'BLOCK: preflight could not complete'; blocks=$((blocks+1)); sql_ready=0; fi
passed_drill(){
  [[ -f "$1" ]] || return 1
  for line in 'PASS: globals restore exited 0' 'PASS: pg_restore exited 0' 'suites passed: 9 of 9' \
    'PASS: restored data byte-identical after the suites' 'PASS: preamble left nothing behind' \
    'PASS: rollback restored the exact pre-release schema' 'PASS: PREREQ passes again after rollback' \
    'PASS: restored data byte-identical to before the release' 'DRILL_OK: restore, release, 9 of 9 suites'; do
    grep -Fq "$line" "$1" || return 1
  done
  ! grep -Eq 'FAIL:|DRILL_FAILED|FATAL:' "$1"
}
# Reuse the existing gate's evidence, newest passing log first. No new backup or drill is run.
if [[ -z "${RESTORE_DRILL_LOG:-}" ]]; then
  while IFS= read -r candidate; do
    if passed_drill "$candidate"; then RESTORE_DRILL_LOG="$candidate"; break; fi
  done < <(find /home/edsadmin -mindepth 2 -maxdepth 2 -type f -path '/home/edsadmin/vaydu-f949a14-drill.*/drill.log' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
fi
if [[ -n "${RESTORE_DRILL_LOG:-}" && -f "$RESTORE_DRILL_LOG" ]]; then
  if passed_drill "$RESTORE_DRILL_LOG"; then echo "PASS: recorded real-backup drill evidence $RESTORE_DRILL_LOG";
  else echo 'BLOCK: recorded restore drill did not satisfy the gate'; blocks=$((blocks+1)); fi
elif [[ "$MODE" = --apply || "${P8_REQUIRE_RESTORE_GATE:-false}" = true ]]; then echo 'BLOCK: RESTORE_DRILL_LOG must name the existing passed real-backup drill.log'; blocks=$((blocks+1));
else echo 'EXTERNAL GATE: set RESTORE_DRILL_LOG to the existing passed real-backup drill log before --apply'; fi
[[ "$sql_ready" = 1 ]] || { echo "P8_PREFLIGHT_BLOCKED: all available conflicts reported; no correction/activation performed; evidence=$E"; exit 1; }

P -qAt -c "select coalesce(jsonb_agg(to_jsonb(s) order by service_type,id),'[]') from public.market_pricing_strategies s where upper(country_code)='GB';" > "$E/strategies-before.json"
P -qAt -c "select coalesce(jsonb_agg(to_jsonb(p) order by service_type,id),'[]') from public.pricing_config p where nullif(btrim(country_code),'') is null and currency_code='GBP' and is_active and nullif(btrim(market_city),'') is null and nullif(btrim(zone_id),'') is null and service_type in('ride','delivery','errand','van-moving');" > "$E/legacy-pricing-before.json"
LEGACY=without-legacy
if [[ "$(cat "$E/legacy-pricing-before.json")" != '[]' ]]; then LEGACY=with-legacy; fi
bash "$HERE/build-p8-transaction.sh" "$LEGACY" ROLLBACK > "$E/dryrun.sql"
if P -v expected_rows_json="$(cat "$E/legacy-pricing-before.json")" -v expected_strategies_json="$(cat "$E/strategies-before.json")" < "$E/dryrun.sql" > "$E/dryrun.log" 2>&1; then
  grep -q P8_ACTIVATION_ISOLATION_OK "$E/dryrun.log"; echo 'P8_FULL_ACTIVATION_DRYRUN_OK: exact guard/body passed; everything rolled back'
else tail -40 "$E/dryrun.log"; echo "P8_DRYRUN_BLOCKED: no correction/activation committed; evidence=$E"; exit 1; fi
[[ "$blocks" = 0 ]] || { echo "P8_PREFLIGHT_BLOCKED: SQL projection also checked; external/API blockers reported; nothing committed; evidence=$E"; exit 1; }
if [[ "$MODE" = --inspect ]]; then echo "P8_INSPECTION_OK: no correction/activation committed; evidence=$E"; exit 0; fi
[[ "$api_ready" = 1 ]] || { echo 'BLOCK: deploy the paired reviewed API before --apply (GB binding stays off until the atomic data switch)'; exit 1; }
docker exec -i -e P8_PHASE=before -e P8_AT="$AT" -w /app movabi-develop-api node < "$HERE/probe-p8-quotes.cjs" > "$E/quotes-before.log" 2>&1
grep '^P8_QUOTE_JSON=' "$E/quotes-before.log" | sed 's/^P8_QUOTE_JSON=//' > "$E/quotes-before.json"
bash "$HERE/build-p8-transaction.sh" "$LEGACY" COMMIT > "$E/apply.sql"
P -v expected_rows_json="$(cat "$E/legacy-pricing-before.json")" -v expected_strategies_json="$(cat "$E/strategies-before.json")" < "$E/apply.sql" 2>&1 | tee "$E/apply.log"
docker exec -i -e P8_PHASE=after -e P8_AT="$AT" -w /app movabi-develop-api node < "$HERE/probe-p8-quotes.cjs" > "$E/quotes-after.log" 2>&1
grep '^P8_QUOTE_JSON=' "$E/quotes-after.log" | sed 's/^P8_QUOTE_JSON=//' > "$E/quotes-after.json"
{ printf '{"before":'; cat "$E/quotes-before.json"; printf ',"after":'; cat "$E/quotes-after.json"; printf '}'; } |
  docker exec -i movabi-develop-api node -e 'const a=require("node:assert/strict");let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const x=JSON.parse(s);a.deepStrictEqual(x.after.filter(r=>r.country!=="GB"),x.before.filter(r=>r.country!=="GB"));console.log("OTHER_MARKET_QUOTES_UNCHANGED")})'
grep '^P8_ACTUAL_QUOTES_OK' "$E/quotes-after.log"
echo "P8_RECONCILIATION_ACTIVATION_OK evidence=$E"
