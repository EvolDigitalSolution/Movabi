Develop-only payment-account API release

Run from the authenticated edsadmin terminal. No provisioning or source export
is required. The existing private TEST file is preserved and mounted read-only
only after activation prerequisites pass. No database credentials are copied.

Before any mutation, verify/extract the uploaded archive using its SHA256
sidecar into a new owner-private directory. Never extract over an existing
release. Set the shell variable below to the extracted directory:

```bash
release="$HOME/vaydu-payment-account-releases/vaydu-payment-account-api-20261029-r2"
python3 "$release/operator/payment_account_operator.py" preflight
python3 "$release/operator/payment_account_operator.py" rehearse
python3 "$release/operator/payment_account_operator.py" prepare-image
python3 "$release/operator/payment_account_operator.py" test-api
```

Use `set -e` in a combined shell block so every failed stage stops the sequence.
These stages do not change the application database or restart services.
Rehearsal retains a fresh private dump, restores the original DB image into a
network-none disposable cluster, copies structural NOLOGIN roles only, restores
ownership/ACLs, applies only the setup canonical/recovery lineage, and verifies
unchanged protected functions/data/ACLs plus setup claims/permissions/recovery.
The original dump and application database are retained. Only the freshly
created disposable container is removed. Never clean Docker shared images.

prepare-image uses the pinned server-local image
sha256:1ef978c931bf390273f4648f6c8bdce04231338d64ae7c6ead7e4e10d723c6aa.
It uses exactly the reviewed three-file patch and seven-file API dependency
closure. test-api executes the image's original CMD with networking disabled
and synthetic settings, verifies health/unauthenticated setup routing, then
runs the real disposable Auth/PostgREST/PostgreSQL HTTP tests. It records proof
only on success. Private diagnostics are retained if either test fails.

After those stages pass, the disabled staging sequence is:

```bash
python3 "$release/operator/payment_account_operator.py" install
python3 "$release/operator/payment_account_operator.py" deploy-disabled
python3 "$release/operator/payment_account_operator.py" verify
```

install is the first command that writes to movabi_develop. It requires the
fresh matching real-backup rehearsal receipt. It installs the additive schema
with setup disabled. Repeated complete installation is an operator no-op;
partial or incompatible schema is refused rather than overwritten. Existing
migrations are never rewritten. There are no collection route seeds, booking
changes, transfer/outbox or subaccount migrations in this sequence.

deploy-disabled recreates only the develop API, causing a brief API interruption
and disconnecting in-flight requests. It preserves every original Compose file
in order, appends its own image/disabled-gate override and leaves NODE_ENV,
existing credentials, Stripe/booking/payout sources and the web image unchanged.
Rollback metadata is written BEFORE restart, so a failed restart is recoverable.
verify checks the running image, preserved source fingerprints, web identity,
disabled gates and the known authenticated endpoint contracts.

The optional private binding check, without any provider request, is:

```bash
python3 "$release/operator/payment_account_operator.py" check-binding \
  --secret-file "$HOME/.config/vaydu-collection-subaccount-sandbox/flutterwave-test.env"
```

This explicitly uses the already-provisioned TEST key for beneficiary onboarding,
not wallet collection or subaccounts. It reports presence/format/internal-alias
match only. It neither prints the key nor treats that alias as a Merchant ID.
If the existing file is elsewhere, supply its verified absolute path. Do not
scan again, change unrelated permissions, substitute wallet secrets, or repeat
provisioning. Missing or mismatched binding is a blocker, not an approval.

Setup-only onboarding has no cash-exclusion integration dependency. Cash rides, wallet collection and transfers stay disabled through their existing independent gates. No cash-exclusion files are included or modified. Merchant evidence gates provider activation only; image preparation, rehearsal and disabled staging proceed independently.

Merchant evidence is supplied by the human operator, never automatically filled.
Copy merchant-evidence.template.json to a private file outside the repository,
mode 0600. While signed into the intended Flutterwave business, visibly select
TEST mode, confirm the business name and provider Merchant ID, privately confirm
the existing key belongs to that TEST business, and approve only the selected
NG/NGN bank-destination setup. Enter the non-secret fields and mark only checks
actually completed. Do not enter keys, account numbers or raw provider payloads.
Then the review command is:

```bash
python3 "$release/operator/payment_account_operator.py" record-merchant-evidence \
  --evidence-file "$HOME/.config/vaydu-payment-account-merchant-evidence.json"
```

The receipt explicitly records an operator dashboard review, not an independent
provider identity API verification. Unresolved fields stay false and block it.
No wallet transaction account_id, webhook, subaccount default split or existing
transaction is required for this beneficiary setup. Native return certification
and wallet collection are separate work.

After private TEST binding and genuine merchant evidence pass, the command is:

```bash
python3 "$release/operator/payment_account_operator.py" activate
```

This command refuses activation until merchant evidence and private TEST binding pass.
Its successful use mounts the existing TEST file read-only, activates only
the selected driver/tenant NG/NGN setup row, and keeps transfers, collection,
booking splits and production untouched. It never creates a beneficiary itself.
Creation is only the driver's confirmed onboarding action.

Rollback, including after a failed API restart:

```bash
python3 "$release/operator/payment_account_operator.py" rollback
```

Rollback restores the saved original API image and exact original Compose chain,
removing this release's override/private-file mount. It disables the selected
setup row when the database is available. If the database is unavailable it
still restores the original API and reports the DB disable as incomplete. It
does not drop additive schema, erase claims/reconciliation history, delete
backups, undo unrelated data changes, or change the original web image.
The rollback receipt is under
$HOME/.local/state/vaydu-payment-account-operator/deployed.json.

Later browser acceptance, only after activation:
sign in as the confirmed driver, open Driver Setup > Payment account, select a
bank, enter the account number, Check account, review the resolved name, tick
confirmation, and Confirm payment account. Completed setup must survive reload.
An uncertain response must offer reconciliation without another creation.
Refresh canonical requirements, complete outstanding identity/compliance checks,
then use the normal review submission/Driver Hub journey. Setup alone must not
grant identity approval, cash jobs, payouts or money movement. Real merchant and
hosted browser results must be recorded separately; local tests do not prove them.
