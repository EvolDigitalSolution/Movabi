# Early-stop fare proposal pilot

Development-only, disabled by default. This extends stop confirmation with a proposed fare and separate authenticated consent from both participants. Creating a proposal accepts nothing on either person's behalf.

## Pricing policy

Policy `early-stop-distance-prorata-v1` proposes floor(original inclusive charge in minor units × eligible covered metres / original quoted metres). It never exceeds the original charge. Original platform fee and commission are prorated and floored; the driver allocation receives the rounding remainder so the split balances exactly. Currency precision is retained. This is an experimental distance-proportional proposal, not recalculation of the original time/base-fare tariff.

A zero-distance proposal is possible for an evidenced stationary ride; later settlement must release an authorisation rather than attempt a zero capture. No capture, refund, release, payout, earnings update, fare update or booking closure is implemented here. Even an agreed proposal is only an audited agreement pending settlement integration and support review.

## Evidence and access

Both existing stop confirmation and new `VAYDU_EARLY_STOP_FARE_PILOT_V23` flags must be true; NODE_ENV=production always returns 404. The evidence recording flag is also needed to produce evidence. The migration creates no enrolments. A database administrator must deliberately enrol an individual development booking before it begins; enrolment must match its customer and driver and remain valid through consent.

An immutable server timestamp and pricing snapshot are captured only on the enrolled assigned driver's arrived/driver_arrived → in_progress transition. Existing or already-started bookings receive no invented start marker. The pilot requires an agreed stop and unchanged assignment and canonical original payment authority.

Only driver-reported points received before the initial stop request are considered; time waiting for confirmation is excluded. Accuracy must be at most 30m, sample gaps at most 45s, first/last coverage within 30s, first point within 100m of pickup, and speed at most 45m/s. Jitter is filtered. Missing or unreliable evidence, ambiguous distance units, changed terms and recorded travel more than 110% of the quote require review. These are conservative heuristics; signed driver GPS is not independent proof of travel. Unused quoted metres are not an exact remaining road route.

The service-only database functions lock the booking and request before changing consent. The proposal is immutable, separately accepted by both parties, expires after 15 minutes and can be rejected. Retries do not duplicate acceptance events. Changed source evidence invalidates consent. Browser requests cannot supply fares, distances, participant identities or provider settings. Public views contain no GPS or raw booking records.

Normal booking completion is not blocked by this pilot; a completed or reassigned booking invalidates further proposal actions. It must remain a development pilot until canonical booking closure and payment reconciliation are integrated.

## Validation and rollout

Local verification ran 35 calculator/service cases and eight real route-handler boundary checks with dependency stubs. SQL and all four PL/pgSQL bodies parse. These are not database execution or browser tests. Run the included Vitest suite, existing early-stop suite, server compilation and both Angular development builds in the actual repository. Only then apply the new migration to movabi_develop with a backup, inspect permissions and run rollback-only database state tests. No feature flags, enrolments, database changes, staging, commits or deployment are performed by the installer.

New migration: `20261023200000_early_stop_fare_pilot.sql`.
