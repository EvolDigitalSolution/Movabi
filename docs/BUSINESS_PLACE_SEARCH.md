# Nearby businesses in pickup and destination search

Named-place searches use the existing ORS venue and MapTiler POI capabilities.
Country limits remain structured parameters from the configured market. Search
text no longer has an inferred street/country appended as if it were a town.
Provider-supplied business names are retained in the main suggestion line.

Matching names are ranked by relevance and then geographic distance, without
requiring the customer to type near me. Pickup prefers current GPS when available;
destination search prefers the selected pickup, falling back to GPS. Explicit
comma-separated town/address input keeps textual relevance rather than overriding
it with the current location. UK postcodes retain their unbiased lookup and
numbered/street addresses retain textual matching ahead of distance. There is
no hard UK-only POI configuration. No new paid API or key is introduced.

Unrelated provider suggestions are excluded from named-place results. A single
character name variation can be retained; provider fuzzy matching is also enabled.
Empty/failed searches no longer substitute recent addresses as apparent business
matches. Recent locations remain available before typing a substantive query.
Empty results show a business-name/town/street-address hint. Delayed autocomplete
and blur-resolution responses cannot replace a later query or selected location.
Selecting a suggestion or current location clears old search/loading state.

Each provider request is bounded to six seconds and individual provider failures
retain the others. Empty failures are not cached indefinitely; positive cache
entries remain keyed by country/query/position and are capped at 100. There are
still three provider requests per non-postcode autocomplete, with no additional
provider accounts or server endpoints.

Business availability depends on the configured providers' indexed data. Tests
use provider fixtures; they do not prove a real Labuka Restaurant listing exists
or that production API keys permit these requests. Verify named businesses near
the actual customer on develop, duplicate branches, explicit other towns,
postcodes, normal numbered addresses, provider failure and final map-pin selection.
No booking, quote, payment, payout or routing calculation is modified.

Provider reference: https://docs.maptiler.com/cloud/api/geocoding/
