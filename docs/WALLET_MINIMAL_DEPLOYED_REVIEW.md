# Wallet-only release review against deployed API

Verified source image: sha256:1ef978c931bf390273f4648f6c8bdce04231338d64ae7c6ead7e4e10d723c6aa.

| File | Deployed/local difference | Wallet release decision |
|---|---|---|
| connect.routes.ts | Byte-identical; same Connect onboarding, account readiness and dashboard/payout settings. | Preserve deployed bytes. |
| stripe.service.ts | Local adds a static stripe-payment-bridge import and opt-in proxy wrapping the SDK. Deployed exports the original Stripe SDK instance directly. | Preserve deployed SDK construction, version and methods. No bridge. |
| booking.routes.ts | Local adds early-stop routes and NG acquisition checks using DriverPaymentAccountService and sandbox transfer readiness; deployed retains existing PayoutEligibilityService path. | Preserve deployed route table and acquisition/completion authority. No new early-stop or NG transfer gating. |
| job-payout.service.ts | Local adds provider-filtered retry selection, Flutterwave payout dispatch, unsupported-provider handling and lazy Stripe imports. Deployed uses existing Stripe reconciliation/list/create and payout eligibility. | Preserve entire deployed worker; no queue filter or transfer adapter changes. |
| payout-eligibility.service.ts | Normalized text identical; byte/line-ending evidence retained in comparison. | Preserve deployed bytes. |
| payment.routes.ts | Local adds market-provider/card-wallet/saved-card routes, database/global routing selection, saved-method preparation, GB gateway checkout and job_payment_bindings persistence. Deployed directly creates the existing manual-capture Stripe intent with existing idempotency/metadata. | Preserve entire deployed booking payment route and its direct Stripe checkout. |

## Dependency findings

None of the six deployed sources statically imports/requires either absent module. The deployed Stripe service imports Stripe and dotenv and constructs its SDK directly. The deployed payment route does not import gb-gateway-checkout. The local candidate adds stripe.service -> stripe-payment-bridge and payment.routes -> gb-gateway-checkout -> stripe-payment-adapter. These are candidate architecture additions, not established missing deployed dependencies. This conclusion covers the reviewed sources, not an assertion that every unexported module was audited.

The safe release inherits the exact deployed API image and adds a namespaced wallet dependency closure plus one guarded index mount. It does not copy local server/index.ts or the local server tree, replace the six protected files, add the two absent Stripe modules, install packages or overwrite in-process Supabase configuration. This preserves the unexported deployed dependency graph too. The new wallet shim resolves the already-loaded /app/server/services/supabase.service and shares the same supabaseAdmin object. No database credentials are read/copied by release tooling.

The base image is not present locally. The locally built payload is therefore NOT a claim that the final derived deployed API image has passed. An operator prepare-image stage builds from the pinned server-local baseline without restarting anything; it verifies protected hashes/absences before and after and records the resulting image ID. Unexpected index layout or missing dependencies blocks, rather than broadening the patch. The real canonical rehearsal remains separate and never writes application SQL.

Local protected files are intentionally retained as other ongoing work; release overlay excludes their changes. Expected protected evidence is sourced from the verified deployed comparison and enforced against the actual derived image. This is a code-selection change, not a hash bypass.

Wallet-specific TEST key, separate wallet webhook hash, alias, provider account identity, exact return URL and TEST-only flags remain unverified. The excluded subaccount file is never used. No more filename scans and no permission changes to unrelated directories. Merchant identity/account mapping, webhook hash match, NGN card support and merchant-pays-provider-fees evidence remain required. Live payments, subaccounts, booking splits and transfers remain disabled.
