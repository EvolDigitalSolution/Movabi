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
