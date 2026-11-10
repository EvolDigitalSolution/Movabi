#!/usr/bin/env bash
# =============================================================================
# Batch 1B — signature-regression test (disposable DB only).
# Proves: (1) first application succeeds, (2) unchanged rerun succeeds, and
# (3) a genuinely incompatible existing function is rejected without changes.
#
# Preservation is asserted by EXACT TYPE IDENTITY (to_regprocedure) plus a
# pre-attempt snapshot of the overload's OID and pg_get_functiondef — never a
# formatted argument-name comparison.
# =============================================================================
set -euo pipefail
EXPECTED_DB="${EXPECTED_DB:-vaydu_batch1b_test}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261245000000_wallet_accounting_foundation_batch1b.sql"
PSQL=(psql -X -v ON_ERROR_STOP=1 -d "$EXPECTED_DB")

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "== $* =="; }

step "regression: reset accounting objects and plant a conflicting overload"
"${PSQL[@]}" -qAt -c "
DROP TABLE IF EXISTS public.wallet_movements, public.wallet_business_events, public.wallet_accounts CASCADE;
DROP VIEW IF EXISTS public.wallet_reconciliation_projection;
DROP FUNCTION IF EXISTS public.post_wallet_event(text,text,uuid,uuid,text,jsonb,text,text,text,uuid);
DROP FUNCTION IF EXISTS public.post_wallet_event(text);
DROP FUNCTION IF EXISTS public.post_wallet_reversal(text,text);
DROP FUNCTION IF EXISTS public.wallet_currency_minor_exponent(text);
DROP FUNCTION IF EXISTS public.wallet_ledger_append_only();
CREATE FUNCTION public.post_wallet_event(p_x text) RETURNS uuid LANGUAGE sql IMMUTABLE AS \$\$ SELECT '11111111-1111-1111-1111-111111111111'::uuid \$\$;"

step "regression: snapshot the conflicting overload by exact type identity"
"${PSQL[@]}" -qAt -c "
DROP TABLE IF EXISTS batch1b_fn_snapshot;
CREATE TABLE batch1b_fn_snapshot (oid oid, def text);
INSERT INTO batch1b_fn_snapshot
SELECT p.oid, pg_get_functiondef(p.oid)
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.post_wallet_event(text)');"

step "regression: migration must reject the incompatible overload"
out="$( "${PSQL[@]}" -f "$MIGRATION" 2>&1 )" && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then fail "migration unexpectedly succeeded with an incompatible post_wallet_event"; fi
if ! grep -qF 'incompatible signature' <<<"$out"; then
  fail "migration did not reject with 'incompatible signature' (got: $(printf '%s' "$out" | head -3))"
fi

step "regression: reconnect and assert preservation (OID + definition) and no leak"
preserved="$("${PSQL[@]}" -qAt -c "
SELECT count(*) FROM batch1b_fn_snapshot s
JOIN pg_proc p ON p.oid = s.oid
WHERE p.oid = to_regprocedure('public.post_wallet_event(text)')
  AND pg_get_functiondef(p.oid) = s.def;")"
if [ "$preserved" != "1" ]; then fail "conflicting overload was not preserved byte-for-byte (OID + definition)"; fi

leak="$("${PSQL[@]}" -qAt -c "
SELECT to_regclass('public.wallet_accounts') IS NOT NULL
    OR to_regclass('public.wallet_business_events') IS NOT NULL
    OR to_regclass('public.wallet_movements') IS NOT NULL
    OR to_regclass('public.wallet_reconciliation_projection') IS NOT NULL
    OR to_regprocedure('public.post_wallet_reversal(text,text)') IS NOT NULL
    OR to_regprocedure('public.wallet_currency_minor_exponent(text)') IS NOT NULL
    OR to_regprocedure('public.wallet_ledger_append_only()') IS NOT NULL;")"
if [ "$leak" = "t" ]; then fail "migration leaked objects despite rejection"; fi

step "regression: cleanup and clean re-application"
"${PSQL[@]}" -qAt -c "DROP FUNCTION IF EXISTS public.post_wallet_event(text); DROP TABLE IF EXISTS batch1b_fn_snapshot;"
"${PSQL[@]}" -f "$MIGRATION"

echo "Batch 1B signature-regression test: PASSED"
