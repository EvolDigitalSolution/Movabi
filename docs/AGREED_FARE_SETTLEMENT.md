# Agreed fare settlement

The original quote must not survive as the financial settlement snapshot after
an agreement. Every service uses the same jobs trigger: agreement, price aliases,
platform fee, frozen driver commission and entitlement update in one transaction.
Existing ownership, compliance, vehicle, payment and margin guards remain active.
No live configuration is read to reprice an existing agreement.

The trigger scales the original platform fee by the agreed/quoted customer amount,
using the same existing PricingService policy. Commission uses the persisted
snapshot rate, including a frozen zero subscriber rate. A NULL job commission
column must never silently become a zero commission. The subscription trigger
still decides a new assignment's waiver from server-held subscription evidence.
A final trigger aligns display aliases after the waiver and verifies conservation.

Authorization, confirmation, webhooks and wallets already share PaymentAuthority.
That authority now rejects a versioned snapshot whose charge differs from the
verified payable or whose split does not conserve the customer charge. Legacy
negotiation evidence is read using the installed proposed_by/proposed_by_role
schema. Completion checks this same authority before capture or payout. It checks
capturable funds before submitting a capture and uses currency minor units.
The capture key includes the expected amount; a confirmed succeeded intent is
verified first and is never captured again.

Existing immediate Connect transfer behavior is retained: completion commits a
durable payout record and immediately calls JobPayoutService.process. Only the
frozen driver entitlement transfers; platform fee and applicable commission stay
on Movabi. Retry reconciliation and charge-linked transfers are unchanged.
This is a transfer to Connect, not a promise of immediate bank availability.

## Observed legacy booking

For b4c6399b-7e3d-41be-b0ee-caa711ea7c09 the original snapshot was GBP6.71,
the confirmed agreement and uncaptured Stripe authorization were GBP6.04.
The preserved 15% commission policy produces platform fee GBP0.29, commission
GBP0.86 and driver entitlement GBP4.89. No additional customer charge is needed.
The migration does not backfill existing bookings. The separate repair SQL ends
in ROLLBACK, verifies exact booking/session/settlement conditions and is only a
dry run. A real repair additionally requires a fresh read of the same Stripe
intent (test mode, GBP, requires_capture, 604 authorized/capturable minor units),
a backup and deliberate commit after review. Paid/refunded/settled bookings
must not be rewritten by this procedure.

## Verification and release

Run server TypeScript and the agreed-settlement, payment authority, subscription,
wallet, shopping, fare split, acquisition and payout retry tests. The SQL policy
fixture embeds the migration in an isolated schema and ends in ROLLBACK. It tests
legacy repair, replays, funded and authorized re-agreement rejection, margin
rejection, shopping budget preservation and subscription waiver ordering.

Before release, back up develop and dry-run the migration against the actual
schema. Apply migration and API together during a short application stop. Review
the target booking repair separately. Do not capture or transfer from an ad hoc
script: after repair, completion performs the normal PIN/ownership checks and
idempotent settlement. This patch alone does not prove production readiness for
all unrelated map, notification or navigation behavior.
