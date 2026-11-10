# MapTiler primary address and business search

MapTiler is the primary forward-search provider whenever a MapTiler key is configured. A legacy OpenRouteService key no longer causes parallel geocoding requests on every typed query. Installations without a MapTiler key retain the existing ORS path. Driving routes and reverse geocoding are unchanged.

## Query behaviour

- Keep the existing configured-country restrictions, exact 10/25 km circle checks, explicit country-wide scope, location requirement and typed-address safeguards.
- For a local cuisine category such as African restaurant, query the cuisine word (African) so generic restaurant results cannot crowd the limited provider response. Validate the original category against the returned name/cuisine metadata: a memorial is not a restaurant and an unclassified restaurant is not claimed to be African.
- For a named local business, first use the entered query. If no verified matches survive, make at most one retry with the distinctive business words, excluding generic words such as restaurant. Retain the original query for result validation and the same country/bounds on the retry.
- Do not shorten postcode, numbered-address, explicit-town or country-wide searches.
- No business is invented and no automatic radius expansion occurs.

## Request control

Identical active searches share one request chain. Positive results have a 60-second in-memory lifetime, with at most 100 cached entries per service instance. Empty results and failures are not cached. These are session-local controls, not a persistent business directory.

MapTiler HTTP 403/429 responses pause new geocoding requests for 60 seconds. The pause prevents repeated failing requests; it does not reset a provider quota. Customers receive a retry/map-selection message. Other errors retain the retryable unavailable state. A failed request does not trigger a distinctive-name retry or hidden ORS calls.

The existing 400 ms input debounce remains. A named query can use two MapTiler requests if the first yields no relevant matches; most queries use one. Routing requests are not affected.

## Live checks and limits

Direct MapTiler requests around the supplied Bolton-area coordinates returned HTTP 200. Queries with the restaurant category sometimes returned only generic restaurants, whereas the distinctive word Spices returned named Spices businesses within the 25 km test box. The specific The Spices African Restaurant listing did not appear in the tested response. This is a provider-data limitation, not evidence the business is closed or absent in reality.

OpenRouteService geocoding separately returned HTTP 403 with Quota exceeded. This alone does not distinguish a daily limit from a minute limit.

Do not claim Google-equivalent coverage. A missing business needs a full address or map selection. Live account limits, browser key restrictions and mobile usability must be checked in the deployed app.

## Verification

Regression tests cover bounded distinctive-name retry, cuisine verification, no ORS requests with a configured MapTiler key, no invented/misclassified matches, explicit towns, countries, postcode/home addresses, in-flight coalescing, cache expiry and 403/429 backoff/recovery. Existing local-geofence and booking UI regression suites are retained.
