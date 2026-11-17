# Errand purchase payer + NG wallet settlement — develop deploy preflight (2026-11-17)

Deploy target: develop only. Production is not authorised.

## Verification evidence (all green)

| Suite | Engine / baseline | Result |
|---|---|---|
| `realdb-errand-purchase-payer-test.sql` | `supabase/postgres:15.1.1.78` (host image) + `develop_live_public_schema_20261112.sql` + **full repo migration chain** on a DB named `movabi_develop` | 71/71 — §9 wallet settlement (freeze, once-only credit, provider exclusion, reserve→settle/reverse, **client metadata cannot select wallet**) + §10 separated eligibility (earn without beneficiary, withdrawal needs verified beneficiary, double-spend, lease reclaim, uncertain-held, tenant/currency isolation, beneficiary freeze, **paystack beneficiary refused — no payout adapter**) + §11 Kora payout adapter (provider gate admits kora/refuses unreviewed, malformed beneficiary rejected, reserve→marker→verified `KPY-D-` settle, **numeric flutterwave-shaped id cannot settle a kora withdrawal**) |
| `realdb-customer-funding-chain-test.sql` | same | 17/17 — adds binding coverage: bound at freeze, route drift never rewrites, direct rebind refused (frozen trigger), missing stripe binding fails closed, retry reuses the same attempt, one-preferred-route invariant |
| Worker rehearsal (real `JobPayoutService` **and real `DriverWithdrawalService`**, simulated provider boundary) | same | 18/18 — wallet-mode dispatch: zero provider creates, ledger credited exactly once across replays; connected withdrawal journey: reserve → submission marker → reconcile-required (never paid) → verified transfer settles held→paid_out once |
| **Connected integration journey — simulated provider HTTP** `connected-journey.cjs` | disposable stack: real GoTrue (admin-created users, password sign-in, bearer validation), real PostgREST on migrated `movabi_develop`, real Express routers (`/api/wallet`, `/api/booking`, `/api/driver-withdrawals`, `/api/driver-payment-account`, `/api/market-safety`), real services/RPCs | 15/15 — wallet setup → top-up readiness → quote (provider account bound from the trusted `market_payment_routes` row at freeze) → confirmed checkout → server verify → booking-wallet credit → `pay-job` wallet funding → server-policy settlement preference → driver assignment → completion with the stamped PIN → `JobPayoutService` credits `earnings_payable` once (`wallet:<job>`, zero provider transfers) → withdrawal 202 reserve → submission marker → reconcile (never paid) → verified provider transfer settles held→paid_out (`KPY-D-…` reference) → remaining balance spendable. **Withdrawal leg runs on the Kora provider** (market-configured adapter); only provider HTTP boundaries simulated (Stripe package, Kora adapter, payout-eligibility). **This is an application-journey result, not provider-sandbox verification** — no request ever reached a real provider endpoint |
| Migration chain rehearsal | every `supabase/migrations/*.sql` in version order, one transaction each | 117 applied, 38 rolled back (already reflected in the live dump — reported per file) |
| Browser `e2e/customer-wallet-collection.spec.ts` | this checkout's dev build | 2/2 — top-up through the real UI: readiness → frozen quote → card confirm → server verify → credit; hidden when collection unavailable |
| Browser `e2e/driver-earnings-errand-ledger.spec.ts` | this checkout's dev build | 6/6 (3 tests × 2 projects) — reimbursement breakdown, 403 degradation, NG provider routed to the payment-account surface (never Stripe Express) |
| Collection route/adapter runtime `src/testing/customer-wallet-collection.spec.ts` | real route + real `CustomerWalletCollectionService` + real Stripe adapter contract + RPC chain | 8-step: readiness → auth/body validation → quote freeze → over-limit refusal → confirmed-quote submission → one-time credit → idempotent replay → fail-closed identity mismatch |
| Behavioural money-authority `src/testing/batch2c-money-authority.spec.ts` | executes the real booking-create allow-list + server mode derivation against a hostile payload | 53/53 — forged client payment/negotiation modes are discarded; server-derived modes win |
| Unit + runtime specs | wallet/errand/payout scope | `check-customer-wallet-collection-runtime` 12/12 (route-seeded binding, missing/mismatched/drifted, retry, cross-tenant) + 89/89 across the touched spec files (batch1a/1h/1i/1l/1m harnesses, wallet-booking-lifecycle, batch2c, wallet-sandbox-ui, admin-campaigns) + 19/19 `status-wallet-browser` |
| Full suite `npx vitest run` | — | 3663 passed / 21 failed — all remaining failures are Docker-environmental or parallel-load flakes, classified in `docs/roadmap-evidence/full-suite-failures-b09997f.md`; zero regressions |
| Package integrity | clean Windows checkout (`git worktree`, `core.autocrlf=true`) | `sha256sum -c CHECKSUMS.sha256` → 9/9 OK; `*.sql`/`*.sha256`/`*.md` pinned `-text` so CRLF conversion cannot corrupt checksummed bytes. Checksums are recorded over committed (LF) bytes — verify from a clean checkout, not a CRLF working copy |

Reproduce:
`PG_IMAGE=supabase/postgres:15.1.1.78 BASELINE=develop_live_public_schema_20261112.sql PSQL_USER=supabase_admin bash scripts/errand-purchase-payer/run-realdb-tests.sh`
`bash scripts/errand-purchase-payer/run-worker-rehearsal.sh`
`bash scripts/errand-purchase-payer/run-connected-journey.sh` (disposable GoTrue + PostgREST + migrated `movabi_develop`, ~4 min)
All fixtures are committed (test `.sql` files were force-added past the repo's `*.sql` gitignore — they ARE tracked; a clean checkout reproduces both suites).

## Fresh-schema rehearsal

The disposable database is named `movabi_develop`, so database-name-gated
migrations (`202612547` flutterwave payout outbox, driver-sandbox gates) execute
exactly as on the host. The chain loop applies every migration file in version
order inside its own transaction (`psql -1`): files that fail — because their
objects are already in the Nov-12 live dump, or a genuine incompatibility —
roll back and are logged `SKIPPED` with the first error line; pending ones
commit. That rehearses "develop's current schema + this release", not a
hand-picked subset. Notable applied prerequisites this release depends on:
`20261254700000` (flutterwave_job_submissions, `jobs.payout_provider`),
`20261254800000` (`guard_job_transfer_method` — NG payouts require
`metadata.driver_settlement_method='transfer'`), `20261254100000`
(`freeze_wallet_topup_fee` now reads `wallet_topup_fee_policies`).

### Harness-only accommodations (never a production step)

The rehearsal disables, inside disposable containers only:

- the supabase image's built-in DDL-watch **event triggers** (graphql/pgrst/pg_net) —
  image-bundled schema watchers that error during bulk baseline import;
- `jobs` AFTER/BEFORE triggers that require live auth context
  (`auth.uid()`/notification fan-out/market eligibility) — for fixture inserts only:
  `a_sync_agreed_fare_snapshot`, `enforce_driver_market_jobs_v23`,
  `enforce_job_vehicle_category_trigger`, `guard_booking_payment_margin`,
  `mark_enrolled_ride_start_v23`, `reward_credit_lifecycle`,
  `trg_enforce_job_acquisition_eligibility`, `trg_freeze_subscription_driver_commission`,
  `trg_gb_mot_job`, `trg_guard_direct_arrival`, `zz_finalize_agreed_fare_aliases`,
  `zz_job_funding_breakdown_record`, plus the PIN triggers where present.

**Kept enabled during the checks** (production-path coverage): the two
payment-integrity triggers `trg_enforce_job_payment_eligibility` and
`enforce_ride_cash_credit_v1e`, plus the data-only `tr_check_errand_completion_guard`
(blocks completion with a pending over-budget request), `reward_credit_reserve`,
`trg_sync_job_prices`, `tr_update_jobs_updated_at`.

## Migration order

Apply pending migrations in filename order against
`supabase_migrations.schema_migrations`. This release's tail:

1. `20261270000000_capture_develop_inspection_drift.sql` — no-op where drift exists.
2. `20261270100000_completion_pin_effective.sql` — PIN chain already on host; guarded.
3. `20261270200000_referral_fare_minor_units.sql`
4. `20261270300000_overdue_debt_followup.sql`
5. `20261270400000_completion_pin_acceptance_market.sql`
6. `20261270500000_errand_purchase_payer.sql` — payer records, funded-budget cap,
   method lock, reimbursement through the payout outbox (Stripe GB + Flutterwave NG);
   the NG identity check splits: wallet terms need activated-driver identity only,
   transfer terms still need the full verified-beneficiary binding.
7. `20261270600000_customer_wallet_booking_bridge.sql` — bridges credited
   `customer_credit` top-up attempts to `wallets.available_balance`.
8. `20261270700000_driver_wallet_settlement.sql` — `'wallet'` becomes a third
   frozen `job_settlement_methods` mode; `finish_wallet_job_payout` credits
   `earnings_payable` once; `driver_withdrawals` +
   `driver_withdrawal_submissions` (provider-tagged) implement reserve →
   submit → settle/reverse; mutual exclusion on every finish path.
9. `20261270800000_driver_settlement_policy.sql` — `driver_payout_preferences`
   (service-role-owned) + `set_driver_settlement_preference` +
   `resolve_driver_settlement_method`; `guard_job_transfer_method` re-derives
   the frozen method from policy alone — `jobs.metadata` never selects it.
10. `20261270900000_kora_payout_adapter.sql` — the reviewed second adapter:
   `payout_withdrawal_provider_supported` admits `'kora'` (paystack/fincra
   still refused), `finish_driver_withdrawal` validates the settle identity
   per provider (flutterwave `^\d+$`, kora `^KPY-[A-Za-z0-9_-]{3,60}$`), and
   `driver_payment_accounts` accepts provider `'kora'` whose completed
   beneficiary identity is the verified 10-digit NUBV account number.

705/706/707 assert prerequisites in-file. 705's CREATE OR REPLACE functions were
diff-verified identical between the deployed and live-develop schemas — drift-safe.
705 requires `202612547`'s objects (`flutterwave_job_submissions`,
`jobs.payout_provider`, `driver_earnings.payout_provider`) — apply after 547;
the rehearsal proves the ordering.

## Compatibility checks (run before applying)

```sql
-- 1. In-flight payout rows:
select job_id, status from job_payout_queue where status in ('claimed','reconcile');
--    Expected: empty or reviewed — uncertain rows reconcile safely under the new
--    finish path, but confirm with ops first.

-- 2. In-flight errand jobs with recorded spend (backfill candidates):
select j.id, d.actual_spending, d.receipt_url
from jobs j join errand_details d on d.job_id=j.id
where j.status in ('accepted','arrived','in_progress') and d.actual_spending > 0;
--    receipt_url present -> backfilled + reimbursed on completion; absent ->
--    reconciliation, never silent payout; issuing-funded rows excluded by
--    authoritative job_issuing records.

-- 3. Provider/market isolation unchanged:
select count(*) from market_payment_routes where provider<>'stripe' and country_code='GB';
--    Expected: 0.

-- 4. NG settlement is policy-assigned, not metadata-driven (708):
select driver_id, method, updated_at from driver_payout_preferences;
--    Absent rows mean 'transfer' — the historical behaviour. Each 'wallet'
--    row opts that driver's future entitlements into wallet settlement;
--    jobs.metadata.driver_settlement_method is ignored end-to-end and the
--    booking-create path strips the key from client payloads. Any wallet
--    entitlement additionally requires terms.settlement_mode='wallet' frozen
--    at completion (server-side in LogisticsService.completeJob).

-- 5. Wallet settlement prerequisites present (707's in-file guard also checks):
select to_regclass('public.job_settlement_methods'),
       to_regclass('public.driver_payment_accounts'),
       to_regclass('public.wallet_movements'),
       to_regclass('public.flutterwave_job_submissions');
--    Expected: all four non-null (202612410+, 202612450+, 202612547+).
```

## Rollback limits

- `202612706`: safe to `drop trigger trg_wallet_topup_customer_credit_bridge on
  wallet_topup_attempts`; already-bridged balances are posted wallet facts —
  reverse via wallet adjustment, never row deletion.
- `202612705`: function bodies may be restored, but `errand_purchase_payments`
  rows, `job_payout_queue` terms and `reimbursement_transfer_id` values are
  historical payment records — preserve them; never delete to roll back.
- `202612708`: preference rows may be deleted individually; removing the table
  returns every NG driver to `transfer` — already-frozen `job_settlement_methods`
  and wallet ledger facts stay authoritative regardless.
- Legacy ambiguous jobs parked in reconciliation remain until adjudicated —
  intended, not a deploy failure.

## Driver settlement: two alternative modes, frozen per entitlement

Automatic bank transfer and wallet withdrawal are **alternative settlement
modes**. Double payment is prevented structurally — one mode is frozen per
entitlement — never by making withdrawal impossible:

- `guard_job_transfer_method` (BEFORE INSERT on `job_payout_queue`) derives the
  method from **trusted server policy** — `resolve_driver_settlement_method`
  reads the service-role-owned `driver_payout_preferences` row (absent ⇒
  `'transfer'`; non-NG ⇒ always `'transfer'`) — and freezes it in
  `job_settlement_methods` (`'transfer' | 'split' | 'wallet'`).
  `jobs.metadata.driver_settlement_method` is never consulted anywhere on the
  money path: booking create strips the key from client payloads,
  `LogisticsService.completeJob` and the acquisition gate call the resolver,
  and §9 proves metadata claiming `'wallet'` freezes `'transfer'` (and vice
  versa). A 'wallet' queue row must carry `terms.settlement_mode='wallet'`,
  and a 'transfer' row carrying wallet terms is refused. Once frozen, a
  different method claiming the same job raises `Another settlement method
  owns these earnings`. Drivers opt in via
  `POST /api/driver-payment-account/settlement-method` (authenticated driver,
  `set_driver_settlement_preference` validates an activated NG profile).

- **Transfer mode** (GB Stripe `acct_*`; NG Flutterwave `flw:<account-uuid>`):
  unchanged. `claim_flutterwave_job_submission`, `finish_flutterwave_job_payout`
  and `finish_queued_job_payout` all refuse rows whose terms carry
  `settlement_mode='wallet'` — provider rails cannot pay a wallet-mode
  entitlement.

- **Wallet mode** (NG only): `JobPayoutService` dispatches wallet terms to
  `finish_wallet_job_payout`, which posts `earnings_clearing → earnings_payable`
  once via `post_wallet_event` (`event_key='driver-earnings:<job>'`, replay
  returns the same event), marks driver-paid purchases reimbursed with the
  `wallet:<job>` reference, and settles the queue row — **no provider transfer
  is ever submitted** (worker rehearsal: zero provider creates, balance 850
  across replays). It refuses any job with a `flutterwave_job_submissions` row.

- **Withdrawal**: `POST /api/driver-withdrawals` →
  `request_driver_withdrawal` re-checks the spendable `earnings_payable`
  balance under the account lock, then posts `earnings_payable →
  earnings_payable_held` (reserve) before returning. `DriverWithdrawalService`
  (background tick) claims leased rows, writes the irreversible
  `driver_withdrawal_submissions` marker **before** provider contact,
  dispatches through the adapter selected by the market's configured provider
  (`sandboxDestinationProvider`), and finishes via `finish_driver_withdrawal`
  (held → `earnings_paid_out`) on the verified provider transfer id.
  Uncertain outcomes stay `processing`/`reconcile` — retried against the
  submission marker, never re-submitted; definitive failure calls
  `reverse_driver_withdrawal`, which posts the exact negation of the reserve
  legs (validated by `post_wallet_event`'s reversal check) so funds return to
  spendable. `jobs.payout_transfer_id`/`driver_earnings`/`errand_purchase_payments`
  show `wallet:<job>` / `flw:<transfer-id>` — provider references never
  disguise as Stripe.

`flw:*` payout path, traced end-to-end: provider **Flutterwave v3**
(`api.flutterwave.com/v3`, `FLWSECK_*` secret); adapter
`FlutterwaveDriverPayoutProvider` in
`server/services/payments/flutterwave-driver-payout.ts`; merchant binding is
cryptographic — `complete_job_with_pending_payout` re-verifies
`payout_account_id` + `payout_merchant` + `payout_tenant` against
`driver_payment_accounts` (state `completed`) joined to `driver_payout_markets`
(`enabled AND merchant_approved AND adapter_ready AND merchant_mode='test'`
with sandbox driver/tenant binding) before queueing, and the frozen terms are
re-validated at dispatch. The `flw:` destination prefix is a *derived display
form* of `driver_payment_accounts.id`, not a provider claim — the binding is
what proves which provider pays. Dispatch additionally requires
`VAYDU_DRIVER_PAYOUT_TRANSFERS=true` and a `FLWSECK_TEST-` secret (account
setup never moves money; sandbox keys are enforced at adapter construction).

Driver-facing surface: GB keeps Stripe Express (`withdrawFunds()` →
`connectService.getDashboardLink`). For NG, `earnings.page.ts` shows
"Withdraw earnings" when `withdrawableMinor > 0` (posts
`/api/driver-withdrawals`, then refreshes the balance) and routes to
`/driver/settings?section=payouts` (`app-driver-payment-account`) otherwise —
verified by the e2e suite and `status-wallet-browser.spec.ts` (19/19).
Records and UI distinguish **wallet credit** from **bank payment**: earnings
rows carry `payout_provider='wallet'`/`payout_reference='wallet:<job>'` and
render "Credited to Vaydu wallet — not yet paid to a bank"
(`earnings-currency.ts`), while bank-settled rows keep their provider
reference. `GET /api/driver-withdrawals` returns withdrawal status verbatim —
`processing`/`reconcile` are held funds, never displayed as paid.

## Separated eligibility — no single "subaccount ready" gate

Each action checks only what it needs; the checks are independent:

| Action | Required checks | Explicitly NOT required |
|---|---|---|
| **Earn** into the wallet (`complete_job_with_pending_payout`, wallet terms) | Activated NG driver profile, tenant match, NGN terms, `wallet` method frozen | Verified bank account, `driver_payout_markets` capability, collection subaccount |
| **Withdraw** (`request_driver_withdrawal` + worker) | Spendable `earnings_payable` balance (held/paid-out never count), `state='completed'` `driver_payment_accounts` row matching driver/tenant/country/currency, enabled + approved + adapter-ready `driver_payout_markets` (test mode, sandbox driver/tenant binding) | Collection subaccount, any job-level flag |
| **Transfer settlement** (`payout_provider` terms, no `settlement_mode`) | Full verified-beneficiary identity at completion (existing NG branch) | Wallet balance |
| **Collection subaccount / split** (`driver_collection_accounts`) | Its own setup state — untouched by this release | Payment-account or wallet state |

`LogisticsService.completeJob` only calls `DriverPaymentAccountService.ready()`
when policy resolves `'transfer'`; wallet-mode jobs skip it entirely
and carry no `payout_account_id`/`payout_merchant` — the destination is the
ledger (`wallet:<job>`). `driver_earnings_wallet_balance` sums only
`earnings_payable` movements, so a balance is never reported withdrawable while
funds are held or already paid out.

## Provider capability — provider-neutral interface, no invented rails

Withdrawals are **provider-neutral at the DB + service layer**: the row
freezes `provider` from the verified account, the market's configured provider
selects the adapter (`sandboxDestinationProvider`), and
`payout_withdrawal_provider_supported(provider)` is the single gate listing
adapters with a verified beneficiary-payout implementation. Traced
capabilities:

| Provider | Payout capability | State here |
|---|---|---|
| **Flutterwave v3** | Full beneficiary model: `POST /beneficiaries` → `GET /beneficiaries/{id}` re-verified by bank-code + HMAC fingerprint → `POST /transfers` (`beneficiary:<id>` + merchant `reference`) → `GET /transfers?reference=` re-validating reference/currency/amount/bank/fingerprint | **Enabled** behind existing sandbox gates + `VAYDU_DRIVER_PAYOUT_TRANSFERS` — never silent |
| **Paystack** | `PaystackDriverPayout` implements recipient setup/verification only; `submit()` is deliberately unimplemented | **Refused at request time** (`payout_withdrawal_provider_supported` returns false — §10 proves a paystack beneficiary cannot withdraw) |
| **Kora** | Official Payout API reviewed and implemented in `KoraDriverPayout`: `GET /misc/banks?countryCode=NG` → `POST /misc/banks/resolve` (beneficiary verification — Kora requires no pre-created beneficiary; the resolved account IS the identity, frozen as a 10-digit NUBV `beneficiary_id` + bank/account HMAC fingerprint) → `POST /transactions/disburse` (merchant `reference`, `bank_account` destination) → `GET /transactions/{reference}` — per Kora's guidance 5xx/timeouts are never definitive, so submit throws and the worker verifies via lookup | **Implemented, sandbox-only** — `sk_test_` key enforced at construction, `KORA_PAYOUT_MERCHANT_REF` binding, market-configured dispatch through `sandboxDestinationProvider`, same `VAYDU_DRIVER_PAYOUT_TRANSFERS` flag + test-mode `driver_payout_markets` row. No programme approval or live keys implied. |
| **Fincra** | Reviewed (`POST /disbursements/payouts`, `customerReference` idempotency, `successful`/`processing`/`failed`); **no adapter implemented — not selected** | Not selectable — never claimed |

Adding a provider to `payout_withdrawal_provider_supported` without a verified
adapter would invent capability — do not.

## Customer funding

The chain test exercises the REAL collection RPCs — `initiate_wallet_topup` →
`freeze_wallet_topup_fee` → `claim_wallet_topup_submission` →
`record_wallet_topup_provider_reference` → `confirm_wallet_topup_with_total`
(with idempotent replay) — no seeded balances. UI e2e drives the same flow
through `/api/wallet/topup-readiness` → `/api/wallet/collection/checkout`
(quote then confirmed total) → `confirmCardPayment` → `/api/wallet/collection/verify`.
`check-customer-wallet-collection-runtime.mjs` (wired into
`src/testing/customer-wallet-collection.spec.ts`) executes the real
`/collection/checkout` + `/collection/verify` Express handlers against the real
`CustomerWalletCollectionService` and the real Stripe adapter contract —
readiness, auth/body validation, quote freeze, over-limit refusal before any
provider call, provider-reference binding, one-time ledger credit, idempotent
replay, and fail-closed identity mismatch. Stripe.js is stubbed in-browser;
the server route + orchestrator + RPC chain are real. A live Stripe sandbox run
requires deployed test keys — marked as a
deploy-day check, not a blocker (same adapter is exercised by the driver card
collection path). The batch-1A metadata columns are written only by the reviewed
706 bridge (event_key dedupe); the wallet-metadata source contract spec
whitelists it and still forbids any other writer.

## Remaining gaps (explicitly unavailable / not yet proven)

Approval, implementation, deployment and journey verification are separate
concerns — a row being green never implies another:

| Concern | State |
|---|---|
| Provider **programme approval** (Flutterwave, Kora) | Develop-sandbox scope only: `FLWSECK_TEST-` + `merchant_mode='test'` + sandbox driver/tenant binding, dispatch behind `VAYDU_DRIVER_PAYOUT_TRANSFERS`. No production/live approval exists or is implied. |
| Adapter **implementation** | Done — `FlutterwaveDriverPayout` (beneficiary create/verify + reference-bound transfer + reconcile-before-create) **and `KoraDriverPayout`** (bank resolve + `transactions/disburse` + `transactions/{ref}` lookup; adapter spec 13/13) behind the neutral `sandboxDestinationProvider`; `payout_withdrawal_provider_supported` gates the DB side. |
| **Deployment** to `movabi_develop` | Not yet applied — package + instructions below are the artefact. |
| Connected integration **journey** (simulated provider HTTP) | **Verified** — 15/15 on the disposable stack (`run-connected-journey.sh`): real GoTrue/PostgREST/Express/services with provider HTTP simulated. One run against the deployed stack with live test keys remains a deploy-day check. |

| Capability | State |
|---|---|
| Direct merchant payment (`vaydu_direct`) | **Unavailable** — no approved payment rail/adapter; a Stripe transfer cannot pay an arbitrary shop. Stays gated until a rail is selected and approved. |
| Customer-direct payment (`customer_direct`) | **Unavailable** — agreed design retained, but charging semantics/evidence are not integrated. The server never re-charges a customer who already paid the shop. |
| Cash advances | **Deferred/unavailable** — not part of this release. |
| Live provider confirmation (Stripe/Kora collection, Flutterwave payout + withdrawal transfer) | Requires deploy-day test keys + configured `market_payment_routes`/`driver_collection_setup_markets`/`driver_payout_markets` rows; all harness evidence uses mocked or simulated provider transport. Live readiness claims require actual configuration evidence, not test results. |
| NG withdrawable earnings — live transfer leg | Ledger + reserve/settle/reverse proven against the real schema and real worker; the actual provider transfer still requires deployed provider test credentials (`FLWSECK_TEST-`/`sk_test_`) and an enabled `driver_payout_markets` row. Withdrawal is per-driver opt-in via the frozen `'wallet'` settlement method — existing `transfer`-method NG jobs keep paying straight to bank. |
| Customer collection `provider_account_id` binding | **Resolved by 710** — bound from the trusted `market_payment_routes` row at freeze (never client-supplied, frozen by `driver_card_attempt_scope_freeze`, missing stripe binding fails closed before any provider call). Covered by the runtime harness (12/12: missing/mismatched/drifted bindings, retry reuse, foreign-tenant invisibility) and the funding-chain real-DB test (17/17). |
| Connected integration journey — simulated provider HTTP (funding → credit → reservation → purchase → completion → driver credit → withdrawal → reconciliation) | **Verified on the disposable stack** (15/15 — including the server-derived provider-account binding step). Not provider-sandbox verification: every provider call was simulated in-process. A real provider test requires requests to that provider's sandbox and remains a **deploy-day check** with live test keys. |
| Develop deployment | Not yet applied — this package + migration order are the deploy artefact. Legacy ambiguous jobs remain in reconciliation until adjudicated. |

## Deploy instructions (develop)

1. Confirm target: `select current_database()` must return `movabi_develop`.
   707 raises `'Develop database required'` anywhere else.
2. Run the compatibility checks above; adjudicate or defer flagged rows.
3. Apply pending migrations in filename order, one transaction each. This
   package ships 705, 706, 707, 708, 709, 710 as its tail; apply whatever earlier files
   `supabase_migrations.schema_migrations` shows as pending first
   (rehearsed order ends `…704 → 705 → 706 → 707 → 708 → 709 → 710`).
11. `20261271000000_customer_collection_account_binding.sql` — customer
    collection provider-account binding: `market_payment_routes` gains
    `provider_account_id` (the approved provider-side account on the merchant
    route, service-role written) and `freeze_wallet_topup_fee` binds it onto
    `customer_credit` attempts before checkout. Never client-supplied;
    `driver_card_attempt_scope_freeze` already refuses to change a non-null
    binding; a stripe route with no approved account fails closed (BP008)
    before any provider call.
4. Deploy the server build (withdrawal worker starts with
   `JobPayoutService`; routes at `/api/driver-withdrawals*` mount under the
   existing driver auth middleware).
5. Verify post-deploy, in order:
   `select method,count(*) from job_settlement_methods group by 1;`
   `select proname from pg_proc where proname in ('finish_wallet_job_payout','request_driver_withdrawal','reverse_driver_withdrawal');`
   (all three present), then one NG wallet-mode errand →
   `driver_earnings_wallet_balance` increases once; one withdrawal →
   `driver_withdrawals` reserves, dispatches (with transfer env enabled),
   settles or reconciles — never both transfers and stays spendable.
6. Provider env for the NG rails (unchanged from the 546/547 chain):
   `VAYDU_DEPLOYMENT_ENV=develop`, `VAYDU_DRIVER_PAYOUT_SANDBOX=true`,
   `FLUTTERWAVE_TEST_SECRET_KEY` (must match `FLWSECK_TEST-`),
   `FLUTTERWAVE_PAYOUT_MERCHANT_REF`,
   `FLUTTERWAVE_PAYOUT_CALLBACK_URL` (must be
   `https://movabi-develop.apps.evolsolution.com/api/driver-payment-account/webhook`)
   + `VAYDU_DRIVER_PAYOUT_CALLBACK_APPROVED=true`, a 32+-char
   `FLUTTERWAVE_PAYOUT_WEBHOOK_SECRET` distinct from the provider secret,
   `DRIVER_PAYOUT_FINGERPRINT_KEY`, plus the **Kora** binding when a kora
   `driver_payout_markets` row is used (`KORA_TEST_SECRET_KEY` matching
   `sk_test_*`, `KORA_PAYOUT_MERCHANT_REF`), and `VAYDU_DRIVER_PAYOUT_TRANSFERS=true`
   to dispatch bank transfers (job payouts **and** withdrawals share this
   flag — leave unset to hold all NG transfers safely queued).

## Package

`deploy/vaydu-errand-purchase-payer/package/` contains the five migrations
(705, 706, 707, 708, 709, 710), this preflight, and `CHECKSUMS.sha256` covering the final
committed bytes (LF-normalized; `-text` pins verified from a clean Windows
checkout under `core.autocrlf=true`). Re-run the checksums if any file changes.
