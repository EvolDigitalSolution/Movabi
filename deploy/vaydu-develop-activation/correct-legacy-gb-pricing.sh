#!/usr/bin/env bash
# Run on develop from the checksum-verified activation fix directory. No SSH or new backup.
# bash correct-legacy-gb-pricing.sh
# Correction only: activation is a separate, explicitly gated command in LEGACY-GB-SCOPE.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
(cd "$HERE" && sha256sum -c --quiet FIX_SHA256SUMS)
P(){ docker exec -i movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -P pager=off "$@"' sh "$@"; }
E=$(mktemp -d /home/edsadmin/vaydu-gb-pricing-scope.XXXXXX)
AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf 'EVIDENCE=%s\n' "$E"
docker inspect -f '{{.Config.Image}} {{.State.Status}}' movabi-develop-api | tee "$E/api-image.txt"
docker exec movabi-develop-api cat /app/SOURCE_SHA | tee "$E/api-source.txt"
# Retain the precise row IDs and ALL fields used for optimistic concurrency checks/audit.
P -qAt -c "select coalesce(jsonb_agg(to_jsonb(p) order by service_type,id),'[]'::jsonb) from public.pricing_config p where nullif(btrim(country_code),'') is null and currency_code='GBP' and is_active and nullif(btrim(market_city),'') is null and nullif(btrim(zone_id),'') is null and service_type in ('ride','delivery','errand','van-moving');" > "$E/intended-uk-before.json"
P -qAt -c "select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]'::jsonb) from public.pricing_config p;" > "$E/all-pricing-before.json"
docker exec -i -e PROBE_AT="$AT" -w /app movabi-develop-api node < "$HERE/probe-gb-ng-quotes.cjs" > "$E/quotes-before.log" 2>&1
test "$(grep -c '^QUOTE_PROBE_JSON=' "$E/quotes-before.log")" -eq 1
grep '^QUOTE_PROBE_JSON=' "$E/quotes-before.log" > "$E/quotes-before.json"
grep '^PROFILE_MARKETS_OK ' "$E/quotes-before.log"
P -v expected_rows_json="$(cat "$E/intended-uk-before.json")" < "$HERE/correct-legacy-gb-pricing.sql" 2>&1 | tee "$E/correction.log"
docker exec -i -e PROBE_AT="$AT" -w /app movabi-develop-api node < "$HERE/probe-gb-ng-quotes.cjs" > "$E/quotes-after.log" 2>&1
test "$(grep -c '^QUOTE_PROBE_JSON=' "$E/quotes-after.log")" -eq 1
grep '^QUOTE_PROBE_JSON=' "$E/quotes-after.log" > "$E/quotes-after.json"
diff -u "$E/quotes-before.json" "$E/quotes-after.json" > "$E/quote-diff.txt" || {
  echo "STOP: a GB or NG quote changed; activation must not proceed. Inspect $E/quote-diff.txt"; exit 1;
}
P -qAt -c "select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]'::jsonb) from public.pricing_config p;" > "$E/all-pricing-after.json"
{ printf '{"before":'; cat "$E/all-pricing-before.json"; printf ',"after":'; cat "$E/all-pricing-after.json";
  printf ',"intended":'; cat "$E/intended-uk-before.json"; printf '}';
} | docker exec -i -w /app movabi-develop-api node -e "$(cat "$HERE/compare-legacy-pricing.cjs")"
printf 'GB_NG_QUOTES_UNCHANGED\nPRICING_SCOPE_HOST_OK evidence=%s\nActivation has not run.\n' "$E"
