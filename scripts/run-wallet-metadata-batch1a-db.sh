#!/usr/bin/env bash
# =============================================================================
# Batch 1A — disposable-database runner.
#
# Execution environment (required): an ISOLATED PostgreSQL 15 container with no
# application volumes and no network, e.g.:
#   docker run --rm --network none -e POSTGRES_PASSWORD=test \
#     -e POSTGRES_DB=vaydu_batch1a_test --name vaydu-batch1a-pg postgres:15
# then mount this repository read-only and run the runner against that DB.
#
# Usage (explicit target required):
#   EXPECTED_DB=vaydu_batch1a_test ./scripts/run-wallet-metadata-batch1a-db.sh
#
# Every migration attempt is a SEPARATE psql invocation; exit status and error
# text are captured, and a reconnect compares the schema against a pre-attempt
# snapshot so conflicting objects remain unchanged and no objects leak.
# =============================================================================
set -euo pipefail

EXPECTED_DB="${EXPECTED_DB:-vaydu_batch1a_test}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261244000000_wallet_metadata_batch1a.sql"
FIXTURE="$ROOT/scripts/check-wallet-metadata-batch1a-fixture.sql"
ASSERT="$ROOT/scripts/check-wallet-metadata-batch1a-assert.sql"
DIFF="$ROOT/scripts/check-wallet-metadata-batch1a-diff.sql"

PSQL=(psql -X -v ON_ERROR_STOP=1 -d "$EXPECTED_DB")

fail() { echo "FATAL: $*" >&2; exit 2; }
step() { echo "== $* =="; }

if [ -z "$EXPECTED_DB" ]; then
  fail "EXPECTED_DB is required (disposable test database: vaydu_batch1a_test)"
fi

# Destructive guard: reject protected names and require the disposable convention.
case "$EXPECTED_DB" in
  postgres|template0|template1) fail "'$EXPECTED_DB' is a protected system database";;
esac
case "$EXPECTED_DB" in
  *movabi*) fail "'$EXPECTED_DB' looks like an application database (contains 'movabi')";;
esac
case "$EXPECTED_DB" in
  *_batch1a_test) ;;
  *) fail "'$EXPECTED_DB' must match the disposable-test naming convention *_batch1a_test";;
esac

# Confirm we are connected to the expected disposable database.
ACTUAL_DB="$("${PSQL[@]}" -qAt -c 'SELECT current_database()' 2>/dev/null || true)"
if [ "$ACTUAL_DB" != "$EXPECTED_DB" ]; then
  fail "current_database()=$ACTUAL_DB does not match EXPECTED_DB=$EXPECTED_DB (or connection failed)"
fi
echo "Runner target: $EXPECTED_DB (disposable, convention *_batch1a_test)"

# Required-columns template for the synthetic wallet_transactions fixture.
WT_BASE="id uuid PRIMARY KEY DEFAULT gen_random_uuid(), wallet_id uuid, user_id uuid, job_id uuid, transaction_type text NOT NULL, amount numeric NOT NULL, description text, metadata jsonb, balance_before_available numeric, balance_after_available numeric, balance_before_reserved numeric, balance_after_reserved numeric, stripe_payment_intent_id text, payment_intent_id text, created_at timestamptz DEFAULT now()"

run_migration() { "${PSQL[@]}" -f "$MIGRATION" 2>&1; }

# expect_reject: reset to a bad shape, snapshot the schema, run migration (expect
# a specific rejection), then reconnect and verify the schema is unchanged.
expect_reject() {
  local label="$1" expected="$2" setup_sql="$3"
  step "$label"
  "${PSQL[@]}" -qAt -c "$setup_sql"
  "${PSQL[@]}" -qAt -c "DROP TABLE IF EXISTS batch1a_pre_negative; CREATE TABLE batch1a_pre_negative AS SELECT 'col' AS kind, column_name AS name, udt_name||'|'||is_nullable||'|'||coalesce(column_default,'') AS def FROM information_schema.columns WHERE table_schema='public' AND table_name='wallet_transactions' UNION ALL SELECT 'idx', indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='wallet_transactions';"
  local out rc
  out="$(run_migration)" && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: $label unexpectedly succeeded" >&2; exit 1
  fi
  if ! grep -qF "$expected" <<<"$out"; then
    echo "FAIL: $label error mismatch (expected '$expected'):" >&2
    printf '%s\n' "$out" | head -5 >&2
    exit 1
  fi
  if ! "${PSQL[@]}" -qAt -f "$DIFF" >/dev/null 2>&1; then
    echo "FAIL: $label leaked or changed schema objects" >&2
    exit 1
  fi
  echo "PASS: $label rejected with '$expected' and left the schema unchanged"
}

# 0. Fixture.
step "fixture"
"${PSQL[@]}" -f "$FIXTURE"

# 1. First application (print diagnostics on failure).
step "1. first application"
first_out="$(run_migration)" && first_rc=0 || first_rc=$?
if [ "$first_rc" -ne 0 ]; then
  echo "FAIL: first application failed:" >&2
  printf '%s\n' "$first_out" >&2
  exit 1
fi

# 1+11. Hard assertions.
step "hard assertions (1/7/8/9/10/11)"
"${PSQL[@]}" -f "$ASSERT"

# 2. Safe rerun (print diagnostics on failure).
step "2. safe rerun"
rerun_out="$(run_migration)" && rerun_rc=0 || rerun_rc=$?
if [ "$rerun_rc" -ne 0 ]; then
  echo "FAIL: safe rerun failed:" >&2
  printf '%s\n' "$rerun_out" >&2
  exit 1
fi
echo "PASS: rerun succeeded without error"

# Negative preconditions (specific rejections).
expect_reject "3. wrong-type metadata column" "has wrong type" \
  "DROP TABLE IF EXISTS public.wallet_transactions CASCADE; CREATE TABLE public.wallet_transactions ($WT_BASE, event_key integer);"

expect_reject "4. correct-type NOT NULL metadata column" "must be nullable" \
  "DROP TABLE IF EXISTS public.wallet_transactions CASCADE; CREATE TABLE public.wallet_transactions ($WT_BASE, tenant_id uuid NOT NULL);"

expect_reject "5. correct-type non-NULL default metadata column" "must have no default" \
  "DROP TABLE IF EXISTS public.wallet_transactions CASCADE; CREATE TABLE public.wallet_transactions ($WT_BASE, tenant_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid);"

expect_reject "6. wrong same-name index (non-unique)" "is not UNIQUE" \
  "DROP TABLE IF EXISTS public.wallet_transactions CASCADE; CREATE TABLE public.wallet_transactions ($WT_BASE, event_key text); CREATE INDEX wallet_transactions_event_key_uniq ON public.wallet_transactions (event_key);"

expect_reject "7. same-name unique index with narrower predicate" "predicate is not exactly" \
  "DROP TABLE IF EXISTS public.wallet_transactions CASCADE; CREATE TABLE public.wallet_transactions ($WT_BASE, event_key text); CREATE UNIQUE INDEX wallet_transactions_event_key_uniq ON public.wallet_transactions (event_key) WHERE event_key IS NOT NULL AND amount > 0;"

echo "Batch 1A disposable-database runner: ALL SCENARIOS PASSED"
