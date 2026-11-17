# Errand purchase payer — develop deploy preflight (2026-11-17)

Deploy target: develop only. Production is not authorised.

## Verification evidence (all green)

| Suite | Engine / baseline | Result |
|---|---|---|
| `realdb-errand-purchase-payer-test.sql` | `supabase/postgres:15.1.1.78` (host image) + `develop_live_public_schema_20261112.sql` + **full repo migration chain** on a DB named `movabi_develop` | 44/44 |
| `realdb-customer-funding-chain-test.sql` | same | 11/11 |
| Worker rehearsal (real `JobPayoutService`, simulated provider) | same | 10/10 |
| Migration chain rehearsal | every `supabase/migrations/*.sql` in version order, one transaction each | 116 applied, 38 rolled back (already reflected in the live dump — reported per file) |
| Browser `e2e/customer-wallet-collection.spec.ts` | this checkout's dev build | 2/2 — top-up through the real UI: readiness → frozen quote → card confirm → server verify → credit; hidden when collection unavailable |
| Browser `e2e/driver-earnings-errand-ledger.spec.ts` | this checkout's dev build | 4/4 (2 tests × 2 projects) |
| Unit + runtime specs | wallet/errand/payout/admin-finance scope | 89/89 across the 9 touched spec files (batch1a/1h/1i/1l/1m harnesses, wallet-booking-lifecycle, batch2c money-authority, wallet-sandbox-ui, admin-campaigns) |

Reproduce:
`PG_IMAGE=supabase/postgres:15.1.1.78 BASELINE=develop_live_public_schema_20261112.sql PSQL_USER=supabase_admin bash scripts/errand-purchase-payer/run-realdb-tests.sh`
`bash scripts/errand-purchase-payer/run-worker-rehearsal.sh`
All fixtures are committed (test `.sql` files were force-added past the repo's `*.sql` gitignore — they ARE tracked; a clean checkout reproduces both suites).

## Fresh-schema rehearsal

The disposable database is named `movabi_develop`, so database-name-gated
migrations (`202612547` flutterwave payout outbox, driver-sandbox gates) execute
exactly as on the host. The chain loop applies every migration file in version
order inside its own transaction (`psql -1`): files that fail — because their
objects are already in the Nov-12 live dump, or a genuine incompatibility —
roll back and are logged `SKIPPED` with the first error line; pending ones
commit. That rehearses "develop's current schema + this release", not a
hand-picked subset. Notable applied prerequisites this release depends on:
`20261254700000` (flutterwave_job_submissions, `jobs.payout_provider`),
`20261254800000` (`guard_job_transfer_method` — NG payouts require
`metadata.driver_settlement_method='transfer'`), `20261254100000`
(`freeze_wallet_topup_fee` now reads `wallet_topup_fee_policies`).

### Harness-only accommodations (never a production step)

The rehearsal disables, inside disposable containers only:

- the supabase image's built-in DDL-watch **event triggers** (graphql/pgrst/pg_net) —
  image-bundled schema watchers that error during bulk baseline import;
- `jobs` AFTER/BEFORE triggers that require live auth context
  (`auth.uid()`/notification fan-out/market eligibility) — for fixture inserts only:
  `a_sync_agreed_fare_snapshot`, `enforce_driver_market_jobs_v23`,
  `enforce_job_vehicle_category_trigger`, `guard_booking_payment_margin`,
  `mark_enrolled_ride_start_v23`, `reward_credit_lifecycle`,
  `trg_enforce_job_acquisition_eligibility`, `trg_freeze_subscription_driver_commission`,
  `trg_gb_mot_job`, `trg_guard_direct_arrival`, `zz_finalize_agreed_fare_aliases`,
  `zz_job_funding_breakdown_record`, plus the PIN triggers where present.

**Kept enabled during the checks** (production-path coverage): the two
payment-integrity triggers `trg_enforce_job_payment_eligibility` and
`enforce_ride_cash_credit_v1e`, plus the data-only `tr_check_errand_completion_guard`
(blocks completion with a pending over-budget request), `reward_credit_reserve`,
`trg_sync_job_prices`, `tr_update_jobs_updated_at`.

## Migration order

Apply pending migrations in filename order against
`supabase_migrations.schema_migrations`. This release's tail:

1. `20261270000000_capture_develop_inspection_drift.sql` — no-op where drift exists.
2. `20261270100000_completion_pin_effective.sql` — PIN chain already on host; guarded.
3. `20261270200000_referral_fare_minor_units.sql`
4. `20261270300000_overdue_debt_followup.sql`
5. `20261270400000_completion_pin_acceptance_market.sql`
6. `20261270500000_errand_purchase_payer.sql` — payer records, funded-budget cap,
   method lock, reimbursement through the payout outbox (Stripe GB + Flutterwave NG).
7. `20261270600000_customer_wallet_booking_bridge.sql` — bridges credited
   `customer_credit` top-up attempts to `wallets.available_balance`.

705/706 assert prerequisites in-file. 705's CREATE OR REPLACE functions were
diff-verified identical between the deployed and live-develop schemas — drift-safe.
705 requires `202612547`'s objects (`flutterwave_job_submissions`,
`jobs.payout_provider`, `driver_earnings.payout_provider`) — apply after 547;
the rehearsal proves the ordering.

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

-- 4. NG jobs settle on their own rail:
select count(*) from jobs where country_code='NG'
  and metadata->>'driver_settlement_method' is distinct from 'transfer';
--    Any in-flight NG job missing 'transfer' cannot queue a payout under
--    guard_job_transfer_method — review before deploy.
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

## Driver credit → withdrawal reconciliation

The driver's entitlement flows through ONE channel: `job_payout_queue` → one
provider transfer (fare entitlement + reimbursement, Stripe `acct_*` on GB,
`flw:*` on NG) → `driver_earnings` (fare, commissionable) and
`errand_purchase_payments` (reimbursement, non-commissionable,
`reimbursement_transfer_id` = same transfer). No `wallets`/`wallet_transactions`
row, `reward_credits` row, or `driver_cash_credit` balance is credited for job
earnings anywhere in the schema — `wallets` exists for the **customer booking
wallet** (auto-provisioned at signup by `handle_new_user`) and the driver
cash-credit ledger is a separate `driver_cash_credit` purpose that drivers
pre-fund to take cash rides, not an earnings balance. The automatic transfer
therefore cannot double-pay with a withdrawable credit: no second balance is
created for the same entitlement. Driver cash-credit deposits stay out of the
customer booking wallet (verified: bridge trigger fires only for
`customer_credit`).

## Customer funding

The chain test exercises the REAL collection RPCs — `initiate_wallet_topup` →
`freeze_wallet_topup_fee` → `claim_wallet_topup_submission` →
`record_wallet_topup_provider_reference` → `confirm_wallet_topup_with_total`
(with idempotent replay) — no seeded balances. UI e2e drives the same flow
through `/api/wallet/topup-readiness` → `/api/wallet/collection/checkout`
(quote then confirmed total) → `confirmCardPayment` → `/api/wallet/collection/verify`.
Stripe.js is stubbed in-browser; the server route + orchestrator + RPC chain are
real. A live Stripe sandbox run requires deployed test keys — marked as a
deploy-day check, not a blocker (same adapter is exercised by the driver card
collection path). The batch-1A metadata columns are written only by the reviewed
706 bridge (event_key dedupe); the wallet-metadata source contract spec
whitelists it and still forbids any other writer.

## Package

`deploy/vaydu-errand-purchase-payer/package/` contains the two migrations, this
preflight, and `CHECKSUMS.sha256` covering final content. Re-run the checksums if
any file changes.
