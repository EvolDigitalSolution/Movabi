#!/usr/bin/env bash
# =============================================================================
# Batch 1B — independent-session concurrency tests (disposable DB only).
# A synchronization barrier (batch1b_barrier) ensures deliberate, bounded
# transaction overlap; both child exit codes are captured; exact event IDs,
# movement counts, balanced totals and SQLSTATEs are asserted.
#   EXPECTED_DB=vaydu_batch1b_test ./scripts/check-wallet-accounting-batch1b-concurrency.sh
# =============================================================================
set -euo pipefail
EXPECTED_DB="${EXPECTED_DB:-vaydu_batch1b_test}"
PSQL=(psql -X -v ON_ERROR_STOP=1 -qAt -d "$EXPECTED_DB")
RUNID="$(date +%s%N)"
TENANT="11111111-1111-1111-1111-111111111111"
OWNER="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "== $* =="; }

# Barrier table (per run). Distinct synthetic identities per scenario.
"${PSQL[@]}" -c "DROP TABLE IF EXISTS public.batch1b_barrier; CREATE TABLE public.batch1b_barrier(run_id text, session_id text);"

post_expr() { printf "public.post_wallet_event('%s','%s','%s','%s','GBP','%s'::jsonb,%s,%s,%s)" "$1" "$2" "$TENANT" "$OWNER" "$3" "$4" "$5" "$6"; }
rev_expr()  { printf "public.post_wallet_reversal('%s','%s')" "$1" "$2"; }

# Write a session .sql file: (1) committed barrier registration, (2) bounded
# barrier wait, then the post expression, reporting RESULT OK <id>/ERR <sqlstate>.
write_session() {
  local file="$1" run="$2" sid="$3" expr="$4"
  cat > "$file" <<SQL
INSERT INTO public.batch1b_barrier(run_id, session_id) VALUES ('$run','$sid');
DO \$\$
DECLARE i int := 0; v uuid;
BEGIN
  LOOP
    IF (SELECT count(*) FROM public.batch1b_barrier WHERE run_id='$run') >= 2 THEN EXIT; END IF;
    i := i + 1; IF i > 200 THEN RAISE EXCEPTION 'barrier timeout'; END IF;
    PERFORM pg_sleep(0.02);
  END LOOP;
  v := $expr;
  RAISE NOTICE 'RESULT OK %', v;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'RESULT ERR %', SQLSTATE;
END \$\$;
SQL
}

run2() {
  local f1="$1" f2="$2"
  OUT1="$(mktemp)"; OUT2="$(mktemp)"
  set +e
  timeout 20s "${PSQL[@]}" -f "$f1" >"$OUT1" 2>&1 & P1=$!
  timeout 20s "${PSQL[@]}" -f "$f2" >"$OUT2" 2>&1 & P2=$!
  wait "$P1"; R1=$?
  wait "$P2"; R2=$?
  set -e
}
res() { grep -oE 'RESULT (OK|ERR) [0-9a-fA-F-]+|RESULT (OK|ERR) BP[0-9]+' "$1" | head -1 || echo "NO_RESULT"; }
dump() { echo "--- session1 (exit $R1) ---"; cat "$OUT1"; echo "--- session2 (exit $R2) ---"; cat "$OUT2"; }
ok_uuid() { [[ "$1" =~ ^RESULT\ OK\ [0-9a-fA-F-]{36}$ ]]; }

L1='[{"accountPurpose":"customer_credit","amountMinor":100},{"accountPurpose":"platform_funding","amountMinor":-100}]'

# 1. Same key / same terms -> both exit 0, RESULT OK <UUID>, identical, 1 event + 2 movements.
step "1. same key / same terms"
K1="internal:cc1:$RUNID"
F1="$(mktemp)"; F2="$(mktemp)"
write_session "$F1" "$RUNID" s1 "$(post_expr "$K1" topup "$L1" "'stripe'" "'stripe-platform'" "'pi_same'")"
write_session "$F2" "$RUNID" s2 "$(post_expr "$K1" topup "$L1" "'stripe'" "'stripe-platform'" "'pi_same'")"
run2 "$F1" "$F2"
A="$(res "$OUT1")"; B="$(res "$OUT2")"
if [ "$R1" -ne 0 ] || [ "$R2" -ne 0 ]; then dump; fail "same-key sessions exited non-zero ($R1/$R2)"; fi
if ! ok_uuid "$A" || ! ok_uuid "$B"; then dump; fail "expected RESULT OK <UUID> on both, got '$A' / '$B'"; fi
if [ "${A#RESULT OK }" != "${B#RESULT OK }" ]; then dump; fail "same-key UUIDs differ ($A vs $B)"; fi
ec="$("${PSQL[@]}" -c "SELECT count(*) FROM public.wallet_business_events WHERE event_key='$K1';")"
mc="$("${PSQL[@]}" -c "SELECT count(*) FROM public.wallet_movements m JOIN public.wallet_business_events e ON e.id=m.event_id WHERE e.event_key='$K1';")"
[ "$ec" = "1" ] && [ "$mc" = "2" ] || { dump; fail "expected 1 event + 2 movements, got $ec/$mc"; }
echo "PASS: both returned ${A#RESULT OK } (1 event, 2 movements)"

# 2. Same key / different balanced terms -> one OK, one BP002 (both exit 0).
step "2. same key / different balanced terms"
K2="internal:cc2:$RUNID"
L2a='[{"accountPurpose":"customer_credit","amountMinor":200},{"accountPurpose":"platform_funding","amountMinor":-200}]'
L2b='[{"accountPurpose":"customer_credit","amountMinor":300},{"accountPurpose":"platform_funding","amountMinor":-300}]'
write_session "$F1" "$RUNID" s1 "$(post_expr "$K2" topup "$L2a" "'stripe'" "'stripe-platform'" "'pi_d1'")"
write_session "$F2" "$RUNID" s2 "$(post_expr "$K2" topup "$L2b" "'stripe'" "'stripe-platform'" "'pi_d2'")"
run2 "$F1" "$F2"
A="$(res "$OUT1")"; B="$(res "$OUT2")"
if [ "$R1" -ne 0 ] || [ "$R2" -ne 0 ]; then dump; fail "different-terms sessions exited non-zero ($R1/$R2)"; fi
if ! { { ok_uuid "$A" && [[ "$B" == "RESULT ERR BP002" ]]; } || { ok_uuid "$B" && [[ "$A" == "RESULT ERR BP002" ]]; }; }; then
  dump; fail "expected one OK + one BP002, got '$A' / '$B'"
fi
echo "PASS: $A / $B"

# 3. Different keys / shared accounts -> 2 events + 4 movements, +500/-500 linked totals.
step "3. different keys / shared accounts"
K3a="internal:cc3a:$RUNID"; K3b="internal:cc3b:$RUNID"
write_session "$F1" "$RUNID" s1 "$(post_expr "$K3a" topup "$L2a" "'stripe'" "'stripe-platform'" "'pi_s1'")"
write_session "$F2" "$RUNID" s2 "$(post_expr "$K3b" topup "$L2b" "'stripe'" "'stripe-platform'" "'pi_s2'")"
run2 "$F1" "$F2"
A="$(res "$OUT1")"; B="$(res "$OUT2")"
if [ "$R1" -ne 0 ] || [ "$R2" -ne 0 ]; then dump; fail "shared-account sessions exited non-zero ($R1/$R2)"; fi
if ! ok_uuid "$A" || ! ok_uuid "$B"; then dump; fail "shared-account sessions did not both succeed ($A / $B)"; fi
ec="$("${PSQL[@]}" -c "SELECT count(*) FROM public.wallet_business_events WHERE event_key IN ('$K3a','$K3b');")"
mc="$("${PSQL[@]}" -c "SELECT count(*) FROM public.wallet_movements m JOIN public.wallet_business_events e ON e.id=m.event_id WHERE e.event_key IN ('$K3a','$K3b');")"
cc="$("${PSQL[@]}" -c "SELECT sum(m.amount_minor) FROM public.wallet_movements m JOIN public.wallet_accounts a ON a.id=m.account_id JOIN public.wallet_business_events e ON e.id=m.event_id WHERE e.event_key IN ('$K3a','$K3b') AND a.balance_purpose='customer_credit';")"
pf="$("${PSQL[@]}" -c "SELECT sum(m.amount_minor) FROM public.wallet_movements m JOIN public.wallet_accounts a ON a.id=m.account_id JOIN public.wallet_business_events e ON e.id=m.event_id WHERE e.event_key IN ('$K3a','$K3b') AND a.balance_purpose='platform_funding';")"
[ "$ec" = "2" ] && [ "$mc" = "4" ] && [ "$cc" = "500" ] && [ "$pf" = "-500" ] || { dump; fail "scenario3: events=$ec movements=$mc customer_credit=$cc platform_funding=$pf (expected 2/4/500/-500)"; }
echo "PASS: 2 events, 4 movements, customer_credit=+500, platform_funding=-500"

# 4. Same reversal key -> both resolve to one reversal (identical UUID).
step "4. same reversal key"
ORIG="internal:orig:$RUNID"; REV="internal:rev:$RUNID"
"${PSQL[@]}" -c "SELECT $(post_expr "$ORIG" topup "$L1" "'stripe'" "'stripe-platform'" "'pi_orig'")" >/dev/null
write_session "$F1" "$RUNID" s1 "$(rev_expr "$ORIG" "$REV")"
write_session "$F2" "$RUNID" s2 "$(rev_expr "$ORIG" "$REV")"
run2 "$F1" "$F2"
A="$(res "$OUT1")"; B="$(res "$OUT2")"
if [ "$R1" -ne 0 ] || [ "$R2" -ne 0 ]; then dump; fail "same-reversal sessions exited non-zero ($R1/$R2)"; fi
if ! ok_uuid "$A" || ! ok_uuid "$B"; then dump; fail "same-reversal sessions did not both succeed ($A / $B)"; fi
if [ "${A#RESULT OK }" != "${B#RESULT OK }" ]; then dump; fail "same reversal key returned different IDs ($A vs $B)"; fi
rc="$("${PSQL[@]}" -c "SELECT count(*) FROM public.wallet_business_events WHERE event_key='$REV';")"
[ "$rc" = "1" ] || { dump; fail "expected exactly 1 reversal event, got $rc"; }
echo "PASS: both returned ${A#RESULT OK } (one reversal)"

# 5. Different reversal keys for one original -> one OK, one BP005.
step "5. different reversal keys for one original"
ORIG2="internal:orig2:$RUNID"; REV5a="internal:rev5a:$RUNID"; REV5b="internal:rev5b:$RUNID"
"${PSQL[@]}" -c "SELECT $(post_expr "$ORIG2" topup "$L1" "'stripe'" "'stripe-platform'" "'pi_orig2'")" >/dev/null
write_session "$F1" "$RUNID" s1 "$(rev_expr "$ORIG2" "$REV5a")"
write_session "$F2" "$RUNID" s2 "$(rev_expr "$ORIG2" "$REV5b")"
run2 "$F1" "$F2"
A="$(res "$OUT1")"; B="$(res "$OUT2")"
if [ "$R1" -ne 0 ] || [ "$R2" -ne 0 ]; then dump; fail "different-reversal sessions exited non-zero ($R1/$R2)"; fi
if ! { { ok_uuid "$A" && [[ "$B" == "RESULT ERR BP005" ]]; } || { ok_uuid "$B" && [[ "$A" == "RESULT ERR BP005" ]]; }; }; then
  dump; fail "expected one OK + one BP005, got '$A' / '$B'"
fi
rc="$("${PSQL[@]}" -c "SELECT count(*) FROM public.wallet_business_events WHERE reverses_event_id = (SELECT id FROM public.wallet_business_events WHERE event_key='$ORIG2');")"
rmc="$("${PSQL[@]}" -c "SELECT count(*) FROM public.wallet_movements m JOIN public.wallet_business_events e ON e.id=m.event_id WHERE e.reverses_event_id = (SELECT id FROM public.wallet_business_events WHERE event_key='$ORIG2');")"
[ "$rc" = "1" ] && [ "$rmc" = "2" ] || { dump; fail "expected 1 reversal + 2 movements, got $rc/$rmc"; }
echo "PASS: $A / $B (one reversal, two movements)"

"${PSQL[@]}" -c "DROP TABLE IF EXISTS public.batch1b_barrier;"
rm -f "$F1" "$F2" "$OUT1" "$OUT2" 2>/dev/null || true
echo "Batch 1B concurrency tests: PASSED"
