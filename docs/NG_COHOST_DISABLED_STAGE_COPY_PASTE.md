> Superseded for the requested combined setup release by [setup-only schema and co-hosted API plan](NG_SETUP_ONLY_COMBINED_RELEASE.md). Use new migration 550/new API image; real develop-backup rehearsal is still pending.

# Disabled develop staging: complete review sequence

Prepared 28 October 2026. REVIEW ONLY: none of the SSH commands below has been executed. The local public bundle/image export is prepared and checksum-verified. It contains no credential file or backup archive.

## Compatibility correction: no SQL deployment in this sequence

The previous proposal to apply all five reviewed migrations was too broad for the current instruction to leave the booking journey unchanged. Runtime flags do not prevent database trigger/authority changes. The reviewed order is:

1. 20261253900000_flutterwave_market_provider_prerequisite.sql â€” widens provider constraint.
2. 20261254600000_driver_payment_accounts_sandbox.sql â€” can change preferred card routes across the catalogue.
3. 20261254700000_flutterwave_payout_outbox.sql â€” rewrites completion authority and adds payout machinery.
4. 20261254800000_flutterwave_collection_subaccounts.sql â€” includes booking/payout/refund triggers in addition to setup tables.
5. 20261254900000_flutterwave_booking_split_authority.sql â€” adds booking split authority.

These exact files are included only for checksum/history/compatibility inspection, NOT execution. The migration-plan check reports broadBundleCompatibleWithNoBookingChanges=false and migrationsApplied=false. No tracker columns are invented and no migration history is written. The completed earlier clone rehearsal remains evidence that those files apply to that clone, not approval to deploy their broader effects now. A narrower setup-only schema release, with its own review/clone check, is needed before onboarding activation.

For this request, the safe complete sequence stages the application DISABLED with the existing pinned image and a narrowly extended release helper. Its explicit --allow-missing-schema-disabled exception is accepted only with --stage-disabled; all setup/merchant/default/payout/split flags remain fixed false. With absent tables, authenticated NG status may return unavailable/conflict; this is not onboarding-ready. The baseline must pass protected-source parity or the whole sequence stops before staging.

## Prepared files and pins

Local bundle: C:\Users\fedri\source\repos\Movabi-mobile-develop\.temp\ng-cohost-stage-review-20261028

- Image archive: vaydu-api-review-cohost-20261028.tar, 399,013,888 bytes.
- Archive SHA256: 5a45b190acd10470f65cb2240accc791f285853cbadab4fb71e45ca10fbf2e02.
- Immutable Docker image ID: sha256:508ae7f1260bd3340ad2c2d7e1503007aeb16a4a99143356d6e0c2dbcfe15480.
- SHA256SUMS file SHA256: 98fdf87f0bca0de2e559adf10e10412e36965943f9c178ee5a71d5696e304335.
- The manifest covers the image, release helper, read-only checks, backup verifier, review metadata, stage/rollback shell scripts and five reference SQL files. The shell scripts contain the complete blocks below (the outer manifest pin is verified separately before invoking them).

Do not rebuild/export another image under the same reviewed tag. Do not use the earlier standalone helper checksum; this bundle includes the explicit application-only disabled-stage option.

## 1. Windows PowerShell: verify and transfer

This verifies the pinned manifest and every public artifact locally, refuses to merge into an existing remote review directory, transfers the directory, and opens SSH. Native-command failures stop the sequence. SSH/password authentication uses its normal private terminal prompt; do not put credentials in commands.

```powershell
$ErrorActionPreference = 'Stop'
$bundle = 'C:\Users\fedri\source\repos\Movabi-mobile-develop\.temp\ng-cohost-stage-review-20261028'
$expectedManifest = '98fdf87f0bca0de2e559adf10e10412e36965943f9c178ee5a71d5696e304335'
$manifest = Join-Path $bundle 'SHA256SUMS'
if ((Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedManifest) { throw 'Manifest checksum mismatch' }
foreach ($line in Get-Content -LiteralPath $manifest) {
    $parts = $line -split '  ', 2
    if ($parts.Count -ne 2) { throw 'Invalid checksum manifest' }
    $artifact = Join-Path $bundle $parts[1]
    if ((Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant() -ne $parts[0]) { throw ('Checksum mismatch: ' + $parts[1]) }
}
ssh edsadmin@87.106.64.25 'test ! -e ~/ng-cohost-stage-review-20261028'
if ($LASTEXITCODE -ne 0) { throw 'Remote review directory exists or SSH check failed; stop rather than overwrite it' }
scp -r $bundle 'edsadmin@87.106.64.25:~/'
if ($LASTEXITCODE -ne 0) { throw 'Transfer failed' }
ssh edsadmin@87.106.64.25
if ($LASTEXITCODE -ne 0) { throw 'SSH session ended with an error' }
```

## 2. SSH shell: checks, fresh private backup, import and disabled stage

Paste the complete block only after approving this application-only disabled plan and choosing a develop API maintenance window. set -euo pipefail stops on the first failed prerequisite. Do not bypass a failure or reset evidence to rerun a failed staging attempt.

```bash
bash -euo pipefail <<'SH'
umask 077
cd "$HOME/ng-cohost-stage-review-20261028"
printf '%s  SHA256SUMS\n' '98fdf87f0bca0de2e559adf10e10412e36965943f9c178ee5a71d5696e304335' | sha256sum -c -
sha256sum -c SHA256SUMS
test ! -e "$HOME/ng-cohost-release/release.json"

# Read-only baseline: last supplied API image, DB image/network/project,
# exact selected driver/tenant/NGN, public disabled flags, unchanged Stripe/
# booking sources, routing/completion fingerprints and health/auth boundaries.
python3 check-cohost-disabled-stage.py baseline

# Fresh PRIVATE develop archive plus disposable network-none restore only.
# No provider calls, application changes, SQL deployment or key provisioning.
python3 verify-develop-wallet-backup.py \
  --expected-driver 318e6be9-9164-41fa-bb0c-c5ccd3526585 \
  --expected-tenant d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8 \
  | tee operator-evidence/fresh-backup.log
python3 check-cohost-disabled-stage.py backup

# Verify reviewed SQL hashes/catalog/history identity columns and record why
# all five broad migrations are deferred. This does NOT execute SQL files.
python3 check-cohost-disabled-stage.py migration-plan

if docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
  D=(docker)
else
  D=(sudo -n docker)
fi
"${D[@]}" image load --input vaydu-api-review-cohost-20261028.tar
image='sha256:508ae7f1260bd3340ad2c2d7e1503007aeb16a4a99143356d6e0c2dbcfe15480'
actual="$("${D[@]}" image inspect --format '{{.Id}}' vaydu-api:review-cohost-20261028)"
test "$actual" = "$image"
python3 release-driver-collection-cohost.py --plan --image "$image"

# Only application staging is authorised by this plan: no migrations/setup.
python3 release-driver-collection-cohost.py \
  --stage-disabled --allow-missing-schema-disabled --image "$image"

# Wait for the existing API to restart; these are local GET /health calls only.
ready=0
for attempt in {1..30}; do
  if "${D[@]}" exec movabi-develop-api node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||"3001")+"/health",{signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok||(await r.json()).status!=="ok")process.exit(1)}).catch(()=>process.exit(1))' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
test "$ready" = 1
python3 check-cohost-disabled-stage.py post-stage

# Check the existing external API authentication boundary without a token.
for path in /api/connect/payout-settings /api/driver-payment-account/status; do
  status="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "https://movabi-develop.apps.evolsolution.com$path")"
  test "$status" = 401
done
printf '%s\n' 'Disabled application stage verified. Setup and both approvals remain off; no SQL/provider account/payment/transfer was submitted.'
SH
```

The fresh backup stays privately under /home/edsadmin/vaydu-develop-wallet-backups; it is never copied into the bundle or repository. The evidence check requires a successful restore, correct source/container/image/database, archive SHA256, private provenance and an archive younger than two hours. It accepts the new backup, not the historical archive. The helper compares the selected existing driver inside the restore; canonical/collection migration flags were not requested in this fresh backup-only run and do not become new migration approvals.

The baseline deliberately refuses if the current API differs from the last supplied image sha256:1ef978c931bf390273f4648f6c8bdce04231338d64ae7c6ead7e4e10d723c6aa, if protected Stripe/booking sources differ from the reviewed image, or if a capability is enabled. A mismatch needs image/source review, not a force option. There have been many local pending changes, so parity is a real gate, not an assumed pass. The image import also stops if the remote Docker engine reports a different immutable ID; do not silently substitute another tag/ID.

Post-stage checks compare the running image, original protected-source hashes, database route/completion/settlement fingerprints, NODE_ENV=production, selected driver/tenant, disabled runtime/database gates and unapproved defaults. They verify the provider file is mounted at the exact expected source/destination with RW=false; they do not read its contents. The script never enumerates container Env or extracts/copies database credentials. It retains the original Compose references and connection configuration in place.

Existing local Stripe/payment regression evidence is 161 tests, plus the co-host/account suites and four browser tests recorded in the implementation report. Post-stage live-server checks are read-only source parity, health and unauthenticated 401 smoke checks, NOT an authenticated Stripe authorisation/capture/refund/payout test. No financial operation is initiated to prove a regression check.

## 3. Restart impact

The stage recreates only the existing develop API service through its original Compose project with --no-deps --no-build --pull never --force-recreate. In-flight requests, keep-alive/WebSocket connections and onboarding calls can be interrupted; normal background workers restart with that API. Database, frontend and auth containers are not recreated. No port/proxy routing is added, no NODE_ENV change is made, no SQL is applied and no provider file is rewritten. Merchant/default/setup/payout/top-up/new split/timing approvals remain off. The co-host selector is on only to exercise its disabled routing.

## 4. SSH rollback, only if staging was attempted

If staging/post-stage checks fail, stop and use the retained release record. Do not delete it, retry creation, drop tables or restore the whole database automatically. This application-only plan made no SQL change, so an API rollback is sufficient for the changes this sequence makes.

```bash
bash -euo pipefail <<'SH'
umask 077
cd "$HOME/ng-cohost-stage-review-20261028"
python3 release-driver-collection-cohost.py --rollback
if docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
  D=(docker)
else
  D=(sudo -n docker)
fi
ready=0
for attempt in {1..30}; do
  if "${D[@]}" exec movabi-develop-api node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||"3001")+"/health",{signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok||(await r.json()).status!=="ok")process.exit(1)}).catch(()=>process.exit(1))' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
test "$ready" = 1
python3 check-cohost-disabled-stage.py post-rollback
SH
```

Rollback restores the prior local API image and original Compose references, removes the added provider mount from the resulting definition, and disables the co-host/setup/approval gates. It preserves the original database connection/NODE_ENV/Stripe configuration, database state, fresh backup and any durable or uncertain operation history. It recreates only the API and has the same connection-interruption impact. Keep the previous image and private release record until the stage is closed. If staging did not create a release record, do not invoke rollback; it has nothing authorised to restore.

## Local preparation verification

The image archive and all public bundle files were checksum-verified in a network-disabled Linux container. Release-helper tests covered the narrowly allowed missing-schema disabled stage, normal missing-schema refusal and rollback commands. Synthetic Linux checks covered baseline, migration deferral/history-count inspection, fresh backup provenance, post-stage/rollback health/auth, source drift and approval rejection. No remote command has been executed. Merchant identity/default decisions and a narrower setup-only migration remain needed before any onboarding activation.
