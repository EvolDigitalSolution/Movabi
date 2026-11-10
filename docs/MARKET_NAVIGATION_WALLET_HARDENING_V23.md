# Market, navigation and driver wallet hardening

## Country and ownership

Driver requests require a matching registered country and tenant. GPS and display currency never substitute for the job's service country. Missing/conflicting market data fails closed. Dispatch, initial feeds, realtime hydration, hybrid opportunity hydration, earnings previews and acceptance APIs check the scope. Existing payout/service eligibility remains required.

The migration adds assignment, offer and negotiation-claim triggers and restrictive read policies. Active job transitions also check the assigned driver's market. Existing wrong assignments are not reassigned or paid automatically; cancellation/review is possible. Old incompatible work is surfaced as a support-review banner instead of silently being reassigned. Driver operating identity and Stripe account mirrors are protected from public client edits. Privileged server workflows retain approved identity changes. Drivers acting as customers can read their own bookings, and assigned terminal history remains readable across approved market changes. Neither exception makes a foreign-market job eligible for the driver feed or acquisition.

## Map providers

MapTiler remains the basemap renderer with attribution. Public address/reverse methods use the authenticated Mapbox-first/TomTom-fallback server API. Road routes and guidance use TomTom then Mapbox. Disabled/missing server providers produce an unavailable state rather than browser MapTiler/ORS fallback. Existing caching, inflight deduplication, provider cooldowns and call intervals remain. No external provider calls are made by the tests.

Navigation controls show errors immediately. A GPS start more than 1000 km from the destination is rejected before spending route quota. ResizeObserver keeps the map canvas fitted after modal/container size changes. Existing customer road-motion interpolation, actual driver GPS and freshness checks are preserved; no synthetic location or straight-line directions are introduced.

## Checkout

Checkout context uses the owned stored booking's country/currency, never the browser amount or profile country. Stripe Elements mounts only for available Stripe checkout in the implemented GB/GBP scope. Other assigned providers show setup pending instead of silently mounting Stripe. Expired or missing quote terms show a new-quote action. Home and new-quote actions start a fresh request generation even for the same service, clear the consumed quote cache, and retain duplicate-call protection inside the current request. Quote caches are owner-scoped; invalid expiry timestamps are rejected. The earlier booking-request inline card fallback and saved-card lookup are limited to a quoted GB/GBP journey; the owned booking context remains authoritative at payment. Negotiated payments require a current persisted fare_agreed session deadline.

Legacy GB/GBP checkout remains available while global/database execution routing is off. Once enabled, explicit route readiness is required. Mapping alone cannot activate a provider. Kora collection, saved-card tokenization and payouts are NOT implemented or activated by this patch.

## Driver wallet

Provider and capability status are separate. Existing GB Stripe payout eligibility is verified. Other providers show integration pending rather than pretending to be connected. Ledger totals retain their recorded currencies and distinguish paid, pending, failed and review states. Totals are not presented as a withdrawable bank balance. Transfer references remain historical evidence, not proof of bank arrival. Errors are explicit; stale ledger/provider responses cannot populate a different signed-in owner's wallet. Dashboard, earnings, settings and onboarding use the provider context.

Every Connect endpoint requires an authenticated eligible driver and resolves account IDs from their stored profile. Foreign account/user IDs, unsupported account countries and explicit Stripe metadata owner mismatches are rejected before links/status writes. Legacy accounts without metadata still depend on the server-owned profile binding. No arbitrary account is rebound. The migration protects canonical and legacy account mirrors from client edits. Fees and existing earning/booking snapshots are unchanged; pricing continues to read Settings.

## Verification and rollout

The Node checks execute actual guards, map adapters, DriverService feed/wallet methods and Connect handlers with controlled external dependencies. The updated maptiler-primary-search.spec.ts replaces the superseded browser MapTiler-first contract with server-provider tests.

Full TypeScript/Vitest/Angular checks require the installed repository dependencies on Windows. The review environment only parsed TypeScript syntax and SQL, and ran the standalone actual-code checks; SQL parsing is not a PostgreSQL trigger/RLS execution test.

1. Apply the guarded local installer on v2.3; run focused tests, API compile guard and both develop builds.
The migration version follows the repository's existing 20261242900000 release sequence so its registration/profile prerequisites are already installed.

2. Back up movabi_develop before database rollout. Migration 20261243000000_driver_market_isolation.sql refuses to proceed unless jobs and driver_earnings already have RLS. It adds restrictive policies without deleting existing policies or enabling RLS blindly.
3. Apply the migration transactionally as supabase_admin, then run scripts/check-driver-market-isolation-v23.sql. This rollback-only check uses an existing GB driver and NG job to attempt a real prohibited assignment. No test changes persist.
4. Build an API candidate from the current deployed image, preserving its index and existing release overlays. Add /api/market-safety and reviewed guards without replacing unrelated deployed source. Compile and verify unauthenticated/foreign-owner rejection, configuration preservation and health before switching. Do not copy the complete local server tree into the older deployed image.
5. Deploy web builds after the new API context endpoints exist. Keep assets readable (directories 755/files 644), preserve development origins and rollback images, and leave provider keys server-side.
6. Verify GB drivers cannot see/claim/accept NG work through feeds, stale invitations or RPCs; eligible GB drivers still receive GB work; Kora-assigned wallets show pending without Stripe controls; owned GB payout links work; mixed-currency history and failure states remain accurate. Test actual driver/customer tracking in the same operating market.

The installer does not stage Git, write to the database, deploy or change secrets/flags. All authoritative layers require database and API rollout. Saved-card and early-stop 404s are separate feature deployment gaps and are not made functional here.
