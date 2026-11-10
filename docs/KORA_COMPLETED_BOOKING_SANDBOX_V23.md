# Kora completed-booking sandbox pilot

## Implemented scope

This is a booking-linked sandbox collection/refund pilot, not live ride-payment activation. Existing Stripe checkout, job statuses/payment columns, dispatch, wallet balances, subscriptions, earnings and driver payout workers are unchanged. It does not add a customer UI button or enrol any booking automatically.

The repository's charge-after-completion requirement is preserved. Kora hosted checkout collects immediately, so this pilot accepts only completed, explicitly enrolled, unpaid NGN rides in Nigeria. It does not represent Kora collection as Stripe manual authorisation. Cancelled/in-progress/uncompleted bookings cannot create checkout. A pilot collection cannot activate a driver or cause real fulfilment.

The fare is resolved by the existing PaymentAuthorityService, including its frozen-split and negotiated-fare provenance checks. The pilot requires fare-split-v1, no errand budget, an exact minor-unit fare of at least NGN100 (the documented refund minimum), and no existing payment intent/wallet payment, operational payment binding, driver earnings or payout queue entry. The server—not the browser—owns currency, country, amount, provider, customer email and callback URLs.

## New persistence and concurrency

- kora_sandbox_booking_enrolments: database-operator-only activation for an isolated test job and its customer. Default active=false. The API receives SELECT only and cannot enrol jobs.
- kora_sandbox_booking_payments: one immutable booking/payment binding per job with frozen monetary snapshot, original merchant label, checkout state and single full-refund reference.
- Reservation RPC locks the job and enrolment before creating/reading the binding. Provider POST occurs only for the first reservation.
- Confirmation re-locks the booking after provider verification. If relevant terms, ownership, enrolment or payout evidence changed, it enters requires_refund and initiates one compensating sandbox full refund.
- Refund claim is durable before POST. Processing is distinct from success; only a matching provider query can record refunded. Timeout/unknown does not resubmit, switch provider or allocate a new reference. Failed/unknown refunds remain visible for reconciliation.
- Tables are RLS-enabled; browser roles have no access. Writes occur through service-role-only RPCs. Operational jobs and financial tables are read, never updated.

All raw response/card/token material is excluded from API results. The legacy diagnostic fixed-NGN100 flow remains separate. The optional notification URL change used by the isolated runner is now synced into the main helper.

## API

Existing prefix: /api/payment/kora-sandbox

POST /booking/checkout    {"jobId":"<UUID>"}
POST /booking/verify      {"jobId":"<UUID>"}
POST /booking/refund      {"jobId":"<UUID>","completionStatus":"success"}
POST /booking/refund-verify {"jobId":"<UUID>"}

Refund completionStatus is an explicit sandbox simulation: success or failed. Refunds are full amount only; partial refunds/cancellation fees are not supported by this pilot. All four routes require the authenticated original customer's bearer session and the configured user allowlist. Requests containing amount, currency, provider, userId, return URL or extra fields are rejected.

Responses identify bookingId, reference, amountMinor, currency, paymentState, refundState, sandbox=true, operationalBookingUpdated=false and driverPayoutEnabled=false. A checkout response additionally supplies the private hosted checkout URL. A redirect is not payment authority.

The existing /webhook endpoint can route book/refund references to the pilot. It validates the data-only HMAC signature, ignores unsigned event names and supplied monetary values, maps to a stored reference and re-queries Kora before updating the ledger. Existing diagnostic webhook behaviour is retained. Actual delivery/signature compatibility must be tested for the merchant account; published developer and support docs have previously differed. Without public callback ingress, use explicit verify/refund-verify calls and do not claim webhook delivery has been tested.

## Configuration and rollout

Default: disabled. Requires VAYDU_KORA_BOOKING_PILOT=true in addition to the existing sandbox API flag, a non-production NODE_ENV, sk_test_ secret, stable account label and customer UUID allowlist. Fincra remains disabled. No flag/key/account changes are made by the installer.

1. Apply source installer on branch v2.3 at reviewed HEAD 1576ba3. It backs up affected files and rejects divergent source.
2. Force-add the new migration 20261023020000_kora_completed_booking_sandbox.sql for schema-lineage validation.
3. Run the dependency-free provider check script (135 checks), schema-lineage and API-startup compile specs, followed by full tests/builds in the real repository.
4. Review the new migration and apply only to movabi_develop using the established privileged migration role and backup procedure. Earlier required payment migrations must already be present. SQL execution was NOT performed in the preparation environment.
5. Select an existing isolated completed unpaid NGN ride with a valid frozen fare and no operational financial evidence. If none exists, prepare a schema-verified test fixture in a separate step. Never repurpose a real paid/completed ride or disable the completed-status guard.
6. A database operator can explicitly enrol the reviewed job/customer:
   INSERT INTO public.kora_sandbox_booking_enrolments(job_id,user_id,active)
   VALUES('<reviewed sandbox job UUID>','<original customer auth UUID>',true);
   The installer does not execute this statement or create artificial completed jobs.
7. Add the pilot module and route changes to the isolated runner and validate compilation/startup there before enabling its pilot flag. The current runner on the host is not automatically updated by this local source patch.
8. Test create/duplicate create, wrong owner, verify/replay, full refund processing/success/failure, exact account/currency/amount mismatch, and late confirmation after changed terms. Confirm that jobs/payment status, wallets, dispatch and driver earnings remain untouched.

Live onboarding, pre-service funding/authorisation design, a real Kora payout adapter, partial refunds, dispute handling, callback UX and production booking settlement remain outside this pilot. These must be completed and approved before customer rollout.

## Validation evidence and limits

135 offline behavioural checks passed, including the original helper/session checks, real route authentication/body checks, booking lifecycle/refund tests and integration with the actual frozen-fare authority. Transport, database RPCs and provider calls are mocked. The SQL has been reviewed against the supplied schema/migrations, but no PostgreSQL runtime is available here. New SQL locking/security behaviour and API TypeScript compilation require validation in the full project/host environment. No new real provider request, payment, refund, migration or deployment was performed during preparation.

Official provider references checked 23 October 2026:
https://developers.korapay.com/docs/refunds-api
https://developers.korapay.com/docs/refunds-in-sandbox
https://developers.korapay.com/docs/webhooks
