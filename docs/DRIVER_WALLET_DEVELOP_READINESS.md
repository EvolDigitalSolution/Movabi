# Develop wallet readiness — current status, 27 October 2026

The current implementation/release report is `docs/DRIVER_CARD_5_PERCENT_SANDBOX.md`. It supersedes earlier Flutterwave-only fee assumptions and the fresh-only SQL candidate. No application deployment or provider payment has occurred.

## Verified server backup

- Source: `movabi-develop-db`, database `movabi_develop`.
- Archive: `/home/edsadmin/vaydu-develop-wallet-backups/20261027T134821Z-1eabea4c/movabi_develop.dump`.
- SHA256: `abf0c32b9287efb2ca13b57521c786fde2930d21103a70343793d6fa1c404f21`.
- Successful manifest: `/home/edsadmin/vaydu-develop-wallet-backups/20261027T134821Z-1eabea4c/verification-9168cbbb449f.json`.
- Full isolated restore, checksum and wallet ownership/ACL/count comparisons passed. Wallet accounts/events/movements/attempts were zero; both provider-store records were preserved.
- The original failed manifest was retained; the separate successful manifest is the verification proof. Source cluster login/password recovery was not copied/tested.

The new canonical card-policy section has also passed complete synthetic-backup restore/application/repeat tests locally. Applying it to a disposable restore of the actual retained server archive is prepared, but has not run on the server. Nothing in that preparation applies SQL to the application container.

## Confirmed deployment state

API → `movabi-develop-kong:8000` → develop PostgREST → `movabi-develop-db:5432/movabi_develop`. The initial maintenance database `postgres` audit was superseded. The audited wallet function hashes match local pre-Batch-2 source using the same PostgreSQL 15.1 binaries.

The shared API remains `NODE_ENV=production` with its driver API switch off. Broad wallet collection resolves false. All inspected card routes were disabled/unapproved. The prepared test-only sidecar leaves that shared process alone and uses a separate driver-scoped database gate; it rejects live provider keys and production database targets.

## Approval/configuration status

- Approved shared card fee: `vaydu-driver-card-5pct-wallet-v1`, 5% of credit, half-up in configured minor units, no fixed fee/cap. Not approved for bank/mobile-money methods.
- First candidate market: Flutterwave / NG / NGN, conditional on merchant support and fee-passing checks.
- Eligible-driver inventory: only `c24f395c-c787-4464-a1ab-3345881e5faa`, registered/wallet GB/GBP; not an NGN candidate. An activated NG/NGN driver must still be selected. The Nigerian customer must not be used or converted.
- Private prompt was corrected and Linux PTY-tested after its non-seekable TTY failure. Real private provisioning has not yet been confirmed. It asks for test key, distinct webhook secret, merchant reference/account ID and approved callback, then does only a read-only NGN fee query after test-mode validation. Dashboard merchant settings and actual checkout remain unverified.
- Direct existing secret-manager injection for the develop database connection is user-authorized. Extraction/copying from a container is not authorized or performed. Its binding/reference is still needed; no credential values belong in chat or reports.

## Prepared artifacts

Canonical source: `supabase_incremental_schema_reconcile.sql`, managed section `VAYDU_DRIVER_CARD_TOPUP_20261027`.
Reviewed extraction: `scripts/driver-card-develop-release/supabase_incremental_schema_reconcile.sql`.
Manifest/checksums, injection-only sandbox Compose, narrow web override and default-read-only schema checker are in that release directory. Built image IDs and SQL checksum are pinned in `release-manifest.json`. All gates/scopes remain off and driver selection remains unset.

Before any application mutation, validate the new canonical extraction against the actual backup clone, retain original API/web override chains, complete private merchant review and driver selection, and review the exact develop-only rollout. No enablement command is supplied while these inputs are incomplete. After any provider submission, retain all evidence and reconciliation paths; do not restore the whole application backup to erase an attempt.

The detailed report contains exact test commands/results, staging commands and UI test/rollback steps. Current tests are 147 focused/regression cases, two browser cases, disposable provider integrations, canonical rerun/drift checks, full synthetic restore/canonical checks, both image builds and the mobile develop build. A real UI → provider → verification → single-credit demonstration and native return are still outstanding.
