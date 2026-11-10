> Superseded for the requested combined setup release by [setup-only schema and co-hosted API plan](NG_SETUP_ONLY_COMBINED_RELEASE.md). Use new migration 550/new API image; real develop-backup rehearsal is still pending.

> Current staging sequence and compatibility correction: [disabled application-only staging](NG_COHOST_DISABLED_STAGE_COPY_PASTE.md). The earlier broad migration deployment is deferred because it changes routing/booking authorities and triggers. Use the new checksum-pinned bundle for disabled staging only.

# Implemented co-hosted develop onboarding — review before rollout

28 October 2026. Local implementation and tests only. No remote deployment, provider call, key provisioning, backup rehearsal, account creation, transfer or payment was performed. Merchant identity and the administrative split remain UNAPPROVED; no flat-zero default was installed.

## Implemented integration

The existing API mount now calls developDriverPaymentAccountRouter(). With the opt-in absent/false it returns the existing router, preserving Stripe/default behaviour. With the explicit co-host opt-in true it injects the same supabaseAdmin object into auth, account scope and DriverCollectionAccountService. It uses that client's non-secret supabaseUrl to verify the exact develop target. No createClient, database credential getter, environment enumeration, credential serialization or DB transport is added.

The new provider factory permits the existing NODE_ENV=production only for VAYDU_DEPLOYMENT_ENV=develop plus explicit VAYDU_DRIVER_SUBACCOUNT_COHOST_DEVELOP=true and an exact develop client target. The isolated-process sandbox guard is unchanged. Setup defaults disabled and reads no file/makes no requests while disabled. All other new collection/transfer/timing flags must remain false/absent.

Actual activation additionally requires VAYDU_DRIVER_SUBACCOUNT_SANDBOX=true, VAYDU_DRIVER_SUBACCOUNT_MERCHANT_VERIFIED=true and VAYDU_DRIVER_SUBACCOUNT_DEFAULT_APPROVED=true. These are operator approvals, not inferred by code or tests. The approved database market row must also exist, match its merchant alias and configured default, and satisfy the existing setup approvals. No default value is supplied by this patch or release helper.

Only the exact driver 318e6be9-9164-41fa-bb0c-c5ccd3526585 and tenant d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8 can use NG/NGN collection setup, even if another database row is accidentally approved. Owner identity comes from existing JWT verification and activated profile scope, not request fields. GB/GBP status delegates to the existing Stripe service; Stripe /api/connect, credentials, booking authorisation/capture and payout rules are unchanged.

The co-hosted router registers only GET status/banks and POST resolve/setup/reconcile. It does not register the transfer webhook. It does not mount another booking route or start a worker. Existing customer/Stripe routes remain in the main API, with the new booking split gates false.

The existing private provider file is mounted read-only at /run/vaydu/flutterwave-test.env. It is read once only when explicitly approved setup activates; its values are not injected into process.env. The Linux loader requires a regular 0600 file, verified owner UID, bounded size and O_NOFOLLOW. Strict provider-only parsing rejects duplicate/unknown/DB fields, live credentials and activated flags in the stored file. TEST key, original stable fingerprint key and alias remain in memory only. No new key entry or copied DB connection is needed. The public example file contains only disabled non-secret flags and does not change NODE_ENV.

First-time status does not list subaccounts or require an existing account. Onboarding retains contact/bank entry, account-name resolution and explicit driver confirmation. A durable unique claim precedes one creation POST. Completion requires matching retrieval/identity. A timeout or later empty list remains reconciliation-only, with no second create, even after refresh/repeated confirmation. New co-hosted tests use synthetic approved fixtures with a nonzero test default; this is not approval of any real merchant/default.

Security boundary: added code shares the develop API's existing service-role privilege and restart/failure boundary. RLS is not sufficient for service-role code, so authenticated owner/tenant checks and fixed single-driver scope remain mandatory. Docker/host administrators can access mounted secrets; file permissions are not an isolation boundary from administrators. No main API NODE_ENV/Stripe environment change is needed.

## Local verification

- 179 focused backend tests across seven suites passed, including co-hosted scope/approval/unsafe-env checks, private-file parsing, no DB/Stripe credential reads, claim races, empty-list reconciliation and Stripe delegation.
- 161 existing Stripe/payment convergence, saved-card/shared payment and completion/payout retry regressions passed across four suites.
- Four Playwright settings/onboarding confirmation/reload/timeout-recovery tests passed with mocked services.
- Server TypeScript checks passed locally and in the actual image with networking disabled.
- Linux image smoke checks passed for real private-file 0600/owner/symlink handling using ephemeral synthetic data; deployment files, scripts and .env were absent from the runtime image.
- Synthetic release-helper tests passed for read-only plan, missing-schema refusal, disabled staging and rollback/service-only commands. No Docker/SSH was called by those Python tests.

Reviewed local image tag: vaydu-api:review-cohost-20261028

Immutable local image ID: sha256:508ae7f1260bd3340ad2c2d7e1503007aeb16a4a99143356d6e0c2dbcfe15480

Built with server/Dockerfile.driver-collection-cohost. It copies only API/runtime sources and required shared models/utils; no repository-wide deployment/backup files or external provider file are baked in. It retains the existing API dependency recipe. npm reported 66 dependency audit findings during that existing recipe (6 low, 13 moderate, 40 high, 7 critical); this change does not remediate or establish the exploitability of those dependencies.

## Exact future rollout commands — NOT RUN remotely

The command below stages the co-hosted integration DISABLED. It cannot approve identity/defaults or enable setup. No activation command is supplied while those decisions remain unresolved.

Before staging, the already-rehearsed migration manifest must be applied through the controlled develop migration procedure: 20261253900000, 20261254600000, 20261254700000, 20261254800000, 20261254900000, in order and only when unapplied with matching hashes/history. No SQL changed here. Do not blindly replay non-idempotent files or invent migration-tracking columns. The helper reports table/function prerequisites and refuses staging if absent; it does not apply migrations or certify their history. Keep the completed fresh backup/rehearsal; do not reprovision keys.

After release review, export/copy the credential-free image and public helper from Windows PowerShell:

```powershell
docker image save --output 'C:\Users\fedri\source\repos\Movabi-mobile-develop\vaydu-api-review-cohost-20261028.tar' vaydu-api:review-cohost-20261028
scp 'C:\Users\fedri\source\repos\Movabi-mobile-develop\vaydu-api-review-cohost-20261028.tar' edsadmin@87.106.64.25:~/
scp 'C:\Users\fedri\source\repos\Movabi-mobile-develop\scripts\release-driver-collection-cohost.py' edsadmin@87.106.64.25:~/
```

In the authenticated SSH shell, using the existing authorised Docker access (shown with sudo -n for image import):

```bash
sudo -n docker image load --input "$HOME/vaydu-api-review-cohost-20261028.tar"
printf '%s  %s\n' 'd31496912b95f64f7f6355a19f134ec64350bb911f404b519e183657ee0d2d22' "$HOME/release-driver-collection-cohost.py" | sha256sum -c -
python3 "$HOME/release-driver-collection-cohost.py" --plan --image sha256:508ae7f1260bd3340ad2c2d7e1503007aeb16a4a99143356d6e0c2dbcfe15480
```

The plan is read-only. Inspect its service/image and migrationPrerequisitesPresent result. Stop on an immutable-image mismatch after import; do not substitute an unrelated image/tag. The target must be the original movabi-develop Compose project with its actual original configuration/working-directory references. If those references are unavailable under its release tool, stop and adapt that supported launcher; do not reconstruct its secret environment or print docker compose config.

Only after explicit deployment instruction and verified migrations, the exact disabled staging command is:

```bash
python3 "$HOME/release-driver-collection-cohost.py" --stage-disabled --image sha256:508ae7f1260bd3340ad2c2d7e1503007aeb16a4a99143356d6e0c2dbcfe15480
```

The helper verifies source DB image/network, original Compose labels, schema prerequisites, local immutable image, existing file mode/owner metadata and compatible API runtime UID. It never reads the credential file or Docker Env. It retains original Compose references and the prior API image in ~/ng-cohost-release/release.json (private 0700 directory/0600 files), writes a provider-only read-only mount and disabled non-secret overrides, and invokes Compose up with --no-deps --no-build --pull never --force-recreate for the existing API service alone. It does not change the API's existing DB configuration or NODE_ENV. A failed partial staging leaves the review files for diagnosis/rollback; do not rerun by deleting history.

## Restart impact and rollback

Staging recreates only the shared develop API. In-flight API requests, keep-alive/WebSocket connections and onboarding calls can be interrupted; existing background workers restart as part of the normal API restart. Choose a develop maintenance window. The helper does not recreate the database, frontend, auth, Stripe service dependencies or migrate data. No new port or proxy routing is needed. The existing deployed frontend must contain the already-prepared payment-account onboarding component; if not, its separately reviewed develop frontend release is required before the UI test.

After staging, verify normal API health and existing authenticated GB Stripe status without submitting payments. Selected NG status must remain unavailable while runtime/merchant/default approvals are false. No provider creation or credential read is expected in that disabled stage.

If staging fails, or to revert the integration:

```bash
python3 "$HOME/release-driver-collection-cohost.py" --rollback
```

Rollback validates the same develop identity, uses the retained original Compose references and prior local image, sets the new setup/co-host/merchant/default approvals false and recreates only that API service. It omits the added provider mount from the restored Compose definition. It does not drop tables, reset claims, erase uncertain outcomes or rotate keys. It has the same brief API interruption. Retain the local prior image until the test is closed.

## Later activation: remaining decisions, not executed

Merchant identity attestation and provider clarification/explicit owner approval of an administrative default remain unresolved. Keep the prior dashboard checklist/support question from NG_SUBACCOUNT_COHOSTED_DEVELOP_PLAN.md; the alias is not a verified MID and flat zero is not assumed safe/accepted.

After those decisions, separately review the selected NG/NGN market row and capability evidence/default, then the runtime merchant/default approval gates and setup flag. This patch restricts the fixed driver/tenant regardless of row values. Keep other market setup approvals and all F4B, booking split, fee-passing/settlement, transfer and live approvals disabled. No current command activates them.

The sole test creation will then occur inside that driver's /driver/onboarding > Payment account > Set up payment account form: private details, resolution, confirmation, one POST, verified retrieval/link and status update. An empty list before submission does not block the form. An uncertain result after submission requires reconciliation, not another creation. No manual account, booking, transfer or wallet charge is part of this test.
