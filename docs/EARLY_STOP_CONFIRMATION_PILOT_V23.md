# Early-stop confirmation pilot

This implements request and two-party stop agreement only. It is NOT an operational early-completion or partial-settlement feature. It is blocked in NODE_ENV=production, disabled unless VAYDU_EARLY_STOP_PILOT_V23=true, and must remain isolated from real customer trips until settlement is integrated.

## Customer and driver flow

The customer tracking Help tab and the driver trip screen receive a shared early-stop panel. It is hidden when the endpoint is disabled/not deployed. Either signed-in participant may request a stop for breakdown, safety, medical or another problem. The requester's action records their own agreement; the other participant must confirm through their own authenticated account. No shared completion PIN or client-supplied actor ID can sign for another person.

Request creation atomically stores the request, captures a recent active-phase driver-reported location when available, writes an audit event and creates a durable safety support ticket using the existing booking support queue. Missing GPS does not block a request. Support email delivery may be pending; the UI makes no emergency-response promise.

The original request is immutable and one request is allowed per booking in this pilot. Exact retries resume it; changed payloads or another request ID cannot replace it or sign for another person. Confirmations have a 15-minute window. Only the recorded participants, still bound to the current active ride, may respond. Reassignment, a changed booking, expiry or dispute cannot silently turn into agreement. Repeated confirmations do not duplicate events. Either participant can flag a dispute for support. An agreed stop is explicitly not fare acceptance.

Safety support remains independent of agreement. The panel explains that emergencies must be handled through local emergency services and that this support channel is not an emergency response service. Existing safety support has not been disabled or gated by the pilot flag.

## Database

New service-only request and event tables. Anonymous/authenticated users receive no direct privileges. service_role can SELECT but cannot directly mutate either table; writes use a SECURITY DEFINER function with a pinned search_path. That function derives participants, service, status and location from database records, locks the booking and request in a consistent order, and queues support transactionally.

The existing `create_booking_support_request(uuid,uuid,uuid,text,text,text,uuid,text,text,uuid)` function must be installed before this migration. The migration preflight checks it. The existing support mail worker must be running with appropriate recipients before delivery is expected. Never report email delivery merely because a ticket was queued.

No jobs, fares, payment status, authorisations, transfers, earnings or payout records are changed. Existing normal completion/cancellation paths are not blocked by this pilot; the UI explicitly states that closure and any revised fare require support review. This limitation is why production runtime is rejected.

## Next integration

Persist the canonical trip-start/stop state, validate trace coverage, freeze a revised fare under approved pricing, collect separate fare consent, and bind the result to the canonical completion/capture/refund path. Protect races against ordinary completion, cancellation and provider callbacks before permitting any live rollout. Old trips cannot be backfilled with invented travel history.

## Validation

The included tests cover strict inputs, authenticated identities, production/default-off gates, participant rejection, immutable settlement flags, expiry errors, support-queue failure and the real HTTP boundary with RPC calls mocked. They do not prove the SQL state machine. Validate actual two-account request/confirm/dispute/retry behavior on a controlled development booking after migration installation. Both app builds are required because templates have changed.

No configuration or deployment is changed by the local patch installer. Backups and source hashes protect existing uncommitted work. No staging or commit is performed.
