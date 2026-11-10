# Status, wallet cards and payout browsing

Expired bookings were included in customer Past activity, but the status label map
omitted expired, producing Unknown status. It now displays Expired. This does not
infer completion or a refund; genuinely unknown values retain the neutral label.

Driver navigation order is Requests, Trips, Wallet, Inbox, Profile. Paid, Pending
and Fees occupy three compact cards in a single row with smaller labels/amounts.
Amounts remain currency formatted, and long amounts may wrap rather than be hidden.
No earnings, fee or payout calculation changes.

Stripe Express payout dashboards open in a separate tab on web and Capacitor
Browser on native mobile. Web reserves the tab synchronously from the tap to avoid
popup blocking after the authenticated request; its opener is cleared, and the
placeholder is closed on errors. There is no same-window fallback. Closing or
blocking the payout tab produces a retry message while the Movabi app stays open.
Only HTTPS Stripe-owned hosts are accepted for payout dashboard links. Dashboard,
Settings and Full Earnings use the shared opener. Full Earnings now uses the
existing authenticated Connect endpoint instead of scanning local storage and
trying multiple legacy endpoint paths. Native browser dismissal notifies the
existing Connect return listeners. Stripe onboarding itself retains its current
flow and return URLs. No payment is captured, transferred or recalculated here.

Run status-wallet-browser and the history/inbox regression tests, then build the
mobile develop app. Verify the compact row with large currency amounts, narrow
screens/enlarged text, actual Stripe test login, closing the tab/in-app browser,
popup blocking and failed link requests. Native browser behavior still requires
a device build/check. Deploy web for browser changes; native clients need a new
app build to receive the native-browser change. No API or database changes.
