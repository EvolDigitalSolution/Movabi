# Driver invitation ranking

Disabled by default. `VAYDU_DRIVER_RANKING_V23=true` opts into the ranking only after the service-only review RPC migration is installed. This patch does not change flags or apply the migration.

Existing vehicle, service, availability, online, payout, location, tenant/city, canonical eligibility and decline rules remain authoritative. Ranking applies to the existing bounded candidate pool before the invitation shortlist. Dispatch still invites up to 20 drivers; ranking is not a guaranteed assignment, customer-facing leaderboard or safety verdict. The existing candidate query remains capped at 40 and this is not a global ranking of all nearby drivers.

## Review evidence

The database read counts only a booking owner's review of a completed/settled booking, attributed to the driver stored on that booking. It excludes self-reviews and invalid scores, deduplicates each booking to its latest review and considers the latest 100 reviews per candidate. Existing optional booking_id storage is read only when canonical job_id is absent. No profile rating field is used as ranking authority. No schema columns are added or renamed.

This confirms booking linkage; it does not detect collusion or independently prove that every completed booking was genuine. Existing review submission authorization remains necessary.

## Priority

Confidence-adjusted stars = (review average × review count + 4.5 × 20) / (review count + 20).
A driver without usable reviews has a neutral 4.5 prior. A single five-star review therefore does not outweigh a substantial strong record.
Priority = straight-line pickup distance in kilometres + (5 − confidence-adjusted stars) × 0.15.
Lower priority comes first. Rating preference can never offset more than 600 metres of geographic proximity. This is not road distance or a travel-time estimate. Distance, then recent valid activity, then driver ID resolve ties. Invalid coordinates are placed last.

The score read returning an error, unavailable function or malformed result restores the legacy ordering. Customer availability previews keep their prior ordering and do not call the ranking function.

## Deployment

First run helper and server compilation tests. The SQL function is transactional, read-only and executable only by service_role. Review its preflight against the development database before applying as the authorized database administrator; take a backup following the existing deployment process. Do not enable the flag until the function and invited-driver order have been tested in development. No payment behavior, market rollout, production deployment or automatic driver rejection is added.
