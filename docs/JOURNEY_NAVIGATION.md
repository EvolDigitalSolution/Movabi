# Integrated journey navigation

This release adds a MapLibre route view using the existing OpenRouteService provider. Drivers see instructions, remaining route distance, estimated time and optional spoken instructions. External maps remain an optional action. This is a route guide, not a full traffic-aware native navigation SDK. ORS usage remains subject to the configured provider quota.

Active assigned bookings start a separate journey tracking service. Native Android/iOS builds use pinned @capgo/background-geolocation 8.4.11 and native HTTP upload, independent of the navigation modal or suspended WebView. Browser builds use foreground GPS only. Customers see a waiting state when the last location is more than 45 seconds old. No synthetic driver movement is generated.

The server issues a six-hour job/driver/tenant-scoped location token, refreshes through the authenticated app and rechecks assignment and active status on every update. Completion, cancellation, reassignment and logout stop app tracking; terminal jobs reject uploads even if an offline device has not received the state change. Financial completion, PIN, payout and wallet logic are unchanged.

## Native build and device verification

Run npm ci --legacy-peer-deps, then npm run build:mobile:develop and npx cap sync android. Build Android using the project's supported JDK/SDK. On macOS also run npx cap sync ios and build the iOS app. A web Docker deployment cannot install native tracking into an old APK/IPA.

Verify with two real devices: driver accepts an active job, opens in-app navigation, backgrounds to another app, locks the screen, and customer receives fresh points. Verify completion/cancellation/logout stops uploads, permission denial offers retry, loss of network shows the customer waiting state, and stale GPS does not move the marker. Confirm pickup/store/customer destinations for ride, delivery and errand stages. Optional voice requires platform speech support.

Location delivery depends on OS permission, GPS and network. The plugin does not persist a retry queue. iOS force quit stops background execution. Android battery policies can affect delivery. These limits are handled through location freshness; uninterrupted tracking is not guaranteed. No driver warning about switching maps is added.

## Deployment

The release script checks types, focused regression tests, PostgreSQL tests and mobile build before creating images. This upgrade uses the existing completion-outbox schema and does not rerun its non-idempotent migration. Compose configuration is backed up before replacement. Deploy to develop only; native device acceptance remains necessary before production.
