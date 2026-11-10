# Kora authenticated sandbox API — stage 2

Adds local/development-only diagnostic HTTP endpoints under /api/payment/kora-sandbox. This stage does not integrate customer bookings. It tests authenticated server checkout and durable verification before an immediate-payment booking lifecycle is introduced.

## Endpoints

- POST /checkout: Supabase bearer authentication and explicit user UUID allowlist. Body contains only requestId (UUID). Fixed server charge: NGN100. Customer email comes from authenticated Supabase user. Never accepts userId, amount, currency, provider or callback URLs from the request.
- POST /verify: authenticated and owner-scoped. Body contains only reference. Queries Kora using stored merchant account, amount and currency, then records sandbox verified state.
- POST /webhook: no bearer token; requires x-korapay-signature over data, then re-queries Kora using persisted terms. The event name and supplied amounts cannot determine the state. Unknown references, removed allowlisted users and mismatched accounts are rejected. No booking side effect occurs on replay.

All endpoints are unavailable unless VAYDU_KORA_SANDBOX_API=true and NODE_ENV is not production. Existing server rate limits apply. Responses use Cache-Control: no-store. Raw provider errors and customer/card responses are not returned.

A requestId must remain stable for retries of one sandbox checkout. The reference is deterministically derived from owner plus requestId. A submitted attempt resumes its stored checkout URL. A started/unknown attempt requires verification/reconciliation; it is never automatically reinitialized. Reusing a requestId after account rotation fails closed. Keep all required merchant credentials unchanged while reconciling existing attempts.

## Local environment configuration (do not commit credentials)

VAYDU_KORA_SANDBOX_API=false
KORA_TEST_SECRET_KEY=<your test secret, entered locally only>
KORA_SANDBOX_MERCHANT_ACCOUNT_REF=<a stable label for this exact Kora test account>
KORA_SANDBOX_ALLOWED_USER_IDS=<comma-separated Supabase auth user UUIDs>
KORA_SANDBOX_RETURN_URL=<your server-owned HTTPS return page>
KORA_SANDBOX_NOTIFICATION_URL=<your HTTPS API origin>/api/payment/kora-sandbox/webhook

The callback page itself is not supplied. Do not use a URL unless you control it. For a local test without public HTTPS ingress, verify manually via /verify; do not claim that a webhook delivery was tested. The Kora helper requires HTTPS URLs and rejects live keys. Confirm webhook deliveries for your actual account before relying on the signature format: Kora's developer Webhooks page and a support FAQ currently describe different formats. This implementation uses the developer page's x-korapay-signature/data-only HMAC contract and fails closed on any other format.

## Migration and validation

1. Apply the source installer on v2.3. It backs up affected files, does not alter credentials/flags, and does not commit, stage, deploy or apply SQL.
2. Explicitly git add -f the new 20261023001000_kora_sandbox_sessions.sql migration before the schema lineage test.
3. Run node --experimental-vm-modules scripts/check-kora-fincra.cjs (Node 24+): expected 75 passing offline checks.
4. Run the schema lineage and API-startup compile specs, then the normal test suite. Startup type-check catches integration issues that dependency-free runtime checks cannot.
5. Before enabling the API in a development database, review and apply 20261022010000_payment_customers_and_card_consent.sql, 20261022223000_kora_fincra_provider_options.sql, and 20261023001000_kora_sandbox_sessions.sql in dependency order if not already applied. Use the repository's migration workflow; do not blindly reapply historical migrations.
6. Configure the explicit allowlist, stable account label and test-only key locally. Restart the development server. Global payment routing, saved-card flags and all live market approvals remain unchanged.
7. Test unauthenticated rejection, owner checkout, duplicate requestId, wrong-owner verification, successful provider verification and signed callback with actual sandbox credentials.

The new table is service-role-only with RLS enabled, fixed currency/amount checks and a unique primary-key reference. Historical sandbox CLI tests are not imported or marked paid in this table.

## Validation limits

75 offline checks cover the helper, session service and actual route handler functions using mocked Express transport, Supabase auth and provider calls. No provider HTTP call, database migration, full repository build or TypeScript compilation was executed in the preparation environment, which contains only the partial source export. Previous CLI verification confirms Kora sandbox NGN100 payment, not this new HTTP lifecycle.

Stripe routes, raw-body middleware, booking dispatch, customer payment statuses, wallets, driver payouts, subscriptions and saved cards are not modified. Fincra remains disabled. Immediate-payment booking settlement/refunds and driver payout approval are still required before a live rollout.
