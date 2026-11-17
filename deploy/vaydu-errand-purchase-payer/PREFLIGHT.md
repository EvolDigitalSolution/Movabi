# Errand purchase payer — develop deploy preflight (2026-11-17)

Deploy target: develop only. Production is not authorised.
Verified on: `supabase/postgres:15.1.1.78` (host image) with the live develop
baseline — 42/42 errand checks + 11/11 customer-funding-chain checks.
Payout worker rehearsal (real `JobPayoutService`, simulated provider): 10/10.

## Migration order

Apply in filename order. Pending on develop host (verify with
`select * from supabase_migrations.schema_migrations`):

1. `20261270000000_capture_develop_inspection_drift.sql` — capture-only, no-op on live.
2. `20261270100000_completion_pin_effective.sql` — PIN policy already applied on host;
   idempotent guards make a re-apply safe.
3. `20261270200000_referral_fare_minor_units.sql`
4. `20261270300000_overdue_debt_followup.sql`
5. `20261270400000_completion_pin_acceptance_market.sql`
6. `20261270500000_errand_purchase_payer.sql` — payer records, funded-budget cap,
   method lock, reimbursement through the payout outbox.
7. `20261270600000_customer_wallet_booking_bridge.sql` — bridge credited
   `customer_credit` top-up attempts to `wallets.available_balance`.

705 and 706 are self-contained: prerequisites are asserted in-file (raise if
missing). 705's CREATE OR REPLACE functions were diff-verified identical between
the deployed and live-develop schemas — it does not revert host drift.

## Preflight checks (run before applying)

```sql
-- 1. No unresolved payout rows that would pick up new terms mid-flight:
select job_id, status from job_payout_queue where status in ('claimed','uncertain');
--    Expected: empty, or each row reviewed (an uncertain row reconciles safely
--    under the new finish path, but confirm with ops first).

-- 2. In-flight errand jobs with recorded spend (backfill candidates):
select j.id, d.actual_spending, d.receipt_url
from jobs j join errand_details d on d.job_id=j.id
where j.status in ('accepted','arrived','in_progress') and d.actual_spending > 0;
--    Review: rows WITH receipt_url backfill+reimburse on completion; rows
--    WITHOUT route to reconciliation. Issuing-funded rows are excluded by
--    authoritative records — verify none of the listed jobs has an active
--    job_issuing_spend_controls row if you intend reimbursement.

-- 3. Provider/payment invariants unchanged:
select count(*) from market_payment_routes where provider<>'stripe' and market='GB';
--    Expected: 0 — GB remains Stripe-only; no provider switching performed.
```

## Rollback limits

- `20261270600000`: safe to drop the trigger (`drop trigger
  trg_wallet_topup_customer_credit_bridge on wallet_topup_attempts`), but any
  balance already bridged is a posted wallet fact — reverse via wallet
  adjustment, not by deleting rows.
- `20261270500000`: code objects can be restored to the prior definitions, but
  `errand_purchase_payments` rows and `job_payout_queue` terms written under the
  new path are historical payment records — preserve them; never delete to roll
  back. Reimbursed purchases keep `reimbursement_transfer_id`; do not clear it.
- Legacy ambiguous jobs parked in reconciliation stay there until adjudicated —
  that is intended, not a deploy failure.

## Package

Deploy package = the two migrations + this preflight. Checksums at packaging
time (run `certutil -hashfile <file> SHA256` on Windows or `sha256sum` on the
host). Not yet packaged: produce the checksummed bundle only when the deploy
window is confirmed, so the checksums cover final file content.
