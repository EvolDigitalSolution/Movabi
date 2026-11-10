# Batch 1F — disabled driver cash-credit API integration

## Scope

New authenticated GET `/api/market-safety/driver-cash-credit`. Owner comes from the existing verified Bearer-token middleware; request query/body cannot override owner, tenant or currency. Server-only `driver_cash_credit_status_v1f(uuid)` resolves the registered market and returns a whitelisted status and Batch 1E balance. Money remains decimal minor-unit strings; no JS numeric rounding. This is cash credit for commission/fee custody, not earnings or a withdrawable wallet.

The legacy `/driver-wallet` payout response is unchanged. There are no client application files or layout edits. The endpoint is groundwork for the existing wallet screen, not a completed UI integration.

Cash Ride acquisition alone can use the internal credit approval path when the existing DB pilot is explicitly enabled, the driver has current approved enrolment, and tenant/country/currency/custody match. No Stripe account is required by this API path. While the pilot is disabled the existing acquisition checks remain. Card, non-Ride and payout eligibility are unchanged. Database compliance, market, payment and assignment triggers/RPCs remain authoritative and can still deny work; this batch does not bypass or reactivate them.

All six CE001..CE006 database errors map to stable safe API codes in the existing acquisition-error mapper (including negotiation paths). The API does not reserve funds or claim affordability from a stale balance. The existing acquiring transaction creates the Batch 1E hold against the final subscription-adjusted frozen fare and rejects insufficient credit atomically. Zero-fee rides need no deposit. No fees or percentages are hardcoded in production code.

## Money and providers

No top-up endpoint, payment initiation, collection transport, payout or live keys. The status always reports topupAvailable=false and payoutAvailable=false for this cash-credit feature. Existing Stripe payouts remain on their separate unchanged endpoint. NGN/Korapay and GBP/Stripe-funded eligible deposits follow the same accounting authority. This does not enable Korapay collection/payouts, or claim any merchant approval. Fincra activation is untouched.

## Safety and reversible installation

1A through 1E applied migrations are dependencies only; never rewritten by this installer. The new migration adds one server-only read function. It requires both gates disabled during installation and grants no table privileges. Unknown function overloads/incompatible ownership or inherited client EXECUTE cause transactional rejection. Application SQL creates no role, enrolment, grant to clients, deposit, job or flag row.

The source-only Node installer validates all five applied migration hashes and exact baseline bytes of three modified API files from the uploaded running source. Local drift causes refusal before writes; backup and guarded rollback are printed. New API service/checks/spec/docs/migration and the already-reviewed 1E test-variable correction are installed, but copied isolated dependencies and fixtures are package-only. No git commands, provider calls, environment edits or DB commands run in the installer.

## Verification

Executed here: 37 actual service/route/acquisition-wrapper/error-mapper behavioral cases (external auth/database/Express dependencies mocked), including missing/invalid auth, owner override, role denial, database outage, NGN/GBP, disabled gate, invalid/rounded data, reconciliation, custody and market isolation, safe error whitelisting and no provider contact. Shell syntax and installer install/reinstall/rollback were checked. Supplemental source checker is not runtime proof.

Not run here: PostgreSQL/Docker and full-project TypeScript/Vitest (not installed). Owner runner starts a fresh PostgreSQL 15 container with no network/application volume. It executes the complete proven 1E suite, applies 1F, tests real service/client role boundaries, currency/tenant scope, future consent, missing owner, existing-function preservation, then reruns 1F safely. Fixture-only synthetic Korapay evidence never contacts a provider or enables a route. Tests roll back their 1F financial/config changes.

Image build is a separate guarded step after isolated tests. It checks the exact running image and original modified-source hashes, overlays only four API source files, runs the full existing server TypeScript compiler, and builds a candidate. No container is restarted or deployment performed.

Applied evidence from owner: 1A/1B/1C/1D applied and verified; 1E SHA d5bb2338f3f5575e0950005af20cc5139091e9ce1164d99dfe5b384c95d28c99 applied/checked with gates off, backup /home/edsadmin/movabi-before-wallet-batch1e.QE0prB.dump. 1F is NOT applied or deployed.

## Local/deployed source difference resolved

The supplied local booking route additionally imports and mounts the existing early-stop router. Both lines are preserved in the local installer output. No early-stop module was present in the supplied running API source, so the candidate image uses a separate `payload/server` overlay based on that running API, without publishing an unavailable/unreviewed early-stop dependency. Batch 1F cash-credit changes are identical in both versions. Baseline hashes for the local installer use the supplied local files; image baseline hashes continue to use the supplied running API. Neither guard was loosened.
