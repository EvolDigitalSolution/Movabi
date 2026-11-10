# Provider currency options — 2026-10-23

Configured requested options: Kora 10 fiat codes (NGN, KES, GHS, ZAR, XOF, XAF, EGP, TZS, USD, GBP), USDT and USDC as separate stablecoin wallet products, and all 134 Stripe codes supplied by the owner. Asterisks are retained as American Express exclusions. ANG, XCG and STD are retained exactly as requested, not silently renamed. Each requires current merchant/account verification.

These are selectable configuration options, not activated payment routes. Existing market approvals and readiness checks remain in force. No live keys, merchant references, feature flags, markets or database rows are changed. In particular, no account reference is invented for the currently missing VAYDU_MARKET_PAYMENT_ROUTES variable. Currency codes do not establish a business country, Connect payout approval or a payment method. XOF/XAF/USD/GBP must be paired with an explicit country and approved merchant account when a route is activated.

## Product evidence

Stripe's list is card presentment support, subject to the account country and payment method. Charge, settlement and payout support are separate. Kora Checkout Redirect documents NGN/KES/GHS as examples, while conversion, mobile money and other products have their own coverage. The owner's ten Kora fiat choices are therefore catalogued as product-to-verify options rather than asserted to support cards, partial refunds, authorisation holds or payouts in every market.

USDT and USDC use Kora's stablecoin wallet flow. They require a customer, coin and explicit supported network; supported pairs must be verified at integration time. No wallet, deposit address, default network, fiat conversion rate or token precision is invented. Stablecoins are excluded from fiat card encoders and the existing three-letter fiat route schema. A separate wallet adapter and deposit/confirmation/refund ledger are still required before using them for rides.

## Amount handling

The new Stripe boundary helper converts exact decimal text or explicit ledger minor units into API integers with BigInt arithmetic. It is separate from ISO/display precision. It includes Stripe's zero-decimal list, whole-unit ISK/UGX amounts encoded with two API decimal digits, and whole-unit HUF/TWD manual payouts encoded with two API decimal digits. HUF/TWD charges can retain two fractional digits. Nonrepresentable agreed amounts require review; no silent rounding occurs. Amount limits, settlement-conversion minimums, network/card restrictions and account capability checks remain provider-execution responsibilities. A zero encoded value is not permission to execute a zero capture.

The global early-stop preview now checks provider currency options and exposes a separate providerAmountPreview for Stripe charge/refund plans. Stored ledger amounts are never reinterpreted as Stripe API units. Example: 500 UGX stored in zero-decimal ledger units previews as 50000 Stripe API units. The field is a preview, not an instruction to execute. Legacy payment endpoints have not all been migrated to the new helper; this patch does not claim every existing Stripe endpoint supports every listed currency.

## Patch compatibility and rollout

This installer follows the already applied global reconciliation preview patch and validates its source hashes before writing. Existing route guards are preserved. The earlier NGN-only closure remains a prototype; keep its flag off pending generic executor replacement. No SQL is added by this patch.

Run provider currency tests, global reconciliation tests, existing closure/fare/stop checks, server startup compilation, provider offline checks and both development builds. Provider execution remains disabled in preview results. The complete multi-market closure/capture/refund state machine remains outstanding.

## Sources reviewed

- https://docs.stripe.com/currencies?locale=en-GB
- https://docs.stripe.com/currencies
- https://developers.korapay.com/docs/checkout-redirect
- https://developers.korapay.com/docs/convert-currency
- https://developers.korapay.com/docs/stablecoins
