# Shopping budget protection

This release preserves existing wallet credit and existing job fares, commission and driver payouts. Driver requests enter an additional amount; the RPC stores the revised total. Approved totals are never added to the original budget again.

Card customers enter their card and approve a replacement manual authorization for the unchanged service fare plus revised shopping budget. This deliberately avoids relying on incremental authorizations, which are not universally available. The previous bank hold can temporarily coexist with the replacement. Only a verified `requires_capture` authorization with matching amount, currency, job and request can replace the stored job intent. The old hold is released after commit; failed releases are retried every minute. Generic payment webhooks ignore replacement intents so they cannot redispatch an active job. Completion continues to capture service plus actual purchases from the replacement intent.

The replacement authorization must pass the existing processing-cost contribution policy. A budget that makes the existing fare unsustainable is refused and requires a revised quote through Movabi; this release does not silently change agreed fares, invent an additional fee or deduct money from the driver. Automated service repricing for those requests is not included.

The Issuing pool is reserved per job and currency under a database currency lock. Outstanding reservations are deliberately conservative: held or voided authorizations may retain allocation until the job ends. Terminal jobs stop consuming capacity. No automatic movement from collected customer payments into Stripe Issuing is implemented by this release. Available pool funding is still required.

Before enabling card activation, confirm in Stripe Issuing settings that the synchronous webhook points to this API and that timeout/error fallback DECLINES. Stripe can otherwise approve on timeout without Movabi's budget check. Only after verification set `STRIPE_ISSUING_FAIL_CLOSED_CONFIRMED=true`, alongside `STRIPE_ISSUING_ENABLED=true`. This deployment confirmation flag is not itself a verification of Stripe configuration.

Existing pending requests without `budget_request_id` need rejection followed by a new request. Existing Issuing cards need activation/synchronization to establish their job reservation. Do not change any customer's wallet balance or add more simulated funds as part of this migration.

The migration is `20261242200000_shopping_budget_protection.sql`. Apply it once, transactionally, after a verified database backup and dry run. Do not rerun the earlier completion-outbox migration. Deploy both API and web images from the same tested revision. Runtime authentication, authorization and capture testing in Stripe TEST mode remains required before rollout.

Authorization decisions and transaction accounting are database-atomic. Identical webhook replays do not add spending twice. Merchant authorization increments or transactions without a known authorization/job association fail closed and require reconciliation. Partial captures, reversals, unmatched refunds or differences between receipts and card commitments may require manual reconciliation; completion cannot quietly undercharge the customer and leave Movabi funding the difference.

Local validation: server/frontend TypeScript; mobile develop build; 121 targeted application tests; 15 isolated PostgreSQL database checks. The PostgreSQL checks used a minimal schema built from the supplied deployed columns. The actual deployment dry run is still mandatory to validate production constraints and triggers. Existing global CSS budget warning remains.
