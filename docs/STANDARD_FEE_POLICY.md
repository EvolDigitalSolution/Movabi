# Standard fee policy v2

New quotes: standard driver commission 15% of service fare, excluding customer platform fee; customer platform fee 5% of service fare. Existing Pro exemption remains. Database config remains authoritative. Enabled strategy commission rates are aligned to 15%; unexpected active overrides or tenant policies stop the migration.

Existing agreed quotes, jobs, wallet ledger and payout queue are never rewritten. Existing payment-margin protection remains: GBP processing allowance defaults to 3.25% plus 20p, 10p operating allowance, 50p minimum contribution, including processing on errand shopping budgets. Environment values may override these allowances. They are estimates, not guaranteed profit or actual processor invoices. A small-fare protection adjustment may increase the customer platform amount beyond 5%, and must be included in the displayed total before agreement. Unknown currencies fail closed until a currency cost policy exists.

Competitor benchmarks must represent complete customer prices for equivalent routes, services and vehicles. Convert the inclusive target to a pre-platform-fee service fare, then apply driver minimums and the final payment-margin safeguard. If protection prevents undercutting, sustainability takes priority. Do not advertise an unconditional cheapest-price promise. Stale or insufficient benchmarks do not justify inventing competitor prices.

This migration deliberately retains market_pricing_enabled=false, shadow mode and benchmarks disabled. Validate fresh benchmark coverage and driver floor settings before enabling market adjustments. Changing commission alone does not promise a lower customer price; preserving driver minimums may raise the necessary fare.

Deployment: apply code through the existing checked develop release, then back up the develop database, dry-run the fee migration with its COMMIT changed to ROLLBACK, apply it, and restart only the develop API to clear settings caches. Keep production unchanged. The existing release script transfers migration 420, not this new fee migration 421; transfer 421 separately. No existing completion migration needs rerunning.
