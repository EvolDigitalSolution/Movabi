# Batch 1J — startup configuration and Korapay transport

The requested admin switch was withdrawn in favour of the existing Stripe startup pattern. No admin component, payment-mode SQL migration, wallet balance change or provider/gate activation is included. Existing STRIPE_SECRET_KEY and Stripe service remain byte-identical. KORA_SECRET_KEY is captured once at startup; existing isolated KORA_TEST_SECRET_KEY is not read or silently migrated. Startup captures merchant reference and server callback URLs. A controlled restart is required for configuration changes.

New server-only transport uses the existing sandbox protocol: HTTPS api.korapay.com/merchant/api/v1/charges/initialize and charges/:reference, Bearer authentication, no redirect following, bounded 15s timeout, exact reference/currency/expected amount verification and exact paid amount for success. Uses hosted card checkout, not direct card data or saved cards. Callback origins are server configuration, not browser input. Test/live mode follows the startup key prefix. No HTTP request occurs during startup. Status never exposes key, merchant reference or fingerprint; collectionEnabled in status describes this unwired batch, not the database gate.

This is a transport foundation, NOT a client-facing deposit endpoint or spendable-balance release. The durable repository, frozen-context persistence, provider policy loader, collection HTTP routes and settlement destination are not wired by this batch. Its submission store is a required injected interface; tests mock it and cannot prove database durability/concurrency. It must commit a unique claim and frozen terms before provider contact. No default store is supplied, so startup alone cannot collect funds. Future wiring must use the applied Batch 1C transaction/claim contract and enforce persisted policy/owner/tenant/market/limit/destination checks. Existing collection and cash-pilot gates remain disabled. Do not enable real deposits into the diagnostic-only ledger.

Frozen context includes provider, startup mode, SHA256 credential fingerprint, merchant, reference, currency, minor exponent and bigint amount. Context must be persisted before contact by future repository wiring. A different key/account fails before network with ORIGINAL_COLLECTION_CREDENTIAL_REQUIRED; no old payment is silently retargeted. Retain the original credential securely for reconciliation after rotating keys. This simple startup pattern does not itself provide parallel old-key storage or automatic rotation/recovery. Webhook HMAC authenticates data only; it never credits a wallet. Server-side verification remains mandatory.

Currencies are not globally fixed to GBP/NGN. Exact exponent-aware conversion supports 0..3 decimal formatting; actual transport use additionally requires an injected approved provider/account/currency policy, collect capability, destination and enabled collection gate. Tests for JPY/BHD prove exact arithmetic only, NOT Kora product/merchant support. Initial existing sandbox evidence is NGN; approve other currencies/products separately. Numeric provider payloads beyond safely representable amounts are explicitly refused before claiming or HTTP. No automatic provider fallback or POST retry.

Environment slots (server-side only):

    KORA_SECRET_KEY=
    KORA_MERCHANT_ACCOUNT_REF=
    KORA_COLLECTION_RETURN_URL=
    KORA_COLLECTION_NOTIFICATION_URL=

Do not paste keys into source, browser, report or chat. Existing sandbox container is unchanged. Adding a live key does not enable collection, approve merchant routes, configure limits or activate the cash pilot. This package has no environment modification script.

Executed locally: 30 mocked transport/startup behavioral cases, source preservation, installer install/reinstall/rollback, shell syntax and extracted archive checksums. No real provider calls. Full project TypeScript/Vitest and candidate Docker build are NOT RUN here; owner commands run them. Isolated test script streams archive bytes into a network-disabled, read-only container with tmpfs; no host bind mount or docker cp dependency.

Candidate build requires deployed Batch 1I image 3ab26d2e711ac6ffc0c59097417517fd4e47223fa06da24b01b5dc867856ab2e. Verifies original index source then adds a no-network startup import and new transport only. Candidate tag movabi-api:wallet-collection-startup-v1j. No deployment, SQL migration, key configuration or activation.

Provider documentation checked 2026-10-26:
https://developers.korapay.com/docs/checkout-redirect
https://developers.korapay.com/docs/accepting-card-payments-with-apis
