#!/usr/bin/env bash
set -euo pipefail
: "${EXPECTED_DB:?isolated database required}"
case "$EXPECTED_DB" in *movabi*|postgres|template*) exit 2;; *_batch1d_test) ;; *) exit 2;; esac
ROOT=$(cd "$(dirname "$0")/.." && pwd)
P=(psql -X -q -v ON_ERROR_STOP=1 -d "$EXPECTED_DB")
test "$("${P[@]}" -At -c 'SELECT current_database()')" = "$EXPECTED_DB"
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
snapshot(){ pg_dump --schema-only --no-owner -d "$EXPECTED_DB" | sed '/^\\restrict /d; /^\\unrestrict /d' > "$1"; }
reject(){
 local message="$1" rc=0
 snapshot "$D/before"
 "${P[@]}" -f "$ROOT/supabase/migrations/20261247000000_wallet_authorization_batch1d.sql" > "$D/result" 2>&1 || rc=$?
 if [ "$rc" -eq 0 ] || ! grep -qF "$message" "$D/result"; then cat "$D/result"; exit 1; fi
 snapshot "$D/after"; diff -u "$D/before" "$D/after"
 echo "PASS rejected $message; ACL/schema unchanged"
}
"${P[@]}" <<'SQL'
CREATE ROLE batch1d_inherited NOLOGIN;
GRANT TRUNCATE ON public.driver_earnings TO batch1d_inherited;
GRANT batch1d_inherited TO authenticated;
SQL
reject 'Batch 1D: remaining inherited client table privilege'
"${P[@]}" <<'SQL'
REVOKE batch1d_inherited FROM authenticated;
REVOKE ALL ON public.driver_earnings FROM batch1d_inherited;
DROP ROLE batch1d_inherited;
CREATE FUNCTION public.cancel_job_safely(uuid,integer) RETURNS boolean LANGUAGE sql AS 'SELECT false';
SQL
reject 'Batch 1D: unexpected financial RPC overload'
"${P[@]}" <<'SQL'
DROP FUNCTION public.cancel_job_safely(uuid,integer);
DROP POLICY batch1d_client_no_insert ON public.wallets;
CREATE POLICY batch1d_client_no_insert ON public.wallets FOR INSERT TO authenticated WITH CHECK(true);
SQL
reject 'Batch 1D: conflicting policy'
"${P[@]}" <<'SQL'
DROP POLICY batch1d_client_no_insert ON public.wallets;
CREATE POLICY batch1d_client_no_insert ON public.wallets AS RESTRICTIVE FOR INSERT TO anon,authenticated WITH CHECK(false);
SQL
"${P[@]}" -f "$ROOT/supabase/migrations/20261247000000_wallet_authorization_batch1d.sql"
echo BATCH1D_RERUN_AND_NEGATIVE_REGRESSIONS=PASSED
