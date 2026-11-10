#!/usr/bin/env bash
set -euo pipefail
: "${EXPECTED_DB:?isolated DB required}"
case "$EXPECTED_DB" in *movabi*|postgres|template*) exit 2;; *_batch1e_test) ;; *) exit 2;; esac
P=(psql -X -qAt -v ON_ERROR_STOP=1 -d "$EXPECTED_DB")
test "$("${P[@]}" -c 'SELECT current_database()')" = "$EXPECTED_DB"
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
RUN="$(date +%s)-$$"
T=11111111-1111-1111-1111-111111111111; DRIVER=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
J1=$("${P[@]}" -c "SELECT md5('$RUN-1')::uuid");J2=$("${P[@]}" -c "SELECT md5('$RUN-2')::uuid");J3=$("${P[@]}" -c "SELECT md5('$RUN-3')::uuid")
"${P[@]}" <<SQL
INSERT INTO driver_cash_credit_config_v1e VALUES('ride_cash_credit',true);
INSERT INTO driver_cash_credit_enrolments_v1e VALUES('$T','$DRIVER','NG','NGN','concurrency-test',now(),true);
SELECT public.batch1e_test_deposit('$T','$DRIVER','NGN',20000);
SELECT public.batch1e_test_job('$J1','$DRIVER');
SELECT public.batch1e_test_job('$J2','$DRIVER');
CREATE TABLE batch1e_barrier(group_key text,worker integer,PRIMARY KEY(group_key,worker));
SQL
worker(){
 local group="$1" number="$2" stmt="$3"
 "${P[@]}" > "$D/$number" 2>&1 <<SQL
SET statement_timeout='15s';
INSERT INTO batch1e_barrier VALUES('$group',$number);
DO \$\$ DECLARE i int;BEGIN
 FOR i IN 1..200 LOOP
  EXIT WHEN (SELECT count(*) FROM batch1e_barrier WHERE group_key='$group')=2;
  PERFORM pg_sleep(.02);
 END LOOP;
 IF (SELECT count(*) FROM batch1e_barrier WHERE group_key='$group')<>2 THEN RAISE EXCEPTION 'BARRIER_TIMEOUT';END IF;
END \$\$;
DO \$\$ DECLARE v uuid;BEGIN
 $stmt
 RAISE NOTICE 'RESULT OK %',v;
EXCEPTION WHEN others THEN RAISE NOTICE 'RESULT ERR %',SQLSTATE;
END \$\$;
SQL
}
pair(){
 local tag="$1" s1="$2" s2="$3" r1=0 r2=0
 worker "$tag" 1 "$s1" & local p1=$!
 worker "$tag" 2 "$s2" & local p2=$!
 wait "$p1" || r1=$?;wait "$p2" || r2=$?
 if [ "$r1" -ne 0 ] || [ "$r2" -ne 0 ];then cat "$D/1" "$D/2";exit 1;fi
 A=$(sed -nE 's/^NOTICE:  (RESULT (OK [0-9a-f-]+|ERR [A-Z0-9]{5}))$/\1/p' "$D/1")
 B=$(sed -nE 's/^NOTICE:  (RESULT (OK [0-9a-f-]+|ERR [A-Z0-9]{5}))$/\1/p' "$D/2")
 test -n "$A" && test -n "$B" || { cat "$D/1" "$D/2";exit 1; }
}
one_error(){ { [[ "$A" == RESULT\ OK\ * ]] && [ "$B" = "RESULT ERR $1" ]; } || { [[ "$B" == RESULT\ OK\ * ]] && [ "$A" = "RESULT ERR $1" ]; } || { cat "$D/1" "$D/2";exit 1; }; }
assert_sql(){ test "$("${P[@]}" -c "$1")" = "$2" || { echo "FAILED $1";exit 1; }; }
pair "accept-$RUN" "UPDATE jobs SET driver_id='$DRIVER',status='assigned' WHERE id='$J1' RETURNING id INTO v;" "UPDATE jobs SET driver_id='$DRIVER',status='assigned' WHERE id='$J2' RETURNING id INTO v;"
one_error CE004
assert_sql "SELECT count(*) FROM driver_cash_credit_holds_v1e" 1
assert_sql "SELECT sum(required_credit_minor) FROM driver_cash_credit_holds_v1e" 15000
assert_sql "SELECT public.driver_cash_credit_balance_v1e('$T','$DRIVER','NGN')->>'availableMinor'" 5000
echo 'PASS concurrent jobs: only one acceptance/hold; no double spend'
HJOB=$("${P[@]}" -c 'SELECT job_id FROM driver_cash_credit_holds_v1e');HID=$("${P[@]}" -c 'SELECT id FROM driver_cash_credit_holds_v1e')
pair "replay-$RUN" "v:=public.reserve_cash_job_credit_v1e('$HJOB','$DRIVER');" "v:=public.reserve_cash_job_credit_v1e('$HJOB','$DRIVER');"
test "$A" = "RESULT OK $HID" && test "$B" = "RESULT OK $HID"
assert_sql "SELECT count(*) FROM wallet_business_events WHERE event_key='cash-hold:$HID'" 1
echo 'PASS concurrent same-hold replay returns same identity'
pair "resolve-$RUN" "UPDATE jobs SET status='completed' WHERE id='$HJOB' RETURNING id INTO v;" "UPDATE jobs SET status='cancelled' WHERE id='$HJOB' RETURNING id INTO v;"
one_error CE005
assert_sql "SELECT count(*) FROM wallet_business_events WHERE event_key IN ('cash-hold:$HID:release','cash-hold:$HID:settle')" 1
assert_sql "SELECT count(*) FROM driver_cash_credit_holds_v1e WHERE status='held'" 0
echo 'PASS completion/cancellation race resolves once'
# A provider-confirmed deposit reversal races another acceptance on the same scope.
REF=$("${P[@]}" -c "SELECT public.batch1e_test_deposit('$T','$DRIVER','NGN',30000)")
"${P[@]}" -c "SELECT public.batch1e_test_job('$J3','$DRIVER')" >/dev/null
refund="SELECT public.mark_wallet_topup_refunded(id,'concurrent-refund-$RUN',provider_reference,merchant_account_ref,currency_code,amount_minor,'refunded','fixture') INTO v FROM wallet_topup_attempts WHERE id='$REF';"
pair "refund-$RUN" "UPDATE jobs SET driver_id='$DRIVER',status='assigned' WHERE id='$J3' RETURNING id INTO v;" "$refund"
if [[ "$B" != RESULT\ OK\ * ]] || { [[ "$A" != RESULT\ OK\ * ]] && [ "$A" != 'RESULT ERR CE004' ] && [ "$A" != 'RESULT ERR CE006' ]; };then cat "$D/1" "$D/2";exit 1;fi
assert_sql "SELECT status FROM wallet_topup_attempts WHERE id='$REF'" refunded
assert_sql "SELECT (b->>'availableMinor')::numeric>=0 AND ((b->>'deficitMinor')::numeric=0 OR b->>'availableMinor'='0') AND (b->>'consistent')::boolean FROM (SELECT public.driver_cash_credit_balance_v1e('$T','$DRIVER','NGN') b) x" t
echo 'PASS refund/acceptance serialization and fail-closed deficit'
"${P[@]}" -c 'DROP TABLE batch1e_barrier; UPDATE driver_cash_credit_config_v1e SET enabled=false;'
echo BATCH1E_DATABASE_CONCURRENCY=4_PASSED
