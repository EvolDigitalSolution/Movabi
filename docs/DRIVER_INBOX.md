# Driver Inbox

The Driver Hub tabs are Requests, Inbox, Trips, Wallet and Profile. Acceptance
and customer rating retain their existing calculations under Profile > Performance.
The Future analytics placeholder is removed. The Wallet and Full History retain
their existing financial views and routes.

Inbox has Messages (incoming booking messages, including lost-item reports) and
Updates (persisted system, payment and admin notices). Both streams fetch ten
records plus one lookahead and load older records automatically at the bottom.
Chat notification copies are omitted from Updates/counts, because the durable
booking messages appear in Messages. Lists do not mark items read: displaying the
full item acknowledges that one received item. Failed acknowledgements show a
retry. Opening an ended booking goes to its stored record; active booking messages
open the existing Chat tab. Ended-job chat remains read-only. Admin messages open
the existing Messages from Movabi record. Plain notices can be read without a
booking. New opportunity notices return to Requests without accepting a job.

Unread totals are server counts, independent of loaded pages. A dedicated realtime
subscription refreshes counts on message/notice inserts and read updates, with a
30-second fallback poll. It plays no sound, leaving existing notification/alarm
ownership unchanged. New unread items refresh the first list batch automatically when no detail is
open. While reading a message or browsing older batches, a show-latest banner
preserves the current position. Scrolling loads older items. Auth changes clear cached counts and stale responses.

The API derives user identity from the bearer session and ignores body/query user
IDs. Incoming message reads are constrained by receiver_id and notice reads by
user_id. Only explicit safe fields are returned. Stored arbitrary routes/URLs are
not followed. Booking navigation verifies the current driver assignment, including
accepted_driver_id fallback only when driver_id is empty. Old assigned recipients
can read their own received message but cannot navigate into a reassigned job.
No payment, payout, compliance, availability or subscription logic is modified.

Deploy both API and web together. No migration is required; existing notifications
and job_messages tables are reused. Verify on develop with actual customer and
admin messages, unread counts, a failed load/retry, scrolling past ten records,
active and ended booking links, sign-out/account changes, and narrow/enlarged text.
Existing SMTP delivery setup is unchanged. Do not claim a real message or admin
email has been delivered based solely on mocked tests or the build.
