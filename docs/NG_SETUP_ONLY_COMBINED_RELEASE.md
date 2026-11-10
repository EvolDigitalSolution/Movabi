# Setup-only schema + co-hosted develop API: one gated release plan

28 October 2026. PREPARED LOCALLY; NOT DEPLOYED. Real develop-backup rehearsal is still pending: noninteractive SSH to edsadmin@87.106.64.25 returned Permission denied (publickey,password). No usable managed SSH connector/identity was available. Do not describe the local synthetic restore evidence as real-server verification. Existing private key provisioning is retained unchanged; no key entry is requested.

## Release lineage and exact scope

New additive migration: 20261255000000_driver_collection_setup_only.sql.

SQL SHA256: cd572ea992590aa9f211b0e2508ab266da0add18768dc5e2f175bb4bfd9156be.

This is an independent setup-only branch, numbered after 549, not a rewrite or a dependency on 539/546/547/548/549. The five previously reviewed migration files were checksum-compared and remain unchanged. They are not included in this release manifest and must not be picked up by a blanket migration command. Existing applied history in any environment is preserved. If old collection tables already exist, this release does not import their associations or replace their functions; it uses distinct names. A boolean-only preflight refuses any legacy collection operation for this driver, including uncertain ones, so switching stores cannot bypass reconciliation. A later explicit reconciliation migration would be required to bridge those histories.

Objects created:

- public.driver_collection_setup_markets — one NG/NGN/test configuration row for the confirmed driver/tenant. Merchant reference/evidence and default type/value are NULL. Identity/default/setup/adapter approvals are false; F4B is constrained false.
- public.driver_collection_setup_accounts — private immutable operation/association records, fingerprints and masked last four digits. No full bank details, contacts, credentials, payout fields, booking commissions or wallet-fee rules are stored.
- public.claim_driver_collection_setup(uuid,uuid,text,text,text,text,text) — service-role-only atomic claim with fixed driver/tenant, activated profile, NG/NGN/test, merchant/default approvals and frozen input checks.
- public.guard_driver_collection_setup_identity() — trigger function only for the new private association table. It blocks deletion, frozen-term changes, reference replacement and downgrading verified completion. Foreign keys provide normal ownership enforcement against profiles; no user trigger is added to jobs/outbox/refund tables.

Only one operation per driver/tenant/market/test environment is allowed, independent of merchant alias. A retry, timeout or alias change cannot win another creation claim. Completion requires a provider reference plus verification='retrieved'; service_role cannot insert/delete/truncate rows or alter frozen identity fields. Anonymous/authenticated users have no table or claim access. The existing API validates the owner JWT and profile/tenant before reaching these server-only tables.

No booking, completion, refund, payout-outbox, collection-route, provider-enum or existing settlement function is changed. No preferred provider route is updated. Wallet top-up policy and its approved 5% fee are unchanged. No default split is inferred or applied.

## Explicit dependencies

Functional migration/API dependencies: verified database name movabi_develop; existing profiles.id/tenant_id UUIDs, role, registered country and registration_activated_at; market_availability.country_code/supported_currency with unambiguous NG/NGN; PostgreSQL UUID generation; pre-existing anon/authenticated/service_role roles. The API needs the existing Supabase service role's RLS bypass, which rehearsal checks explicitly.

The rehearsal additionally requires existing market_payment_routes, jobs and job_payout_queue to certify their preservation. These are inspection dependencies, not new payout functionality. The exact confirmed driver is 318e6be9-9164-41fa-bb0c-c5ccd3526585 and tenant d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8. No other driver is created in develop.

The co-hosted API now selects SETUP_ONLY_COLLECTION_STORE explicitly. Its profile/market scope lookup skips driver_payout_markets; the setup path does not require any broader payout or booking schema. The constructor's default path and the old store remain unchanged for existing consumers. GB/GBP status still delegates to the established Stripe service.

## Local evidence and remaining real-server gate

Passed locally:

- Restore of a previously verified synthetic develop fixture archive into an isolated network-none PostgreSQL container, then the exact migration above.
- The complete backup/restore verifier's new --setup-only-directory path on that synthetic source, including ownership/ACL checks and a second disposable restore.
- Before/after hashes of all existing public functions/procedures, user triggers, old table columns/constraints/ownership/grants/RLS, collection-route rows, booking rows and payout-outbox rows match. Only the exact new setup objects are excluded. Source/restore metadata queries use consistent UTC/search_path.
- New private tables remain empty/disabled with NULL default and unapproved merchant identity; service-role RLS dependency and privileges are checked.
- Real PostgreSQL claim race has one winner; wrong driver/tenant, unauthorised roles, deletion, term/reference mutation, uncertain retries and incomplete verification are rejected. Alias changes cannot create a second claim.
- The original Stripe SQL completion/outbox/settlement flow passed in the synthetic clone with fake IDs and tr_synthetic. No Stripe provider request or actual transfer occurred.
- 343 API/payment/booking/Stripe regression tests passed across eleven suites. Server TypeScript checks passed, including inside the rebuilt image. Operator-helper tests use mocked commands and explicitly reject synthetic evidence as real proof.

The local archive came from a labelled synthetic fixture. Its driver identifiers were seeded only inside that disposable synthetic clone to exercise the exact fixed scope. No real develop account was created or altered. The local reports explicitly say realDevelopBackupRehearsed=false. SSH authentication is the remaining blocker to executing the real rehearsal from this chat; use the authenticated SSH terminal command below. No deployment may pass the proof gate until that real run succeeds.

## Artifacts

Public rehearsal/release bundle: scripts/ng-setup-only-review. It contains only migration 550, its lineage/checksum manifest, the verifier, metadata contracts, guarded apply/stage/check helpers and review metadata. No provider file, DB credentials or database archive is transferred.

Bundle SHA256SUMS file SHA256: fa4b12f20788247425b65fdb8a3c5a3c3aa9882f1d1607865d59a054dc55f073.

Rebuilt API tag: vaydu-api:review-setup-only-20261028.

Immutable local image ID: sha256:084b2cf6a7db7713244a7554a38acb54f0dd78323250ce9c260a2d541d7c3cfa.

Prepared local image archive: C:\Users\fedri\source\repos\Movabi-mobile-develop\.temp\vaydu-api-review-setup-only-20261028.tar.

Archive bytes: 399,014,400; SHA256: f94ce142681aba4dd9a633c6facf5ebf2e3ee4376daa4f9c2ff477cdfdd9d842.

Do not reuse the older co-host image/archive or the broad five-migration bundle. The new API deliberately names the new setup-only store.

## Phase 1 — real backup rehearsal only, safe next operator command

From Windows PowerShell, transfer public files and enter SSH. This does not provision keys or stage the API:

```powershell
scp -r 'C:\Users\fedri\source\repos\Movabi-mobile-develop\scripts\ng-setup-only-review' 'edsadmin@87.106.64.25:~/'
if ($LASTEXITCODE -ne 0) { throw 'Public rehearsal bundle transfer failed' }
ssh edsadmin@87.106.64.25
```

In the authenticated SSH shell:

```bash
bash -euo pipefail <<'SH'
umask 077
cd "$HOME/ng-setup-only-review"
printf '%s  SHA256SUMS\n' 'fa4b12f20788247425b65fdb8a3c5a3c3aa9882f1d1607865d59a054dc55f073' | sha256sum -c -
sha256sum -c SHA256SUMS
mkdir -p operator-evidence
chmod 700 operator-evidence
python3 verify-develop-wallet-backup.py \
  --setup-only-directory "$PWD/migrations" \
  --expected-driver 318e6be9-9164-41fa-bb0c-c5ccd3526585 \
  --expected-tenant d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8 \
  | tee operator-evidence/fresh-backup.log
python3 check-cohost-disabled-stage.py backup
SH
```

This creates a new private develop archive and a fresh disposable restore, applies ONLY 550 inside that clone, checks grants/gates/protected state, then removes the clone. The source database/application is read-only. No provider calls occur. The backup stays under /home/edsadmin/vaydu-develop-wallet-backups with private ownership/permissions. It is not copied into the repository or the public bundle.

Expected evidence: sourceKind=verified-develop; restoreVerified, setupOnlyCloneVerified, protectedAuthorityUnchanged, routingUnchanged, selectedExistingDriverVerified and collectionGatesDisabledVerified all true. The detailed private manifest must also record unchanged booking/outbox rows, owners/ACL verification, appliedSetupOnlyMigrations=[550 filename] and matching migrationSetSha256. canonicalCloneVerified and collectionMigrationCloneVerified remain false because those broader modes were not requested; they are not failures or approvals.

Keep the printed verificationManifest path. The apply/stage helpers require that private manifest, the unchanged archive SHA256, source identity and exact release hash. They reject synthetic fixtures, incomplete flags, a different migration set and proof older than two hours. Do not edit a manifest or weaken a gate to continue.

## Phase 2 — apply ONLY setup schema, after separate deployment instruction

All remaining steps are a review plan, NOT authorised execution in this turn. Use a quiet develop maintenance window and verified original deployment launcher/Compose references. Do not change the customer journey or drain/cancel/rewrite payout work. If existing financial work is active, reschedule the stage; the API stage guard refuses pending/processing/reconcile payout work.

Before mutation, run the baseline and compatibility checks. Protected Stripe/payment/booking source hashes must match the reviewed image and the supplied baseline API image. Stop for image/source review if they differ; do not bypass with a force option. Existing migration-tracker identifier columns and matching-version counts are read only.

```bash
cd "$HOME/ng-setup-only-review"
python3 check-cohost-disabled-stage.py baseline
python3 check-cohost-disabled-stage.py migration-plan
```

Extract the already-verified private proof path from the sanitized log (no credentials):

```bash
proof="$(python3 - <<'PY'
import json
from pathlib import Path
rows=[json.loads(s) for s in (Path('operator-evidence')/'fresh-backup.log').read_text().splitlines() if s.startswith('{')]
row=next(x for x in reversed(rows) if x.get('sourceKind')=='verified-develop' and x.get('setupOnlyCloneVerified') is True)
print(row['verificationManifest'])
PY
)"
```

First inspect the guarded schema plan, then apply only when deployment is explicitly authorised:

```bash
python3 apply-driver-setup-only-release.py --migration-directory "$PWD/migrations" --rehearsal-manifest "$proof"
# MUTATION: do not execute during review.
python3 apply-driver-setup-only-release.py --migration-directory "$PWD/migrations" --rehearsal-manifest "$proof" --apply
```

The apply helper validates the real restore proof, exact single-file hash, current source schema/routing and develop DB identity, then executes the unchanged transactional 550 file through the existing local PostgreSQL administration path. It never extracts a DB password. It refuses existing/partial objects and writes a private pending receipt before mutation, then an applied checksum receipt only after all before/after state hashes and disabled checks pass. No generic migration runner is used. A failure/uncertain receipt needs inspection; never delete it to blind-retry.

Lineage is recorded in the new migration manifest and ~/ng-cohost-release/setup-only-schema.json. Existing migration-tracker rows are not invented or rewritten because the deployment's authoritative tracker-write contract has not been established. If release policy requires an additional tracker registration, establish its verified schema/write procedure before executing Phase 2; do not fabricate columns or run a blanket db push. Already-applied broad migrations elsewhere remain unchanged and are not retroactively marked unapplied.

## Phase 3 — import the rebuilt API and stage DISABLED

Transfer the new image archive from Windows only after its local SHA256 matches the pin above:

```powershell
$archive = 'C:\Users\fedri\source\repos\Movabi-mobile-develop\.temp\vaydu-api-review-setup-only-20261028.tar'
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'f94ce142681aba4dd9a633c6facf5ebf2e3ee4376daa4f9c2ff477cdfdd9d842') { throw 'Image archive mismatch' }
scp $archive 'edsadmin@87.106.64.25:~/'
if ($LASTEXITCODE -ne 0) { throw 'Image transfer failed' }
```

On SSH, verify/import using the existing authorised Docker prefix (shown as sudo -n):

```bash
cd "$HOME/ng-setup-only-review"
printf '%s  %s\n' 'f94ce142681aba4dd9a633c6facf5ebf2e3ee4376daa4f9c2ff477cdfdd9d842' "$HOME/vaydu-api-review-setup-only-20261028.tar" | sha256sum -c -
sudo -n docker image load --input "$HOME/vaydu-api-review-setup-only-20261028.tar"
image='sha256:084b2cf6a7db7713244a7554a38acb54f0dd78323250ce9c260a2d541d7c3cfa'
test "$(sudo -n docker image inspect --format '{{.Id}}' vaydu-api:review-setup-only-20261028)" = "$image"
python3 release-driver-collection-cohost.py --plan --image "$image" --setup-only-directory "$PWD/migrations"
# MUTATION: only after deployment instruction, schema receipt and fresh real proof.
python3 release-driver-collection-cohost.py --stage-disabled --image "$image" --setup-only-directory "$PWD/migrations" --rehearsal-manifest "$proof"
```

The new helper selects the NEW schema contract; do not use --allow-missing-schema-disabled. It requires exact real proof plus matching applied-schema receipt and disabled private tables. It preserves the existing Supabase connection in-process and NODE_ENV=production. The provider file is the existing /home/edsadmin/.config/vaydu-collection-subaccount-sandbox/flutterwave-test.env, mounted read-only at /run/vaydu/flutterwave-test.env. Nothing is reprovisioned/copied into the image. Setup=false means it is not read by the provider factory.

Runtime flags: VAYDU_DEPLOYMENT_ENV=develop; co-host selector=true; setup=false; merchant_verified=false; default_approved=false; payout=false; topup=false; booking_split=false; split_timing=false. Flutterwave live key remains empty. Stripe credentials/routes/behaviour and existing collection routes are not changed.

## Phase 4 — disabled health and preservation checks

Wait for API /health to report status ok, then:

```bash
cd "$HOME/ng-setup-only-review"
python3 check-cohost-disabled-stage.py post-stage
```

This verifies pinned running image, fixed driver/tenant, untouched routing/completion/settlement fingerprints and protected Stripe/booking sources, private provider mount read-only, new setup schema present, all approvals/defaults disabled/NULL and no account rows. Local /health must be 200; unauthenticated Stripe and setup status reads must remain 401. These are read-only smoke checks, not a real financial transaction. With the schema in place an authenticated selected-driver status is unavailable while approvals remain off; no form activation/provider call is implied.

The stage recreates only the shared develop API. In-flight HTTP/WebSocket connections can be interrupted and existing workers restart. No database/frontend/auth container restart or port/proxy change is required. The existing frontend must contain the prepared Payment account component; otherwise review its develop frontend release separately. Keep the prior API image for rollback.

## Phase 5 — later single-driver activation (NOT approved)

Remaining decisions: privately attest intended Flutterwave TEST business/MID and map it to the internal alias; clarify the contradictory flat-default semantics and obtain explicit approval of an administrative default. The docs/API reference do not establish this merchant accepts flat zero; do not assume or apply it. No new key request is needed. Keep booking commission and wallet fee separate.

Only after those decisions, separately review an update to the one new driver_collection_setup_markets NG/NGN/test row: verified alias/evidence, merchant_identity_verified=true, explicitly approved default type/value and administrative_default_approved=true, then adapter_ready/setup_approved=true. Fixed driver/tenant checks prohibit another market/driver. Keep F4B false. Set the corresponding runtime merchant/default approval gates and setup opt-in only in that reviewed later release. All Flutterwave live, transfer, topup and booking-split/timing flags remain false. No booking route/default provider change is part of activation.

The first provider creation remains exclusively inside existing /driver/onboarding > Payment account > Set up payment account: private contact/bank details, resolve, driver confirmation, atomic claim, one TEST subaccount POST, matching retrieval and secure association, then completed status. No existing subaccount is required to open the approved form. HTTP 400/Subaccounts not found before creation is an empty list. After an uncertain create it remains reconciliation-only, never permission for another POST. Completed setup does not approve paid work, live payments or transfers.

## Rollback and recovery

Initial disabled API rollback uses the retained prior image/original Compose references:

```bash
cd "$HOME/ng-setup-only-review"
python3 release-driver-collection-cohost.py --rollback
# After /health is ready:
python3 check-cohost-disabled-stage.py post-rollback
```

Rollback has the same API connection interruption. It removes the extra provider mount and disables new opt-ins/approvals; it does not drop 550 tables, revert the new additive schema, rewrite migration history or restore the whole database. Keep schema configuration disabled and preserve any operation/subaccount references. After later UI testing, account rows must be retained; do not delete them merely to satisfy the initial-empty-stage check. Reconcile unknown outcomes with the original operation and stable fingerprint key.

## Current blocking status

Implementation, synthetic restore/SQL tests, API regressions, rebuilt image and combined plan are prepared. The real develop-backup rehearsal and real API source-parity preflight are NOT verified from this chat because authenticated SSH is unavailable. The next action is Phase 1 only. Merchant identity and default approval remain unresolved by design; neither is required to rehearse or install a disabled schema, but both are mandatory before later setup activation. No deploy/activation/provider creation has occurred.
