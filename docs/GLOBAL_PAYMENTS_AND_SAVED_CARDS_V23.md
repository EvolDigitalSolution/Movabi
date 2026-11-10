# Global payments and optional saved cards — implementation stage 1

No market, database migration, secret or feature flag is activated by the installer.

Implemented:
- Explicit server-owned country/currency/merchant/method capability registry. Published coverage candidates are disabled by default.
- Country detection respects a persisted user selection, otherwise geographic hints before browser locale. A service booking's server market remains payment authority.
- Native-currency formatting without hidden GBP conversion; existing bookings display their own currency. Explicit GBP conversion remains available separately.
- Stripe card saving with an unchecked opt-in, versioned consent record, customer/account ownership checks, saved-card selection and provider removal. Reuse is customer initiated/on-session; Stripe can require authentication.
- Test-key-only Flutterwave hosted collection and strict transaction verification, protected by durable request reservations. Hosted collections are not authorisations.
- Immutable references for newly routed checkouts and server-only customer mappings.

Not yet a global live checkout:
- The current booking capture/refund/payout lifecycle is still Stripe based. The global checkout guard permits only the existing Stripe platform GBP lifecycle. Other registry entries fail closed rather than silently using Stripe.
- Flutterwave is not registered as a live booking adapter. Completion, cancellation, webhook processing, refunds, payouts and reconciliation must be implemented and tested before it can dispatch funded bookings.
- Flutterwave card tokens must remain server-only and scoped to the merchant and original email. They are not exposed or persisted by this stage. Saved-card UI is Stripe only.
- Other currencies need an end-to-end amount audit, including processor-specific units and wallet/settlement accounting. The new currency utilities do not automatically rewrite existing financial calculations.
- Location hints do not enable a country. Markets/cities still need server-approved operational and payment configuration.

Activation prerequisites for Stripe saved cards:
1. Review and apply supabase/migrations/20261022010000_payment_customers_and_card_consent.sql through your normal migration process.
2. Confirm the deployed Stripe platform account and test opt-in, 3DS, subsequent reuse and removal in Stripe test mode.
3. Enable VAYDU_SAVED_CARDS_V23=true on the test server. Missing/false keeps the feature hidden.
4. Keep VAYDU_GLOBAL_PAYMENT_ROUTING_V23 unset until market route configuration and binding migration are reviewed.

VAYDU_MARKET_PAYMENT_ROUTES is a JSON array of explicit country, currency, provider, merchantAccountRef, enabled, merchantApproved, adapterReady, payoutApproved, methods and capabilities. Missing configuration activates nothing. Do not label an adapter ready merely because a country appears in a provider's public coverage list.

Verified provider references (22 October 2026):
https://stripe.com/global
https://docs.stripe.com/currencies
https://docs.stripe.com/payments/save-during-payment?payment-ui=elements
https://developer.flutterwave.com/docs/payment-methods
https://developer.flutterwave.com/docs/preauthorization
https://developer.flutterwave.com/docs/transaction-verification
https://developer.flutterwave.com/docs/tokenization

Store only provider identifiers and explicit consent. Never store PAN/CVC in Vaydu, local storage, application logs or SQL records. Removing a saved card does not cancel an existing authorised booking or delete financial/consent audit history.
