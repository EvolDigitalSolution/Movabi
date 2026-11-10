# Batch 1G — additive driver cash-credit display

The supplied Earnings page is the current driver wallet. Existing template, cards, colors, stylesheet, buttons, earnings filtering and payout action remain byte-identical after removing the single added cash-credit section. A supplemental checker compares their normalized SHA256s against the uploaded original source. No customer or admin screen changes.

The new section shows unreserved credit, credit held for cash rides and an amount needing review where present, with an explicit disabled/not-approved/enrolled/review state. It describes credit as fee/commission custody separate from earnings and bank payouts. Enrolment never promises job acceptance: the server/database remains authoritative per ride. No top-up, provider picker, payment form, enrolment control or withdrawal action is added. While backend top-up capability is unavailable the UI states that honestly.

## Read and account isolation

Only GET /api/market-safety/driver-cash-credit through the existing ApiUrlService. The current Supabase session owner must match AuthService's current owner before transmitting its Bearer token. No caller-supplied tenant/country/currency or destination. The 1F response is validated and whitelisted; driver ownership, scope, flags, currencies and exact nonnegative minor-unit strings are required. No numeric coercion, legacy balance substitution or invented zero on failure.

An owner-keyed in-memory reader coalesces pending reads, caches for 15 seconds and supports forced refresh. It clears cached balances on forced reads, failure, account switch and logout. Generation checks prevent late requests (including A→B→A) from republishing another session's data. The Angular computed status additionally hides a previous owner's record before effects flush. There is no localStorage or persistent financial cache. Page entry, pull-to-refresh and the new section's Refresh button request current state; no polling or other calls are introduced. Status errors are independent of earnings/payout state.

## Money

Use the response currency, never the user's display preference. Display ISO code with exact string grouping and the applied ledger's 0/2/3-decimal exponent contract. Do not convert large integer strings to JS Number. A deficit remains an explicit amount needing review; it is never subtracted from displayed earnings or presented as an automatically repayable customer debt.

## Verification and limits

Executed here: 35 production-reader/money/Angular-service behavioral cases with mocked Angular/RxJS/HTTP/auth boundaries. This proves the state machine and service code exercised by those cases, not a live Supabase session or Angular template compilation. Supplemental source checks verify unchanged original template/styles/payout action and additive no-write integration. Installer install/reinstall/rollback and archive checks are executed separately.

Not run here: full Angular/Vitest builds (dependencies are absent in this environment), browser visual rendering and signed-in staging acceptance. Owner must run targeted Vitest plus mobile/admin develop builds before packaging browser output. No backend migration or provider call is required. API 1F is already deployed with collection and cash pilot disabled; deployment evidence includes preserved environment and HTTP401 guards. Do not enable either gate for this display batch.

The guarded installer changes the supplied Earnings page only when its exact normalized baseline matches, adds only the new feature/service/checks/spec/docs, and verifies six applied wallet-migration baselines. It backs up original bytes and prints a guarded rollback command. It executes no git, database, deployment, provider or flag command.
