# Mapbox address search and TomTom road routing

This patch adds server-owned Mapbox Geocoding v6 and TomTom Calculate Route v1 / Matrix v2 integrations. It does not change the existing MapLibre/MapTiler base map display, native map SDK, database schema, payment routing, merchant approvals or deployments.

## Defaults and activation

All switches are off unless their server environment value is exactly true:

- VAYDU_MAPBOX_GEOCODING_V23: Mapbox forward/reverse geocoding. Requires MAPBOX_GEOCODING_TOKEN. Permanent geocoding is explicitly requested because booking addresses/coordinates are retained; the Mapbox account must permit that product. Browser requests only call the authenticated Vaydu API. No vendor keys are sent to the client.
- VAYDU_TOMTOM_ROUTING_V23: TomTom car-route geometry, distance, duration and text guidance. Requires TOMTOM_API_KEY with Routing access.
- VAYDU_TOMTOM_MATRIX_V23: optional eligible-driver shortlist ETA ordering. Requires TOMTOM_API_KEY with Matrix v2 access. No public arbitrary matrix endpoint is exposed. A failed/incomplete matrix preserves existing eligibility/ranking order.
- VAYDU_MAP_QUOTE_AUTHORITY_V23: reverse-resolve pickup country and recompute road distance/duration on the server before pricing. Requires BOTH Mapbox and TomTom switches/keys and authenticated quote requests. Missing country/route or inconsistent pricing currency blocks the quote instead of displaying a different currency. The configured market and pricing tables must already have valid local rates. No exchange-rate conversion or replacement of GBP symbols is performed.

The UI checks /api/maps-v23/configuration, caches only readiness for 30 seconds and uses existing search/routing when that product is disabled or the endpoint has not yet been deployed. An enabled provider failure does not silently switch to a different provider. Existing address-input debounce remains 400ms with a three-character minimum. Route/Matrix results are coalesced and cached in memory for 30 seconds with bounded entry counts. Driver navigation already enforces a 30-second reroute floor. Requests use fixed vendor domains, no redirects, an eight-second provider timeout, redacted errors, authenticated requests and a per-user map request limit.

## Country and search behaviour

The customer booking screen shows an explicit Journey country selector using configured countries/currencies. Changing it clears addresses, markers, quotes and route state and recenters the map. Registration country, current IP country and service country are distinct: the selected country filters search; server-verified pickup country authorizes the actual quote. An account registered in Nigeria can explicitly book in another enabled market.

Mapbox requests country=the selected country and verifies each result's provider country context. Unknown/foreign-country suggestions are excluded. Coordinates are mapped longitude-first for GeoJSON and latitude-first for TomTom URLs. Local radius filtering remains in place; use country-wide search for destinations outside the chosen local radius. Manual map-pin selection remains supported. Country changes cancel address result subscriptions through existing clearAddress and search-version handling.

Search Box was not selected for Nigeria because the documented Search Box geographies are US, Canada and Europe. Geocoding v6 has addresses/places but no POIs. This patch preserves the existing additional-listing path for shop/service discovery; it does not promise Mapbox searches for named shops, churches, airports or businesses. Retain manual map selection for unavailable results. Mapbox attribution is exposed in the address selector.

## Quote and dispatch integration

The quote feature independently verifies the pickup country through reverse geocoding, discards a city found in a different country, authorizes the market, supplies its currency to the existing pricing engine and replaces browser-provided route distance/time. It then checks both legacy and protected quote currencies match that market. If Nigerian pricing is missing or inconsistent, fix the rate configuration; do not relabel a GBP fare as NGN. Existing protected fare split remains authoritative.

Matrix ordering runs after vehicle/service/compliance filters and after existing rating/distance ordering. It evaluates at most the first 20 already eligible drivers; no new driver is introduced. Drivers in the same ETA-minute bucket keep existing ranking order; drivers outside the shortlist keep their prior order after it. Strict customer availability previews do not invoke Matrix. This is ETA-based dispatch ranking, not a change to acceptance authority or payouts.

Nigeria is listed for TomTom routing but not real-time traffic in the checked coverage table. Routes can be returned without live traffic. This is car routing; do not treat it as commercial truck height/weight/hazard routing for vans or goods vehicles. Existing vehicle eligibility rules remain unchanged.

## Validation and rollout

The local standalone runner executes the 28 actual adapter tests plus real HTTP auth/country/input guards with provider and database I/O mocked. No live provider key or paid API call was used. Full Angular builds and API project typechecking must run in the user's repository. Run:

node --experimental-vm-modules scripts/check-map-adapters-v23.cjs
npx vitest run src/testing/maps-provider-v23.spec.ts src/testing/journey-navigation.spec.ts src/testing/driver-ranking-v23.spec.ts src/testing/quote-dedupe-and-market-errors.spec.ts src/testing/batch2c-api-startup-compile.spec.ts
npx ng build mobile --configuration develop
npx ng build admin --configuration develop

Then prepare a reviewed API/web release. Keep all switches off until compilation/builds pass. Configure keys privately on the host, verify Mapbox permanent geocoding and TomTom entitlements, test NG address/route results, and enable products individually. Use a Nigerian pickup/drop-off and confirm quote.market.countryCode=NG and currency=NGN with local configured rates. Check GB regression, manual pins, searches without GPS, permission denial, provider timeouts, eligible-driver ETA ordering and route changes while driving. Keep payment flags unchanged.

The current deployed API has a separate read-only provider-lookup overlay. This local source patch does not recreate that deployment-specific mount; preserve or reconcile it when preparing the next complete API release. Do not overwrite the running container with this working tree without reviewing all existing feature changes and Compose overrides.

Official documentation checked 2026-10-23:
https://docs.mapbox.com/api/search/geocoding/
https://docs.mapbox.com/api/search/search-box/
https://docs.tomtom.com/routing-api/documentation/tomtom-maps/v1/calculate-route
https://docs.tomtom.com/routing-api/documentation/tomtom-maps/v1/product-information/market-coverage/
https://docs.tomtom.com/matrix-routing-v2-api/documentation/synchronous-matrix
