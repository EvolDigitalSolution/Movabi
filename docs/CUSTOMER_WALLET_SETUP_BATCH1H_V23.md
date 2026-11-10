# Batch 1H — market-aware zero-balance customer wallets

## Scope and currency authority

Missing legacy customer wallets can be provisioned through authenticated POST `/api/wallet/setup`. The route accepts no owner, tenant, amount, currency, country or provider input. Owner comes from a verified Supabase Bearer identity; a service-only RPC locks the profile, requires role=customer and server-activated registration with a tenant, and resolves the configured registration market. Current address/GPS/browser display country and raw signup metadata never choose the currency.

Currency is `market_availability.supported_currency`, for ANY configured currency: no GBP/NGN allow-list. The test matrix includes NGN, GBP, KES, GHS, USD, EUR, JPY and BHD, plus a configured CAD city override. Enabled/current country and city rows use the existing hierarchy; ambiguous configurations fail closed, and an explicitly paused city cannot fall back to country. Creation additionally requires a live customer-app market. It does not require Stripe, Korapay or any payout/collection capability, because no money is collected.

A customer/currency result is frozen at creation. New wallets explicitly start with available_balance=0 and reserved_balance=0; the table's existing GBP default is NOT changed. Existing wallets, including empty GBP wallets and funded wallets in another currency, are returned unchanged. Exact amounts are returned as decimal strings. `currencyMatchesMarket=false` reports an existing different currency; it is not an instruction to convert it.

IMPORTANT: the observed legacy table has UNIQUE(user_id). This batch supports different configured currencies across customers/markets; it does NOT enable simultaneous multi-currency balances for one legacy customer. It never duplicates a wallet, merges currencies, backfills historical rows or changes wallet/transaction/earnings authority. Concurrent setup requests produce one wallet and the same identity.

## Required profile-authority protection

The supplied live preflight confirms authenticated profile INSERT/DELETE/TRUNCATE/REFERENCES/TRIGGER grants and an ownership guard whose registration protection applies on UPDATE. An unused TRUNCATE grant is removed, but no successful destructive operation on the application database is claimed: 1E foreign keys may already block actual TRUNCATE. Disposable tests distinguish FK rejection from our new statement guard using a separate FK-free probe.

The new additive profile guards use actual SQL role, not JWT role text, for trusted server/auth-bootstrap paths. Client identity/tenant/validated registration fields cannot change; direct profile INSERT/DELETE/TRUNCATE are server-only, including a future accidental grant. Existing SELECT/basic UPDATE and first customer/driver role-selection flows remain, while admin promotion is denied. Ordinary address country is not treated as wallet currency authority. Existing function bodies, signup bootstrap, policies, service rights and financial RPCs are not replaced. Client lifecycle/DDL privileges are revoked (including column INSERT/REFERENCES); inherited unsafe permissions abort the migration. The inspected handle_new_user function is used in the isolated signup-context test, preserving pending registration and ignoring raw activation/admin claims.

No application profile, wallet or auth record is updated by the migration. No account cleanup is performed. Existing trusted service/admin/auth-bootstrap paths remain available; account closure stays on the existing server path.

## Default-off and frontend behavior

`customer_wallet_setup_enabled_v1h()` reads a separate `customer_wallet_setup_enabled` key from the existing protected `wallet_collection_config`. No key is inserted by the migration: default=false. Existing collection and cash-pilot gates must remain false at install and are never enabled. Enabling zero-wallet setup, after reviewed deployment, is separate from collecting or spending money.

WalletService preserves its existing direct owner-scoped read. Only when no row exists does it POST an empty authenticated setup request, checking current session owner before contact and ignoring stale responses after account changes. Disabled setup, pending registration and unavailable markets remain "Not set up"; other failures are unavailable, never fabricated zero. Existing funded wallets never initiate setup. All prior recorded-currency/owner-isolation behavior and payment-writing method bodies remain. No new customer/driver controls or layout changes are added.

## Verification and release limits

Executed here: 20 production server/route behavioral cases; 33 production client wallet cases (the existing 25 plus 8 setup cases); supplemental preservation checks; shell syntax; source-only install/reinstall/rollback and archive verification. External HTTP/auth/DB/Angular boundaries are mocked. These do not establish SQL runtime behavior.

NOT RUN here: PostgreSQL/Docker, full API compile, Vitest runner and Angular builds. Owner commands run a fresh PostgreSQL 15 container, network=none, no application volumes: complete 1E/1F suites, observed customer-shape extension, 1H migration, currency/role/signup/city tests, synchronized two-session creation, safe rerun and four negative schema/ACL regressions. A separate image build checks the exact deployed 1F image/source and compiles the complete server before producing a candidate. Neither command deploys or activates anything.

The guarded local installer verifies exact current wallet route/client source/old test baseline, six unchanged applied migration hashes and the recorded-money helper; it refuses unrelated local changes, backs up original bytes and prints rollback. SQL fixtures and old migrations are package-only dependencies, never installed over the applied originals. No staging, commit, deployment, provider key, merchant approval, live charge, payout, collection or driver-layout change is performed.
