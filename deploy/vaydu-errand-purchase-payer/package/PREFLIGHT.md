# Errand purchase payer — develop deploy preflight (2026-11-17)

Deploy target: develop only. Production is not authorised.

## Verification evidence (all green)

| Suite | Engine / baseline | Result |
|---|---|---|
| `realdb-errand-purchase-payer-test.sql` | `supabase/postgres:15.1.1.78` (host image) + `develop_live_public_schema_20261112.sql` | 42/42 |
| `realdb-customer-funding-chain-test.sql` | same | 11/11 |
| Worker rehearsal (real `JobPayoutService`, simulated provider) | same + full pending chain | 10/10 |
| `run-realdb-tests.sh` applied chain | `202612700→706` in order, incl. Africa/GB PIN work | applied cleanly |
| Browser test `e2e/driver-earnings-errand-ledger.spec.ts` | this checkout's dev build | 4/4 (2 tests × 2 projects) |
| Unit specs | wallet/errand/payout/admin-finance | 89/89 |

Reproduce: `PG_IMAGE=supabase/postgres:15.1.1.78 BASELINE=develop_live_public_schema_20261112.sql PSQL_USER=supabase_admin bash scripts/errand-purchase-payer/run-realdb-tests.sh` and `bash scripts/errand-purchase-payer/run-worker-rehearsal.sh`. All fixtures are committed (test `.sql` files were force-added past the repo's `*.sql` gitignore — they ARE tracked, so a clean checkout reproduces both suites).

### Harness-only accommodations (never a production step)

The rehearsal disables, inside disposable containers only:
- the supabase image's built-in DDL-watch event triggers (graphql/pgrst/pg_net) —
  image-bundled schema watchers that error during bulk baseline import;
- non-payment AFTER triggers on `jobs` during fixture inserts only (status-transition
  and notification guards that require live auth context). The payment-integrity
  triggers stay enabled.

## Migration order

Apply in filename order. Pending on develop host (verify against
`supabase_migrations.schema_migrations`):

1. `20261270000000_capture_develop_inspection_drift.sql` — no-op where drift exists.
2. `20261270100000_completion_pin_effective.sql` — PIN chain already on host; guarded.
3. `20261270200000_referral_fare_minor_units.sql`
4. `20261270300000_overdue_debt_followup.sql`
5. `20261270400000_completion_pin_acceptance_market.sql`
6. `20261270500000_errand_purchase_payer.sql` — payer records, funded-budget cap,
   method lock, reimbursement through the payout outbox.
7. `20261270600000_customer_wallet_booking_bridge.sql` — bridges credited
   `customer_credit` top-up attempts to `wallets.available_balance`.

705/706 assert prerequisites in-file. 705's CREATE OR REPLACE functions were
diff-verified identical between the deployed and live-develop schemas — drift-safe.

## Compatibility checks (run before applying)

```sql
-- 1. In-flight payout rows:
select job_id, status from job_payout_queue where status in ('claimed','reconcile');
--    Expected: empty or reviewed — uncertain rows reconcile safely under the new
--    finish path, but confirm with ops first.

-- 2. In-flight errand jobs with recorded spend (backfill candidates):
select j.id, d.actual_spending, d.receipt_url
from jobs j join errand_details d on d.job_id=j.id
where j.status in ('accepted','arrived','in_progress') and d.actual_spending > 0;
--    receipt_url present -> backfilled + reimbursed on completion; absent ->
--    reconciliation, never silent payout; issuing-funded rows excluded by
--    authoritative job_issuing records.

-- 3. Provider/market isolation unchanged:
select count(*) from market_payment_routes where provider<>'stripe' and country_code='GB';
--    Expected: 0.
```

## Rollback limits

- `202612706`: safe to `drop trigger trg_wallet_topup_customer_credit_bridge on
  wallet_topup_attempts`; already-bridged balances are posted wallet facts —
  reverse via wallet adjustment, never row deletion.
- `202612705`: function bodies may be restored, but `errand_purchase_payments`
  rows, `job_payout_queue` terms and `reimbursement_transfer_id` values are
  historical payment records — preserve them; never delete to roll back.
- Legacy ambiguous jobs parked in reconciliation remain until adjudicated —
  intended, not a deploy failure.

## Withdrawal-flow reconciliation

The driver's money path is a single channel: `job_payout_queue` → one Stripe
Connect transfer (fare entitlement + reimbursement) → `driver_earnings` (fare,
commissionable) and `errand_purchase_payments` (reimbursement, non-commissionable,
`reimbursement_transfer_id` = same transfer). Nothing credits a driver wallet
balance for this money (`earnings_payable` is a taxonomy label only; no write
path), so the automatic transfer does NOT create a second withdrawable balance.
Driver withdrawals remain Stripe Connect payouts; the wallet-withdrawal product
flow is a separate decision and is not conflated here.

## Package

`deploy/vaydu-errand-purchase-payer/package/` contains the two migrations, this
preflight, and `CHECKSUMS.sha256` covering final content. Re-run the checksums if
any file changes.
