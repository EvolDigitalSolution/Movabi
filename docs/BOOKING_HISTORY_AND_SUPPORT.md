# Booking history and in-app support

Customer Activity past cards, driver Trips (including cancelled records), wallet
transactions and earnings records open /customer/history/:id or /driver/history/:id.
The read-only record uses a participant-scoped API projection, showing the stored
journey and dates. It never subscribes to live driver location or invokes job
progress actions. Active bookings retain their existing tracking/detail routes.

The customer sees the agreed service fare and the platform fee included in it.
Shopping budget is explicitly an allowance rather than a claim about spending.
A paid card receipt amount comes from a read-only Stripe retrieve, with matching
booking metadata and currency. A hold is labelled Authorized. An unavailable
receipt is not replaced with an invented paid amount. Driver earnings and transfer
status come from the frozen booking; they are never recomputed by this feature.
Saved participant messages can be read without reopening ended chat for writing.

Get help, report issue, payment help, safety support and lost item reporting use
an in-app textarea. Ratings use the existing rating endpoint with explicit bearer
authentication, a bounded integer score and error feedback. The server derives
rating customer identity from the session rather than the request body.

## Support storage and delivery

Apply 20261242900000_booking_support_requests.sql before enabling the new API.
Support requests are saved with a user-scoped idempotency key before delivery.
Lost item text is limited to 1500 characters; other support messages allow 2000.
Repeated submissions with the same key return the same ticket; changing its
content with that key is rejected. The limit is five new tickets per 15 minutes
per user. Requests are authenticated and checked against the booking participants.
Browser roles cannot read the support table directly or claim delivery leases.

The server sends admin email. A durable worker retries missing SMTP configuration
and transient delivery failures. A stable SMTP Message-ID is used on retries;
SMTP delivery is at least once, not an exactly-once guarantee. A UI reference
means the request is saved, not proof that an email has already been delivered.
The worker creates a deterministic job message for a lost item report and notifies
the assigned driver; the admin also receives email. A driver-message retry does
not resend a previously acknowledged admin email.

Recipient precedence is server configuration only:
1. SUPPORT_MARKET_EMAILS JSON keys tenant:COUNTRY:city, tenant:COUNTRY, tenant.
2. SUPPORT_ADMIN_EMAILS_COUNTRY (for example SUPPORT_ADMIN_EMAILS_GB).
3. SUPPORT_ADMIN_EMAILS.
4. Existing DRIVER_ONBOARDING_MARKET_EMAILS COUNTRY:city mapping, country admin
   recipients, then global driver-onboarding admin recipients.
No recipient supplied by the client is accepted. If no destination or SMTP
credentials are configured, the request remains queued; confirm configuration
and an actual delivered support request on develop before production release.
The form is not an emergency response channel.

## Layout and validation

Transaction headings, amounts and status labels occupy full-width rows on small
screens rather than shrinking descriptions to one character per line. Setup
choices use an adaptive one-column layout on narrow screens and keep existing
vehicle/compliance selection handlers unchanged. Wallet totals wrap responsively.

Run server TypeScript, mobile build, booking-history-support, booking-support-
delivery, booking-help-forms and existing lost-item, payment and payout regression
tests. booking-support-policy.sql runs isolated PostgreSQL fixture, idempotency,
lease, participant, tenant, rate-limit and privilege checks and ends in ROLLBACK.
Also dry-run the migration against the actual develop schema before applying it.
Device checks are still required at narrow widths and enlarged text, including
keyboard activation, back navigation, a failed submission/retry, an actual support
email and a lost item driver message. No existing job/payment data is backfilled.

## Existing baseline checks

The older driver-onboarding-notifications and driver-onboarding-stages suites have
three existing source-text assertion failures: obsolete Connect coalescing/forced
refresh expectations and a blanket DVS prohibition that also matches the already
installed DVSA MOT feature. The same three failures were reproduced with the
unchanged dashboard and onboarding files before this patch. They are not hidden
or rewritten by this change; the remaining targeted regression suites are run
separately. Device layout and SMTP delivery still require develop smoke checks.
