# Develop booking and cash correction

Application correction only. No SQL/activation, policy, cash cohort, driver enrolment, payment
binding or historical amount changes. Production is excluded. Existing approved cash enablement
is preserved; Africa-provider integration remains deferred. The package is f949a14 plus the
reviewed eef726b quote-tenant API and exactly three additional API files, and an isolated mobile
build from f949a14 plus five frontend files. Unfinished followups are excluded.
Separate admin browser bytes remain unchanged; the admin label source correction is included
in the mobile route build and remains available for a separately verified admin deployment.

Build/source/test evidence: `EVIDENCE.md`. The optimized isolated build also passes all 13
browser fixture cases. These do not establish an authenticated live customer journey.

Upload the produced `vaydu-booking-cash-<source>.tar.gz` and sidecar to `/home/edsadmin`, then
run the following from an existing authenticated host terminal. Replace the source placeholder
with the source from the supplied artifact name. Do not run another backup or retry SSH login.

```bash
set -euo pipefail
cd /home/edsadmin
SOURCE='<source from artifact name>'
sha256sum -c "vaydu-booking-cash-$SOURCE.tar.gz.sha256"
D=$(mktemp -d /home/edsadmin/vaydu-booking-cash-tools.XXXXXX)
tar -xzf "vaydu-booking-cash-$SOURCE.tar.gz" -C "$D"
H="$D/vaydu-booking-cash-$SOURCE"
# Use the same passing real-backup drill.log already recorded by the P8 inspection.
export RESTORE_DRILL_LOG="$(cat /home/edsadmin/vaydu-p8-reconciliation.Q8xr7I/restore-drill-path.txt)"
bash "$H/deploy.sh"
```

The script checks all nine suites and preservation/rollback markers in that existing drill,
checks the entire current API source inventory against f949a14 or eef726b, verifies actual
f949a14 web bytes/inventory and image ID, pins the actual previous API and web images and records
existing compose labels. An unknown baseline stops deployment. It builds in a new evidence
directory and appends an image-only compose override; no existing release directory or compose
file is replaced. It starts only API and web, preserves existing environment/volumes/configuration,
checks health/cash flag and API/web hashes, and never runs an activation or a database migration.

If `restore-drill-path.txt` is absent in that inspection, set RESTORE_DRILL_LOG to the existing
passing corrected f949a14 drill.log itself. Its strict checks remain mandatory. Do not fabricate
a path, substitute a local rehearsal, request another backup or skip the gate.

## Recovery

The script prints `BOOKING_CASH_EVIDENCE=/home/edsadmin/vaydu-booking-cash.XXXXXX` before any
application change. Both actual old image IDs and unique recovery tags are retained there.
If API starts but web fails, stop and retain logs; no SQL activation was performed. Roll both
applications back to their exact recorded images, without a DB restore:

```bash
set -euo pipefail
E='/home/edsadmin/vaydu-booking-cash.XXXXXX' # exact printed evidence directory
IFS=',' read -r -a files < "$E/compose-files.txt"
args=(--project-name "$(cat "$E/compose-project.txt")" --project-directory "$(cat "$E/compose-workdir.txt")")
for f in "${files[@]}"; do test -f "$f"; args+=(-f "$f"); done
docker compose "${args[@]}" -f "$E/recovery.compose.yml" up -d --no-deps --no-build api web
test "$(docker inspect -f '{{.Image}}' movabi-develop-api)" = "$(cat "$E/api-before-image-id.txt")"
curl -fsS https://movabi-api-develop.apps.evolsolution.com/health
```

Do not roll back SQL, driver enrolment or payments. Jobs/holds/settlements created meanwhile stay
valid and are not deleted. If the baseline/API differs, preserve it and inspect rather than
relabelling it f949a14. Rerunning this deployment is intentionally blocked once the old baseline
has changed; verify/recover the recorded state first.

## Authenticated verification gate

Use the existing affected customer session and quote; run the included read-only diagnostic with
VAYDU_CUSTOMER_ACCESS_TOKEN and VAYDU_QUOTE_ID set privately in the process environment. Optional
VAYDU_ADMIN_ACCESS_TOKEN inspects only that customer's profile in its output. Do not paste tokens
in commands, chat, files or logs. The diagnostic prints the exact cash availability reason and
market/native tenant alongside the card-wallet status. No token or payment action is printed/run.

On the real develop screen, select pickup/drop-off, get the quote and check the response against
the displayed Card/Cash options or specific unavailable reason. Switch Card/Cash repeatedly,
change route and navigate away/back; assert no form errors and usable submission. Complete
separate Card and Cash test bookings. Cash must use only fee-hold/confirm; only the enrolled
same-tenant GB/GBP driver can acquire it, retaining inspection/ownership/PIN checks. Verify cash
completion records cash earnings/credit settlement exactly once and releases the security hold
without full-fare card capture. Card continues its existing provider flow. Verify NG remains
unsupported for saved-card setup and never resolves GB Stripe from saved GBP currency.

Until those authenticated screen/API/provider checks are recorded, deployment verification is
incomplete and the completion matrix's live verification state must remain pending.
