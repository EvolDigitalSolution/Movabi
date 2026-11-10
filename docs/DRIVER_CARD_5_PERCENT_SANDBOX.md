# Shared 5% driver card policy and first develop sandbox

Status: local implementation/builds/tests passed; no remote schema or application deployment, sandbox scope activation or provider payment has occurred. The first candidate is **Flutterwave / Nigeria / NGN**, conditional on the actual test merchant. Real credentials have not yet been confirmed provisioned: the first terminal prompt failed before accepting a key; its corrected replacement has passed a real Linux PTY regression.

## Approved policy and account selection

The shared server-owned version is `vaydu-driver-card-5pct-wallet-v1`: card method only, wallet-credit basis, 500 basis points, no fixed component, no cap, rounded half-up once to the configured currency's minor unit. The three frozen amounts are wallet credit, **Vaydu fee (5%)**, and total. For credit 10,000 major units, the fee is 500 and total 10,500, at the approved exponent. Provider processing costs are separate observations; 5% is not assumed to cover them.

No market is enabled by defining this policy. Each provider/market/test driver needs an immutable reviewed scope identifying the tenant, driver, merchant, actual provider account, card method, merchant-absorbed fee mode and review evidence. The only new route adapters currently implemented/tested are **Flutterwave sandbox and Stripe sandbox**. Other providers fail closed until their own card adapter and review are approved; shared-policy arithmetic tests do not assert those providers support a market.

The user's driver inventory returned:

| Driver ID | Registered market | Resolved wallet market | NGN candidate |
|---|---|---|---|
| `c24f395c-c787-4464-a1ab-3345881e5faa` | GB / GBP | GB / GBP | No |

There is no eligible NG/NGN driver in that activated-account result. This does not prove that no incomplete Nigerian driver profile exists. The next business input is an approved, activated **driver** with a resolved NG/NGN wallet and valid login/email; supply its UUID after normal onboarding/activation. Do not convert or reuse the Nigerian customer account. Country/currency and the 5% fee approval do not need to be supplied again.

## Implementation and isolation

- Driver Hub wallet panel displays credit, Vaydu fee and total, requires agreement, persists one owner-scoped attempt/key across reloads, and never treats a browser return as payment success.
- The server derives owner/tenant/market/route/account/policy from auth and database state. It rejects client authority fields, unsupported adapters, unreviewed scopes and inconsistent totals. Fee/exponent/account/review identities freeze before the durable submission claim.
- A **separate driver sandbox gate** (`driver_card_sandbox_enabled`) allows only approved driver-card scopes. Its additive exception preserves the remaining inspected initiation/submission functions exactly. The broad `wallet_collection_enabled` gate stays false; customer collection is not enabled for this test.
- Existing Stripe checkout, saved-card setup and payout source paths remain unchanged. A separate driver Stripe adapter uses test keys, exact existing Stripe unit conversion, card-only fixed line items, disabled tax/adaptive pricing/promotions, server-side session/PaymentIntent/charge checks and read-only reconciliation after a lost response.
- Flutterwave uses test keys, card-only checkout, a pre-submission fee query and exact requested/charged-total/account/method verification. Its JSON monetary number tokens are preserved before numeric parsing, including large decimals.
- `wallet_topup_provider_observations` stores only whitelisted fee-estimate and transaction-query fields, deduplicated by evidence hash. It excludes card details, tokens, credentials, customer objects and IPs. Provider fee/settlement decimals are retained separately, with explicit settlement currency/API-unit labels for Stripe. Later observations may add settlement data not yet available initially.
- Exactly one wallet credit posts for the wallet amount only. Duplicate callbacks/queries do not post another credit. Unexpected provider totals are observed and rejected; no redirect or webhook alone grants value.
- The dedicated process (`server/driver-card-sandbox.ts`) runs in test/development mode with an explicit develop marker/origin, rejects live keys and production Supabase targets, and exposes only driver top-up routes. It leaves the shared API's `NODE_ENV=production` and existing integrations alone.
- The develop-only web variant routes only `/api/payment/driver-topup/` to that process. Native develop builds use the approved develop web endpoint with narrowly allowed native origins. No production frontend routing changes are made. Native execution/return is still unverified.

## Merchant/checkout checks still required

Flutterwave's dashboard setting can add provider fees after the submitted amount. Official instructions place it at Settings → Business preference → Fee settings. Review the **test merchant**, requiring merchant absorption rather than customer passthrough. A fee estimate is useful evidence, but not proof of the dashboard setting, account identity or every card's international fee. [Official fee-passing guidance](https://www.flutterwave.com/us/support/pricing/how-to-pass-the-transaction-charge-to-your-customers), [fee-query API](https://developer.flutterwave.com/reference/get-transaction-fee).

The corrected terminal prompt validates the `FLWSECK_TEST-` format **before any provider request**. It then makes only a read-only NGN/card fee query for amount 105 and requires the reported charge to remain 105. It asks privately for a distinct webhook secret, merchant reference, test account ID and the approved callback `https://movabi-develop.apps.evolsolution.com/driver-topup-return`. It stores configuration mode 0600 under the user's private configuration directory, refuses repository paths, and keeps the API switch false. It prints presence/result flags only. A successful fee query does not establish complete merchant NGN support or account ownership; dashboard review and the actual hosted checkout remain required.

Before payment, the provider page must show exactly the frozen currency and total. Stop without paying if it differs. Server verification independently checks the actual charged total and records provider-reported `app_fee`, `merchant_fee`, `amount_settled` or Stripe balance-transaction fields for comparison. These are provider-reported transaction/settlement observations, not proof of bank settlement. [Flutterwave transaction fields](https://developer.flutterwave.com/reference/verify-transaction-with-tx_ref).

## Canonical SQL and deployment preparation

`supabase_incremental_schema_reconcile.sql` now contains managed section `VAYDU_DRIVER_CARD_TOPUP_20261027`. The generator preserves all pre-existing bytes outside that section. The exact section is extracted to `scripts/driver-card-develop-release/supabase_incremental_schema_reconcile.sql`, so unrelated legacy reconciliation is not replayed.

The section is develop-database-only, atomic, validates the audited baseline, enables no routes/scopes/gates and seeds no active market fee schedule. Its private release marker records source and catalog fingerprints. An identical rerun is a no-op; changed SQL/catalog refuses automatic reconciliation. This replaces the earlier fresh-only candidate as the reviewed deployment path.

The credential-free release folder contains checksums/manifest, disabled schema checker, separate sandbox Compose file and narrow web override. The manifest pins the built image IDs and canonical SQL checksum and leaves the first driver unset. The checker defaults to **read-only**; its explicit disabled-schema application option changes no images or collection flags. Do not invoke application/activation steps until remaining prerequisites are reviewed.

Compose uses user-authorized **secret-manager injection only**. A proposed helper to extract and copy the existing Supabase service-role key was rejected by automatic approval review and was not created. The user subsequently authorized direct injection, not extraction/copying. The connection-binding reference/path must still be supplied by the existing manager; do not print its contents or run a rendered Compose config with real secrets. No such credential extraction or persistence was performed.

The existing API/web ordered override chains and previous image identities must be retained. The new sandbox process has its own Compose project, no host port publication, a read-only filesystem and limited resources. Its prepared configuration forces the API switch false. The web override must be appended only to the verified original develop web chain, never used as a replacement for it.

## Actual validation for this revision

| Check | Actual result |
|---|---|
| `npx tsc --noEmit -p server/tsconfig.json` | Passed |
| Focused/shared-policy/Stripe saved-card and payout regression command below | **147 tests passed** across 11 files |
| `pwsh -NoProfile -File scripts/test-driver-topup-db.ps1 -Integration` | Passed; disposable PostgreSQL, Auth/PostgREST, both Stripe/Flutterwave adapters with mocked transports, concurrency, single credits, observations, 0/2/3 exponents, rollback/reapplication/refusal; broad collection remained false |
| `pwsh -NoProfile -File scripts/test-driver-card-canonical.ps1` | Passed first apply, idempotent repeat, record preservation, gates off, drift refusal |
| `verify-develop-wallet-backup.py` with fixture source and reviewed canonical SQL | Passed complete archive restore, ownership/ACL comparison, canonical apply twice only inside the fresh clone, original source counts/gates unchanged |
| `npx playwright test e2e/driver-wallet-topup.spec.ts --project=mobile-chromium` | **2 passed**, separate provider handoffs; actual Angular UI with synthetic API/provider pages |
| `npm run build:mobile:develop` | Passed; existing app.css size-budget warning |
| Both dedicated Docker images | Built successfully; API health smoke passed without credentials/DB; nginx syntax passed |
| Sandbox Compose `config --quiet` | Passed using empty fixture env files only; nothing started |
| Linux PTY provisioning regression | Passed hidden inputs/no echo, 0600 outside-repository storage, live-key rejection before network, payments off; synthetic inputs only |

The payout regression harness initially lacked its existing real market-fare-guard dependency. Its test import was repaired; production pricing/payout behavior was not changed. A canonical drift test also caught a reserved SQL variable-name collision; the variable was corrected and the refusal regression passed. No failures are counted as successful validation.

The real server backup is already verified as recorded in `DRIVER_WALLET_DEVELOP_READINESS.md`. Applying this **new** canonical section to a disposable restore of that actual archive is prepared in `scripts/validate-driver-card-canonical-on-backup.sh` but has not yet run on the server. Synthetic restore success is not claimed as that server test or as a real provider payment.

## Local reproduce and safe staging

```powershell
Set-Location 'C:\Users\fedri\source\repos\Movabi-mobile-develop'
$ErrorActionPreference='Stop'
function Check-Exit { if($LASTEXITCODE -ne 0){throw "Command failed: $LASTEXITCODE"} }
npx tsc --noEmit -p server/tsconfig.json; Check-Exit
npx vitest run src/testing/driver-card-approved-policy.spec.ts src/testing/driver-wallet-topup-http.spec.ts src/testing/flutterwave-driver-card.spec.ts src/testing/stripe-driver-topup-sandbox.spec.ts src/testing/driver-card-sandbox-process.spec.ts src/testing/card-wallet-v23.spec.ts src/testing/wallet-topup-orchestration.spec.ts src/testing/provider-currency-options-v23.spec.ts src/testing/completion-payout-retries.spec.ts src/testing/payout-calculator.spec.ts src/testing/shopping-budget-payout-authority.spec.ts; Check-Exit
pwsh -NoProfile -File scripts/test-driver-topup-db.ps1 -Integration; Check-Exit
pwsh -NoProfile -File scripts/test-driver-card-canonical.ps1; Check-Exit
npm run build:mobile:develop; Check-Exit
npx playwright test e2e/driver-wallet-topup.spec.ts --project=mobile-chromium; Check-Exit
python scripts/prepare-driver-card-release.py; Check-Exit
```

Optional credential-free SQL staging from a **local PowerShell terminal**, using password entry only at SSH/SCP's own hidden prompts:

```powershell
ssh edsadmin@87.106.64.25 'umask 077; mkdir -p "$HOME/vaydu-driver-card-release-20261027"'
scp scripts/driver-card-develop-release/supabase_incremental_schema_reconcile.sql scripts/driver-card-develop-release/release-manifest.json scripts/driver-card-develop-release/checksums.json scripts/driver-card-develop-release/check-driver-card-disabled-release.py edsadmin@87.106.64.25:vaydu-driver-card-release-20261027/
```

This stages public release artifacts only. Then the existing SSH session can run the prepared `validate-driver-card-canonical-on-backup.sh` to validate **only an isolated clone**, before any app mutation. The app schema checker remains read-only unless its explicit apply option is selected. No deployment/activation block is provided while the driver, merchant review and secret-manager binding remain unresolved.

## Rollback and eventual one-payment UI test

Before any test charge, rollback can restore the previous web image/override chain and remove the unused sandbox process. After a provider submission, stop only new initiation by turning the separate driver gate/scopes off; keep the test process, original credentials and verification path available until all attempts reconcile. Do not turn the outer API switch off while it is still needed for reconciliation. Retain frozen policies, provider-store rows, observations and ledger events. The new rollback SQL refuses removal when reviewed/payment evidence exists. Do not restore the whole app backup to erase attempts.

Once the NG driver is selected and merchant/configuration checks pass: sign in as that driver, open Driver Hub → Wallet, enter the agreed test amount, review credit/5% fee/total, confirm, and open hosted test checkout. Inspect the provider's final amount/currency before entering approved test-card data. Return to the app/browser, reconcile and confirm exactly one credit excluding the fee. Repeat status/reload to demonstrate no duplicate charge/credit. Record actual provider fees/net settlement for comparison. No real provider sandbox payment or native-device return has passed yet.
