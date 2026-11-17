# Errand purchase payer authority — 2026-11-16

Migration `supabase/migrations/20261270500000_errand_purchase_payer.sql`, verified on the committed
deployed-develop baseline in a disposable postgres:16.15 + pinned GoTrue environment:
`bash scripts/errand-purchase-payer/run-realdb-tests.sh` → **38/38 checks PASS**
(`deploy/vaydu-errand-purchase-payer/realdb-errand-purchase-payer-test.sql`, all inside one rolled-back
transaction).

## What changed

- `errand_funding.purchase_method` records the job-level purchase method. All five agreed methods are
  valid column values; only `vaydu_card` and `driver_personal` are writable by any code path today.
  `customer_direct`, `vaydu_direct` and `cash_advance` are recognised but unreachable — every write is
  rejected by `guard_errand_purchase_method` until their evidence/charging semantics are integrated.
- `public.errand_purchase_payments` is the per-purchase payer record: payer (`vaydu`/`driver`/`customer`),
  method, kind, amount in minor units, evidence (`provider_reference`, `merchant_name`) and settlement
  state (`recorded` → `reimbursed` with the transfer id). One row per purchase evidence item
  (unique job+method+reference); manual driver spend is a single aggregate `manual-spend` row.
  service_role only; RLS enabled.
- `enforce_errand_spending_budget` corrected. The deployed trigger granted
  `estimated_budget + requested_over_budget_amount`, where the requested amount is the NEW TOTAL —
  an approved £30→£80 raise permitted £130 of spend against £80 funded. The cap is now the funded
  budget only: `errand_funding.item_budget` (post-approval new total; the card create-intent writes
  the authorised item budget here) or `amount_reserved` on a legacy `pending` row. A missing funding
  row fails closed. A higher estimate never grants spend.
- Method lock: `activate_job_issuing_control` refuses activation after driver spend is recorded (and
  vice versa — manual spend under an active spend control must equal the issuing ledger).
- Reimbursement reaches the driver through the real payout outbox:
  `complete_job_with_pending_payout` sums recorded driver purchases (DB-derived, never caller terms,
  capped at the funded budget) into the queued transfer amount and freezes `reimbursementMinor` +
  `purchaseMethod` in queue terms; `finish_queued_job_payout` marks the purchases `reimbursed` with
  the same transfer id in the same transaction that settles earnings. `driver_earnings` keeps
  `settlement_purpose='job_earnings'` with gross = service fare only — reimbursement stays separate
  from commissionable earnings. Legacy in-flight spend recorded before payer records existed is
  backfilled at completion (never silently unpaid), still capped at the funded budget.
- `release_job_wallet_reservation` refuses a silent release while recorded purchase payments exist —
  cancellation after purchase requires reconciliation, matching the protected-spend handoff path.

## Verified (real PG, 38 checks)

- Wallet pay reserves fare + **funded** budget (30), not the 50 estimate; spend ≤ 30 ok, 31 rejected.
- Requested-but-unapproved increase to 80 keeps the cap at 30; after customer approval the delta is
  reserved, item_budget becomes 80, spend 75 ok / 81 rejected.
- Method lock both directions; unsupported `customer_direct` insert rejected; mixed-method rejected;
  payer/method mismatch rejected.
- Card method: activation locks `vaydu_card`; authorization within limit approved; capture writes a
  `payer='vaydu'` purchase row; ledger replay dedupes; `sync_job_issuing_spend` writes allowed
  (equals ledger); any other manual value rejected.
- Full driver-personal errand: reservation → spend 20 → completion → one outbox transfer of
  850 (earnings) + 2000 (reimbursement) minor → customer settled fare+spend, £10 unused released →
  claim → purchases stay `recorded` while processing → wrong token refused → confirmed transfer marks
  the purchase `reimbursed`/`tr_main_1` → replayed finish and replayed completion idempotent →
  wallet settlement exactly-once.
- Reconcile path: an uncertain outcome is reclaimable without a new attempt and reimburses exactly
  once on the retried transfer.
- Cancellation after purchase raises reconciliation; reservation and purchase record untouched.
- Fail-closed edges: no funding row, and a zero-reserved marker, both reject any spend.

`npx vitest run wallet-booking-lifecycle shopping-budget errand-budget completion-payout-retries
shopping-budget-payout-authority automatic-issuing-spend` → **72/72** after the change.

## State separation (explicitly not claimed)

- Implemented: `driver_personal` and `vaydu_card` payer tracking + reimbursement, spend-cap fix.
- NOT implemented/available: `customer_direct` (evidence + charging semantics not integrated — the
  customer can never be double-charged because the method cannot be recorded), `vaydu_direct`
  (needs an approved merchant-payment rail; a Stripe Connect transfer cannot pay an arbitrary shop),
  `cash_advance` (deferred).
- Deployed to develop: NO — migration prepared and locally verified only.
- Journey-verified on develop: NO.
- Customer wallet top-up for GB remains retired/sandbox-only (batch-1 orchestration documented
  separately); wallet reservation → settlement is verified on the funded-wallet path in the test.


## Follow-up verification — 2026-11-17

### Legacy reimbursement tightened (`20261270500000` §6)

`complete_job_with_pending_payout` no longer infers "driver paid" from a missing purchase row.
Backfill now requires positive evidence and honours authoritative exclusions:

- `job_issuing_spend_controls` active → Vaydu card funded, no driver reimbursement.
- `driver_earnings` already present (paid/pending) → reconciliation, never double-pay.
- `receipt_url` present → driver-personal evidence, backfill + reimburse.
- No evidence at all → reconciliation, no silent payout.

Real-PG 42/42 covers each branch.

### Real TypeScript payout worker against migrated DB — 10/10

`deploy/vaydu-errand-purchase-payer/payout-worker-rehearsal.cjs` + Stripe/eligibility stubs
drive the actual `JobPayoutService` (static import graph, tsx) against the migrated DB
(disposable supabase postgres + PostgREST). All 10 checks:

- one provider transfer carries fare + reimbursement (850 + 2000 minor)
- queued row settles paid with the provider reference
- purchase marked `reimbursed` only after provider confirmation
- service earnings stay commissionable-fare-only (8.50 of 10.00)
- replaying a paid job sends no second transfer
- uncertain transfer outcome leaves the row reconcilable (not paid, no new attempt)
- reconciliation finishes the uncertain transfer without a duplicate create
- reconciled purchase reimbursed exactly once
- pre-existing provider transfer matched and finished, not re-created

### Customer wallet funding restored (`20261270600000`)

Trace: the retired `wallet_topup` endpoint credited `wallets.available_balance` directly. The
replacement batch-1 collection ledger credits `wallet_business_events` (`customer_credit`
purpose) but never bridges to `available_balance`, which `pay_job_from_wallet` actually spends —
verified in the deployed schema.

`20261270600000_customer_wallet_booking_bridge.sql` adds
`trg_wallet_topup_customer_credit_bridge` on `wallet_topup_attempts`: when an attempt transitions
to `credited` with `destination_purpose='customer_credit'`, it credits
`wallets.available_balance` in the same transaction as the ledger event. Driver cash-credit
attempts (`driver_cash_credit`) are explicitly not bridged — verified.

11/11 customer-funding-chain checks on `supabase/postgres:15.1.1.78` with the live baseline:

- frozen customer collection submission + idempotent replay
- one wallet business event (`operation='topup'`)
- customer booking wallet credited 300.00
- completion + release; driver purchase payer evidence; reservation 40.00
- one reimbursement; zero driver cash-credit leakage

### Deployment compatibility

Full rehearsal on `supabase/postgres:15.1.1.78` (the host image) with
`develop_live_public_schema_20261112.sql` as baseline: 42/42 errand + 11/11 funding chain.
Migration 705's CREATE OR REPLACE functions diff-verified identical between the deployed and
live-develop schema — drift-safe.

### Ledger visibility (driver + admin)

New endpoint `GET /api/bookings/:jobId/purchase-ledger` (booking.routes.ts) returns
`errand_purchase_payments` (non-commissionable reimbursement, `reimbursement_transfer_id`)
alongside `driver_earnings` (commissionable) and the queue row's `terms.reimbursementMinor` —
so both dimensions reconcile even inside a single provider transfer. Admin accounting export
now includes `errand_purchase_payments`.


## Deployment-readiness closure — 2026-11-17 (second pass)

- **Full-chain rehearsal**: `run-realdb-tests.sh` and `run-worker-rehearsal.sh` now apply
  `202612700→706` in deploy order on `develop_live_public_schema_20261112.sql` over
  `supabase/postgres:15.1.1.78` — including the inspection drift capture, completion-PIN
  effective/acceptance (Africa/GB PIN work), referral and receivables migrations.
  42/42 + 11/11 + worker 10/10, all green.
- **Harness-only accommodations documented**: the rehearsal disables the supabase image's
  bundled DDL-watch event triggers and non-payment `jobs` AFTER-triggers during fixture
  inserts only; payment-integrity triggers stay enabled (PREFLIGHT.md).
- **Endpoint isolation**: `GET /api/bookings/:jobId/purchase-ledger` requires the booking's
  customer, its assigned driver, or an admin **of the same tenant** (tenant_id compared).
- **Screens**: driver earnings expanded row shows "Shopping reimbursement" separately from
  commissionable earnings (lazy per-job ledger fetch, cached; degrades gracefully on 403);
  admin finance daily report exposes `shoppingReimbursement` per booking (non-commissionable
  driver-paid purchases only).
- **Browser-tested**: `e2e/driver-earnings-errand-ledger.spec.ts` 4/4 against this checkout's
  dev build (note: `E2E_BASE_URL=http://localhost:3001` — port 3000 was held by a different
  checkout's dev server, which produced a false failure initially).
- **Withdrawal reconciliation**: verified nothing credits a driver wallet balance for
  payout money — `earnings_payable` is taxonomy-only, no write path. The automatic
  transfer cannot create a second withdrawable balance (PREFLIGHT.md).
- **Customer funding**: the chain test exercises the real `initiate_wallet_topup` →
  `confirm_wallet_topup_with_total` (+idempotent replay) path — not seeded balances.
- **Reproducibility**: test `.sql` files are git-tracked (force-added past the `*.sql`
  gitignore); baselines and harness files are committed — clean checkout reproduces all suites.
- **Package**: `deploy/vaydu-errand-purchase-payer/package/` = two migrations + PREFLIGHT +
  `CHECKSUMS.sha256` over final content.
