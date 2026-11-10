#!/usr/bin/env bash
# Destructive fixtures only inside the runner's isolated cluster.
set -euo pipefail
: "${EXPECTED_DB:?explicit disposable database required}"
case "$EXPECTED_DB" in *movabi*|postgres|template*) exit 2;; *_batch1c_test) ;; *) exit 2;; esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PSQL=(psql -X -v ON_ERROR_STOP=1 -d "$EXPECTED_DB")
test "$("${PSQL[@]}" -qAt -c 'SELECT current_database()')" = "$EXPECTED_DB"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
snapshot() {
 pg_dump --schema-only --no-owner --no-privileges -d "$EXPECTED_DB" |
   sed '/^\\restrict /d; /^\\unrestrict /d' > "$1"
}
reject() {
 local message="$1" rc=0
 snapshot "$TMP/before"
 "${PSQL[@]}" -f "$ROOT/supabase/migrations/20261246000000_wallet_topups_batch1c.sql" > "$TMP/result" 2>&1 || rc=$?
 if [ "$rc" -eq 0 ] || ! grep -qF "$message" "$TMP/result"; then cat "$TMP/result"; echo 'UNEXPECTED MIGRATION RESULT'; exit 1; fi
 snapshot "$TMP/after"
 diff -u "$TMP/before" "$TMP/after"
 echo "PASS: rejected $message; schema unchanged"
}
reset_provider_index() {
 "${PSQL[@]}" -q -c 'DROP INDEX public.wallet_topup_attempts_provider_reference_unique; CREATE UNIQUE INDEX wallet_topup_attempts_provider_reference_unique ON public.wallet_topup_attempts(payment_provider,merchant_account_ref,provider_reference) WHERE provider_reference IS NOT NULL;'
}
for definition in \
 'CREATE INDEX wallet_topup_attempts_provider_reference_unique ON public.wallet_topup_attempts(payment_provider,merchant_account_ref,provider_reference) WHERE provider_reference IS NOT NULL' \
 'CREATE UNIQUE INDEX wallet_topup_attempts_provider_reference_unique ON public.wallet_topup_attempts(payment_provider,merchant_account_ref,provider_reference) WHERE provider_reference IS NOT NULL AND amount_minor>0' \
 'CREATE UNIQUE INDEX wallet_topup_attempts_provider_reference_unique ON public.wallet_topup_attempts(payment_provider,merchant_account_ref,provider_reference) INCLUDE (status) WHERE provider_reference IS NOT NULL' \
 'CREATE UNIQUE INDEX wallet_topup_attempts_provider_reference_unique ON public.wallet_topup_attempts(payment_provider,merchant_account_ref,provider_reference text_pattern_ops) WHERE provider_reference IS NOT NULL' \
 'CREATE UNIQUE INDEX wallet_topup_attempts_provider_reference_unique ON public.wallet_topup_attempts(payment_provider,merchant_account_ref,lower(provider_reference)) WHERE provider_reference IS NOT NULL'; do
 "${PSQL[@]}" -q -c "DROP INDEX public.wallet_topup_attempts_provider_reference_unique; $definition;"
 reject 'Batch 1C: incompatible index'
 reset_provider_index
 done
"${PSQL[@]}" -q -c 'DROP INDEX public.wallet_topup_attempts_credit_unique; CREATE INDEX wallet_topup_attempts_credit_unique ON public.wallet_topup_attempts(credited_event_id) WHERE credited_event_id IS NOT NULL;'
reject 'Batch 1C: incompatible index'
"${PSQL[@]}" -q -c 'DROP INDEX public.wallet_topup_attempts_credit_unique; CREATE UNIQUE INDEX wallet_topup_attempts_credit_unique ON public.wallet_topup_attempts(credited_event_id) WHERE credited_event_id IS NOT NULL;'
"${PSQL[@]}" -q -c 'DROP INDEX public.wallet_topup_attempts_owner; CREATE INDEX wallet_topup_attempts_owner ON public.wallet_topup_attempts(owner_id,tenant_id,currency_code);'
reject 'Batch 1C: incompatible index'
"${PSQL[@]}" -q -c 'DROP INDEX public.wallet_topup_attempts_owner; CREATE INDEX wallet_topup_attempts_owner ON public.wallet_topup_attempts(tenant_id,owner_id,currency_code);'
for extra in "AND cardinality(capabilities)<=1" "OR true"; do
 "${PSQL[@]}" -q -c "ALTER TABLE public.market_payment_routes DROP CONSTRAINT market_payment_routes_capabilities_check; ALTER TABLE public.market_payment_routes ADD CONSTRAINT market_payment_routes_capabilities_check CHECK ((capabilities <@ ARRAY['authorise','capture','release','refund','retrieve','payout','collect']::text[] AND array_position(capabilities,NULL) IS NULL) $extra);"
 reject 'Batch 1C: incompatible capability CHECK'
 "${PSQL[@]}" -q -c "ALTER TABLE public.market_payment_routes DROP CONSTRAINT market_payment_routes_capabilities_check; ALTER TABLE public.market_payment_routes ADD CONSTRAINT market_payment_routes_capabilities_check CHECK (capabilities <@ ARRAY['authorise','capture','release','refund','retrieve','payout','collect']::text[] AND array_position(capabilities,NULL) IS NULL);"
done
"${PSQL[@]}" -q -c 'ALTER TABLE public.wallet_topup_attempts ALTER COLUMN provider_reference SET DEFAULT '\''bad'\'';'
reject 'Batch 1C: incompatible table columns'
"${PSQL[@]}" -q -c 'ALTER TABLE public.wallet_topup_attempts ALTER COLUMN provider_reference DROP DEFAULT;'
"${PSQL[@]}" -q -c 'ALTER TABLE public.wallet_topup_attempts DROP CONSTRAINT wallet_topup_attempts_amount_minor_check; ALTER TABLE public.wallet_topup_attempts ADD CONSTRAINT wallet_topup_attempts_amount_minor_check CHECK(amount_minor>=0);'
reject 'Batch 1C: incompatible table constraints'
"${PSQL[@]}" -q -c 'ALTER TABLE public.wallet_topup_attempts DROP CONSTRAINT wallet_topup_attempts_amount_minor_check; ALTER TABLE public.wallet_topup_attempts ADD CONSTRAINT wallet_topup_attempts_amount_minor_check CHECK(amount_minor>0);'
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261246000000_wallet_topups_batch1c.sql"
echo BATCH1C_CATALOG_REGRESSIONS=11_PASSED
