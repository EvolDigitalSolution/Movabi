# Exact develop host correction and activation rerun

Source commit `a180556`; upload `release/vaydu-gb-scope-fix-a180556.tar.gz` to `/home/edsadmin`.
No new backup, SSH retries, API deployment or pricing decision is needed. Existing real-backup
restore-drill and release-verification gates must already have passed before activation runs.
No live execution is claimed by the agent.

From the authenticated develop host terminal:

```bash
set -euo pipefail
cd /home/edsadmin
printf '%s  %s\n' \
  a8fe2694d563f7d6a4fe2fa4ac95e174544caf9fc09e8f53b8976b933e03a394 \
  vaydu-gb-scope-fix-a180556.tar.gz | sha256sum -c -
D=$(mktemp -d /home/edsadmin/vaydu-gb-scope-fix.XXXXXX)
tar -xzf vaydu-gb-scope-fix-a180556.tar.gz -C "$D"
F="$D/vaydu-gb-scope-fix-a180556"
(cd "$F" && sha256sum -c FIX_SHA256SUMS)
bash "$F/correct-legacy-gb-pricing.sh"
docker exec -i movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -P pager=off' < "$F/activate-gb.sql"
```

The correction must report recognised GB profiles, four audited country-only changes,
`ALL_PRICING_FIELDS_PRESERVED`, `GB_NG_QUOTES_UNCHANGED` and `PRICING_SCOPE_HOST_OK` before
activation is reached. It checks actual installed-service quotes at identical inputs and
preserves evidence in the printed directory. On any failure the command stops; keep that output.

The activation copy includes only the blank/NULL profile lookup correction; its explicit GB/GBP
minimum-fare guard and all other guards are retained. The existing ride minimum is GBP 3.35
(335 minor units), read from the corrected rows, never changed by this command. Scope correction
checks conflicts and preserves all other row fields, IDs, rates, updated_at and NG data.

The selected cash driver and API cash flag are not changed by this command. If that existing
cash cohort needs rerunning, use the corrected activate-gb-cash.sql with its already recorded
driver_email; do not choose another driver. Full scope/correction details are in LEGACY-GB-SCOPE.md.
