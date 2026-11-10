# History scrolling

Trips and customer Activities load ten ended bookings per request, with one
lookahead row to detect whether more exist. Ionic infinite scroll requests the
next batch at the bottom; there are no numbered pages or manual Load more buttons.
An explicit retry remains available after a network error. Failed requests keep
existing records and the same cursor. Concurrent scroll requests are ignored,
and every scroll event is completed, including failures.

The cursor orders by created_at and id descending. Newer bookings inserted while
scrolling cannot shift offsets and skip older bookings. Refreshing reopens the
newest batch. Account changes clear the previous account's history. Queries keep
customer/driver ownership predicates and existing RLS. No database migration is
required. Active and negotiating customer bookings are fetched independently on
initial load, so older active jobs are not hidden behind ended-booking pages.

The Earnings screen progressively renders ten transactions at a time and resets
when the period changes. Its existing full earnings data source is retained for
financial totals and filters; this is a rendering optimization, not a paginated
financial aggregate implementation. The Wallet preview already shows five
transactions and links to Full History. Payment calculations are unchanged.

Run history-infinite-scroll, activity-history-fetch, activity-history-status,
booking-history-support and booking-help-forms tests and the mobile develop build.
On device, verify scrolling past ten records, the final batch, offline retry,
returning from a booking record, and enlarged text. The separate wallet card
layout change can remain uncommitted; this patch preserves it.
