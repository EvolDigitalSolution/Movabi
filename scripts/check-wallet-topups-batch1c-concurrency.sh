#!/usr/bin/env bash
set -euo pipefail
: "${EXPECTED_DB:?explicit isolated database required}"
case "$EXPECTED_DB" in *movabi*|postgres|template*) exit 2;; *_batch1c_test) ;; *) exit 2;; esac
P=(psql -X -qAt -v ON_ERROR_STOP=1 -d "$EXPECTED_DB")
test "$("${P[@]}" -c 'SELECT current_database()')" = "$EXPECTED_DB"
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
RUN="$(date +%s)-$$"; T=11111111-1111-1111-1111-111111111111; O=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
"${P[@]}" <<'SQL'
INSERT INTO public.wallet_collection_config VALUES('enabled','true'),('max_amount_minor_GBP','1000000') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
UPDATE public.market_payment_routes SET enabled=true,merchant_approved=true,adapter_ready=true,capabilities=ARRAY['collect']::text[] WHERE provider='stripe';
CREATE TABLE batch1c_barrier(group_key text,worker int,PRIMARY KEY(group_key,worker));
SQL
init() { printf "public.initiate_wallet_topup('%s','%s','%s','GB','GBP',%s,'customer_credit','stripe','stripe-platform','%s')" "$1" "$T" "$O" "$2" "$1"; }
worker() {
 local group="$1" number="$2" expression="$3"
 "${P[@]}" > "$D/$number" 2>&1 <<SQL
SET statement_timeout='15s';
INSERT INTO batch1c_barrier VALUES('$group',$number);
DO \$\$ DECLARE n int; BEGIN
 FOR n IN 1..200 LOOP
  EXIT WHEN (SELECT count(*) FROM batch1c_barrier WHERE group_key='$group')=2;
  PERFORM pg_sleep(0.02);
 END LOOP;
 IF (SELECT count(*) FROM batch1c_barrier WHERE group_key='$group')<>2 THEN RAISE EXCEPTION 'BARRIER_TIMEOUT'; END IF;
END \$\$;
DO \$\$ DECLARE v text; BEGIN
 v:=($expression)::text;
 RAISE NOTICE 'RESULT OK %',v;
EXCEPTION WHEN others THEN RAISE NOTICE 'RESULT ERR %',SQLSTATE;
END \$\$;
SQL
}
pair() {
 local group="$1" left="$2" right="$3" rc1=0 rc2=0
 worker "$group" 1 "$left" & local p1=$!
 worker "$group" 2 "$right" & local p2=$!
 wait "$p1" || rc1=$?; wait "$p2" || rc2=$?
 if [ "$rc1" -ne 0 ] || [ "$rc2" -ne 0 ]; then cat "$D/1" "$D/2"; exit 1; fi
 A=$(sed -nE 's/^NOTICE:  (RESULT (OK [a-z0-9-]+|ERR [A-Z0-9]{5}))$/\1/p' "$D/1")
 B=$(sed -nE 's/^NOTICE:  (RESULT (OK [a-z0-9-]+|ERR [A-Z0-9]{5}))$/\1/p' "$D/2")
 test -n "$A" && test -n "$B" || { cat "$D/1" "$D/2"; exit 1; }
}
same_uuid() { [[ "$A" =~ ^RESULT\ OK\ [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] && [ "$A" = "$B" ] || { cat "$D/1" "$D/2"; exit 1; }; }
one_error() { { [[ "$A" == RESULT\ OK\ * ]] && [ "$B" = "RESULT ERR $1" ]; } || { [[ "$B" == RESULT\ OK\ * ]] && [ "$A" = "RESULT ERR $1" ]; } || { cat "$D/1" "$D/2"; exit 1; }; }
assert_sql() { test "$("${P[@]}" -c "$1")" = "$2" || { echo "FAILED $1"; exit 1; }; }
k="same-$RUN"; pair "$k" "$(init "$k" 100)" "$(init "$k" 100)"; same_uuid
assert_sql "SELECT count(*) FROM wallet_topup_attempts WHERE attempt_key='$k'" 1
echo 'PASS concurrent identical initiation'
k="conflict-$RUN"; pair "$k" "$(init "$k" 100)" "$(init "$k" 200)"; one_error BP002
echo 'PASS concurrent conflicting initiation'
id=$("${P[@]}" -c "SELECT $(init "claim-$RUN" 100)")
pair "claim-$RUN" "public.claim_wallet_topup_submission('$id')" "public.claim_wallet_topup_submission('$id')"
{ [ "$A" = 'RESULT OK true' ] && [ "$B" = 'RESULT OK false' ]; } || { [ "$B" = 'RESULT OK true' ] && [ "$A" = 'RESULT OK false' ]; } || exit 1
echo 'PASS one durable submission claim'
"${P[@]}" -c "SELECT public.record_wallet_topup_provider_reference('$id','pi-$RUN')" >/dev/null
expr="public.confirm_wallet_topup('$id','pi-$RUN','stripe-platform','GBP',100,'succeeded')"
pair "confirm-$RUN" "$expr" "$expr"; same_uuid
assert_sql "SELECT count(*) FROM wallet_business_events WHERE event_key='wallet-topup:$id'" 1
assert_sql "SELECT count(*) FROM wallet_movements m JOIN wallet_business_events e ON e.id=m.event_id WHERE e.event_key='wallet-topup:$id'" 2
assert_sql "SELECT sum(m.amount_minor) FROM wallet_movements m JOIN wallet_business_events e ON e.id=m.event_id WHERE e.event_key='wallet-topup:$id'" 0
echo 'PASS concurrent confirmation: one event, two balanced movements'
expr="public.record_wallet_topup_verification('$id','evidence-$RUN','pi-$RUN','stripe-platform','GBP',100,'succeeded')"
pair "evidence-$RUN" "$expr" "$expr"
test "$A" = 'RESULT OK true' && test "$B" = 'RESULT OK true'
assert_sql "SELECT count(*) FROM wallet_topup_verifications WHERE evidence_key='evidence-$RUN'" 1
echo 'PASS concurrent identical evidence'
expr2="public.record_wallet_topup_verification('$id','conflict-evidence-$RUN','pi-$RUN','stripe-platform','GBP',200,'succeeded')"
expr="public.record_wallet_topup_verification('$id','conflict-evidence-$RUN','pi-$RUN','stripe-platform','GBP',100,'succeeded')"
pair "evidence-conflict-$RUN" "$expr" "$expr2"; one_error BP002
echo 'PASS concurrent conflicting evidence'
id2=$("${P[@]}" -c "SELECT $(init "duplicate-$RUN" 100)")
# Same provider payment cannot be bound to another attempt.
pair "duplicate-$RUN" "public.record_wallet_topup_provider_reference('$id2','pi-$RUN')" "public.record_wallet_topup_provider_reference('$id','pi-$RUN')"; one_error 23505
assert_sql "SELECT count(*) FROM wallet_topup_attempts WHERE provider_reference='pi-$RUN'" 1
echo 'PASS duplicate provider payment reference rejected'
"${P[@]}" -c 'DROP TABLE batch1c_barrier'
echo BATCH1C_DATABASE_CONCURRENCY=7_PASSED
