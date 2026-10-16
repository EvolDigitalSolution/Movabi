# Automatic customer-local business search

## Customer flow

Local pickup and drop-off place searches use the customer's fresh GPS position first. If it is missing or older than two minutes, automatically request a current position instead of requiring the customer to press Use my location. Share one pending location request across both fields. Do not overwrite the typed business or set booking coordinates merely from the search anchor.

The browser/device still controls permission. On failure, suppress repeated automatic location attempts for one minute. A previously selected other endpoint can anchor the search when GPS is unavailable; do not silently use the configured country's capital. Keep the location retry button after a failed attempt and allow fully specified addresses. Explicit towns, numbered addresses, postcodes and country-wide searches do not trigger GPS acquisition just to search.

Use customer GPS for both pickup and dropoff business discovery. Explicit address/town queries retain their existing search behaviour.

## Automatic source fallback

MapTiler remains the first provider. If it returns no verified local matches or reports provider unavailability, wait 600 ms and automatically query the existing current HeiGIT geocoder. No Search additional listings button is needed. The existing 400 ms input debounce remains.

A new input immediately cancels the field's current search subscription, including the delayed fallback or active HTTP request. Scope retries, selection and destruction cancel active searches too. Existing query-generation checks prevent stale geolocation and provider responses from replacing new input.

The automatic fallback only runs with a valid local origin and a selected 10/25 km radius. It retains country/radius/category verification, does not widen the area and does not turn unverified restaurants into African restaurant matches. Positive provider caches and in-flight deduplication remain in place. A valid nonempty primary result does not spend secondary-provider quota. A secondary failure is shown as unavailable rather than disguised as a successful empty search.

## Coverage limits

This combines the two existing free-provider integrations automatically; it does not create businesses absent from both datasets. MapTiler and HeiGIT results are not guaranteed to match Google's listings. Incomplete restaurant names/cuisine tags may still prevent a verified category match. Full-address entry remains available. A curated, verified Movabi business directory is a separate future coverage improvement, requiring real business records rather than invented listings.

## Verification

Tests cover automatic missing/stale GPS refresh, customer-GPS precedence, permission failure cooldown, concurrent field requests, preserving typed input, stale GPS responses, address-only bypass, delayed additional search, error fallback, cancellation, and unchanged geofences. Mobile develop build and existing booking/search/history/journey regression suites must pass. On-device permission, keyboard and result-tray checks remain necessary after deployment.

Client/web-only change: no database or API deployment. Existing routing and payment code is unchanged.
