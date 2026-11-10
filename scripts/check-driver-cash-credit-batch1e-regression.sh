#!/usr/bin/env bash
set -euo pipefail
: "${EXPECTED_DB:?isolated DB required}"
case "$EXPECTED_DB" in *movabi*|postgres|template*)exit 2;; *_batch1e_test);; *)exit 2;;esac
ROOT=$(cd "$(dirname "$0")/.." && pwd);P=(psql -X -q -v ON_ERROR_STOP=1 -d "$EXPECTED_DB")
test "$("${P[@]}" -At -c 'SELECT current_database()')" = "$EXPECTED_DB"
D=$(mktemp -d);trap 'rm -rf "$D"' EXIT
snapshot(){ pg_dump --schema-only --no-owner -d "$EXPECTED_DB" | sed '/^\\restrict /d;/^\\unrestrict /d' > "$1"; }
reject(){ local rc=0; snapshot "$D/before"; "${P[@]}" -f "$ROOT/supabase/migrations/20261248000000_driver_cash_credit_batch1e.sql" > "$D/result" 2>&1 || rc=$?;
 if [ "$rc" -eq 0 ] || ! grep -qF "$1" "$D/result";then cat "$D/result";exit 1;fi
 snapshot "$D/after";diff -u "$D/before" "$D/after";echo "PASS rejected $1; schema/ACL unchanged";
}
"${P[@]}" -c 'DROP INDEX driver_cash_credit_holds_scope_v1e;CREATE INDEX driver_cash_credit_holds_scope_v1e ON driver_cash_credit_holds_v1e(driver_id,tenant_id,currency_code,status);'
reject 'Batch 1E: incompatible index'
"${P[@]}" -c 'DROP INDEX driver_cash_credit_holds_scope_v1e;CREATE INDEX driver_cash_credit_holds_scope_v1e ON driver_cash_credit_holds_v1e(tenant_id,driver_id,currency_code,status);ALTER TABLE driver_cash_credit_holds_v1e ALTER COLUMN status SET DEFAULT '\''settled'\'';'
reject 'Batch 1E: incompatible table columns'
"${P[@]}" -c 'ALTER TABLE driver_cash_credit_holds_v1e ALTER COLUMN status SET DEFAULT '\''held'\'';ALTER TABLE wallet_business_events DISABLE TRIGGER serialize_cash_credit_ledger_v1e;'
reject 'Batch 1E: incompatible trigger'
"${P[@]}" -c 'ALTER TABLE wallet_business_events ENABLE TRIGGER serialize_cash_credit_ledger_v1e;CREATE FUNCTION public.reserve_cash_job_credit_v1e(uuid) RETURNS uuid LANGUAGE sql AS '\''SELECT NULL::uuid'\'';'
reject 'Batch 1E: unexpected overload'
"${P[@]}" -c 'DROP FUNCTION public.reserve_cash_job_credit_v1e(uuid);CREATE ROLE batch1e_parent NOLOGIN;GRANT SELECT ON driver_cash_credit_config_v1e TO batch1e_parent;GRANT batch1e_parent TO authenticated;'
reject 'Batch 1E: unexpected inherited client table access'
"${P[@]}" -c 'REVOKE batch1e_parent FROM authenticated;REVOKE SELECT ON driver_cash_credit_config_v1e FROM batch1e_parent;DROP ROLE batch1e_parent;'
"${P[@]}" -f "$ROOT/supabase/migrations/20261248000000_driver_cash_credit_batch1e.sql"
echo BATCH1E_NEGATIVE_REGRESSIONS=5_PASSED
