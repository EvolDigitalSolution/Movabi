# Multi-market early-stop reconciliation preview

The product scope is every enabled Vaydu market, subject to the actual provider/account capabilities for each booking. GB and NG are currently enabled in the deployed market table. The deployed API reported no VAYDU_MARKET_PAYMENT_ROUTES configuration. Published provider coverage does not supply a merchant route or payment binding.

This patch adds a currency-independent, provider-aware preview API:
POST `/api/booking/early-stop/:jobId/fare/:stopId/reconciliation-plan`, body `{proposalId}` only. It requires a signed-in participant, the existing stop/fare pilot flags, new `VAYDU_EARLY_STOP_RECONCILIATION_V23=true`, nonproduction runtime, enrolled unchanged journey evidence and separate accepted fare consent. No flags are enabled by the installer.

The preview uses the booking country and currency, the exact original provider/account/reference binding, configured server market policies and capabilities. It contains no country allowlist and no default currency. Integer minor units retain zero/two/three decimal precision. Missing, ambiguous or rotated routes go to review. No alternate provider or account is tried.

For existing payments the preview can identify provider verification before capture, release or refund. A paused new-payment market does not prevent previewing existing-money remediation. Unknown or pending original references must be reconciled before another collection. An unbound positive fare needs exactly one enabled, merchant-approved installed route and an enabled payment market. Synthetic test policies illustrate supported decisions; they are not claims of merchant approval or installed provider coverage.

A plan is not a payment instruction: every response has executionEnabled=false, bookingUpdated=false, paymentUpdated=false. Provider payment status, actual captured amounts and prior refunds still need verification by an installed execution adapter. No provider SDK is called, payment credentials are read nowhere in this module, and no ledger/booking mutations occur. Public plans omit merchant account and payment references.

## Current limitations and next implementation stage

The earlier NGN closure endpoint remains a narrow sandbox prototype; keep VAYDU_EARLY_STOP_CLOSURE_PILOT_V23 off. Its source can stay installed, and its migration is not needed for this preview. Do not enable it as a global implementation. This patch does not silently convert or delete any existing closure audit data.

The common route registry deliberately rejects enabled Kora/Fincra booking adapters because they are not installed. Kora sandbox collection/refund is currently NGN-only; Kora tokenisation and other currency execution contracts remain unverified. The current Stripe completion/payout RPC is GBP-only. Thus provider-aware planning is now available across currencies, but global automatic closure, capture/refund execution and payouts are not yet complete. The actual route map must be configured only after account and adapter capabilities are established. No routes, markets or countries are activated here.

After repository tests, the next stage is a generic durable closure/payment reconciliation state machine and provider adapters, replacing the narrow closure executor. It must verify provider state, keep deterministic operation references, reconcile uncertain results without resubmission and freeze the agreed split before any earnings or payout transition. Two-account browser and provider sandbox tests must precede rollout.
