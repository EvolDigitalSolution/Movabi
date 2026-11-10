#!/usr/bin/env bash
# =============================================================================
# Batch 1C — disposable-database runner (isolated PostgreSQL 15).
#   docker run --rm --network none -e POSTGRES_PASSWORD=test \
#     -e POSTGRES_DB=vaydu_batch1c_test --name vaydu-batch1c-pg postgres:15
#   EXPECTED_DB=vaydu_batch1c_test ./scripts/run-wallet-topups-batch1c-db.sh
# =============================================================================
set -euo pipefail
EXPECTED_DB="${EXPECTED_DB:-vaydu_batch1c_test}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PSQL=(psql -X -v ON_ERROR_STOP=1 -d "$EXPECTED_DB")
fail() { echo "FATAL: $*" >&2; exit 2; }
step() { echo "== $* =="; }

case "$EXPECTED_DB" in
  postgres|template0|template1) fail "'$EXPECTED_DB' is protected";;
  *movabi*) fail "'$EXPECTED_DB' looks like an application database";;
  *_batch1c_test) ;;
  *) fail "'$EXPECTED_DB' must match *_batch1c_test";;
esac
ACTUAL="$("${PSQL[@]}" -qAt -c 'SELECT current_database()' 2>/dev/null || true)"
[ "$ACTUAL" = "$EXPECTED_DB" ] || fail "current_database()=$ACTUAL != $EXPECTED_DB"
echo "Runner target: $EXPECTED_DB"

step "0. fixture"
"${PSQL[@]}" -f "$ROOT/scripts/check-wallet-topups-batch1c-fixture.sql"

step "1. apply Batch 1A"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261244000000_wallet_metadata_batch1a.sql"

step "2. apply Batch 1B"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261245000000_wallet_accounting_foundation_batch1b.sql"

step "3. apply Batch 1C"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261246000000_wallet_topups_batch1c.sql"

step "4. Batch 1C top-up test"
"${PSQL[@]}" -f "$ROOT/scripts/check-wallet-topups-batch1c.sql"

step "5. Batch 1C concurrent initiation test"
EXPECTED_DB="$EXPECTED_DB" "$ROOT/scripts/check-wallet-topups-batch1c-concurrency.sh"

step "6. safe rerun of Batch 1C"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261246000000_wallet_topups_batch1c.sql"

step "7. Actual role-boundary verification"
"${PSQL[@]}" -f "$ROOT/scripts/check-wallet-topups-batch1c-role.sql"
step "8. Malformed-object rejection and unchanged schema"
EXPECTED_DB="$EXPECTED_DB" bash "$ROOT/scripts/check-wallet-topups-batch1c-regression.sh"
echo "Batch 1C runner: PASSED"
