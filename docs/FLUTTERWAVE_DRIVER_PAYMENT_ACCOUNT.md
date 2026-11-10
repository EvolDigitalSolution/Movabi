> Superseded setup requirement: the current driver setup creates collection subaccounts, not beneficiaries. See [the collection-subaccount correction](FLUTTERWAVE_COLLECTION_SUBACCOUNT_SANDBOX.md). The transfer adapter below remains separate.

# Driver payment account: local implementation, 27 October 2026

Implemented locally; not deployed. No credentials were provisioned or changed, no Flutterwave requests were sent, and no real or provider-sandbox transfer was performed. Production, existing cash-ride settings and existing live capability flags were not changed.

## Why Kora appeared

The original `20261023230000_market_payment_routes.sql` seeded NG/NGN card preference as Kora (`CASE WHEN country_code='GB' THEN 'stripe' ELSE 'kora' END`). The African catalogue also listed Kora/Fincra without a Flutterwave preference. Database assignment reads the preferred collection row; selecting Flutterwave elsewhere did not replace that persisted row. Payout readiness previously had a separate, GB-only Stripe implementation and explicitly rejected Flutterwave payouts through the collection registry.

The supplied develop audit showed the preferred NG Kora row and a provider constraint allowing only Stripe/Kora/Fincra. Flutterwave migrations exist locally, including provider prerequisite `20261253900000`, but that audit did not show them applied. This is historical evidence, not a fresh remote verification. Direct authenticated SSH is unavailable to the execution tools. `scripts/inspect-driver-payment-account-develop.sh` is a read-only check for the existing authenticated shell: it verifies the previously audited DB image/network, queries **movabi_develop**, lists catalogue/configuration and activated driver IDs/markets, and never extracts credentials or bank details. It makes no provider requests.

## Implemented capabilities

- Separate server-owned `driver_payout_markets`, independent of collection method preference and `payout_approved`. An approved collection does not prove bank-payout support.
- Provider-neutral Payment account form in Driver Settings and Onboarding. Existing Stripe UI/hosted flow remains for GB/GBP. Other configured providers remain unavailable rather than falling back.
- Flutterwave **v3 test mode, NG/NGN bank beneficiaries**: bank catalogue, branch-metadata checks, account resolution, explicit account-name confirmation, beneficiary creation and retrieval verification. A changed resolved name requires another confirmation. Banks needing branch details are not submitted through this form.
- States: not_started, in_progress, action_required, completed, unavailable. Completion requires activated driver, exact registered market/tenant, single-driver sandbox approval, merchant capability evidence, test runtime/credentials, approved callback and successful beneficiary verification.
- Private RLS tables retain provider beneficiary reference, bank code, last four digits and keyed HMAC fingerprint. Full account numbers exist only transiently in the form/server/provider call. No provider payloads are returned or logged. Completed destination identity is immutable. Setup failures persist action_required; a safe retry may create an additional beneficiary reference but cannot initiate a transfer.
- Owner JWT authentication; body/query driver identifiers cannot change ownership. Responses are not cached. Provider errors are sanitized; setup/resolve requests have a finite rate limit.
- Existing earnings/completion/outbox authority is reused. Flutterwave destinations and transfer references use separate fields, leaving Stripe reference columns for Stripe. The settlement writer still owns the single earnings row.
- A unique, durable submission marker is committed before a transfer request. Unknown outcomes remain lookup-only, even after a timeout or an empty later lookup. No automatic resubmission, new reference, payout-provider fallback, or retry of a failed transfer. Operator reconciliation is required for unresolved/failed transfers.
- Transfer acceptance is not payment completion. Server lookup must match reference, amount, currency, bank and keyed account identity and report SUCCESSFUL. Duplicate/out-of-order callback payloads are hints only; the leased worker re-queries the provider. Paid queue entries cannot be claimed again.
- Provider-reported transfer fees are recorded privately for comparison; no assumption that the approved card top-up fee covers payout costs.
- An isolated runtime, `server/driver-payment-account-sandbox.ts`, exposes only account setup/callback routes and reconciles Flutterwave queue entries. It has no collection/cash routes or Stripe worker and starts without a Stripe key. The existing production worker excludes sandbox-only Flutterwave jobs when the sandbox prerequisites are absent.

This implements neither a virtual account/card nor a hosted Connect equivalent. Bank resolution confirms the returned account name, not independent proof of ownership or a Connect-style beneficiary KYC process. Any additional beneficiary KYC required by the merchant must be included in its capability approval. No merchant-specific capability has been verified with real credentials. Other catalogue markets need their own destination schemas, verification and merchant tests before an adapter can be enabled.

## Defaults and migration preparation

The explicit 13-market African catalogue now prefers Flutterwave as a planning default: NG/NGN, GH/GHS, KE/KES, ZA/ZAR, UG/UGX, TZ/TZS, RW/RWF, MW/MWK, EG/EGP, CM/XAF, CI/XOF, SN/XOF, ZM/ZMW. Currency options are planning metadata, not approvals. Stripe GB/GBP and Kora/Fincra alternatives remain.

New develop-only migrations:

1. `20261254600000_driver_payment_accounts_sandbox.sql`: private setup/configuration, guarded setup claims and frozen destination identity. Collection preferences change only for untouched, disabled, unconfigured placeholders; existing route rows remain. Configured/audited overrides and existing Flutterwave rows generate review notices instead of being overwritten. The single-preferred index and route audit triggers stay in force. New payout configuration is disabled/unapproved/not-ready.
2. `20261254700000_flutterwave_payout_outbox.sql`: submission ledger, immutable payout terms, provider reference columns and verified completion through the existing settlement writer. Extends the existing completion function only when the expected original validation text matches; missing or changed validation text refuses migration.

Prerequisites include the verified provider constraint expansion, existing completion/settlement outbox, profiles/registered market fields and market tables. These migrations have not been applied to develop. They are not included in the previously pinned card-only deployment bundle; that bundle is not a release artifact for this feature. Fresh develop catalogue review and restoration of the retained real backup with these migrations remain required before deployment preparation can be signed off. No production schema is targeted.

## Stripe and wallet preservation

Stripe still stores profile account aliases, connection status, charges/payouts flags, and resolves actual account readiness through the existing Connect routes/eligibility service. Stripe completion uses its existing outbox, source-transaction validation, transfer-group reconciliation and idempotency key. The new Flutterwave branch dispatches before Stripe initialization or lookup.

The three Connect coalescing failures were reproduced: outdated extracted-method fixtures omitted the session and MarketSafety dependencies, and two assertions compared outer promise identity after `getPayoutSettings` became async. Updated tests assert actual HTTP/refresh coalescing and cache expiry; an added account-switch test rejects the old owner's response and preserves the new owner's cache. Production coalescing/security logic was not weakened.

Broader earnings fixtures also omitted the existing registered-country/tenant guards, and two browser lifecycle fixtures omitted the payout-market guard. Those fixtures now represent eligible GB drivers; existing negative isolation checks remain. No earnings eligibility guard was removed.

The approved versioned **5% of wallet credit**, exact minor-unit policy remains unchanged and applies only to approved card top-ups. An explicit NG/NGN Flutterwave collection route can resolve independently with `payout_approved=false`; collection routing still rejects a payout capability. Stripe/Flutterwave quote, confirmation, provider final-charge checks and single wallet credit regressions remain covered. Bank-account setup and bank payouts do not acquire this card fee policy.

## Verification

Final local results follow. All provider responses and credentials used by tests are synthetic. The database test creates and removes an isolated `postgres:15` container with no network or exposed ports; it uses the actual existing outbox/settlement SQL and the new migrations on a minimal fixture, **not a restoration of the real develop archive**.

- TypeScript server compilation: `npx tsc --noEmit -p server/tsconfig.json` passed.
- Develop mobile build: `npm run build:mobile:develop` passed. Existing `src/app/app.css` budget warning: 113.81 kB versus 100 kB.
- PostgreSQL: `python scripts/test-driver-payment-account-db.py` passed. Defaults/override preservation, setup tenant isolation, duplicate leases, concurrent unique submission, immutable destination/terms, private grants, one Flutterwave earnings settlement, duplicate completion and original Stripe SQL completion.
- Browser: Payment account bank resolve/confirmation/save/reload passed. Both existing driver-wallet top-up provider handoffs passed with mocked checkout/API responses.
- Unit/HTTP/runtime: **295 tests passed across 14 files** in the complete relevant regression run. The final safe-integer checks were followed by another successful 52-case Flutterwave adapter/setup/outbox run. Coverage includes account-name changes, missing branch metadata, bank/provider errors, setup persistence/retry, owner/tenant/market isolation, accepted/completed/failed/unknown transfers, concurrent claims, callback authentication, Stripe regressions and production/live-credential interlocks.

## Merchant checks and remaining prerequisites

Already approved: first market **NG/NGN**, Flutterwave first provider, shared card top-up fee **5% of wallet credit**. These decisions do not need to be requested again.

Still needed before an actual sandbox run:

1. Approved activated **NG/NGN driver ID and tenant**, with a bank destination the driver can legitimately confirm. The last supplied inventory identified only a GB/GBP driver; no NG driver was approved. A Nigerian customer must not be repurposed.
2. Non-secret test merchant reference and evidence that the **v3** product/key supports NGN bank resolution, beneficiaries and Transfers API. Merchant KYC/approval, Transfers via API, IP whitelist, NGN funding, approval/OTP requirements and branch metadata need an actual merchant check. No public documentation proves this account's entitlements.
3. Approve and verify routing for the proposed develop callback `https://movabi-develop.apps.evolsolution.com/api/driver-payment-account/webhook`, including authenticated delivery and lookup reconciliation. The runtime requires explicit callback approval; the URL is a proposed route, not a claim that it is deployed.
4. Later authorized secret-manager binding for the v3 **test** secret, separate webhook secret and stable HMAC key. No values belong in commands/history, repository, logs or reports. Existing Supabase credentials remain injection-only under the user's prior authorization; no container extraction/copy helper was introduced.
5. Fresh develop migration/catalogue audit, real-backup restore rehearsal with both new migrations, and review of reported deliberate market overrides. The previously supplied full-backup restore verification remains historical evidence; it does not validate these new payout migrations against that archive.
6. Explicit instruction before deployment, credential changes, enabling the selected sandbox scope, or a provider transfer. Merchant verification and UI sandbox payment/transfer evidence remain pending.

Official v3 references checked: [banks](https://developer.flutterwave.com/reference/get-all-banks), [account resolution](https://developer.flutterwave.com/docs/bank-account-verification-1), [beneficiaries](https://developer.flutterwave.com/reference/create-a-beneficiary), [beneficiary retrieval](https://developer.flutterwave.com/reference/fetch-a-beneficiary), [create transfer](https://developer.flutterwave.com/reference/create-a-transfer), [reference lookup](https://developer.flutterwave.com/reference/get-all-transfers), [NG prerequisites](https://developer.flutterwave.com/docs/nigerian-bank-account-transfer), [test transfer status and IP whitelist](https://developer.flutterwave.com/docs/testing). These are v3 references; v4 OAuth/idempotency mechanisms are not substituted into the v3 adapter.
