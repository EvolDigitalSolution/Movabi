# Completion, payouts, chat and protected pricing

This forward change separates a completed service from a driver transfer awaiting Stripe funds. It preserves existing wallet credit and keeps new wallet top-ups disabled. It does not enable Stripe Issuing, change production configuration, or move historical money during migration.

## Completion and transfer retries

The assigned driver still provides the customer PIN. Secret lookup errors fail closed. Completion writes pending driver earnings and an immutable payout outbox. Wallet settlement, unused shopping-budget release and completion occur in one database transaction. A previously settled wallet is not debited again. Captured card payments are verified by amount and currency before a retry proceeds.

A worker checks the queue every minute. Insufficient available Stripe funds defer transfer for five minutes. Pending Stripe funds are not treated as available. The driver sees that earnings were recorded and payout remains pending.

Payout leases and attempt numbers live in PostgreSQL. Each attempt has a stable Stripe idempotency key. Only an explicit insufficient-balance rejection permits a fresh attempt. An uncertain response keeps the same key and is reconciled by transfer group, destination, amount and currency. An uncertain attempt older than 20 hours is blocked for operator review; it is not blindly resubmitted after Stripe may have removed its key. This follows [Stripe's idempotency guidance](https://docs.stripe.com/api/idempotent_requests).

Recording transfer success and paid earnings uses the existing atomic settlement RPC. Refund operations are blocked while an unfinished outbox exists. Blocked entries require operator reconciliation; do not clear them or change their attempt counter without checking Stripe. Existing legacy `claimed`/`unknown` settlements also require reconciliation; absence of a local transfer ID does not prove that no payment occurred.

The known £7.07 wallet settlement for job `93769534-ead4-4ae8-ad4a-b7d99eed2875` must not be repeated or refunded to fix its driver payout. After deployment the driver can retry completion with the customer PIN. A legacy `failed` settlement can then become a completed job with pending payout.

## Chat

History, counts and read acknowledgements use authenticated API endpoints. Both the customer and assigned driver can read; unrelated users cannot. Ended jobs retain read-only history. Read acknowledgements apply only to received messages through the latest displayed timestamp. History returns the latest 200 messages. Realtime remains an optimization; history and unread counts also refresh by polling. Notification status subscriptions now watch `jobs`.

## Pricing protection

New GBP quotes preserve the calculated driver entitlement and add only the amount needed to cover the configured estimated payment cost and contribution allowance. Any adjustment is in the upfront customer total and platform fee. Quote totals, AI presentation, frozen fare split, capture and settlement use the same values. AI recommendations remain in shadow mode while the protected canonical split is payable.

Default estimates, configurable through the API environment:

| Variable | Default |
| --- | --- |
| `MOVABI_PAYMENT_COST_PERCENT` | 3.25 |
| `MOVABI_PAYMENT_COST_FIXED` | £0.20 |
| `MOVABI_BOOKING_COST_ALLOWANCE` | £0.10 |
| `MOVABI_MINIMUM_BOOKING_CONTRIBUTION` | £0.50 |

These are allowances, not a statement of Stripe's actual tariff or a guarantee of net profit. The observed test charges averaged 3.2% plus £0.20; actual live payment methods, Connect/Issuing costs, tax, refunds, disputes and operating costs must be reconciled and the allowances calibrated. The £0.50 target is contribution after the configured allowances. It excludes unconfigured expenses and subscription revenue. No subscription price or commission policy is changed by this patch.

For the observed £7.07 fare with £6.24 driver entitlement, these defaults produce a £7.28 upfront quote while preserving £6.24 for the driver. A fare already covering the allowance does not increase. Shopping funds are not platform revenue, but their estimated card-processing cost is included. New quotes with a purchase budget are unavailable while `STRIPE_ISSUING_ENABLED` is false, so retiring top-ups cannot leave a customer funding an unsupported shopping-card flow. Existing agreed bookings are not repriced or cancelled by this gate. A configured positive platform-fee cap is respected; an impossible quote fails closed. Other currencies require their own policy before quoting.

A new protected negotiation below the contribution floor is rejected inside the database before ownership commits. Shopping-budget increases that would consume the protected contribution also require a new quote rather than silently changing an agreed fare. Existing bookings without the new policy retain their agreed terms.

## Validation and release

Run `scripts/completion-payout/check.ps1`. It runs both type checks, the focused Vitest suites, an isolated PostgreSQL 15 container with transactional/concurrency regression tests, the mobile develop build and a whitespace check. It does not use the develop or production database for tests.

The authoring checks passed both type checks, the mobile build, focused regression suites and 14 database scenarios under embedded PostgreSQL. Native PostgreSQL 15 is supplied as the local release gate. The complete uploaded-source Vitest suite had 12 pre-existing failures, including three Git-lineage checks that cannot run against a ZIP checkout. A full-suite comparison introduced no additional failures. The existing app.css size warning remains.

`release-develop.ps1` runs the gate again, stages only the listed patch files (including ignored SQL), commits if needed, pushes the develop branch, verifies the remote revision, builds and checks both images, and transfers the archive, migration and an exact deployment script. It prints `SERVER_COMMAND` for the VPS.

The VPS script verifies checksums and image revisions, requires test Stripe, stops only the develop API, backs up the database, runs a rollback dry-run, applies the migration, pins both images and checks HTTP health. Migration failure restarts the previous API. It creates no historical credits, debits or transfers. Migration deployment is forward-only; restoring old images does not remove queued obligations. Keep the backups and reconcile pending/blocked payouts before any rollback affecting payments.
