#!/usr/bin/env bash
set -euo pipefail
: "${EXPECTED_DB:?isolated test database required}"
case "$EXPECTED_DB" in *movabi*|postgres|template*)exit 2;; *_batch1h_test);; *)exit 2;;esac
P=(psql -X -qAt -v ON_ERROR_STOP=1 -d "$EXPECTED_DB")
test "$("${P[@]}" -c 'SELECT current_database()')" = "$EXPECTED_DB"
D=$(mktemp -d);trap 'rm -rf "$D"' EXIT
u=$("${P[@]}" -c 'SELECT gen_random_uuid()')
"${P[@]}" <<SQL
INSERT INTO wallet_collection_config(key,value) VALUES('customer_wallet_setup_enabled','true');
INSERT INTO auth.users(id) VALUES('$u');
INSERT INTO profiles(id,tenant_id,role,registration_country_code,registration_activated_at) VALUES('$u','11111111-1111-1111-1111-111111111111','customer','JP',now());
CREATE TABLE batch1h_barrier(id integer PRIMARY KEY);
SQL
for n in 1 2;do
 cat > "$D/$n.sql" <<SQL
SET statement_timeout='12s';
INSERT INTO batch1h_barrier VALUES($n);
DO \$\$ DECLARE i integer; BEGIN
 FOR i IN 1..200 LOOP
  IF (SELECT count(*) FROM batch1h_barrier)=2 THEN RETURN; END IF;
  PERFORM pg_sleep(.02);
 END LOOP;
 RAISE EXCEPTION 'Synchronization timed out';
END \$\$;
SET ROLE service_role;
SELECT 'RESULT '||(ensure_customer_wallet_v1h('$u')->'wallet'->>'id');
SQL
 timeout 20s "${P[@]}" -f "$D/$n.sql" > "$D/$n.out" 2>&1 &
 eval "pid$n=$!"
done
set +e
wait "$pid1";r1=$?;wait "$pid2";r2=$?
set -e
if [ "$r1" -ne 0 ] || [ "$r2" -ne 0 ];then cat "$D/1.out" "$D/2.out";exit 1;fi
one=$(sed -n 's/^RESULT //p' "$D/1.out");two=$(sed -n 's/^RESULT //p' "$D/2.out")
if ! [[ "$one" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || [ "$one" != "$two" ];then cat "$D/1.out" "$D/2.out";exit 1;fi
"${P[@]}" <<SQL
DO \$\$ BEGIN
 IF (SELECT count(*) FROM wallets WHERE user_id='$u' AND currency_code='JPY' AND available_balance=0 AND reserved_balance=0)<>1 THEN RAISE EXCEPTION 'Concurrent setup produced incorrect wallet'; END IF;
 IF EXISTS(SELECT 1 FROM batch1h_wallet_baseline b LEFT JOIN wallets w ON w.id=b.id WHERE to_jsonb(w) IS DISTINCT FROM b.row) THEN RAISE EXCEPTION 'Historical wallet changed'; END IF;
END \$\$;
DELETE FROM wallet_collection_config WHERE key='customer_wallet_setup_enabled';
DROP TABLE batch1h_barrier;
SQL
echo BATCH1H_TWO_SESSION_SETUP=PASS
