# Driver subscriptions: commission only

All qualified drivers can go online, negotiate and accept ride, delivery, errand and van-moving work. Subscription status is not an acquisition rule. Account, compliance, vehicle, region, availability, ownership and Stripe Connect checks still apply. Subscription is not proof of payout readiness.

## New bookings

The customer quote is produced before the driver is known. The API therefore uses the configured standard commission provisionally and does not trust a submitted Pro label. Payment-cost protection is calculated without relying on driver commission. This can increase the cost-protection allowance in a new quote, within the existing platform-fee cap; the customer sees and accepts that quote before authorisation. It does not add a charge to an existing booking.

The API stores the complete protected snapshot in quote_market_adjustments.protected_fare_snapshot and restores those financial fields during booking creation. Browser writes to subscription evidence and quote-audit rows are removed; backend service-role access is retained.

On driver assignment, a database trigger freezes commission from backend subscription records for that driver and tenant. An active Stripe subscription with a non-expired period (or an active record whose period end is not supplied) yields zero driver commission. Trialing, inactive, expired and missing records use the quote's configured commission. Platform fees remain separate from driver commission.

Changing subscription status later does not rewrite an assigned booking. Reassignment freezes terms for the replacement driver from the preserved standard commission basis. An explicit agreed-fare change scales that preserved basis with the agreed service fare; payment-cost protection continues to apply without relying on commission income.

## Existing bookings

No job is backfilled. Quotes without subscription-commission-v1 retain their frozen snapshots, including existing completed, authorised and agreed bookings. Completion still settles the frozen entitlement. Its reporting plan now comes from the booking rather than the driver's current profile.

## Validation and rollout

No commit or deployment is authorised as part of preparing this correction.

Run subscription-billing-policy.spec.ts, subscription-commission-access.spec.ts, protected-quote-audit.spec.ts, completion-payout-retries.spec.ts, fare-split-authority.spec.ts, payout-calculator.spec.ts, payment-agreement-authority.spec.ts, progressed-agreed-payment.spec.ts, wallet-booking-lifecycle.spec.ts, shopping-budget.spec.ts and shopping-budget-payout-authority.spec.ts; server TypeScript and mobile develop build.

src/testing/subscription-commission-policy.sql runs real trigger tests in an isolated movabi_subscription_policy_test schema and ends with ROLLBACK. Use a database-owner session on develop only. It does not alter develop application rows or install the migration. It fails rather than reusing an existing test schema. Local validation used embedded PostgreSQL/PGlite.

When rollout is separately authorised, back up develop, dry-run and apply 20261242700000_subscription_commission_only.sql before deploying the API. The migration requires the existing payment-margin guard to match the reviewed implementation; a mismatch aborts the transaction for review. Deploy API and web together, then verify active and inactive subscriptions with separate new bookings. Verify the displayed customer amount, driver commission, frozen entitlement and final transfer. Do not use existing bookings to test new quote policy.
