# Booking form, cash choices and saved-card investigation — 2026-11-16

## Evidence and limits

Workspace: Windows 10.0.26200.9974, `C:\Users\fedri\source\repos\Movabi-topup-on-2385da7`,
branch `release/topup-3ds-on-2385da7`, starting HEAD `1f3a483`.
Existing untracked release artifacts, logs, branches and worktrees were retained.

The original local web reproduces Angular NG01350 after pickup/drop-off and quote.
The served develop assets reproduce the optimized `_rawValidators` TypeError on the
same transition. These browser reproductions use isolated authentication/API fixtures,
**not the affected customer's actual account or the live payment provider**.
The conditional discount input used `ngModel` inside the reactive booking group.
It appeared only after a quote; its unintended registration broke rendering of payment controls.
The fix uses the existing discount signal directly, keeps booking validators, retires
subscriptions when a form is replaced, invalidates late quotes/routes and remounts Stripe
Elements when its conditional host changes. A quote reference is now reactive as well.

Artifacts retained locally (all under `.tmp-release` unless stated):

- Original local failure: `booking-ng01350-before-20261116/`.
- Develop old-assets failure: `develop-booking-before-20261116.log` and
  `.temp/playwright-booking-develop-before/` (trace/error context includes `_rawValidators`).
- Browser pass: `booking-lifecycle-final-20261116.log`, **13/13**.
- Real Express cash-availability router plus canonical service, cash matching, card wallet,
  quote-country/authentication and reset checks: `booking-focused-tests-20261116.log`, **146/146**.
  DB/auth/provider boundaries are controlled fixtures; Stripe is not charged by these tests.
- Server typecheck: `booking-server-typecheck-20261116.log`, exit 0.
- Mobile develop build: `booking-web-develop-20261116/`, exit 0.
- Isolated mobile develop build: `booking-web-isolated-20261116/out/browser`, exit 0;
  source is f949a14 plus only the five frontend overlays recorded by the packager.
  `booking-optimized-browser-20261116.log`: **13/13** on this optimized candidate.
- Disposable PostgreSQL rehearsal: `booking-cash-rehearsal-20261116.log`, `REHEARSAL 2 PASSED`.
  All nine original suites pass, including cash acquisition/chain/lifecycle; exact schema rollback,
  inspection preservation, GB-only cohort activation/deactivation, P8 composition and PIN checks pass.
  This is local evidence; reuse the separately recorded passing real-backup host drill.

## Cash: authoritative decision and lifecycle

`POST /api/booking/cash/availability` reads market/currency/service from the server quote audit,
tenant from the authenticated native profile and fare terms from the protected quote snapshot.
It checks fixed-fare modes using that tenant, immediate eligibility if a schedule is supplied,
canonical percentage-fare terms, the existing market pilot, Stripe hold route and fee policy.
The response exposes context and the exact unavailable code/reason. `/create` repeats the guards;
it cannot rely on the button or on client-provided country/tenant/mode. An unreadable tenant/mode
fails closed. No cash flag, enrolment, market or fee policy is enabled by this change.

The frontend previously discarded all unavailable responses and network failures, leaving only
Card without an explanation. It now renders the server's specific reason. Eligible quotes retain
the existing Card / Cash choices and explain: **pay the fare to the driver in cash; a separate
card security hold remains required for cancellation/no-show fees**. Cash selection becomes
`payment_method=cash` and `metadata.payment_choice=cash`; it uses the fee-hold/confirm endpoints,
not full-fare card intent creation. Saved cards remain separate from this on-session hold journey.

Dispatch also had a separate defect: its candidate query required Stripe payout flags for cash
and did not filter enrolment before offers. Cash candidates now pass the canonical cash-credit
RPC and native tenant/market checks before ranking/offering. Pilot-off/unenrolled/unreconciled
candidates never fall back to Stripe. Online/availability, vehicle, document, account and market
checks remain; acquisition still verifies inspection and atomically reserves the required credit.
Card candidate filters are unchanged. Credit sufficiency/driver-specific frozen commission remain
authoritative in the acquiring database transaction, not a new frontend calculation.

The existing completion path in `server/services/logistics.service.ts` recognises
`full_customer_charge`: `complete_cash_ride_v1e` performs the cash ledger/credit settlement,
then the fee hold is released. It does not capture the fare, debit a wallet or transfer the fare
to the driver. The real-PG cash lifecycle suite checks accounting and retries. This change adds
no completion, settlement, historical amount or payment-binding rewrite.

## Card-wallet 404 and NG / GBP

The actual public develop endpoint `/api/payment/card-wallet` returns **401** with
`{"error":"Please sign in again."}` (`develop-card-wallet-public-probe-20261116.json`).
That proves the route is mounted, but does not identify the affected authenticated 404.
After authentication the saved-card feature gate can return 404; it now supplies
`SAVED_CARDS_DISABLED`. A genuinely missing route remains a load error/retry, not a market message.
Unsupported NG card setup remains GET 200 `canAdd:false` and setup POST 409, with an explicit
reason. Blank registration fields fall back to the saved country, never to an invented GB market.
Profile currency does not authorise Stripe. Existing owned saved-card visibility/removal and
provider bindings remain intact.

Admin used to label the persisted `profiles.currency_code` simply as currency. The schema's
legacy default is GBP, while registration activation sets country without changing that currency.
This explains how NG + GBP can exist, but the actual customer's provenance has not been verified.
Admin now distinguishes registration country and saved profile currency and states that bookings
use the service market's currency/provider. Tests cover GB/GBP, NG/NGN, NG registration with saved
GBP, blank/NULL legacy fields, and customers booking outside their registration country.
**No profile data correction was applied.** Historical payments/amounts/bindings are untouched;
Africa-provider integration remains deferred.

## Reproduce and authenticated follow-through

From the repository root:

```powershell
npx playwright test -c playwright.booking-lifecycle.config.ts
npx vitest run src/testing/booking-request-reset.spec.ts src/testing/booking-create-authentication.spec.ts src/testing/profile-market-context.spec.ts src/testing/card-wallet-v23.spec.ts src/testing/cash-availability-http.spec.ts src/testing/cash-ride-booking.spec.ts src/testing/gb-quote-route-tenant.spec.ts src/testing/quote-country-resolution.spec.ts src/testing/cash-dispatch.spec.ts src/testing/driver-service-eligibility.spec.ts
npx tsc -p server/tsconfig.json --noEmit
```

The 13 browser cases cover quote-to-payment/submission, delayed quotes, clearing/reselecting the
same address, repeated service routes, away/back, Card/Cash/Wallet changes, fee-hold-only creation,
specific ineligible reasons, travelling customers, saved-card failures and the admin labels.
They assert no uncaught/form errors and usable submission. Do not describe their fixture traffic
as an authenticated live customer journey.

For the affected account, use its **existing** access token in the local process environment
(never paste or commit it), and its current quote reference:

```powershell
$env:VAYDU_API_URL = 'https://movabi-api-develop.apps.evolsolution.com'
# VAYDU_CUSTOMER_ACCESS_TOKEN: existing authenticated customer session
# VAYDU_QUOTE_ID: quote reference from this booking
# Optional VAYDU_ADMIN_ACCESS_TOKEN: existing authorised admin session, to inspect that profile
node scripts/diagnose-customer-payment-context.cjs
```

This read-only diagnostic prints status/body, masked card fields and native market/tenant context;
it performs no booking/payment/data change and no authentication retry. It rejects redirects and
non-HTTPS remote requests. It does not print tokens. A typed unsupported response and an unrelated
404 are kept distinct. No additional backup is required.

**Live gate remains open:** actual customer identity/profile, authenticated card-wallet/cash body,
the real screen against the real develop API, enrolled-driver acceptance and a provider-observed
completion still need verification. No deployment or customer-specific diagnosis is claimed.
Once the isolated candidate is deployed, repeat the same pickup/drop-off on the actual account,
compare the displayed choice/reason to that response, submit Card and Cash separately, and verify
only the enrolled driver can acquire Cash; record the cash ledger once and hold release without
a full-fare capture. Preserve existing production, market/cohort, inspection and payment guards.

Isolated packaging and exact-image develop deployment/recovery handoff:
`deploy/vaydu-booking-cash/DEPLOYMENT.md`. Its host script is syntax-checked locally; actual host
compose rollout and authenticated journey remain pending. It reuses the existing real-backup
drill and applies no SQL/activation. Package with `python scripts/release/package-booking-cash.py
.tmp-release/booking-web-isolated-20261116/out/browser` from the committed source.
