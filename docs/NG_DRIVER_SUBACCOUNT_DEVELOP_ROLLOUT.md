> Current result: the user has completed the real restore/collection rehearsal successfully. The canonical flag is expected false in this mode. Bank/fee calls succeeded; subaccount listing returned HTTP 400. See [the accepted results and next diagnostic](NG_SUBACCOUNT_REHEARSAL_RESULT_AND_400.md). Do not rerun provisioning or the rehearsal solely for that flag.

# NG/NGN driver subaccount: operator rehearsal and proposed rollout

27 October 2026. **Preparation only; nothing deployed or enabled.** Booking payment timing and the customer journey remain unchanged. No payment, subaccount creation or transfer has been initiated by the tools.

## Confirmed scope and evidence

- Existing activated driver: `318e6be9-9164-41fa-bb0c-c5ccd3526585`.
- Tenant: `d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8`.
- Market: NG/NGN. Use this account; no replacement driver is needed.
- User-reported develop audit: Flutterwave is absent from the provider constraint, NG/NGN still prefers Kora, and the new subaccount tables are absent.
- User-confirmed test provisioning: private file `/home/edsadmin/.config/vaydu-collection-subaccount-sandbox/flutterwave-test.env`, mode 0600; test format confirmed, no provider requests yet, live key empty, sandbox and database connection unconfigured.
- Do **not** rerun provisioning or rotate the generated HMAC key. The existing private file is the input to the new read-only probe.
- Current SSH identity check from the tools failed with `Permission denied (publickey,password)`. Therefore the real archive rehearsal and real merchant probe require the commands below in the operator's authenticated SSH session. Their results must not be represented as already passed.

## Database connection: exact blocker

The existing API code initializes Supabase using `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` supplied to its process. Local Compose uses variable interpolation; the earlier sandbox file names `VAYDU_DRIVER_CARD_CONNECTION_ENV` as an unresolved placeholder. Neither identifies an existing supported secret-manager binding. The user reports the remote audit also found no supported binding.

**Application connection remains unconfigured.** The missing item is an operator-identified, supported existing manager/deployment binding that injects those two values directly into the isolated develop process. No new connection file, credential extraction, container Env dump, password change, direct admin application connection, or invented manager command is provided.

The backup tool separately uses authorized local Docker/PostgreSQL administration. This does not establish an application connection and does not authorize copying its credentials. It now inspects only selected container metadata and copies structural role attributes as NOLOGIN into the disposable restore; no role passwords or connection URLs are fetched.

## Review bundle

Local folder: `scripts/ng-sandbox-review/`. Contains only reviewed scripts, non-secret confirmed scope, checksum manifests and five SQL sources. The generator rejects unexpected files/symlinks so an accidental credential file is not silently bundled.

From Windows PowerShell, copy these **non-secret review files**, not the private credential file:

```powershell
scp -r 'C:\Users\fedri\source\repos\Movabi-mobile-develop\scripts\ng-sandbox-review' edsadmin@87.106.64.25:~/
```

Then in the existing SSH shell:

```bash
cd "$HOME/ng-sandbox-review"
sha256sum -c SHA256SUMS
```

Stop on a checksum failure. This upload is not application deployment; it does not start services or apply SQL to develop.

## Real backup and isolated restore rehearsal

Prefer a **fresh** backup containing the confirmed driver rather than assuming the older verified archive contains their current activation/tenant. This command makes a private full archive, restores it into a fresh labelled `--network none` clone with no exposed ports, verifies the selected driver and wallet ownership/ACLs, then applies the five files **only inside the clone**:

```bash
python3 "$HOME/ng-sandbox-review/verify-develop-wallet-backup.py" \
  --migration-directory "$HOME/ng-sandbox-review/migrations" \
  --expected-driver 318e6be9-9164-41fa-bb0c-c5ccd3526585 \
  --expected-tenant d0e8e8e8-e8e8-e8e8-e8e8-d0e8e8e8e8e8
```

It verifies the known develop database image/network/project and connects to **movabi_develop** locally without extracting credentials. It requires disabled wallet collection and sufficient disk. It reports missing outbox/settlement/refund prerequisites by name rather than importing guessed baseline migrations.

Required success fields:

```text
restoreVerified: true
collectionMigrationCloneVerified: true
selectedExistingDriverVerified: true
```

The private verification manifest must also show `collectionGatesDisabledVerified: true`. Source counts and selected driver identity/activation must remain unchanged. The clone is removed after verification; the private backup remains. A stale archive missing the driver, or with different activation/tenant, must fail.

Reviewed clone-only order:

1. `20261253900000_flutterwave_market_provider_prerequisite.sql`
2. `20261254600000_driver_payment_accounts_sandbox.sql`
3. `20261254700000_flutterwave_payout_outbox.sql`
4. `20261254800000_flutterwave_collection_subaccounts.sql`
5. `20261254900000_flutterwave_booking_split_authority.sql`

These are migration sources, not idempotent scripts to replay blindly against a database already partly migrated. Unexpected existing objects or changed completion validation must be reviewed before proceeding. The helper does not apply them to the actual develop container.

## Test-merchant capability check: read-only first

Run as `edsadmin`, using the private file already provisioned:

```bash
python3 "$HOME/ng-sandbox-review/check-flutterwave-test-merchant.py"
```

The probe accepts only the exact existing provider-file location, checks owner/0600/non-symlink/outside-Git, requires a test key, an empty live key and all collection/timing gates still false. It performs only:

- `GET /v3/banks/NG`: reports availability and count, not bank data.
- `GET /v3/subaccounts?page=1`: reports availability/count, not subaccount/account records.
- `GET /v3/transactions/fee?amount=105&currency=NGN&payment_type=card`: reports numeric estimate and whether the customer total would unexpectedly exceed 105 NGN.

No raw response, key, account number, name or contact is printed. HTTP errors report stage and status only. It neither creates records nor rewrites the private file. Exit 0 means those read-only checks passed with no estimated additional charge; it is **not** proof of subaccount-create permission, merchant alias ownership, split semantics or settlement support. Those fields are explicitly reported untested/unverified. A fee estimate is not proof of the dashboard fee-passing setting or actual checkout total.

**Current real result (user supplied): bank catalogue and NGN fee quote accessible; collection subaccount list HTTP 400; identity, creation and settlement remain unverified.** The follow-up read-only diagnostic is in the accepted-results document. A successful result must be retained alongside the real backup manifest before setting any setup approval.

## Proposed develop rollout, after review and a separate deploy instruction

1. Accept the checksum-verified real backup rehearsal and the read-only merchant result. Resolve any missing baseline contracts first; preserve existing Kora overrides and historical rows.
2. Identify the supported application connection injection. **Deployment is blocked here until that actual binding is known.** No executable container-start command with an invented connection source is supplied.
3. Approve the administrative test default proposal `split_type='flat', split_value=0`. This is not the wallet fee, booking commission or a guaranteed harmless fallback. The API requires a default; collection remains off, and every future eligible booking must supply its own verified frozen override. If the test merchant rejects zero, report that result and stop; do not silently substitute a percentage or repeat creation.
4. After explicit deploy authorization, apply only the reviewed, successfully rehearsed disabled migration set to the verified develop database, through the existing reviewed deployment procedure. Audit again: Flutterwave provider constraint present; NG preference handled by the additive placeholder/default rules; no collection/payout approval accidentally enabled.
5. Inject the existing private **provider** file by reference and the connection through the verified supported manager. Preserve the shared API's NODE_ENV and Stripe settings. Run the dedicated process with `NODE_ENV=test`, `VAYDU_DEPLOYMENT_ENV=develop`; only the subaccount-setup runtime gate may later be enabled for the approved test.
6. Configure only `driver_collection_markets` NG/NGN for the confirmed driver/tenant, test merchant alias, approved default and evidence reference. Allow bank setup first. Keep F4B approval false unless separately verified. Keep `split_collection_approved`, all transfer approvals and all other market setup approvals false.
7. Use a narrow **develop API** proxy for `/api/driver-payment-account/{status,banks,resolve,setup,reconcile}` to the isolated service on internal port 3022. The browser uses `movabi-api-develop.apps.evolsolution.com`; routing only the web host would not be sufficient. Preserve `/api/connect` and production routes. Do not expose booking checkout routes during this setup test. Release the already-tested develop UI through its existing frontend release procedure; do not reuse an older card-only image as if it contained the corrected form.
8. Verify test-key-only runtime, confirmed NG scope, disabled booking/payout gates, health and owner-bound status before opening the driver form. No new paid-work acquisition, customer payment journey or cash capability is activated by setup completion.

Local reviewed API image:

```text
vaydu-driver-collection-sandbox:review-20261027
sha256:40c4a6cc0372b156dc00c4a64091f6aa58af38e799d3b144ff3a1672e8e159a9
```

Built locally, not pushed or loaded remotely. A network-none smoke run without configuration exited 1 with the expected `Payment-account sandbox configuration rejected.` message. No key or connection was included in the image.

## Exact single-driver sandbox test

After the approved setup-only rollout and supported connection injection:

1. Sign in as the existing confirmed NG driver. Open **Payment account → Set up payment account**.
2. Enter name/contact and approved sandbox bank details privately in the UI. Resolve the account and confirm the returned name. Do not paste bank data into chat or reports.
3. Submit once. Verify one durable claim and one provider create request, then the private association with the same driver, tenant, NG/NGN, merchant and test environment.
4. Require the documented paginated subaccount lookup to match the operation/request markers and destination. Report only setup state, successful association and retrieval match—no bank details. Do not infer transfer/virtual-account readiness.
5. Reload and retry status. It must return the same association without another create. Any timeout must offer reconciliation only. Invalid details, unsupported zero, 401/403, metadata mismatch or ambiguous existing account must be reported precisely and left unenabled/review-required.
6. Verify another driver/tenant cannot use or view the association. Check existing GB Stripe onboarding behavior independently.
7. Finish with booking collection/timing, live keys, live payments and all payouts still disabled. This test creates a TEST collection subaccount only; it sends no transfer and makes no customer payment.

Rollback preserves provider references and unknown outcomes: disable selected setup, stop only the new isolated service, remove only its develop proxy override and restore the previous frontend image if needed. Do not delete subaccount history or recreate an uncertain operation.

## Work completed locally in this turn

- Full synthetic Supabase PostgreSQL 15.1.1.78 archive/restore rehearsal passed, including ownership/ACL comparison, an existing unactivated NG fixture retained, five migrations applied only inside the clone, and source/gates unchanged. The local image is the matching version tag; the real server's exact image ID remains enforced in real mode.
- A second rehearsal correctly refused an older archive lacking the selected fixture driver despite identical wallet counts.
- Merchant probe tests passed with mocked HTTP on Windows and in network-none Linux, including 0600/ownership checks, live rejection before network, and suppression of bank/key/raw error payloads.
- Review image built and its default-off smoke check passed.
- Real server rehearsal is now accepted from user-supplied output; the real probe has the unresolved list 400 described above. Supported connection injection remains blocked. Previous 360-test application regressions are historical validation, not a newly executed merchant test. No booking journey code changed in this turn.
