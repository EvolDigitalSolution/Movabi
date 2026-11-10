> Historical initial closeout. The later shared 5% card approval, canonical integration, verified backup and current blockers are recorded in `docs/DRIVER_CARD_5_PERCENT_SANDBOX.md` and `docs/DRIVER_WALLET_DEVELOP_READINESS.md`.

# Driver wallet top-up — 27 October 2026

Local implementation and synthetic integration are verified. A real Flutterwave sandbox payment has **not** been demonstrated. No deployment, collection enablement, cash-ride enablement or payout change was performed.

## Implemented

- The Driver Hub wallet tab contains a separate top-up panel; existing earnings, cash-credit and payout controls remain.
- Availability resolves the authenticated activated driver, database market, unique approved card route, configured merchant, approved fee schedule and ledger exponent. Client authority fields are rejected. Stripe/Kora routes are not silently replaced with Flutterwave.
- The server requires both its non-production API switch and the existing database collection gate. The concrete adapter requires a Flutterwave **test** secret. These guards remain intact.
- New driver attempts use an additive v2 fee schedule with approval identity/time, immutable versioned terms, wallet/total basis, percentage plus fixed fee, optional combined-fee cap, and explicit half-up/ceiling rounding. No actual merchant fee schedule is seeded. BigInt in TypeScript and numeric in PostgreSQL avoid intermediate precision loss. Gross-up finds the smallest total whose net covers the wallet credit.
- Frozen amounts/exponent/policy cannot change. Total agreement precedes the durable submission claim. Duplicate claims do not submit again. Unknown submissions reconcile against the same reference and original credential fingerprint.
- Added the missing migration for the private `payment_checkout_attempts` table used by the concrete adapter. Verification uses the actual adapter response fields (`reference`, `chargedAmountMinor`), re-queries the provider and checks frozen reference, account binding, currency and total. SQL locks the attempt and posts exactly one credit for the wallet amount.
- Browser storage retains one attempt per signed-in owner before requests and before checkout. Returning from checkout never implies success. A verified credit remains confirmed even if the subsequent wallet refresh fails.
- Public `/driver-topup-return` ignores provider query parameters. It offers `com.movabi.app://driver?topupReturn=1` and a web wallet return. The existing app deep-link listener opens the driver wallet; focus/app resume triggers reconciliation.

## Actual validation

| Command | Result |
|---|---|
| `npx tsc --noEmit -p server/tsconfig.json` | Passed |
| `npx vitest run src/testing/driver-wallet-topup-http.spec.ts src/testing/driver-topup-fees-v2.spec.ts src/testing/wallet-flutterwave-batch2a.spec.ts src/testing/wallet-topup-orchestration.spec.ts` | 21 passed |
| `npx vitest run src/testing/wallet-collection-startup-batch1j.spec.ts src/testing/wallet-accounting-batch1b.spec.ts src/testing/wallet-topups-batch1c.spec.ts src/testing/wallet-authorization-batch1d.spec.ts src/testing/provider-currency-options-v23.spec.ts` | 60 passed |
| `pwsh -NoProfile -File scripts/test-driver-topup-db.ps1 -Integration` | Passed; fresh PostgreSQL 15, migrations, accounting, fees, refund checks, legacy Stripe/Kora, roles, rollback/reapplication and financial rollback refusal |
| Integration Vitest invoked by that runner | Passed; actual GoTrue signup/user authentication, PostgREST, concrete service, concrete adapter and SQL; two independent concurrent HTTP initiations/submissions/confirmations yielded one provider POST and one 10000-minor credit on a 10254-minor charge |
| `npx playwright test e2e/driver-wallet-topup.spec.ts --project=mobile-chromium` | Passed; actual Angular UI with synthetic HTTP/provider navigation: quote, explicit agreement, reload persistence, same key, callback landing page, unconfirmed return, manual server confirmation |
| `npm run build:mobile:develop` | Passed; existing app.css size-budget warning |
| Android `adb devices -l` | No attached emulator/device; native return unverified |

The mounted HTTP tests use injected Supabase data and the real Flutterwave adapter with a mocked provider transport. The separate disposable integration uses actual Auth/PostgREST/PostgreSQL and a mocked provider. Its profile table and market-status RPC are minimal synthetic fixtures; it does not prove the full deployed driver-market schema or live merchant integration. The browser test mocks API responses; it is separate evidence from the backend integration, not a real payment.

Database cases include fixed-plus-percent gross-up, zero fee, zero/three-decimal frozen exponents, overflow refusal, duplicate submission/credit, wrong total/reference/merchant/currency, immutable policy terms, full-refund replay and rejection of partial refunds. HTTP cases additionally cover absent/invalid auth, cross-owner requests, authority overrides, disabled collection, timeout followed by reconciliation, and query mismatches. Actual Auth integration also tests cross-owner access, conflicting amounts and reconciliation after collection shutdown.

Initial test runs exposed invalid old HTTP fixtures and an old SQL fixture binding the provider reference before freezing the fee; those fixtures were corrected. Sandbox loopback and generated-directory permissions required rerunning the affected commands with access. Final results above refer to successful reruns.

Saved final command logs: `docs/driver-topup-evidence/database.log` and `docs/driver-topup-evidence/build.log`. The new SQL files were marked intent-to-add so the repository's `*.sql` ignore rule does not hide them from review; no file contents were staged and no commit was made.

## Providers, currencies and configuration

The new driver checkout supports **Flutterwave sandbox only**. Existing Stripe collection/reconciliation and Kora interfaces remain; neither is newly enabled by this flow. Existing Stripe payment confirmation source was inspected, including its retired new-top-up endpoint; it was not modified.

Synthetic PostgreSQL fee cases exercise NGN (2), JPY (0), KWD (3); HTTP provider verification uses synthetic NGN, and Chromium amount entry uses synthetic KWD. Other configured currencies can use their approved ledger exponent (0–3), but no provider approval is inferred from a currency list. There is no approved real Flutterwave market, merchant, fee or test account supplied by this task.

The develop frontend source identifies `movabi-develop.apps.evolsolution.com` and API `movabi-api-develop.apps.evolsolution.com`. An unauthenticated read of `/api/payment/driver-topup/availability` returned HTTP 404 on 27 October. This alone does not identify the deployed revision, migration history or flag values. There is no local SSH config/identity establishing access to that target. Deployed flags, merchant approvals, database history and callback approval remain unverified.

## Backup, rollback and deployment boundary

New additive migration: `supabase/migrations/20261254400000_wallet_fee_policy_v2.sql`. Previously applied migration files were not rewritten.

Rollback: `scripts/rollback-driver-topup-fees-v2.sql`. It locks the attempt/schedule tables and refuses if any v2 financial snapshot exists. Once financial snapshots exist, disable new initiation and retain schema/data for reconciliation; do not remove ledger history. The private provider submission table is intentionally retained on schema rollback to preserve reconciliation evidence. Rollback and reapplication were tested in disposable databases; destructive financial rollback refusal was also tested.

No deployed backup exists from this task because target access is unavailable. Test containers are removed by the runner; their synthetic data is disposable. No secrets archive or upload was created.

No guarded develop deployment block is supplied because its required inputs are unknown. Before producing one, obtain target access; inspect actual migration history/schema and current flags; identify the exact release and isolated test market/account; create a checksum-verified backup and restore-test it in a disposable target. Confirm the exact approved Flutterwave test merchant, fee schedule, return URL and credentials privately. Keep production and unrelated provider flags intact. Repository deployment documentation requires live changes through the canonical `supabase_incremental_schema_reconcile.sql`, so reconcile history before incorporating this additive migration there. Do not blindly run every migration or set a shared collection flag.

The next access request is: **provide the develop SSH host/user and existing SSH identity or managed connection**, so deployed history/configuration and backup preconditions can be inspected without publishing credentials.

## Reproduce locally

From PowerShell, with Docker Desktop and the existing npm dependencies:

```powershell
Set-Location 'C:\Users\fedri\source\repos\Movabi-mobile-develop'
$ErrorActionPreference = 'Stop'
function Check-Exit { if ($LASTEXITCODE -ne 0) { throw "Command failed: $LASTEXITCODE" } }
npx tsc --noEmit -p server/tsconfig.json; Check-Exit
npx vitest run src/testing/driver-wallet-topup-http.spec.ts src/testing/driver-topup-fees-v2.spec.ts src/testing/wallet-flutterwave-batch2a.spec.ts src/testing/wallet-topup-orchestration.spec.ts src/testing/wallet-collection-startup-batch1j.spec.ts src/testing/wallet-accounting-batch1b.spec.ts src/testing/wallet-topups-batch1c.spec.ts src/testing/wallet-authorization-batch1d.spec.ts src/testing/provider-currency-options-v23.spec.ts; Check-Exit
docker pull supabase/gotrue:v2.132.3; Check-Exit
docker pull postgrest/postgrest:v10.1.2; Check-Exit
pwsh -NoProfile -File scripts/test-driver-topup-db.ps1 -Integration; Check-Exit
npm run build:mobile:develop; Check-Exit
npx playwright test e2e/driver-wallet-topup.spec.ts --project=mobile-chromium; Check-Exit
```

No upload command is possible until a destination/release procedure is established. This block does not change deployed configuration and never accepts an application database URL.

## Real sandbox UI steps after guarded deployment

1. Privately configure the approved test merchant/fee schedule and activated test driver in the approved test market, with a backup and approved callback URL. Use `https://<verified-develop-web-host>/driver-topup-return` (or `http://localhost:3000/driver-topup-return` for a provider-approved localhost test). Do not enable cash rides or payouts. Verify the server's non-production guard rather than removing it.
2. Sign in as that driver, open Driver Hub → Wallet, and check existing earnings/payout controls and the separate wallet-credit balance.
3. Enter an amount at the displayed exponent. Review credit, provider fee and total; check agreement and continue to Flutterwave test checkout.
4. Pay using approved sandbox test details. Return via the landing page's browser/app link. An unverified return must remain pending.
5. Check payment status. Confirm the server's provider query succeeds and the wallet increases only by the credit amount, with one ledger event. Reload and check again to confirm no duplicate credit or submission.
6. Native Android/iOS return must be tested on an actual available device/simulator. No such native test has passed here. A real UI → provider → verification → credit demonstration remains outstanding.
