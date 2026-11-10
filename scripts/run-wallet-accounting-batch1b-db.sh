#!/usr/bin/env bash
# =============================================================================
# Batch 1B — disposable-database runner.
# Execution environment: an isolated PostgreSQL 15 container, no volumes/network.
#   docker run --rm --network none -e POSTGRES_PASSWORD=test \
#     -e POSTGRES_DB=vaydu_batch1b_test --name vaydu-batch1b-pg postgres:15
# Usage:
#   EXPECTED_DB=vaydu_batch1b_test ./scripts/run-wallet-accounting-batch1b-db.sh
# =============================================================================
set -euo pipefail

EXPECTED_DB="${EXPECTED_DB:-vaydu_batch1b_test}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261245000000_wallet_accounting_foundation_batch1b.sql"
FIXTURE="$ROOT/scripts/check-wallet-accounting-batch1b-fixture.sql"
TEST="$ROOT/scripts/check-wallet-accounting-batch1b.sql"
CONCURRENCY="$ROOT/scripts/check-wallet-accounting-batch1b-concurrency.sh"
REGRESSION="$ROOT/scripts/check-wallet-accounting-batch1b-regression.sh"
ROLE="$ROOT/scripts/check-wallet-accounting-batch1b-role.sql"

PSQL=(psql -X -v ON_ERROR_STOP=1 -d "$EXPECTED_DB")
fail() { echo "FATAL: $*" >&2; exit 2; }
step() { echo "== $* =="; }

case "$EXPECTED_DB" in
  postgres|template0|template1) fail "'$EXPECTED_DB' is a protected system database";;
esac
case "$EXPECTED_DB" in
  *movabi*) fail "'$EXPECTED_DB' looks like an application database";;
esac
case "$EXPECTED_DB" in
  *_batch1b_test) ;;
  *) fail "'$EXPECTED_DB' must match *_batch1b_test";;
esac

ACTUAL_DB="$("${PSQL[@]}" -qAt -c 'SELECT current_database()' 2>/dev/null || true)"
if [ "$ACTUAL_DB" != "$EXPECTED_DB" ]; then
  fail "current_database()=$ACTUAL_DB != EXPECTED_DB=$EXPECTED_DB"
fi
echo "Runner target: $EXPECTED_DB"

run_migration() { "${PSQL[@]}" -f "$MIGRATION" 2>&1; }

step "0. fixture (roles + auth.uid() + market_availability)"
"${PSQL[@]}" -f "$FIXTURE"

step "1. first application"
first_out="$(run_migration)" && first_rc=0 || first_rc=$?
if [ "$first_rc" -ne 0 ]; then
  echo "FAIL: first application failed:" >&2; printf '%s\n' "$first_out" >&2; exit 1
fi

step "2. accounting test"
"${PSQL[@]}" -f "$TEST"

step "3. safe rerun (idempotent)"
rerun_out="$(run_migration)" && rerun_rc=0 || rerun_rc=$?
if [ "$rerun_rc" -ne 0 ]; then
  echo "FAIL: safe rerun failed:" >&2; printf '%s\n' "$rerun_out" >&2; exit 1
fi
echo "PASS: rerun succeeded without error"

step "4. independent-session concurrency test"
EXPECTED_DB="$EXPECTED_DB" "$CONCURRENCY"

step "5. role-boundary verification"
"${PSQL[@]}" -f "$ROLE"

step "6. signature-regression test"
EXPECTED_DB="$EXPECTED_DB" "$REGRESSION"

echo "Batch 1B disposable-database runner: PASSED"
