#!/usr/bin/env bash
set -euo pipefail
: "${EXPECTED_DB:?explicit isolated DB required}"
case "$EXPECTED_DB" in *movabi*|postgres|template*)exit 2;; *_batch1h_test);; *)exit 2;;esac
ROOT=$(cd "$(dirname "$0")/.." && pwd);P=(psql -X -v ON_ERROR_STOP=1 -d "$EXPECTED_DB")
test "$("${P[@]}" -qAt -c 'SELECT current_database()')" = "$EXPECTED_DB"
"${P[@]}" -f "$ROOT/scripts/check-driver-cash-credit-batch1e-fixture.sql"
for name in 20261244000000_wallet_metadata_batch1a.sql 20261245000000_wallet_accounting_foundation_batch1b.sql 20261246000000_wallet_topups_batch1c.sql 20261247000000_wallet_authorization_batch1d.sql;do
 f="$ROOT/dependencies/$name";if [ ! -f "$f" ];then f="$ROOT/supabase/migrations/$name";fi
 "${P[@]}" -f "$f"
done
"${P[@]}" -f "$ROOT/supabase/migrations/20261248000000_driver_cash_credit_batch1e.sql"
"${P[@]}" -f "$ROOT/scripts/check-driver-cash-credit-batch1e.sql"
"${P[@]}" -f "$ROOT/scripts/check-driver-cash-credit-batch1e-roles.sql"
EXPECTED_DB="$EXPECTED_DB" bash "$ROOT/scripts/check-customer-wallet-setup-batch1h-prior-concurrency.sh"
"${P[@]}" -f "$ROOT/supabase/migrations/20261248000000_driver_cash_credit_batch1e.sql"
EXPECTED_DB="$EXPECTED_DB" bash "$ROOT/scripts/check-customer-wallet-setup-batch1h-prior-regression.sh"
echo BATCH1E_ISOLATED_DATABASE_SUITE=PASSED

"${P[@]}" -c "CREATE TABLE public.batch1f_function_baseline AS SELECT oid,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace IN ('public'::regnamespace,'auth'::regnamespace) AND prokind='f'"
"${P[@]}" -f "$ROOT/supabase/migrations/20261249000000_driver_cash_credit_api_batch1f.sql"
"${P[@]}" -f "$ROOT/scripts/check-driver-cash-credit-batch1f.sql"
"${P[@]}" -f "$ROOT/supabase/migrations/20261249000000_driver_cash_credit_api_batch1f.sql"
echo BATCH1F_ISOLATED_DATABASE_SUITE=PASSED

"${P[@]}" -f "$ROOT/scripts/check-customer-wallet-setup-batch1h-fixture.sql"
"${P[@]}" -f "$ROOT/supabase/migrations/20261250000000_customer_wallet_setup_batch1h.sql"
"${P[@]}" -f "$ROOT/scripts/check-customer-wallet-setup-batch1h.sql"
EXPECTED_DB="$EXPECTED_DB" bash "$ROOT/scripts/check-customer-wallet-setup-batch1h-concurrency.sh"
"${P[@]}" -f "$ROOT/supabase/migrations/20261250000000_customer_wallet_setup_batch1h.sql"
EXPECTED_DB="$EXPECTED_DB" bash "$ROOT/scripts/check-customer-wallet-setup-batch1h-regression.sh"
echo BATCH1H_ISOLATED_DATABASE_SUITE=PASSED
