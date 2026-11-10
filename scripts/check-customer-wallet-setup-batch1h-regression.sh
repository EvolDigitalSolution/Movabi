#!/usr/bin/env bash
set -euo pipefail
: "${EXPECTED_DB:?isolated DB required}"
case "$EXPECTED_DB" in *movabi*|postgres|template*)exit 2;; *_batch1h_test);; *)exit 2;;esac
ROOT=$(cd "$(dirname "$0")/.." && pwd);P=(psql -X -q -v ON_ERROR_STOP=1 -d "$EXPECTED_DB")
test "$("${P[@]}" -At -c 'SELECT current_database()')" = "$EXPECTED_DB"
D=$(mktemp -d);trap 'rm -rf "$D"' EXIT
snapshot(){ pg_dump --schema-only --no-owner -d "$EXPECTED_DB" | sed '/^\\restrict /d;/^\\unrestrict /d' > "$1"; }
reject(){ local rc=0;snapshot "$D/before";"${P[@]}" -f "$ROOT/supabase/migrations/20261250000000_customer_wallet_setup_batch1h.sql" > "$D/result" 2>&1 || rc=$?;
 if [ "$rc" -eq 0 ] || ! grep -qF "$1" "$D/result";then cat "$D/result";exit 1;fi
 snapshot "$D/after";diff -u "$D/before" "$D/after";echo "PASS rejected $1 without schema/ACL changes";
}
"${P[@]}" -c 'CREATE FUNCTION public.ensure_customer_wallet_v1h(text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$'
reject 'Batch 1H: unexpected overload'
"${P[@]}" -c 'DROP FUNCTION public.ensure_customer_wallet_v1h(text)'
"${P[@]}" -c 'ALTER TABLE public.profiles DISABLE TRIGGER a_guard_customer_wallet_market_v1h'
reject 'Batch 1H: incompatible trigger'
"${P[@]}" -c 'ALTER TABLE public.profiles ENABLE TRIGGER a_guard_customer_wallet_market_v1h'
# This role is created only inside the already guarded fresh disposable cluster.
"${P[@]}" -c 'CREATE ROLE batch1h_bad NOLOGIN; GRANT TRUNCATE ON public.profiles TO batch1h_bad; GRANT batch1h_bad TO authenticated'
reject 'Batch 1H: inherited unsafe profile access'
"${P[@]}" -c 'REVOKE batch1h_bad FROM authenticated; REVOKE ALL ON public.profiles FROM batch1h_bad; DROP ROLE batch1h_bad'
"${P[@]}" -c 'GRANT INSERT ON public.wallet_collection_config TO authenticated'
reject 'Batch 1H: existing financial authorization missing'
"${P[@]}" -c 'REVOKE INSERT ON public.wallet_collection_config FROM authenticated'
"${P[@]}" -f "$ROOT/supabase/migrations/20261250000000_customer_wallet_setup_batch1h.sql"
echo BATCH1H_NEGATIVE_REGRESSIONS=4_PASSED
