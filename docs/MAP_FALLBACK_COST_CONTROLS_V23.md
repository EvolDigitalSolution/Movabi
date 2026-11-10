# Provider fallback and request cost controls

This follow-up applies only after the original Mapbox/TomTom patch. It does not change database data, credentials, deployment or feature flags.

Search: Mapbox permanent geocoding first; TomTom Fuzzy Search only on provider failure, unusable response or zero usable results. The selected country remains mandatory and is verified on both providers' returned results. Reverse: Mapbox first, TomTom Reverse Geocoding on failure. Routing: TomTom first, Mapbox Directions driving on failure; no straight-line fare fallback. If both providers fail, the request fails visibly. Authentication and input validation remain enforced before provider work.

The existing server keys are reused, but TomTom must also authorize Search/Reverse Geocoding and the Mapbox token/account must authorize Directions. Routing/Matrix access alone is not proof that TomTom Search is enabled. Vendor products can have different usage prices. These are billed API requests, not language-model tokens. Search and route products can legitimately return different locations/ETAs; the app retains the strict selected search country and server pickup-country/market-currency check.

Cost controls:
- Passenger search waits 650ms after typing stops and requires four characters. The pre-existing distinct-query checks remain.
- Identical search and reverse requests are coalesced and cached in memory for 60 seconds. Search cache keys include country, normalized query and a proximity bucket of roughly 100m.
- Identical route and matrix calls remain coalesced/cached for 30 seconds. Matrix cache origin buckets avoid needless repeats for small GPS movements. No route query is made for every GPS ping; the existing 30-second driver reroute floor remains.
- Failed provider product requests get a 60-second cooldown; 401/403 failures get five minutes. The other product on the same vendor remains independent (search vs routing). During cooldown the alternate provider is used directly. There is no background probe or retry loop. Invalid input does not trigger fallback.
- Only one primary request is sent normally. One alternate request may be sent when necessary. Cached results make no provider request. Matrix failure preserves existing candidate order and does not fan out to per-driver route requests.
- Map requests remain authenticated and rate-limited; caches are bounded and process-local. More API replicas have independent caches/cooldowns. Server restarts clear them. These controls reduce requests but do not guarantee a monetary spend ceiling; provider dashboards should enforce account quotas.

The original successful live-provider smoke package is superseded by this follow-up source. Do not deploy the older API archive as it lacks fallback. A revised API candidate will be prepared after this patch passes repository checks. Normal live smoke should test search/reverse/route only; Matrix checks can be optional to avoid unnecessary paid cells.

Validation: 35 adapter tests plus actual HTTP auth/country/input guards run locally against mocked provider/database I/O. Tests prove fallback country filtering, no secondary request on primary success, search/reverse deduplication, product cooldown and real route normalization. Full user-repository API compile and frontend builds remain required. No paid vendor calls were made during patch creation.
