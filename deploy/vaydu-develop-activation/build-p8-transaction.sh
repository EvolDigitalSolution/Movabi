#!/usr/bin/env bash
# Compose reviewed bodies under ONE outer transaction. Never executes SQL.
# Only each source's single BEGIN;/COMMIT; is removed; every guard/body line is retained.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; LEGACY="${1:?with-legacy|without-legacy}"; END="${2:?ROLLBACK|COMMIT}"
[[ "$LEGACY" = with-legacy || "$LEGACY" = without-legacy ]] || exit 2
[[ "$END" = ROLLBACK || "$END" = COMMIT ]] || exit 2
strip_outer(){
  awk 'BEGIN{b=0;c=0} /^BEGIN;\r?$/ {b++;next} /^COMMIT;\r?$/ {c++;next} {print} END{if(b!=1||c!=1){print "invalid transaction boundaries" > "/dev/stderr";exit 1}}' "$1"
}
echo '\set ON_ERROR_STOP on'; echo 'BEGIN;'; cat "$HERE/p8-transaction-before.sql"
if [[ "$LEGACY" = with-legacy ]]; then strip_outer "$HERE/correct-legacy-gb-pricing.sql"; fi
strip_outer "$HERE/correct-gb-p8-strategies.sql"
cat "$HERE/preserve-platform-defaults.sql"
strip_outer "$HERE/activate-gb.sql"
cat "$HERE/activate-gb-quote-tenant.sql"
cat "$HERE/p8-transaction-after.sql"
echo "$END;"
