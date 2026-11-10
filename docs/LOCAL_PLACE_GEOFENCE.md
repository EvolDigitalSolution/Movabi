# Local-first pickup and destination search

Named business and supported category searches start within 10 km of an actual
GPS/selected-location anchor. ORS circle parameters and a MapTiler bounding box
restrict upstream results. Every candidate is also checked against the exact
Haversine radius before ranking or display. Empty responses and provider errors
never automatically widen to another city. The UI offers 10 km, 25 km and an
explicit Farther away (configured-country) choice. A new typed query resets the
scope to 10 km. Country restrictions remain derived from the configured market.
This is a search radius, not a replacement for service/booking eligibility checks.

Pickup prefers a GPS fix no older than two minutes, falling back to the selected
delivery address. Destination prefers the selected pickup, then fresh GPS. Missing,
invalid or stale GPS never becomes a fictional country-capital near-me location.
Use my location acquires a real anchor without overwriting the typed business.
Postcodes, numbered/street addresses and explicitly entered areas (comma-separated
or "in/near town") retain address/area lookup. A bare name can be ambiguous between
a town and a business: use an explicit area or Farther away for a distant town.
UK postcode/district lookup is retained, with numeric and CA/IE/NL postcode handling
also bypassing the business radius. This is not an exhaustive worldwide postal
validator; provider data and configured market continue to determine coverage.

Supported categories include restaurants/food, cafes, supermarkets/grocery,
pharmacies, fuel, hospitals and shops. Common cuisine qualifiers use actual
provider category/cuisine/name metadata; Africa restuarant is normalised to
African restaurant. A Nigerian-cuisine venue need not have African in its name.
Missing category/cuisine tags cannot be invented, so coverage depends on the map
providers. Nearby unrelated cuisines are not relabelled as African restaurants.
Named businesses still use relevance plus distance. Duplicate same-name/same-point
provider results are merged while retaining useful category/cuisine metadata.

Nearby POI searches require the customer to tap a result: losing focus does not
silently select the first restaurant/branch. Street-only coordinates never acquire
a fabricated typed house number. A returned different explicit house number is
excluded; blur resolution will not confirm a street-only match as a numbered home.
Selecting a street suggestion remains a deliberate user action, without a claim
that a specific house was verified. Existing routing, pricing and payment logic
is unchanged; editing an address still invalidates the old coordinates/quote.

The result tray has a sticky heading, visible area controls, location access,
readable names and street lines, provider-type icons, actual distance badges,
scrolling, close/Escape controls and native clickable buttons for touch/keyboard.
It separates loading, real empty results and retryable errors. Existing recent
locations remain separate from substantive typed searches. Slow or stale search
responses cannot overwrite a newer query, scope or selected address.

Each provider request is bounded to six seconds. A healthy provider can retain
matches when another fails; all-provider failures or missing API configuration
produce a retryable error rather than "no local restaurants". Positive caches are
bounded and scoped by country, query, exact anchor, radius and lookup mode. No new
provider, key, subscription, backend endpoint or database migration is introduced.

Validation: local-place-geofence, local-place-form, business-place-search,
business-place-input and existing search/history/inbox regression suites plus the
mobile develop build. Provider fixtures do not prove real business coverage or
actual production-key access. On develop, verify a local African restaurant/shop,
duplicate branches, the 10/25 km boundaries, explicit country expansion, no GPS,
postcode/home lookup, tap selection, keyboard and enlarged-text tray layout.
Provider references:
https://docs.maptiler.com/cloud/api/geocoding/
https://github.com/pelias/documentation/blob/master/autocomplete.md
https://github.com/pelias/documentation/blob/master/search.md
