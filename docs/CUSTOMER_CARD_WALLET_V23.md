# Optional customer payment methods

Customer account settings links to `/customer/payment-methods` under the existing customer authentication and registration guards.

- Lists brand, last four digits and expiry only; supports confirmed removal of owned cards.
- Card registration uses Stripe Elements and a SetupIntent, not a charge or booking completion.
- Requires a checked affirmative on-session saving permission. The provider setup metadata retains the consent version and authenticated owner; no fictitious booking is created for consent.
- Retains the request identifier and setup secret in component memory for uncertain retries. Neither is placed in URLs, local storage or logs.
- Uses the existing provider customer/account mapping. Existing ownership checks apply to removal and later checkout.
- The existing checkout still chooses the saved payment method; this screen does not create a default or start a payment.

## Availability

No flags are enabled by this patch. Listing/removal require `VAYDU_SAVED_CARDS_V23=true`. Standalone registration additionally requires `VAYDU_CARD_SETUP_V23=true`, the saved server profile country GB, an available GB/GBP payment market, and exactly one enabled approved Stripe card route for `stripe-platform` in `VAYDU_MARKET_PAYMENT_ROUTES`. That route must support the existing authorise/capture/release/refund/retrieve capabilities. This patch does not supply or activate any route.

Nigeria and all other markets cannot add Stripe cards through this first release. Existing owned cards can still be removed after a profile market change. Kora and Fincra card saving needs its own verified adapter before enabling it.

The new routes live under `/api/payment/card-wallet`. They never accept browser-supplied customer IDs, countries, amounts, provider accounts, return URLs or card details. A setup request accepts only a UUID requestId and the current consent version. Responses carrying a setup secret have Cache-Control: no-store.

## Checks

Run `src/testing/card-wallet-v23.spec.ts`, the existing global saved-card tests, and server startup compilation; then build both apps with the develop configuration. Local dependency-free checks exercised market gates, affirmative consent, stable provider keys, on-session-only setup and provider response mismatch rejection. Express integration tests and Angular compilation require the repository dependencies on the user's machine.

Before enabling in an approved development environment, complete an authenticated test-key card setup, list refresh, ownership rejection and removal through the actual API. Validate that a Nigerian test customer cannot open card entry and that removing a card does not affect historical receipts. No live test or deployment is included.
