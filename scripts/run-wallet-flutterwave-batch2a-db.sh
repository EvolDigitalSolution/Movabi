#!/usr/bin/env bash
# =============================================================================
# Flutterwave Batch 2A-2D — guarded disposable PostgreSQL 15 runner.
# Proves the target is isolated, applies every prerequisite + migration, and
# runs migration/rerun, accounting, fee, duplicate/concurrency, role-boundary,
# refund, rollback and Stripe/Kora regression tests. Any failure exits non-zero.
#   docker run --rm --network none -e POSTGRES_PASSWORD=test \
#     -e POSTGRES_DB=vaydu_batch2a_test --name vaydu-batch2a-pg postgres:15
#   EXPECTED_DB=vaydu_batch2a_test ./scripts/run-wallet-flutterwave-batch2a-db.sh
# =============================================================================
set -euo pipefail
EXPECTED_DB="${EXPECTED_DB:-vaydu_batch2a_test}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PSQL=(psql -X -v ON_ERROR_STOP=1 -d "$EXPECTED_DB")
fail() { echo "FAIL: $*" >&2; exit 2; }
step() { echo "== $* =="; }

# 1. Prove isolation: refuse application/system databases and remote hosts.
case "$EXPECTED_DB" in
  postgres|template0|template1) fail "'$EXPECTED_DB' is protected";;
  *movabi*|*production*|*staging*) fail "'$EXPECTED_DB' looks like an application database";;
  *_batch2a_test) ;;
  *) fail "'$EXPECTED_DB' must match *_batch2a_test";;
esac
ACTUAL="$("${PSQL[@]}" -qAt -c 'SELECT current_database()' 2>/dev/null || true)"
[ "$ACTUAL" = "$EXPECTED_DB" ] || fail "current_database()=$ACTUAL != $EXPECTED_DB"
HOST="$("${PSQL[@]}" -qAt -c "SELECT inet_server_addr()" 2>/dev/null || echo local)"
if [ "$HOST" != "local" ] && [ "$HOST" != "127.0.0.1" ] && [ "$HOST" != "::1" ]; then
  fail "refusing non-local server address: $HOST"
fi
echo "Runner target: $EXPECTED_DB (local, isolated)"

step "0. fixtures (roles, auth.uid, market_availability, market_payment_routes, wallet_transactions)"
"${PSQL[@]}" -f "$ROOT/scripts/check-wallet-topups-batch1c-fixture.sql"

step "1. apply prerequisites + migrations (1A..2C; 2D applied after the Batch 1C regression test)"
for m in \
  20261244000000_wallet_metadata_batch1a.sql \
  20261245000000_wallet_accounting_foundation_batch1b.sql \
  20261246000000_wallet_topups_batch1c.sql \
  20261254000000_flutterwave_provider_batch2a.sql \
  20261254100000_wallet_fee_freeze_batch2b.sql \
  20261254200000_flutterwave_provider_accept_batch2c.sql; do
  step "apply $m"
  "${PSQL[@]}" -f "$ROOT/supabase/migrations/$m"
done

step "2. Batch 1C regression (pre-2D: original lifecycle, no legacy gate)"
"${PSQL[@]}" -f "$ROOT/scripts/check-wallet-topups-batch1c.sql"

step "3. apply Batch 2D (legacy classification + atomic confirm)"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261254300000_wallet_atomic_confirm_batch2d.sql"

step "2. safe rerun (idempotency) — do NOT rerun Batch 1C after 2C (it would revert provider widening)"
for m in \
  20261254000000_flutterwave_provider_batch2a.sql \
  20261254100000_wallet_fee_freeze_batch2b.sql \
  20261254200000_flutterwave_provider_accept_batch2c.sql \
  20261254300000_wallet_atomic_confirm_batch2d.sql; do
  "${PSQL[@]}" -f "$ROOT/supabase/migrations/$m" || fail "rerun failed: $m"
done

step "4. fee + Flutterwave SQL test"
"${PSQL[@]}" -f "$ROOT/scripts/check-wallet-flutterwave-batch2a.sql"

step "4. concurrency (duplicate + concurrent initiation)"
EXPECTED_DB="$EXPECTED_DB" "$ROOT/scripts/check-wallet-topups-batch1c-concurrency.sh"

step "5. role-boundary"
"${PSQL[@]}" -f "$ROOT/scripts/check-wallet-accounting-batch1b-role.sql"

step "6. rollback safety (refuses when financial fee snapshots exist)"
"${PSQL[@]}" -f "$ROOT/scripts/rollback-wallet-flutterwave-batch2a.sql" && fail "rollback unexpectedly succeeded with financial data present"

step "7. Vitest + type checks (run on the extracted copy)"
cd "$ROOT"
npx tsc --noEmit -p tsconfig.spec.json
npx vitest run src/testing/wallet-flutterwave-batch2a.spec.ts

echo "Flutterwave Batch 2A-2D runner: PASSED"
