# Database country/currency/provider routing

Uses the existing market_availability country_code/supported_currency pair. New market_payment_routes holds one preferred route per country/currency/method, plus retained historical identities. Initial assignments from existing market records are GB/GBP/card → Stripe and NG/NGN/card → Kora. GB uses the existing logical stripe-platform account alias. Kora's account reference remains NULL until its real merchant identity is supplied. This does not invent credentials or turn currency coverage into merchant approval.

## Source integration

- New payment checkout, when VAYDU_DATABASE_PAYMENT_ROUTING_V23 or the previous VAYDU_GLOBAL_PAYMENT_ROUTING_V23 flag is true, reads database routes instead of VAYDU_MARKET_PAYMENT_ROUTES JSON. Scope comes from the persisted booking/service market, not a browser provider or country parameter. Missing/disabled/ambiguous routes fail closed without trying another provider. Existing Stripe intents retain their existing flow and are not rebound to the new preference.
- Standalone card setup approval reads the same database policies. Its installed GB/GBP Stripe adapter limitation is retained; Kora card tokenisation is not implemented by this mapping patch. Owned saved-card removal remains available after a market change.
- Early-stop reconciliation reads the database. Original provider/account bindings look up historical routes, ignoring a changed preferred mapping. New payments read only the current preferred route. A country provider change never rewrites job_payment_bindings.
- GET /api/payment/market-provider is an authenticated lookup, gated by either routing flag. It derives the default country from the saved profile and resolves the market currency server-side. Query parameters cannot choose a provider, account or country. Output omits merchant identifiers. It is a profile default; actual booking payments use the service country's route. This adds the backend lookup, not new frontend country-selector wiring.

## Mapping and readiness are distinct

The seed rows assign a provider but are not enabled payment approvals. Merchant-approved, adapter-ready and payout-approved flags are explicit. Server access to mappings is SELECT only; clients cannot read/write the table directly. Operators manage mapping identities. Identity fields cannot be rewritten, and route history cannot be deleted; changes are audited in a private table. A new preferred provider/account requires a new identity and retirement of the old preference in one transaction. The old route remains available for original-payment reconciliation.

Current Kora/Fincra execution restrictions remain enforced by both schema and existing application policy. Those booking adapters cannot be declared enabled or ready until an actual adapter installation and reviewed readiness migration. The current legacy Stripe booking adapter and payout RPC still have GB/GBP restrictions. Assigning another country/currency does not remove those execution limitations.

## Validation and rollout order

Local verification: 16 mapping policy/store cases, four actual provider-lookup handler cases, four actual card-wallet handler cases, and 86 existing currency/reconciliation cases with the DB-backed preview. SQL and PL/pgSQL syntax parse. These are not live DB execution or full repository compile tests.

1. Run the new tests, updated card-wallet/reconciliation tests, saved-card contracts and server startup compile guard; run provider offline checks.
2. Back up movabi_develop, verify/apply 20261023230000_market_payment_routes.sql and inspect seed assignments, permissions and identity/audit guards. The installer does not apply SQL.
3. Verify account capabilities and install the required provider execution adapters before approving/enabling payment routes. Do not enable the routing rollout flags with disabled/incomplete mappings and expect collection to succeed. No flags or approvals are changed by the installer.
4. Deploy the tested API before using the new database routing. No frontend changes are included, so the previously passing Angular builds need not be repeated for this patch.

No existing market, booking, payment, earnings or payout row is modified by this migration. It only adds route/audit schema, its triggers and the two configured preference rows. Other markets can receive explicit mappings through the same schema without adding country conditionals to the resolver. Currency options alone do not select countries, accounts or payment methods. Stablecoin wallets remain a separate product requiring a network and dedicated adapter.
