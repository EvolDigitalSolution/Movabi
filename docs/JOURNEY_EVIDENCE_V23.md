# Early trip ending — journey evidence foundation

Database inspection on development confirmed no rows in legacy job_locations. The live journey API overwrites driver_locations. Old trips therefore have no travel history that can establish partial distance.

This patch starts the prerequisite for new trips: service-only timestamped samples, received through the existing authenticated journey endpoint. It is disabled unless VAYDU_JOURNEY_EVIDENCE_V23=true. No environment, database, deployment or existing booking/payment state is changed by the local installer.

## Recorded evidence

A new table stores booking, assigned driver, tenant, coordinates, stated GPS accuracy, device sample time, server receipt time and the booking phase read inside the database transaction. It is deliberately separate from legacy job_locations, whose historical client write permissions cannot establish equivalent provenance.

The endpoint verifies the signed job/driver/tenant grant and active assignment before calling the service-only append function. The function repeats the assignment and active phase check under a row lock. It validates coordinates, freshness and accuracy, serialises concurrent samples, rejects out-of-order records, treats repeated timestamps as duplicates and accepts at most one sample per five seconds, with a 7,200-sample cap per booking. Existing clients normally post every ten seconds.

Anonymous and authenticated customers cannot read/write the table or call append. service_role can read and call append, but receives no direct table insert/update/delete rights. Superusers/table owners retain their normal administration rights.

Evidence write failures are reported separately in the existing location response and do not stop a live map update. They MUST NOT be interpreted as successful evidence collection. Existing replay/older-point handling remains intact.

These are authenticated driver-reported device locations, not independent proof that a driver travelled a route. GPS can be inaccurate or manipulated. No distance, fare, refund or driver entitlement is calculated from them in this patch.

## Remaining early-ending work

- Persist an authoritative trip-start marker and a stop-request snapshot.
- Provide both participants with an early-stop/safety action, available without the other person's agreement.
- Assess trace coverage, GPS quality, gaps, implausible movement and missing start/end samples; send insufficient evidence to review.
- Freeze a revised fare proposal against the original agreed pricing and currency, capped at the original service charge.
- Record separate participant agreement with a one-time, expiring, rate-limited confirmation; a PIN must never gate access to safety help.
- Integrate the agreed result into the canonical completion/settlement path, protecting against races with normal completion, cancellation and provider callbacks. No second capture path.
- Expose clear disputes and support handling, plus the final receipt/refund status.

Existing trips are not backfilled with invented GPS positions. A current location or straight-line subtraction from the destination is not a substitute for a recorded journey.

## Deployment and retention

Apply and test the migration in development before deploying the updated endpoint. The local installer neither runs SQL nor changes the recording flag. The deployed API still needs the new code before collection can occur.

The table is restricted location history. A retention/purge schedule must accompany any production activation; this foundation does not install a recurring purge worker or promise automatic deletion. It should remain disabled in production until the early-ending workflow and its data lifecycle are complete.

Run the new journey-evidence tests, the existing journey-navigation tests and server startup compilation. They test the real HTTP route with database calls stubbed. Validate SQL permissions, duplicate handling and transactional assignment checks against the development database separately. No live payment or trip-ending test is part of this patch.
