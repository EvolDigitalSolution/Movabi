# HeiGIT migration, additional listings and scrollable result trays

## Root cause and live evidence

The project still used api.openrouteservice.org. HeiGIT's official migration announcement states that the dashboard allowance applies to api.heigit.org and that the deprecated host has reduced quotas. This explains why the old endpoint's Quota exceeded response could coexist with a full dashboard allowance. It does not establish exhaustion of the account's current daily quota.

Official migration: https://ask.openrouteservice.org/t/deprecating-api-openrouteservice-org-in-favour-of-api-heigit-org/7912

Direct checks using the configured key:
- Current Pelias search endpoint: HTTP 200 with local place results.
- Current driving route endpoint: HTTP 200 with a valid route and Access-Control-Allow-Origin: *.
- Current POI endpoint: HTTP 200 with 31 restaurants within a 2 km point buffer at the supplied Bolton-area location.
- A 10 km POI point buffer was rejected: maximum 2 km. A large bounding-box attempt was also rejected by the provider's geometry-area limit.
- The tested POI results did not supply cuisine metadata sufficient to claim African restaurant matches. No assertion is made that The Spices African Restaurant exists in this provider's dataset.

Do not tile dozens of point searches across a 10/25 km area for every keystroke. That would waste the 500/day POI allowance. The app does not add a POI endpoint call in this change.

## Changes

- Migrate legacy geocoding, reverse geocoding, normal routing and navigation routing to the documented current URLs. Keep route profiles, payloads, response handling and caches unchanged.
- MapTiler remains primary for ordinary forward search.
- An explicit Search additional listings action is available on an empty local place search. It queries current Pelias venue search once, keeping the configured country and selected 10/25 km circle. It does not run for postcodes, home addresses, explicit other-town queries or country-wide scope.
- Keep relevance/category verification, actual-distance filtering, positive-result TTL and identical-request sharing. Additional listing failures are distinguished from a successful empty response.
- The action does not consume second-provider quota on each keystroke. There is no automatic scope expansion.
- Additional responses use the existing query-version guard so old responses cannot overwrite a new query or scope.
- Result trays occupy normal document flow within the booking form instead of protruding below an absolutely positioned anchor inside a clipped scroll panel. The entire tray contributes to the form's scroll extent. Trays keep their internal max-height and sticky toolbar. Input icons/clear buttons align at the top of the taller field.
- Empty states explain incomplete listings and full-address entry. Do not label a provider's incomplete data as proof a real business does not exist.

## Verification and rollout

Tests cover exact replacement endpoints, unchanged routing payloads, explicit additional lookup, no automatic extra-provider usage, country/radius enforcement, cuisine evidence, stale responses, repeated clicks, errors, and request coalescing. Run the existing search, booking and journey regression suites and the mobile develop build.

This is a client/web-only change. It requires no SQL migration or API deployment. On-device layout and live additional-search checks remain necessary after deployment, especially with the keyboard open. No Google service or self-hosted infrastructure is introduced.
