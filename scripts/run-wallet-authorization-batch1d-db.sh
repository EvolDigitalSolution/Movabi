#!/usr/bin/env bash
set -euo pipefail
: "${EXPECTED_DB:?explicit isolated database name required}"
case "$EXPECTED_DB" in *movabi*|postgres|template*) echo 'Protected DB' >&2;exit 2;; *_batch1d_test) ;; *) exit 2;; esac
ROOT=$(cd "$(dirname "$0")/.." && pwd)
P=(psql -X -v ON_ERROR_STOP=1 -d "$EXPECTED_DB")
test "$("${P[@]}" -qAt -c 'SELECT current_database()')" = "$EXPECTED_DB"
echo '== observed development schema/role fixture =='
"${P[@]}" -f "$ROOT/scripts/check-wallet-authorization-batch1d-fixture.sql"
for name in 20261244000000_wallet_metadata_batch1a.sql 20261245000000_wallet_accounting_foundation_batch1b.sql 20261246000000_wallet_topups_batch1c.sql; do
 migration="$ROOT/dependencies/$name"
 if [ ! -f "$migration" ]; then migration="$ROOT/supabase/migrations/$name"; fi
 "${P[@]}" -f "$migration"
done
echo '== reproduce pre-hardening exposures (rollback only) =='
"${P[@]}" -f "$ROOT/scripts/check-wallet-authorization-batch1d-baseline.sql"
echo '== reproduce an accidental column grant; migration must remove it =='
"${P[@]}" -c 'GRANT UPDATE(currency_code) ON public.wallets TO authenticated;'
echo '== apply Batch 1D =='
"${P[@]}" -f "$ROOT/supabase/migrations/20261247000000_wallet_authorization_batch1d.sql"
echo '== real client/service sessions and actual inspected financial functions =='
"${P[@]}" -f "$ROOT/scripts/check-wallet-authorization-batch1d.sql"
echo '== safe rerun =='
"${P[@]}" -f "$ROOT/supabase/migrations/20261247000000_wallet_authorization_batch1d.sql"
echo '== inherited grants, unknown overload and conflicting policy rejection =='
EXPECTED_DB="$EXPECTED_DB" bash "$ROOT/scripts/check-wallet-authorization-batch1d-regression.sh"
echo BATCH1D_ISOLATED_DATABASE_SUITE=PASSED
