# Named destinations and airport terminals

## Problem

Manchester Airport Terminal 2 was treated as a local business query and clipped to the customer's 10 km discovery radius. A direct country-filtered MapTiler query returned Terminal 2 on Hong Kong Avenue, Ringway M90 1QX, outside the radius of the supplied Bolton-area origin. The existing provider already contains this result.

## Search intent

- Named destinations such as Manchester Airport Terminal 2, Heathrow T5, Manchester Piccadilly Station and Royal Bolton Hospital search within the configured country without the generic nearby radius.
- Customer coordinates remain a ranking bias when available. GPS is not required merely to search a named destination.
- Explicit near-me/nearby intent keeps the local 10/25 km boundary, including when a name is also supplied.
- Generic queries such as nearest airport, international airport, railway station, terminal 2, Tesco and African restaurant remain local discovery.
- Numbered home addresses, streets, postcodes, explicit other-town searches and country restrictions retain their existing rules.
- The detector does not contain a hard-coded UK city list. It recognizes supported English landmark terms with a distinctive name prefix; it is not a universal natural-language parser for all languages or every landmark name.

## Terminal identity

For a named terminal query, prioritize the requested terminal over the general airport parent and reject explicitly different terminals. Normalize supported forms such as Terminal 2, T2, Terminal Two and Terminal II. Terminal 20 and Terminal 2A remain different identities.

A terminal listing can omit its airport name. If an exact named airport parent is present in the provider response, reject terminal listings more than 15 km from that airport point. This is a sanity check around the airport, not a customer-nearby radius. Without an airport parent or other provider context, the app cannot independently establish a terminal's airport identity. Names and full addresses remain visible for customer confirmation.

Named landmarks do not auto-confirm on blur. The customer must tap a result; the app must not silently substitute a general airport for a terminal. Empty landmark searches request a full place name or street address instead of suggesting a nearby-radius expansion.

## Verification

Tests cover outside-radius terminal results, exact terminal priority, wrong terminal numbers, a terminal at another airport when a parent is available, GPS-independent named lookup, strict near-me override, country restrictions, cache separation and no automatic blur selection. Existing business/address/postcode/location and journey tests remain required.

This is a web/client-only change. No new paid provider, server service or migration is introduced. Provider data and airport entrances still require customer confirmation; no Google-equivalent coverage is claimed.
