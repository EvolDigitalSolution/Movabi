# Vaydu payment provider replacement — v2.3

This patch replaces the isolated Flutterwave sandbox helper with Kora sandbox scaffolding and a disabled Fincra entry. Stripe checkout, saved cards, subscriptions, captures and existing payouts are unchanged.

## Included

- Kora NGN hosted checkout initialization and server verification using the documented merchant API.
- Strict test-secret prefix guard (`sk_test_`); live keys rejected. Confirm your dashboard's test secret format locally without sharing its value.
- Durable reservation using payment_checkout_attempts, uncertainty recording and no retry/failover after an uncertain submission.
- Reference/account/currency/expected amount validation. Verification additionally requires exact amount_paid; providers returning a different documented shape must be reviewed, not silently accepted.
- Signature utility for x-korapay-signature over JSON.stringify(data), per the developer Webhooks page. No webhook endpoint is mounted. A newer support FAQ describes another signature/header format; confirm the payload delivered to your account before wiring an endpoint. Always query the provider and compare persisted terms before changing a booking.
- Fincra status explicitly pending KYC/API access, with no fabricated API implementation.
- Disabled planning entries for Kora/Fincra; no assertion that either supports every listed country.
- Additive migration permitting Kora/Fincra provider values while retaining historical provider records. It does not rewrite payment references or enable any market.
- Flutterwave rejected for new route configuration and adapter registration; its sandbox source is removed. Historical type/SQL values remain readable.

## Deliberate boundaries

Not a live African booking rollout. No Kora/Fincra booking gateway adapter, refund/cancellation settlement, driver payout, mobile-money or saved-card implementation is enabled. The existing booking route requires hold/capture semantics and continues to reject other providers. Hosted collections cannot be passed off as card holds.

The Kora helper is server-side code only; no HTTP endpoint, environment loader or customer button is added. Callers must supply expected terms from persisted server records and server-owned return/webhook URLs. Do not expose API keys, raw provider responses or card tokens to the browser. Keep Kora/Fincra market policies disabled with adapterReady=false, payoutApproved=false and capabilities=[]. Existing Flutterwave configuration must be removed from VAYDU_MARKET_PAYMENT_ROUTES before enabling global routing; stale configuration is rejected explicitly.

## Apply and verify

1. From the v2.3 repository, run the downloaded installer with Node. It preflights every affected file against the supplied ZIP, creates a timestamped backup, and modifies only matching files. It does not commit, deploy, read credentials or apply SQL.
2. Run `node --experimental-vm-modules scripts/check-kora-fincra.cjs` on Node 24+.
3. Run `npm test`, `npm run build`, and the existing booking/saved-card Playwright suite in your complete repository. Stop on failures and retain the output. This partial source export lacks dependencies, Angular project configuration and supporting files, so full builds were not run during preparation.
4. Review the diff and the new SQL. Neither migration is automatically applied. The additive migration requires the earlier 20261022010000 migration first.
5. Keep feature flags unchanged. Do not deploy or enable new countries based on these offline checks.

## Next integration stage

After local regression validation: add an authenticated, owner-scoped Kora sandbox endpoint and test with your own test key stored only on the server; confirm actual checkout host, response fields and webhook contract. Then implement immediate-payment booking lifecycle, cancellation/refund reconciliation, durable event deduplication and approved driver payouts before allowing customer bookings. Fincra follows only after API access and approved capabilities are known. No automatic provider fallback for uncertain payments.

## Evidence

47 dependency-free offline checks passed in Node 24 against the modified TypeScript modules. No provider network call, live payment, full project type-check, database execution or app build was performed here.

Official references checked 22 October 2026:
- https://developers.korapay.com/docs/checkout-redirect
- https://developers.korapay.com/docs/accepting-card-payments-with-apis
- https://developers.korapay.com/docs/webhooks
- https://support.korapay.com/hc/en-us/articles/40023846563858-Technical-Support-Developer-FAQ
- https://docs.fincra.com/reference/initiate-checkout
- https://docs.fincra.com/reference/verify-checkout-status
