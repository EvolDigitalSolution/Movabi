# NGN early-stop closure pilot: API foundation

This is the next development-only stage, not an enabled customer flow. No new customer button is added yet. Endpoint POST `/api/booking/early-stop/:jobId/fare/:stopId/close` accepts only `{proposalId}` with an authenticated participant session. Existing stop/fare flags and `VAYDU_EARLY_STOP_CLOSURE_PILOT_V23` must all be true. Production runtime remains blocked.

Only explicitly enrolled, active, unchanged NGN rides with separate accepted fare consent qualify. Initial scope is quoted (agreed_fare NULL), unpaid (`pending`), non-wallet rides without any intent, provider binding, Kora attempt, refund, earnings or payout queue record. Negotiated or funded trips require later reconciliation support. Proposed amounts below NGN100, zero fares and zero driver entitlement require manual review; they cannot enter the existing refundable Kora pilot.

The service-only SQL function locks the booking, revalidates evidence digest and both acceptances, then updates the booking to completed at the accepted fare. It preserves the original booking and final booking snapshots in a restricted closure ledger. It does not alter existing triggers, fabricate completion PIN evidence, mark payment paid, collect money, create earnings or queue payouts. Existing fare protection remains enforced; any trigger rejection rolls back the entire closure. The amount is not raised to satisfy a minimum without new consent. A retry returns the original closure receipt; it is not a current payment-status query.

The revised terms retain the balanced accepted split in minor units and populate the existing fare aliases. Existing Kora sandbox booking checkout can subsequently use the completed pending ride at that revised fare, subject to its own separate enrolment, account and allowlist requirements. This patch makes no provider request and does not auto-enrol a booking. Kora verification still updates its sandbox payment ledger only. It does not enable operational payment status, driver earnings or Kora payouts.

## Validation and remaining rollout

Run the new input/service/HTTP tests, existing fare/stop tests, 135 provider checks and server startup compilation. Then apply the migration with a backup to movabi_develop only and test copies of the installed closure function with all relevant installed jobs triggers in a rollback-only fixture. In particular, exercise a protected-margin rejection, a fare with agreed_fare, an existing Kora attempt, closure retries and races with a provider reservation. Database execution, two-account browser flow and actual Kora checkout after closure remain unverified by local parser/service checks.

The frontend flow and payment reconciliation will follow those database checks. No deployment, enrolment, credentials, flags, staging or commits are changed by this installer.
