# Develop deployment runbook — errand purchase-payer + wallet settlement

Pinned code: `34b3a42` on `release/topup-3ds-on-2385da7` (supersedes `6b63e9d`:
it adds migration 711 and the provider-scoped transfer flags — both required
before any real Kora call; see §4.2).

Scope: one develop package — API build, required app/UI modules, migrations
`202612705` … `202612711`, this runbook, `PREFLIGHT.md`,
`CHECKSUMS.sha256`, `preflight-schema-check.sql`, and the two real-db
rehearsal scripts. Nothing here is production-scoped; live payouts remain
disabled.

## 0. Backup + restore rehearsal (before touching develop)

1. `pg_dump -Fc movabi_develop > movabi_develop_pre_$(date +%Y%m%d%H%M).dump`
2. Restore rehearsal on a SCRATCH instance:
   `createdb movabi_restore_rehearsal && pg_restore -d movabi_restore_rehearsal movabi_develop_pre_*.dump`
   then apply the package migrations in order and re-run
   `realdb-errand-purchase-payer-test.sql` +
   `realdb-customer-funding-chain-test.sql` on the restored copy.
   A rehearsal that cannot restore cleanly means stop — fix backup first.
3. Keep the dump until post-deploy verification is signed off.

## 1. Inspect the develop schema — apply only missing prerequisites

Run `preflight-schema-check.sql` on `movabi_develop`. It reports each object
the package requires and whether it is `present` or `missing`.

- Objects already present (because an earlier package or the live schema
  supplied them): **skip that file entirely**. Never replay an applied
  migration — several are deliberately not idempotent.
- Apply missing migrations in this exact order, each inside its own psql
  session so a failure stops the chain:

  ```
  psql -v ON_ERROR_STOP=1 -d movabi_develop -f 20261270500000_errand_purchase_payer.sql
  psql -v ON_ERROR_STOP=1 -d movabi_develop -f 20261270600000_customer_wallet_booking_bridge.sql
  psql -v ON_ERROR_STOP=1 -d movabi_develop -f 20261270700000_driver_wallet_settlement.sql
  psql -v ON_ERROR_STOP=1 -d movabi_develop -f 20261270800000_driver_settlement_policy.sql
  psql -v ON_ERROR_STOP=1 -d movabi_develop -f 20261270900000_kora_payout_adapter.sql
  psql -v ON_ERROR_STOP=1 -d movabi_develop -f 20261271000000_customer_collection_account_binding.sql
  psql -v ON_ERROR_STOP=1 -d movabi_develop -f 20261271100000_kora_settle_reference.sql
  ```

- 705 requires `202612547`'s objects (`flutterwave_job_submissions`,
  `jobs.payout_provider`, `driver_earnings.payout_provider`) — the check script
  verifies them first. 707 requires the wallet-settlement tables from 705/706
  lineage; 708–711 chain on 707.
- Each migration asserts `current_database()='movabi_develop'` — a wrong
  target aborts instead of applying.

## 2. API + UI deployment units

Deploy the API and app builds produced from commit `34b3a42`. Material
modules for review:

- API: `server/services/driver-withdrawal.service.ts`,
  `server/services/driver-payment-account.service.ts`,
  `server/services/job-payout.service.ts`, `server/services/logistics.service.ts`,
  `server/services/payments/{kora-driver-payout,flutterwave-driver-payout,paystack-driver-payout,customer-wallet-collection}.ts`,
  `server/routes/{driver-withdrawal,driver-payment-account,wallet,booking}.routes.ts`
- UI: `src/app/apps/mobile/features/driver/earnings/earnings.page.ts` +
  `src/app/shared/utils/earnings-currency.ts` — distinguishes wallet credit
  from bank payout; pending/reconcile withdrawals are never rendered paid.

Rollback for code: redeploy the previous API/app build. Migrations are
additive (new columns, tables, functions, guards) — there are no down
migrations; data rollback is the §0 dump restore.

## 3. Trusted configuration — never fixtures

- `market_payment_routes.provider_account_id` (column added by 710) must be
  seeded per approved collect route from the **verified provider account**
  (e.g. the platform Stripe account id from the Stripe dashboard / config
  store). `acct_ng_journey_1` is a test fixture and must never reach develop.
- If no approved NG/NGN stripe route row exists, customer collection for NG is
  **unavailable by design** — `freeze_wallet_topup_fee` fails closed (BP008)
  before any provider call. Route resolution is scoped to
  country+currency+provider+merchant, so a GB Stripe route can never satisfy
  an NG/NGN attempt — there is no fallback path to GB Stripe.
- `driver_payout_markets` rows bind provider + merchant + sandbox driver/tenant
  per market — write them from reviewed configuration only.

## 4. Flags — provider-specific, never a single global switch

Money movement requires BOTH gates:

| Flag | Meaning |
|---|---|
| `VAYDU_DRIVER_PAYOUT_TRANSFERS=true` | master gate — without it every withdrawal is `blocked` before provider contact |
| `VAYDU_DRIVER_PAYOUT_TRANSFERS_FLUTTERWAVE=true` | arms the flutterwave adapter only |
| `VAYDU_DRIVER_PAYOUT_TRANSFERS_KORA=true` | arms the kora adapter only |
| `VAYDU_DRIVER_PAYOUT_TRANSFERS_PAYSTACK` | exists for completeness; paystack has no payout adapter, so it can never dispatch |

Setting the master flag plus `…_KORA` arms **only** Kora — Flutterwave
transfers stay blocked (`provider_transfer_dispatch_disabled`), and the flw
job-payout outbox is gated the same way (`payoutTransfersEnabled('flutterwave')`).
Historical bindings are untouched: provider is frozen on the withdrawal row
at request time and the settle check is provider-shaped.

Plus the unchanged sandbox bundle: `NODE_ENV=test|development`,
`VAYDU_DEPLOYMENT_ENV=develop`, `VAYDU_DRIVER_PAYOUT_SANDBOX=true`,
`SUPABASE_URL` = the verified develop target, per-provider
`*_TEST_SECRET_KEY` (`FLWSECK_TEST-…` / `sk_test_…`), merchant refs,
`DRIVER_PAYOUT_FINGERPRINT_KEY`, approved callback for flutterwave.

## 5. Post-deploy verification — statuses kept separate

| Status | Evidence | Done when |
|---|---|---|
| Simulated-provider integration | 15/15 connected journey, 73/73 + 17/17 real-db, 14/14 adapter spec | Already recorded in PREFLIGHT — **not** provider-sandbox verification |
| Provider-sandbox verification | Pending | A real `sk_test_`/`FLWSECK_TEST-` journey on deployed develop: funding → wallet credit → reservation → completion → driver credit → withdrawal → unused-fund release. Credentials live on the host only (`deploy/vaydu-errand-purchase-payer/` scripts accept env-supplied keys; never commit them) |
| Production approval | Out of scope | Separate programme approval; this package never enables it |

Run the sandbox journey with the master flag + `…_KORA` set (Kora leg) and
confirm a flutterwave-market withdrawal stays `blocked` — that is the live
proof the flag cannot leak providers.

## 6. Rollback limits

- Flags: unset `…_KORA`/`…_FLUTTERWAVE`/master → new dispatches blocked
  immediately; in-flight `processing`/`reconcile` withdrawals stay **held**,
  never auto-paid, until re-armed and reconciled — no money at risk.
- API/UI: redeploy prior build at any time; the schema remains compatible.
- Schema: additive only; hard rollback = §0 dump restore.
- `driver_payout_preferences` rows are per-driver deletable; removing the
  table reverts everyone to `transfer` — acceptable only while no wallet
  entitlements exist.
