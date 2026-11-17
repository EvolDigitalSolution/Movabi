# Develop deployment runbook — errand purchase-payer + wallet settlement

Pinned application code: `ae917eb` on `release/topup-3ds-on-2385da7`
(feature scope frozen there; packaging commits after it carry only this
archive's docs and scripts — the archive filename names the packaging
commit, and `RELEASE-MANIFEST.md` records it).

Scope: one develop package — API build, required app/UI modules, migrations
`202612705` … `202612711`, this runbook, `PREFLIGHT.md`,
`CHECKSUMS.sha256`, `preflight-schema-check.sql`, and the two real-db
rehearsal scripts. Nothing here is production-scoped; live payouts remain
disabled.

## 0. Backup + restore rehearsal (before touching develop)

1. `pg_dump -Fc movabi_develop > movabi_develop_pre_$(date +%Y%m%d%H%M).dump`
   — a FULL database backup, not a schema extract.
2. Rehearse the exact deployment against that backup, on an isolated
   disposable container, using only this archive's files:

   ```
   runbook/rehearse-restore.sh /path/to/movabi_develop_pre_*.dump
   ```

   The script restores the backup (aborting on any restore error), runs the
   shipped `db/preflight-schema-check.sql`, applies ONLY the reviewed chain
   each preflight group requires — `db/prerequisites/` (547, 548) then
   `db/migrations/` (705-711) — re-runs the preflight, proves every
   pre-existing table's row count and every public function definition is
   unchanged outside the applied files' reviewed declarations, asserts the
   GB Stripe payout identity anchor, then runs BOTH shipped behaviour
   suites. A rehearsal that cannot restore cleanly, that reports baseline
   objects missing, or that touches data outside the reviewed chain means
   STOP — fix the backup or reconcile the schema first. It never sweeps
   repository migrations and never suppresses an error.
3. Keep the dump until post-deploy verification is signed off.

## 1. Read-only inventory — decide from definitions + records, not presence

First host step is read-only. Run `db/preflight-schema-check.sql` on
`movabi_develop`. It reports, per migration group: each required object's
`present`/`missing` state, the recorded `supabase_migrations.schema_migrations`
version state, and two deployed-function **definition checks**.

Apply decision per file (from definitions + records, not object presence):

| objects_missing | recorded | action |
|---|---|---|
| >0 | not-recorded / unknown | **apply the file** |
| 0 | recorded-applied | skip entirely — never replay |
| >0 | recorded-applied | **DRIFT — stop**, investigate |
| 0 | not-recorded / unknown | **DRIFT — stop**, reconcile provenance |
| any `prereq/baseline` missing | — | **STOP** — not the reviewed develop state; no shipped file may fix it |
| any `DEFINITION-DIFFERS` | — | **STOP** — a deployed function was changed outside the reviewed chain |

Then apply only the files the table says to, each in its own psql session so
a failure stops the chain, in this exact reviewed order:

```
# prerequisites - only the ones preflight reports missing:
psql -v ON_ERROR_STOP=1 -d movabi_develop -f db/prerequisites/20261254700000_flutterwave_payout_outbox.sql
psql -v ON_ERROR_STOP=1 -d movabi_develop -f db/prerequisites/20261254800000_flutterwave_collection_subaccounts.sql
# release - only the ones preflight reports missing:
psql -v ON_ERROR_STOP=1 -d movabi_develop -f db/migrations/20261270500000_errand_purchase_payer.sql
psql -v ON_ERROR_STOP=1 -d movabi_develop -f db/migrations/20261270600000_customer_wallet_booking_bridge.sql
psql -v ON_ERROR_STOP=1 -d movabi_develop -f db/migrations/20261270700000_driver_wallet_settlement.sql
psql -v ON_ERROR_STOP=1 -d movabi_develop -f db/migrations/20261270800000_driver_settlement_policy.sql
psql -v ON_ERROR_STOP=1 -d movabi_develop -f db/migrations/20261270900000_kora_payout_adapter.sql
psql -v ON_ERROR_STOP=1 -d movabi_develop -f db/migrations/20261271000000_customer_collection_account_binding.sql
psql -v ON_ERROR_STOP=1 -d movabi_develop -f db/migrations/20261271100000_kora_settle_reference.sql
```

- 202612547 **patches `complete_job_with_pending_payout` by matching its
  deployed source** — the preflight definition check must report
  `definition-verified` before it is applied; on `DEFINITION-DIFFERS`,
  applying it raises `Completion authority differs; review required`.
- 202612547 requires `job_payout_queue`, `driver_earnings`,
  `driver_payment_accounts`, `driver_payout_markets` (baseline objects —
  checked under `prereq/baseline`).
- 202612548 creates `job_settlement_methods` (backfilling `transfer` rows
  from `job_payout_queue`) and requires `driver_payout_markets` +
  `job_payout_queue`.
- 707 requires 547's outbox (`flutterwave_job_submissions`) and 548's
  `job_settlement_methods`; 708-711 chain on 707.
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
migrations; see §6 for what recovery does and does not mean.

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

Plus the unchanged sandbox bundle — these are the **exact variable names the
code reads** (verified against source, not paraphrased):

| Variable | Read by | Required shape |
|---|---|---|
| `NODE_ENV` | all providers | `test` or `development` |
| `VAYDU_DEPLOYMENT_ENV` | all providers | `develop` |
| `VAYDU_DRIVER_PAYOUT_SANDBOX` | all providers | `true` |
| `SUPABASE_URL` | all providers | verified develop target only |
| `KORA_TEST_SECRET_KEY` | `sandboxKoraProvider` | `sk_test_…` — **not** `KORA_PAYOUT_SECRET_KEY`, which the code never reads |
| `KORA_PAYOUT_MERCHANT_REF` | `sandboxKoraProvider` | approved merchant binding |
| `FLUTTERWAVE_TEST_SECRET_KEY` | `sandboxPayoutProvider` | `FLWSECK_TEST-…` |
| `FLUTTERWAVE_PAYOUT_MERCHANT_REF` | `sandboxPayoutProvider` | approved merchant binding |
| `FLUTTERWAVE_PAYOUT_CALLBACK_URL` + `VAYDU_DRIVER_PAYOUT_CALLBACK_APPROVED` + `FLUTTERWAVE_PAYOUT_WEBHOOK_SECRET` | `sandboxPayoutProvider` | approved develop callback, 32+ char webhook secret distinct from the provider key |
| `PAYSTACK_TEST_SECRET_KEY` + `PAYSTACK_PAYOUT_MERCHANT_REF` | `sandboxPaystackProvider` | setup-only; no payout adapter exists |
| `STRIPE_SECRET_KEY` | collection route factory (`wallet.routes.ts`) | `sk_test_…` for the sandbox journey |
| `DRIVER_PAYOUT_FINGERPRINT_KEY` | beneficiary fingerprint | 32+ chars |

Keep ALL payout flags OFF until §5's scoped sandbox configuration check
passes: the master flag and every `…_<PROVIDER>` flag stay unset until the
route rows, merchant bindings and secrets above are verified present.

## 5. Post-deploy verification — statuses kept separate

| Status | Evidence | Done when |
|---|---|---|
| Simulated-provider integration | 15/15 connected journey, 73/73 + 17/17 real-db, 14/14 adapter spec | Already recorded in PREFLIGHT — **not** provider-sandbox verification |
| Provider-sandbox verification | Pending | A real `sk_test_`/`FLWSECK_TEST-` journey on deployed develop: funding → wallet credit → reservation → completion → driver credit → withdrawal → unused-fund release. Credentials live on the host only (`deploy/vaydu-errand-purchase-payer/` scripts accept env-supplied keys; never commit them) |
| Production approval | Out of scope | Separate programme approval; this package never enables it |

## 5a. Provider test plan — per-market, never borrowed

- **GB funding**: customer wallet top-up through the approved **Stripe** test
  route — `market_payment_routes` row GB/GBP/card/stripe with
  `provider_account_id` = the real platform `acct_*` from Stripe config and
  `STRIPE_SECRET_KEY=sk_test_…` on the host.
- **NG funding**: through the **approved NG collection route** only — whatever
  provider `market_payment_routes` holds for NG/NGN with `merchant_approved`
  + `adapter_ready`. If no approved NG route exists, NG collection stays
  **unavailable by design** (freeze fails closed). Do **not** seed a Stripe
  account into NG: `acct_ng_journey_1` was a simulation fixture, and an NG
  route on an unapproved provider would misrepresent the market.
- **NG withdrawal**: driver `driver_payment_accounts` (kora provider,
  completed 10-digit beneficiary) + `driver_payout_markets` row bound to
  `KORA_PAYOUT_MERCHANT_REF` + `sk_test_…` host secret.

Run the sandbox journey with the master flag + `…_KORA` set (Kora leg) and
confirm a flutterwave-market withdrawal stays `blocked` — that is the live
proof the flag cannot leak providers. Reconcile every leg: provider
reference == the attempt/withdrawal's frozen reference, amount == quoted
minor units, currency == market currency, destination == frozen beneficiary,
and exactly one ledger event per transition.

## 6. Rollback limits — a database restore is NOT routine rollback

- Flags: unset `…_KORA`/`…_FLUTTERWAVE`/master → new dispatches blocked
  immediately; in-flight `processing`/`reconcile` withdrawals stay **held**,
  never auto-paid, until re-armed and reconciled — no money at risk.
- API/UI: redeploy prior build at any time; the schema remains compatible.
- Schema: additive only; there are no down migrations.
- **Before any new financial activity** (no wallet top-up settled, no
  purchase recorded, no withdrawal submitted since the migrations ran):
  restoring the §0 dump is a legitimate hard rollback — nothing committed
  is lost.
- **After any new financial activity**: a `pg_restore` is NOT a rollback —
  it is a data-loss operation that destroys committed ledger, wallet and
  payout rows written since the backup. Recovery then means
  **application-level reversal**: unarm the flags, let held withdrawals
  reconcile or reverse through `reverse_driver_withdrawal`, and reconcile
  each wallet/topup ledger entry — never replay the backup over live
  financial state. Treat the restore as disaster recovery requiring
  explicit sign-off plus a reconciliation plan for provider-side effects
  (a settled provider transfer does not un-happen when the row does).
- `driver_payout_preferences` rows are per-driver deletable; removing the
  table reverts everyone to `transfer` — acceptable only while no wallet
  entitlements exist.
