# Customer cash-ride booking: inventory and plan (pilot markets only)

Status: investigation complete; not built. Every stage of a booking assumes card or wallet today,
so a cash ride needs changes at each stage. Shipping only some stages would create cash jobs that
cannot be dispatched, accepted or completed.

## What exists (cash-credit 1E, already deployed)
- `reserve_cash_job_credit_v1e`: holds the driver's commission + platform fee from cash-ride
  credit when a cash Ride is assigned. Requires `payment_method='cash'`,
  `metadata.cash_collection_mode='full_customer_charge'`, no PaymentIntent,
  `payment_status IN ('pending','cash_due','cash_pending')`, and a canonical frozen fare
  (`cash_credit_terms_v1e`: `fare-split-v1`, percentage mode).
- `enforce_ride_cash_credit_v1e` (jobs trigger): reserves on assignment, settles the hold on
  completion, releases it on cancel/expiry/no driver.
- Market-scoped pilot switch (migration 20261266000000, this branch).

## Touchpoints a cash ride needs (file: current behaviour → needed)
1. Booking create, `server/routes/booking.routes.ts` `/api/booking/create`: always sets
   `payment_status='pending'`. `payment_method` is not a creatable field. → Accept
   `payment_method='cash'` only for Ride, direct checkout, pilot market
   (`driver_cash_credit_market_enabled_v1e`), with `payment_status='cash_due'` and
   `metadata.cash_collection_mode='full_customer_charge'`. The frozen fare must satisfy
   `cash_credit_terms_v1e` (from the quote audit's protected fare snapshot).
2. Dispatch start: card jobs start searching after payment confirmation. → Cash jobs start
   searching at creation (`dispatch.service.ts` `activateDueScheduledJobs` filters paid statuses
   only, so a scheduled cash job is never activated).
3. Driver acquisition, DB trigger `enforce_job_payment_eligibility`: rejects assignment unless
   paid/authorised (MB003). → Allow `cash_due` only for cash jobs in an enabled pilot market
   (migration).
4. Acceptance, `/accept` and negotiation accept: `requirePayoutEligible` →
   `cashRideAcquisitionApproved` already handles enrolment/market/credit for cash rides.
5. Completion, `LogisticsService.completeJob`: captures a PaymentIntent or debits the wallet,
   else throws "Payment has not been authorized", then `complete_job_with_pending_payout`
   queues a Stripe transfer. → A cash branch: no capture, no driver transfer (the driver holds
   the cash), status completed, `payment_status='cash_collected'`; the 1E trigger settles the
   credit hold (commission + fee).
6. No driver found, `dispatch.service.ts`: non-wallet jobs go to the card release path. → Skip
   for cash (the 1E trigger releases the hold).
7. Cancellation, `/api/booking/cancel`: card authorisation cancel or fee capture. → Cash: no
   card action; the hold is released by the trigger. Cancellation fee: see decision 1.
8. No-show fee, `no-show.service.ts`: charged from the card authorisation or wallet
   reservation; a cash ride has neither. GB rides require the no-show acknowledgement at
   booking. → Decision 1.
9. Payout worker, `job-payout.service.ts`: would mark a cash job "blocked:
   captured_payment_required". → Never enqueue cash jobs (follows from 5).
10. Customer app, `booking-request.page.ts`: only card/wallet; payment happens before
    dispatch. → A "Pay cash to the driver" option shown only when the server says cash is
    available for the quote's market; a submit branch without payment.
11. Driver app: job card and completion show "Collect <amount> in cash"; completion without
    a payment step.
12. Customer tracking, receipts and history: show "Cash, paid to driver".

## Decisions (agreed 2026-11-12)
1. Fees: a cash ride is secured by an on-session card HOLD (manual-capture authorisation, 3DS if
   needed) for the larger of the disclosed no-show fee and the market's active late-cancellation
   cap, frozen in `cash_ride_fee_holds_v1e.fee_terms`. Captured only for a no-show or late
   cancellation; released on completion, early cancellation or no driver. Saved cards are not
   charged off-session (their consent is on-session only).
2. Immediate rides only (no scheduled cash rides).
3. Fixed quoted fare only (no negotiation or bidding).
4. Driver earnings history: the fare collected in cash, plus the commission and platform fee taken
   from cash-ride credit, marked "cash, no payout".

## Phases
- Phase 1 (done, 20261266100000): `cash_due`/`cash_collected` payment states, the fee-hold table,
  and the acquisition exception (`cash_ride_acquirable_v1e`): cash Ride, full cash custody, no
  PaymentIntent, enabled pilot market, authorised hold for the same job/customer/tenant/currency.
  Real-Postgres: 16/16 (including a NULL bypass the test caught and the fix closed); rollback
  restores a byte-identical schema.
- Phase 2 (done, 20261266200000 + server): `/api/booking/create` cash branch (fixed quoted fare,
  immediate, canonical cash fare terms, customer's own tenant; terms frozen in
  `metadata.cash_fee_hold`); `POST /api/booking/cash/availability`, `/cash/:jobId/fee-hold`
  (starts or resumes the SAME hold), `/cash/:jobId/fee-hold/confirm` (verifies at the provider,
  then `activate_cash_ride_v1e` atomically starts the search); hold provider from the market's
  card route, Stripe adapter only (shared registry still refuses Kora/Fincra booking routes);
  drivers can read unassigned `cash_due` jobs. Off unless `VAYDU_CASH_RIDE_BOOKING=true` and the
  market is enabled. Real Postgres: activation 10/10 and the full chain (booking, hold,
  activation, enrolled driver accepts, 1E reserves GBP 2.50 of GBP 100.00, consistent);
  driver visibility 0 before / 1 after the policy; all three rollbacks restore the baseline.
- Phase 3: completion, no-show, cancellation, no-driver release, earnings record.
- Phase 4: customer and driver UI, receipts; browser tests; Linux build and package.
