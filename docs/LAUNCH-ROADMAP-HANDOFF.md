# Launch roadmap — durable handoff (HEAD `ddf441e` — candidate)

RESUME (authorised payment integration, no re-approval):
DONE: PI wire (job_remaining_payable_minor → amount), zero-payable returns
fully_funded_by_credit+wallet_funded, persisted breakdown, atomic credit
reservation, lifecycle settle/release/reverse, scalar fixes.
OPEN (in order):
1. DONE `6cbc04f`: zero-payable validates REAL records — reserved
   spends only (released/reversed fail), credit owner/tenant/currency/
   unexpired, campaign application required for discount>0, external_due
   must be 0. Route spec 7/7 through real /create-intent (mocked Stripe,
   asserts no PI + wallet_funded write). Dispatch-gate e2e still open.
2. captured/refunded tracking + once-only credit restore; refund bounded by
   collected money; proportional partial-refund allocation on the immutable
   breakdown (currency-aware rounding, cumulative limits, never full
   restore for partial refund).
3. Route/adapter tests: partial/full/no credit, retries, concurrent,
   failure, duplicate/out-of-order webhooks, cancel, partial+full refunds —
   assert provider amounts + persisted accounting, not just responses.
   Do NOT mark PI wire "verified" on SQL arithmetic alone.
4. Admin publish/margin-preview Angular UI.
5. batch1d grant-manifest reconcile — still UNRESOLVED (fixture baseline).
Approved rates: promo/referrals 5%, compensation 80%. No activation/
deployment/packaging/Africa.

RESUME: finish payment integration (authorised, no re-approval needed):
1. PI-path wire: stripe.service/checkout amount => job_remaining_payable_minor
   (persisted external_due_minor preferred). Zero-payable => no PI, explicit
   funded state (wallet_funded), never dispatch before funding secured.
2. Captured/refunded tracking + once-only credit restore + partial-refund
   proportional allocation.
3. Route/adapter integration tests for the above.
4. Admin publish/margin-preview Angular UI (routes+specs exist, 8/8).
5. batch1d grant-manifest reconcile — currently UNRESOLVED (fixture-baseline
   drift, not proven harmless; no ad-hoc permission changes).
Guards: server-only breakdown writes; invalid reward_credit_id fails the
insert atomically (verified orphan_jobs=0); zz_ trigger ordering is the
single breakdown writer; historical fallback only for pre-breakdown rows.
Approved rates: promo/referrals 5%, compensation 80% collected.
No activation/deployment/packaging/Africa.

Verification checkpoint: `a257afb` (integration-frozen). Policy-implementation
commits after it: `c915d7f` (commercial policies v2), `d55eb63` (promo v2).

## Final matrix

| Tier | Items |
|---|---|
| **Implemented + verified** (evidence in commits) | 1 offer events/metrics/availability (`aa661f6`+), 2 inspection+account security (`a7179a9`,`3f3b399`), 3 PIN policy (`51c732e`), 4 traffic+surge display (`14c6af9`), 5 cash lifecycle incl. disabled-acquisition gate + ref-atomicity (`ffdeae1`,`bff41a7`,`bc5d797`), 6 cancellation debt full loop (`860397d`–`a9c0e96`), 7 campaigns/referrals end-to-end (`6f25089`–`fd09eb5`), 8 market-readiness report (`3da32a8`) |
| **Activation-ready** (code verified; awaiting business config) | Cancellation fee/compensation policies; campaign values + referral rewards; debt thresholds; cash pilot enablement |
| **Remote-only** (develop, not done locally) | Concurrent-cash smoke, real Stripe webhook replay, on-device inspection upload, restore drill, admin smoke — `scripts/verify-develop-integration.sh` |

Branch: `v2.3`. Africa parked on `africa/deferred-2026-11-01` (do not advance it).
No deployment, packaging, market activation, or production financial action.
Cash stays disabled. Dynamic pricing/surge stays disabled (maxSurge default 1).
New migrations live in `supabase/migrations/` — force-add (`git add -f`, `*.sql` ignored).
Disposable-PG fixture: `bash scripts/check-cash-credit-lifecycle-pg.sh` recreates
`vaydu-pg-test` (`movabi_develop`) with base stubs + the real wallet chain
(1a-1f + prerequisites) and a seeded £100 cash-credit deposit.

## Done (backend implemented; integration verification pending where noted)

| Item | Commit | Evidence |
|---|---|---|
| 1. Offer events + metrics + availability msgs | `aa661f6` `840db87` `5f67c9a` `8328da8` | driver_offer_events + 5 RPCs; ack-only denominator; metadata.cancellation_reason attribution; service_role-only privileged RPCs; dashboard metrics UI w/ insufficient-data; no_driver_reason messages. **Pending:** end-to-end dispatch smoke on develop |
| 2. Inspection + account security | `a7179a9` `3f3b399` | 6 slots vehicle-scoped, sharp decode+strip+min-dims, storage object policies, admin review w/ signed URLs; suspension enforced per-call via requireAuthenticatedUser + ban_duration revoke. **Pending:** real-device upload smoke |
| 3. Completion PIN policy | `51c732e` | driver_pin_policies (driver>market>default), record_pin_attempt (5x15min lock, replay-safe 'done'), optional/required/disabled through assertCompletionPin; audited admin route. 7/7 specs |
| 4. Traffic + surge | `14c6af9` | congestionRatio from noTrafficTravelTimeInSeconds; /:jobId/traffic green/amber/red+timestamp+unavailable; surge capped via maxSurge, frozen in fare snapshot. **Pending:** live TomTom key verification |
| 5. Cash lifecycle | `8e72d30` `ffdeae1` | Full disposable-PG chain (`check-cash-credit-lifecycle-pg.sh`): atomic INSERT acquire+hold via real trigger; CE004 rollback leaves no job/hold/ledger; second acceptance cannot re-spend held credit; idempotent re-reserve; settle-once → cash_fee_clearing; cancel release restores balance (8400/10000 after £70 settle + £70 release). **Defect fixed:** `20261255500000_cash_acquisition_eligibility.sql` — UPDATE-path assignment was MB003-blocked for cash. batch1f check 37/37. **Pending:** batch1d's non-cash `auth.*` RPCs absent in fixture (not needed for cash lifecycle); develop-DB concurrency |
| 6. Cancellation debt | `860397d` `eaf8326` `a9c0e96` `004a842` | cancellation_policies (versioned, disabled), customer_receivables, /cancel receivable on uncharged fee, cancel-preview, /debts+dispute+repay, webhook marks paid on verified PI success, debt gate in /create; customer debts UI in wallet; admin receivables queue /admin/receivables w/ audit. `customer-debts-routes.spec.ts` 11/11 through real router+webhook |
| 7. Campaigns/referrals | `6f25089` `d96b9cd` `b468efd` `528dcc3` `fd09eb5` | campaigns + referrals schema (disabled), campaign_spend budget guard, earn_referral (completed+paid, wired in completeJob); admin CRUD/status/adjudicate; driver link + redeem self/duplicate 409; discount-code UI quote-bound (auto-invalidates on refresh) + /campaigns/remove releases budget; ReferralPanel in customer wallet + driver profile; completeJob earns on completed+paid. **Pending:** live campaign smoke |
| 8. Market readiness | `3da32a8` | GET /admin/market-readiness: pricing/currency/drivers/payment-route report before enabling; read-only, no implicit capability enablement |

## Integration review (candidate `b1d0c2e` → `2fc2c64`)

| Check | Result |
|---|---|
| Cash exemption (`20261255500000`) bypasses ONLY electronic gate | ✓ non-cash still MB003; wrong-tenant `DRIVER_MARKET_MISMATCH`; unenrolled CE002; invalid fare CE003; `authenticated` role permission denied; failed cases left no phantom rows |
| Admin `paid` requires provider-verified payment | ✓ `bff41a7` — fabricated/mismatched/reused refs rejected server-side; waive/write-off stay reference-free; 9/9 real-route spec cases |
| Debt list/repay/dispute + restored eligibility | ✓ `a9c0e96` 11/11 real router+webhook |
| Cash lifecycle (atomic/concurrent/idempotent/settle-once) | ✓ `ffdeae1` disposable-PG full chain, MB003 defect fixed |
| 60 integrated specs across 9 files | ✓ all pass (cash 1e/1f/1g, debts, receivables, inspection, PIN, metrics, market availability) |

**Remote-only remainder:** develop-DB concurrent-cash smoke, real Stripe webhook replay, inspection on-device upload, restore drill, admin smoke — listed in `scripts/verify-develop-integration.sh` (executable vs interactive split).



| Decision | Current state | Configured value |
|---|---|---|
| Cash hold on driver reassignment/early-stop: auto-release vs operator review | fail-closed `held` → review (correct today) | none — needs explicit policy |
| Campaign reward/discount amounts & referral qualifying rules | schema + plumbing only, no activation | none — `campaigns` rows carry values |
| Commercial fee/commission rates | unchanged, DB-configured only | existing DB values untouched |
| Debt-booking restriction thresholds | `debt_threshold_minor` per policy row | none — disabled until set |
| Driver compensation %, collection-vs-advance funding | `driver_compensation_percent`, `compensation_funding` | defaults 0 / `on_collection` |

## Remaining work

- Item 6: verified-repayment flow needs a real Stripe checkout return path (client_secret hand-off exists; end-to-end card UI confirm is remote).
- Item 9: live backup restore drill + rollback execution evidence; monitoring consumer for ops report (`scripts/report-unresolved-payment-ops.cjs` exits 0/2/3 verified).
- Item 5: batch1d full apply needs `auth.cancel_job_safely`/`auth.finalize_wallet_topup`/`auth.release_job_wallet_reservation`/`auth.reserve_errand_funds` canonical bodies — non-cash RPCs outside the cash lifecycle scope.

## Consolidated remote checks (develop, not production)

1. `bash scripts/check-cash-credit-lifecycle-pg.sh` already proves local chain; on develop: two concurrent driver accepts for cash rides at one credit balance → one CE004.
2. `node scripts/report-unresolved-payment-ops.cjs` against develop Supabase env — expect exit 0/2; force a DB outage → exit 3.
3. Migration apply: push the `supabase/migrations/20261*` chain (incl. `20261104000000_cancellation_debt`, `20261105000000_campaigns_referrals`, `20261255500000_cash_acquisition_eligibility`) to develop — watch for batch1d `auth.*` RPC MD5 expectations.
4. Webhook `debt_repayment` on real Stripe test intent → receivable `paid`, `OUTSTANDING_DEBT` gate lifts.
5. Live backup restore drill into an isolated develop container; record checksums — only then is item 9 complete.
6. Admin UI smoke: /admin/receivables queue + /admin/market-readiness against GB.

## Test commands

`npx vitest run src/testing/<spec>` | `node scripts/check-driver-cash-credit-batch1f-runtime.mjs` |
`node scripts/check-driver-cash-credit-batch1g.cjs` | `bash scripts/check-cash-credit-lifecycle-pg.sh` |
disposable: `docker exec -i vaydu-pg-test psql -U postgres -d movabi_develop -v ON_ERROR_STOP=1 < <migration>`

## Approved commercial policies (spec for implementation — `a257afb`+)

All market/currency-configured, never GB constants. Integer minor units +
basis points. Resolve by tenant+country+currency+service w/ versioned
snapshots. Missing config = policy inactive.

| # | Policy | Approved value | Mechanism |
|---|---|---|---|
| 1 | Cash reassignment | Atomic release old hold + reserve replacement + transfer; insufficient credit preserves original | extend `driver_cash_credit_holds_v1e` + new `reassign_cash_job_credit` RPC |
| 2 | Cash early-stop | Hold disputed for operator review; 24h target then escalate; never auto-release | review state on hold; escalation is a flag, not a state change |
| 3 | Customer promo | 10% first-booking discount, platform-funded (driver earnings preserved), no stacking, market min fare + max discount cap | `campaigns` value_type=percent value=10 + market qualification jsonb + `campaign_spend` reserve before promise |
| 4 | Customer referral | **5%** of referee's first qualifying paid booking fare as non-withdrawable booking credit; min qualifying fare + cap configured; max 5/referrer/month; 90-day credit expiry | extend referrals: `reward_rate_bps`, `qualifying_job_id`, `expires_at`, monthly-count gate in `earn_referral` |
| 5 | Driver referral | **5%** of cumulative fares across first 20 qualifying jobs within 30d of activation; market cap; max 3/referrer/month; release after 7-day review | referrals + job-count tracker + review-release timestamp |
| 6 | Campaign budgets | Per campaign+currency; never sum currencies; explicit funded budget before activation; reserve liabilities | `campaign_spend` already atomic; add per-currency rows constraint |
| 7 | Customer debt | threshold = 50% of market min standard fare for service/currency, PERSISTED in minor at publish; block new bookings only when confirmed-undisputed overdue debt reaches it; aggregation within one currency; preserve active journeys | `cancellation_policies.debt_threshold_minor` computed+persisted at publish; gate excludes disputed |
| 8 | Driver compensation | 80% of collected cancellation/no-show fees; 20% platform; no advance funding; uncollected stays pending non-spendable | `driver_compensation_percent=80`, `compensation_funding='on_collection'` (defaults already align) |
| 9 | Admin/user UX | config+validation+preview+audited activation; customer/driver see terms, caps, progress, pending rewards, debt restrictions; per-op policy snapshot | extend existing admin routes + wallet components |
| 10 | Verification | multi-currency incl. 0- and 3-decimal; rounding, caps, policy changes, budget concurrency, refunds, disputes, replay, cross-market isolation | disposable-PG fixture pattern (`check-cash-credit-lifecycle-pg.sh`) |

Status: spec recorded at context boundary. Schema largely exists
(`campaigns`, `referrals`, `cancellation_policies`, `customer_receivables`,
cash-credit holds); gaps: referral % rewards + monthly caps + expiry +
job-count qualification + review-release, debt-threshold publish formula,
cash reassign RPC, early-stop review hold, multi-currency test matrix.
Nothing activated; no deployment.

## Policy implementation status (post-a257afb)

| Approved policy | State |
|---|---|
| Cash reassignment (atomic release+transfer+reserve; failure preserves original) | **Implemented + disposable-PG verified** — `reassign_cash_job_credit_v1f`, success + insufficient-credit rollback proven |
| Cash early-stop (disputed held for review; 24h target; never auto-release) | **Implemented + verified** — flag/cancel/escalation proven; operator resolves via resolve RPC |
| Customer referral 5% first qualifying fare, non-withdrawable credit, 90d expiry, ≤5/mo | **Implemented + verified** — reward=100 on 2000 fare, expiry set, credit row written |
| Driver referral 5% cumulative × 20 jobs/30d, cap, ≤3/mo, 7-day review | **Implemented + verified** — progress ledger, review-window release sweep |
| Customer promo **5%** first-booking platform-funded (changed from 10%) | **Implemented + verified** — `firstBookingOnly`, `min_qualifying_fare_minor`, `max_discount_minor` in apply; margin preview RPC; multi-currency exponents 0/2/3 confirmed |
| Debt threshold 50% of market reference fare, persisted at publish | **Implemented + verified** — `publish_cancellation_policy` stores computed minor |
| Driver compensation 80% of collected, on_collection | Configured in `cancellation_policies` (publish writes both) |
| Receivable provider/merchant/reference binding | **Implemented + verified** — triple-scoped index + route validation, 10/10 spec |

**Pending:** admin policy-publish UI + preview surface (preview RPC exists),
early-stop/reassign operator route endpoints, reward-credit spend at
booking apply.

**Activation inputs still needed (local config only):** monetary caps,
minimum qualifying fares, funded campaign budgets, overdue debt terms.
No percentages outstanding. Nothing activated; no deployment; Africa parked.

## Fresh-DB + upgrade-path validation

- Full ordered chain applied on fresh `movabi_develop` (vaydu-pg-fresh):
  base stubs → errand_wallet → payment_customers → market_routes →
  driver_market → wallet 1a/1b/1c → topup → settlement → hardening →
  fare_deadline → lifecycle_atomic → cancel_terminal → money_acl →
  batch1d → cash_eligibility → batch1e → batch1f → cancellation_debt →
  campaigns → disabled_gate → policies_v2 → promo_v2. All policy
  migrations apply clean with ON_ERROR_STOP.
- batch1d rolled back on missing `auth.*` RPCs (documented non-cash gap).
- Upgrade path: `pi_bound` backfilled from job_payment_bindings;
  `pi_ambig`/`pi_noref` left NULL + UNBOUND_RECEIVABLE notice — reported,
  never guessed. NOT VALID check blocks NEW unbound writes, preserves
  readable history, never trips on the backfill itself.

## Operator routes + evidence corrections (`a789694`)

- `/cash-jobs/:jobId/reassign` + `/cash-jobs/:jobId/review` — audited admin
  routes over the service-role RPCs; atomicity preserved by the DB.
- `/policies/cancellation/publish` → `publish_cancellation_policy` (threshold
  persisted at publish); `/policies/margin-preview` → `preview_vaydu_margin`.
- `/campaigns/apply` now derives eligible fare from
  `quote_market_adjustments.protected_fare_snapshot` — browser fareMinor
  rejected server-side (QUOTE_NOT_FOUND).
- `receivable_reference_binding` CHECK -> trigger: binding columns gated,
  legacy unbound rows writable on unrelated fields (recovery preserved);
  new unbound ref writes blocked RBD01. Fresh-PG verified all four cases.
- batch1d: `auth.*` RPCs exist via `scripts/fixtures/wallet-authz-batch1d-rpcs.sql`;
  remaining drift is fixture-baseline-specific — explicitly retained gap.

**Still open:** reward-credit spend through canonical wallet authority;
admin publish/margin-preview UI surface (routes exist); concurrent-cash
route-level smoke on develop.

## Reward-credit spend + batch1d analysis (`d45f67b`, `8b6b4cf` pending)

- `reward_credit_spends` + apply/settle/release/reverse RPCs — FOR UPDATE
  on the credit row, owner/tenant/currency isolation, bounded to available,
  expired auto-rejects; partial unique keeps released history. Fresh-PG:
  capped apply, mismatch rejections, settle, release+re-reserve, refund
  reversal all proven. Non-withdrawable by schema.
- batch1d grants analysis: `auth.*` RPCs exist via
  `scripts/fixtures/wallet-authz-batch1d-rpcs.sql`. Remaining "EXECUTE
  drift" entries (credit_wallet_topup 4-arg/5-arg, finalize_wallet_topup_*)
  are functions whose canonical ACL lives in the dedicated
  `batch1d-fixture` schema — a FIXTURE baseline mismatch, not a real
  upgrade defect. Retained as an open integration gap until the real
  grant manifest is reconciled — no ad-hoc permission changes made.
- Operator-route spec: admin-only 403, INSUFFICIENT_CREDIT/CASH_COLLECTED
  mapping, review flag, publish versioning, margin preview — 8/8.

**Still open:** admin publish/margin-preview UI surface (routes+spec exist);
reward-credit apply at booking-create wire; develop concurrent-cash smoke.

## Reward-credit integration final (`563fdb7`)

- Idempotent apply (retry returns existing reservation); lifecycle trigger
  settle/release/reverse; scalar resolutions fix multi-spend defect;
  expired credit cannot reactivate; `/create` wires reward_credit_id with
  server-derived eligible amount — failures map to typed codes, never
  silent spend.
- batch1d RECLASSIFIED **unresolved**: `auth.*` RPCs exist via
  `wallet-authz-batch1d-rpcs.sql` but the remaining EXECUTE drift is the
  dedicated `batch1d-fixture` baseline — a fixture mismatch, not proven a
  real defect. Gap retained in release readiness until the real grant
  manifest is reconciled. No ad-hoc permission changes made.

**Open:** admin publish/margin-preview UI surface (routes+spec exist);
concurrent-cash route smoke on develop; batch1d grant manifest reconcile.

## Atomic reward-credit reservation (`461c0a1`)

- reserve_job_reward_credit INSERT trigger: apply_reward_credit inside the
  same tx as the job insert — bad credit rolls back the whole booking
  (orphan_jobs=0 verified on fresh PG).
- Eligible payable = customerCharge − platform-funded discount (server-
  derived, never driverBase/client amount); spend bounded by credit too.
- batch1d stays **unresolved**: fixture RPCs exist; remaining EXECUTE drift
  is the dedicated batch1d-fixture baseline — not proven harmless, no
  ad-hoc permission changes.
- **Matrix correction:** anything missing UI or unresolved integration is
  NOT "implemented+verified" or "activation-ready": admin publish/
  margin-preview UI surface still open (routes+specs exist, Angular
  component not built); batch1d grant-manifest reconcile open.

## Remaining-payable derivation (`job_remaining_payable_minor`)

Authoritative electronic-due: customerCharge − discount_minor − reserved
credit, floor 0 (fully-covered booking => no PI). customerCharge never
already contains the discount — metadata/discount_minor is the single
source; no double-subtraction. Verified 50−10−30=10 on fresh PG.
Wire into the PI-creation path (stripe.service / pay route) remains open.

## Accepted funding breakdown (`job_funding_breakdown`)

Persisted at insert (zz_ trigger, runs after reserve): charge − discount −
reserved credit = external_due_minor. Lifecycle-stable — reserve->spent does
NOT re-raise payable (verified: 40 stays 40 after completion).
job_remaining_payable_minor prefers the persisted row, falls back to live
derivation for pre-breakdown jobs only.

**Still open:** PI-path wire (stripe.service amount => job_remaining_-
payable_minor), zero-payable funding state (no zero-PI), refund bounds vs
collected money, route/adapter tests, admin Angular UI, batch1d manifest.

## PI-path wire (`c1af9e4`)

job_remaining_payable_minor feeds the PI amount via persisted
job_funding_breakdown; zero-payable returns explicit fully_funded_by_credit
+ wallet_funded — no zero-PI, no fabricated success. `stripe.service` /
checkout now charges only the external remainder.

**Still open:** captured/refunded tracking + once-only credit restore +
partial-refund proportional allocation; route/adapter tests for the flows;
admin publish/margin-preview Angular UI; batch1d grant-manifest reconcile.

## Atomic funding + refund ledger (`e68a0d4`, `ae45d30`)

- secure_zero_payable_funding: one tx — FOR UPDATE on job, reserved spends
  + active/in-scope/unexpired credits + campaign app + external_due==0 ->
  wallet_funded. Concurrency proven on real PG: concurrent release commit
  during lock wait -> insecure_allocation (no TOCTOU). Retry post-expiry ->
  already:true, no re-validation.
- apply_job_refund: external bounded captured-refunded; credit restores
  floor(external*credit/charge) proportional, cumulative-capped, partial
  refund never restores full credit; UNIQUE(provider_ref) replay-safe.
  PG-verified: 20->10, second bounded 20, replay idempotent, full->0.
- Route spec 5/5 through /create-intent.

**Open:** webhook/cancel route integration tests for refunds; admin publish/
margin-preview Angular UI; batch1d grant-manifest (still unresolved).

## Refund RPC v2 — explicit semantics (`1da348c`)

apply_job_refund(job, service_minor, external_minor, ref): three distinct
inputs — service-value (drives credit share), provider-confirmed external
(bounded captured-refunded, overage -> discrepancy_minor, never silently
clamped), derived credit restore (partial proportional cumulative-capped;
final absorbs remainder, restores all eligible once). Discount never
refunded as cash. PG-verified: partial 25, final 25, discrepancy 10 x2,
refunded=40=captured, restored=50 full.

## Refund allocation wired (`4eedf3b`)

apply_job_refund now separates provider_confirmed_minor (verbatim) /
external_minor (allocated vs captured) / discrepancy_minor (for review).
Wired into /refund on all three confirmed paths (executed replay,
unknown->executed reconcile, fresh create) — provider_confirmed amount +
refund id; pending/failed restore nothing. Spec 3/3 asserts provider
ref+amount args, no pending-restore, no duplicate Stripe call on replay.

## Webhook + cancellation + rounding (`d42895e`)

- charge.refund.updated wired: succeeded->apply_job_refund (ref+amount,
  service scaled); pending/failed->nothing; currency mismatch->skipped.
  Spec 5/5 real webhook router.
- Cancel releases spend exactly once (2nd release NULL); external_due=0
  refunds {0,0} no div-by-zero; cumulative 3+3+3 small -> final absorbs
  remainder -> 30 total once; refunded==captured.

**Open:** admin publish/margin-preview Angular UI; batch1d manifest.

## Shared refund handler + credit-only path (`16ae589`, `fb346ee`)

- applyConfirmedRefund shared: charge.refund.updated + refund.created/
  refund.updated; succeeded-only; currency binding; provider_ref dedupes
  cross-event duplicates. Spec 11/11.
- /refund credit-only: completed fully-funded (external_due=0, no PI)
  restores credit via apply_job_refund external=0, once-only ref key —
  no Stripe call; distinct from pre-service cancel release. Spec asserts
  zero Stripe calls.
- reward_credit_available counts un-restored remainder: restored value
  re-spendable; expiry enforced at apply (verified 30/50 back).

## Admin UI + batch1d manifest reconcile (`f10f5c2`, pending)

- Admin `/policies` UI: publish form + validation + version list + audit
  history + margin preview (server-derived). ng build admin passes —
  also fixed pre-existing shared-ui breaks (api-url import path,
  auth.currentSession -> session()).
- batch1d RESOLVED: the drift was real leftover overloads, not fixture
  noise — `finalize_wallet_topup_legacy_incompatible` held service
  EXECUTE (manifest: false -> revoked); `reserve_errand_funds
  (uuid,uuid,numeric)` 3-arg was a dead superseded overload (dropped —
  no server callers); auth.* RPCs present via batch1d fixture file.
  Fresh movabi_develop: batch1d now applies clean end-to-end.
- Remaining develop checks: concurrent-cash smoke on migrated develop,
  real Stripe webhook replay, on-device inspection upload, restore
  drill, admin smoke — all in scripts/verify-develop-integration.sh.

## Completion matrix — payment integration (HEAD `f10f5c2`)

| Layer | Evidence |
|---|---|
| Atomic credit reservation at booking insert | `reserve_job_reward_credit` trigger; bad credit -> orphan_jobs=0 (PG) |
| Payable derivation | `job_remaining_payable_minor` -> persisted `job_funding_breakdown`; lifecycle-stable (40 stays 40 after settle) |
| PI amount wire | `/create-intent` uses external_due_minor; zero-payable -> `secure_zero_payable_funding` (atomic, concurrency-proven) |
| Funding validation | reserved spends + in-scope unexpired credits + campaign app + tenant/account binding — record-level, not arithmetic |
| Refund allocation | `apply_job_refund` v2: confirmed/allocated/discrepancy split; proportional credit restore; final absorbs remainder once |
| Webhook | `charge.refund.updated` + `refund.created/updated` shared handler; succeeded-only; account+currency binding; replay-safe |
| Credit-only refund | `/refund` no-PI path for completed fully-funded jobs; no Stripe call; once-only |
| Route specs | payment-intent-funding 5/5, refund-allocation 3/3, webhook-refund 5/5, cash-operator 8/8, receivables 10/10 — 36/36 suite |
| Admin UI | `/admin/policies` publish+preview+versions+audit; ng build admin passes |
| batch1d | RESOLVED — leftover overloads reconciled to manifest; fresh chain applies clean |

**Develop-only remaining:** concurrent-cash smoke on migrated develop, real
Stripe webhook replay, on-device inspection upload, restore drill, admin
smoke — scripts/verify-develop-integration.sh.

## Four-state matrix (candidate `ddf441e`)

| Area | Implemented | Locally verified | Develop-verified | Activation-configured |
|---|---|---|---|---|
| Cash credit lifecycle | yes | yes (PG chain) | pending develop smoke | no (pilot disabled) |
| Commercial policies v2 | yes | yes (PG + specs) | no | no — caps/fares/budgets unset |
| Reward-credit spend | yes | yes (PG + route) | no | no |
| Funding breakdown + payable | yes | yes | no | n/a (internal) |
| Refund allocation/webhook | yes | yes (spec 11/11) | pending replay | n/a |
| Admin policy UI | yes | yes (ng build admin) | pending smoke | no |
| batch1d manifest | resolved | yes (fresh chain) | pending develop | n/a |

**Activation inputs still needed (config only):** per-market monetary caps,
minimum qualifying fares, funded campaign budgets, overdue debt terms,
cash-pilot approval. Percentages are fixed (5/5/5/80) — the missing values
are monetary, not rates.

## BIKE vs CAR/VAN scope (authorised, pending implementation)

Extend requiredVehicleClass (booking.routes.ts:866 — already returns bike/car/small_van). Server-side bike-only matching across listing/dispatch/accept/reassign/admin-assign using the driver approved vehicle. Category preserved through quote/snapshot; requote on change; no guessing for ambiguous history. UI: Bike/Car/Small Van + bike icon + config parcel limits + explicit no-courier. Onboarding: category checklist, drop car-only reqs for pedal bikes, bike-appropriate inspection, category change recalculates+approval. Clarify pedal/e-bike/motorcycle separately — no blanket waiver. Tests: car driver cannot reach bike jobs via API/RPC. No deploy/activation/Africa.

## Bike vs Car/Van — implementation + completion matrix (`53e690f`)

### Implemented (code)
- Canonical `matchesVehicleCapacity` is strict for bike-required goods jobs (Car/Van cannot match).
- `goodsVehicleMatches` (dispatch) uses the same strict check.
- Acceptance route retains server-side `requiredVehicleClass(job)` + `getDriverVehicle(driverId)` guard.
- New spec `bike-category-isolation.spec.ts` proves Car/Van cannot acquire Bike jobs, unchanged Car/Van flows.

### Completion matrix

| Area | Item | Status | Evidence / Notes |
|---|---|---|---|
| Verification | Wallet/settlement harness repair | **open** | Pre-existing vm-loader/process and customer-wallet-sandbox dependency defects; no weakening allowed. |
| Verification | Full server typecheck (supported tsconfig) | **open** | `tsconfig.json` covers app; `tsconfig.server.json` missing for dedicated server check. |
| Verification | Pre-release DB snapshot upgrade | **open** | Reapplication to current schema only; real pre-release snapshot upgrade pending. |
| Verification | Customer/mobile + driver + admin builds | open | `ng build mobile`/`admin` pending rerun on `53e690f`; `goods-vehicle-capacity` + `bike-category-isolation` specs pass. |
| Bike | Server-side bike-only eligibility | **implemented locally** | `matchesVehicleCapacity` + `goodsVehicleMatches` + `requiredVehicleClass` + acceptance guard + `bike-category-isolation.spec.ts`. |
| Bike | Persist fulfilment category/subtype | pending | Need `jobs.fulfilment_category`/`fulfilment_subtype` and `vehicles.vehicle_subtype` columns; no guessing for ambiguous history. |
| Bike | Customer UI category/parcel limits/no-courier | pending | Bike icon, parcel limit display, disabled options, specific no-bike-courier message. |
| Bike | Subtype-aware onboarding (pedal/e-bike/motorcycle) | pending | Requirements recalc on category change; retain motor-vehicle docs for motorised. |
| Bike | Cross-market/tenant isolation + Car/Van regression tests | partial | `bike-category-isolation.spec.ts` covers canonical utility; full route/RPC tests still needed. |

No deployment, activation, packaging or Africa provider work.

## Bike progress update (`dd4b38e`)

### Implemented
- Migration `20261257000000_bike_fulfilment_category.sql`: jobs.fulfilment_category/subtype/bike_parcel_max_kg/cm; vehicles.vehicle_subtype (creates vehicles if missing).
- `requiredVehicleClass` and `goodsVehicleMatches` trust persisted `fulfilment_category` before metadata; strict bike-only matching.
- `bikeSubtypeCompatible` blocks mismatched pedal/e-bike/motorcycle/moped subtypes in accept.
- Create route validates and allow-lists fulfilment fields.
- `VehicleCompatibilityService` reads `fulfilment_category`.
- Specs: `goods-vehicle-capacity` 22 pass; `bike-category-isolation` 9 pass (31 total).
- `ng build mobile` passes (budget warning only).

### Still open
- Customer UI: recognisable bike icon, parcel-limit display, no-bike-courier message.
- Subtype-specific onboarding (pedal/e-bike/motorcycle/moped) with approval reset.
- Full API/database route integration tests with real auth/DB (currently static + utility).
- Verification blockers: wallet/settlement harness, full server typecheck, pre-release DB snapshot upgrade.

No deployment, activation, packaging, Africa.

## Bike progress update (`b1a301c`)

### Implemented
- Migration uses canonical schema only: no fallback vehicles table; adds jobs.fulfilment_category/subtype and vehicles.vehicle_subtype if canonical table exists.
- Removed customer-set parcel limit columns from jobs; market-config derivation to be added via market_bike_limits.
- Customer booking UI: bike icon is now `bicycle-outline`; create payload sends top-level `fulfilment_category` from selected vehicle class.
- Server create route allow-lists and validates `fulfilment_category`/`fulfilment_subtype`.
- `ng build mobile` passes; `goods-vehicle-capacity` + `bike-category-isolation` specs 31/31.

### Still open
- Parcel limits: create `market_bike_limits` table; derive from market config; display in UI; validate on server.
- Quote-level category/subtype freeze and requote-on-change validation.
- Real authenticated API/database assignment tests (direct RPC, reassignment, admin assignment).
- Subtype-specific onboarding with approval reset for pedal/e-bike/motorcycle/moped.
- Verification blockers unchanged.

No deployment, activation, packaging, Africa.

## Bike progress update (`5c9bd91`)

### Implemented
- Additive migration `20261259000000_market_bike_limits.sql`: market_availability.bike_limits, jobs.fulfilment_snapshot, quote_market_adjustments.fulfilment_snapshot (conditional).
- `goodsVehicleMatches` is now snapshot-aware: frozen category/subtype/allowed_subtypes/parcel limits from job.fulfilment_snapshot; falls back to persisted/metadata only when snapshot is absent.
- Missing bike_limits fails closed (no match).
- goods-vehicle-capacity + bike-category-isolation specs 31/31.

### Still open
- Create route must build fulfilment_snapshot from quote/market and reject mismatches.
- Market bike limits lookup and server-side parcel validation at create.
- Customer UI parcel-limit display, disabled package sizes, bike-unavailable messaging.
- Database-level assignment guard (accept/RPC/reassignment/admin).
- Real authenticated API/PostgreSQL tests.
- Subtype onboarding with approval reset.
- Verification blockers.

No deployment, activation, packaging, Africa.

## Bike progress update (`6b4bf9a`)

### Implemented
- Quote-time `fulfilment_snapshot` created in market-pricing.service.ts from `market_availability.bike_limits` and package size; stored in `quote_market_adjustments`.
- Booking-create validates and copies the frozen quote snapshot into `jobs.fulfilment_snapshot`; rejects mismatches/unsupported category/missing limits.
- `goodsVehicleMatches` dispatches/accepts using the frozen snapshot.
- `goods-vehicle-capacity` + `bike-category-isolation` specs 31/31.

### Still open
- Customer UI limits/messages and package-size disabling.
- Database assignment guard (trigger/RPC) for accept/reassignment/admin.
- Real authenticated API/PostgreSQL integration tests.
- Subtype-specific onboarding with approval reset.
- Verification blockers.

No deployment, activation, packaging, Africa.

## Bike completion matrix (`fdf912c`)

| Item | State | Evidence |
|---|---|---|
| Persisted fulfilment category/subtype through quote, booking and fare snapshot | implemented | `market-pricing.service.ts` builds `fulfilment_snapshot`; `quote_market_adjustments.fulfilment_snapshot`; `booking.routes.ts` validates and copies snapshot |
| Bike-only assignment guard (INSERT/accept/RPC/reassign/admin, `driver_id` + `accepted_driver_id`) | implemented + PG tested | `20261260000000_bike_assignment_trigger.sql`; `src/testing/bike-assignment-trigger-pg.spec.ts` 11 cases pass on `vaydu-pg-fresh` |
| Quote response exposes frozen snapshot | implemented | `global-ai-pricing.service.ts` + `global-ai-pricing.routes.ts`; `GlobalAiPricingQuoteResponse.fulfilmentSnapshot` |
| Customer UI: bike icon, configured parcel limits, disabled incompatible package sizes, bike-unavailable messages; customer can recover to smaller parcel and requote | implemented | `booking-request.page.ts` `bicycle-outline`, `bikeLimitText()`, `packageSizeDisabled()`, `bikeUnavailableMessage()`; `ng build mobile` passes |
| Server-side validation of quote/booking mismatch and missing bike limits | implemented | `market-pricing.service.ts` `bike_available`/`reason`; `booking.routes.ts` `BIKE_UNAVAILABLE` |
| Static/utility Bike tests + real PG trigger spec | passing | `npx vitest run src/testing/goods-vehicle-capacity.spec.ts src/testing/bike-category-isolation.spec.ts src/testing/bike-assignment-trigger-pg.spec.ts` — 32/32 |
| Subtype-specific onboarding (pedal/e-bike/motorcycle/moped), admin-owned classification and server-approved inspection | implemented | `db24645`: subtype select, e-bike specs, declarations, inspection slots, approval reset; `bike_inspection_approved` from inspection-photo status; `e_bike_market_class` admin-owned |
| Authenticated HTTP route integration tests (quote/create, discovery/accept, reassign, admin) | pending | real PG trigger spec covers DB enforcement; HTTP/auth fixture still needed for full route specs |
| Wallet/settlement harness repair, full server typecheck, representative DB upgrade test | pending | verification blockers retained |

No deployment, activation, packaging, Africa.

## Cancellation compensation — accounting + application integration

- `d5f1c35` recorded: **compensation accounting implemented** (the 80/20 split RPC);
  application integration was pending.
- This increment finishes it end-to-end:
  - `20261264000000_cancellation_compensation.sql` + `20261264100000_cancellation_compensation_earnings.sql`
    (canonical, git-tracked, and exercised by the disposable-PG suite — not only a
    copied `scripts/.../migration.sql`).
  - `20261264100000` redirects compensation into canonical `driver_earnings`
    (`settlement_purpose='cancellation_compensation'`, payable `pending`), not a new
    `wallet_accounts.balance_purpose` that payout/reporting ignores. The receivable
    freezes `driver_id`/`market_code`/`policy_version` at record time; settlement
    resolves ONLY the frozen version and routes a missing version to `review_required`
    (never re-prices on today's active policy). Collection and refund are cumulative
    and bounded (over-collection/over-refund rejected); events dedupe by
    `(provider, provider_reference)` and refunds carry `linked_event_id`.
  - `server/routes/stripe-webhook.routes.ts`: confirmed `debt_repayment` collection →
    `settle_cancellation_compensation`; confirmed refund → `reverse_cancellation_compensation`.
  - Tests: disposable-PG (`pwsh scripts/cancellation-compensation/run-postgres-tests.ps1`,
    8 cases) + webhook route spec `src/testing/cancellation-compensation-webhook.spec.ts` (6 cases)
    + `src/testing/manifest-drift.spec.ts` (release ORDER/SHA256SUMS drift guard, 2 cases).
  - Release manifest updated: `deploy/vaydu-develop-validation/{ORDER.txt,SHA256SUMS,UPGRADE_MANIFEST.md}`.
No deployment, activation, provider switching or Africa work.

## Cancellation compensation — acceptance (`886ebf1` → this increment)

- `20261264200000_cancellation_compensation_acceptance.sql`:
  - Webhook settlement is now the single idempotent authority; the webhook returns
    500 on settle failure (never acknowledges a failed settlement) so Stripe
    re-delivers and the atomic RPC completes it.
  - Dedupe is bound to `(provider, merchant_account_ref, test/live environment,
    provider_reference)`, not reference alone.
  - Refund after payout preserves paid `driver_earnings` history and records a
    linked `recovery_required` adjustment instead of editing/deleting paid earnings.
  - `minor_to_major` is exponent-aware (0/2/3-decimal); `driver_earnings` money
    columns widen to `numeric(18,4)`.
- Evidence (labelled separately):
  - **Direct-PG** (`pwsh scripts/cancellation-compensation/run-postgres-tests.ps1`,
    14 cases): collected/duplicate/unpaid/review/over-collection/refund/partial/
    dedupe-binding/atomic-retry/refund-after-payout/0-2-3-decimal/payout-query/grants.
  - **Mocked-webhook** (`npx vitest run src/testing/cancellation-compensation-webhook.spec.ts`,
    7 cases): collection wiring, duplicate re-delivery, 500-on-failure, review,
    refund wiring, failed/non-debt refund ignored.
  - **Upgraded-clone rehearsal** (`npx vitest run src/testing/bike-authenticated-routes.integration.spec.ts`)
    passed with migrations 640/641/642 applied to the disposable baseline.
No deployment, activation, provider switching or Africa work.

## Campaign admin controls — promotions / referrals / driver bonuses

- `20261264300000_campaign_admin_controls.sql`: campaigns gain `paused` (tri-state
  enabled/paused/disabled), `version` + `published_at`/`published_by` (audit trail),
  `referral_reward_bps` (default 500 = 5%) and optional `usage_limit`.
  `apply_campaign_discount` rejects paused + enforces the global usage limit while
  preserving the 202612633 replay-order fix (idempotent replay before cap);
  `earn_referral` rejects paused and uses the campaign referral rate.
  Pausing only blocks NEW applications — accepted discounts, spent budget and
  earned/pending rewards are never erased (no cascade delete).
- `server/routes/admin.routes.ts`: `POST /campaigns` now validates server-side
  (kind/audience/funder/value_type/value/percent≤100/dates/currency/caps/bps) and
  defaults a customer discount to 5% and referral to 500 bps; `POST /campaigns/:id/status`
  accepts `enabled|paused|disabled` with version bump + audit; `GET /campaigns`
  returns qualification rules. Margin preview unchanged (`preview_vaydu_margin`).
- Tests: `src/testing/campaign-admin-controls.spec.ts` (7 cases: defaults, validation,
  tri-state lifecycle, pause-preserves-obligations, invalid state, non-admin 403)
  + `manifest-drift.spec.ts` (2) + full rehearsal re-run green.
No deployment or automatic campaign activation; Africa deferred.

## Campaign admin UI + acceptance

- `20261264400000_campaign_referral_snapshot.sql`: `earn_referral` reads the frozen
  `referrals.reward_rate_bps` snapshot (fallback 500), so an admin rate edit never
  re-prices an existing referral. `booking.routes.ts` `/referrals/redeem` now freezes
  `reward_rate_bps = campaign.referral_reward_bps` at link time and rejects `paused`.
- `server/routes/admin.routes.ts`: tenant-scoped admins are pinned to their own
  `profiles.tenant_id` (global admins unscoped) for list/create/edit/status;
  `POST /campaigns/:id` edits config as a new `version`; `GET /campaigns/audit`.
- Admin UI: `admin-campaigns.component.ts` (create/edit with 5% + 500bps defaults,
  tri-state lifecycle, qualification/caps/budget, margin preview, validation/errors,
  version + audit) wired at `/campaigns`; `AdminService` campaign methods.
- Verified: component spec (5), referral acceptance (3), campaign-admin-controls (9),
  admin-cash-operator (8), manifest-drift (2), cancellation/debt webhook specs, and
  `ng build admin` passes; full upgraded-clone rehearsal green (migrations 640–644).
No deployment, automatic activation or Africa work.

## Referral lifecycle verification (real PostgreSQL)

- `20261264500000_referral_lifecycle_pause.sql`: removes the blanket
  `enabled OR paused` gate from `earn_referral`. Pausing stops NEW links
  (redeem checks enabled+paused); an existing referral keeps its frozen rate
  and still earns when the referee completes a qualifying paid job. A disabled
  campaign still blocks via the atomic budget guard.
- `scripts/referral-lifecycle/` disposable-PG suite (applies the canonical 645)
  proves persisted accounting: customer 5% of first qualifying completed/paid
  fare, frozen rate survives an admin rate edit, pause does not block existing
  earning, driver 5% cumulative across 20 jobs/30d with 7-day review, monthly
  cap, atomic budget, replay idempotence, 90-day non-withdrawable credit expiry.
- `/campaigns/audit` now enforces tenant scope (metadata->>tenant_id); campaign
  edit/status audit records carry `tenant_id`. Margin preview is a pure RPC
  pass-through (no tenant data).
- Full upgraded-clone rehearsal green (migrations 640–645).
No deployment, automatic activation, archive rebuild or Africa work.

## Referral lifecycle — obligations, release/reverse, boundaries

- `20261264600000_referral_reversal.sql`: `campaign_spend` drops the `enabled`
  gate (gating is the caller's job), so an accepted referral still earns after
  the campaign is DISABLED; new links stay rejected at redeem. Adds
  `reverse_referral_reward` — atomically reverses a referral + its linked
  reward credit(s), idempotent, preserving historical spending and never
  creating extra credit.
- `scripts/referral-lifecycle` (13 cases, real PG, applies 645+646):
  disabled-preserves-obligation, customer reversal + credit `reversed` +
  spendable=0 + idempotent, already-used credit history preserved, driver
  release blocked before 7 days then releases/reverses, job-21 no second
  reward, 30-day-window rejection, plus the earlier 5%/frozen-rate/pause/
  20-job/7-day/monthly-cap/budget/replay cases.
- Full upgraded-clone rehearsal green (migrations 640–646).
No deployment, automatic activation, archive rebuild or Africa work.

## Referral integration points — caller/access + adjudication

- Caller: `earn_referral` is invoked by `LogisticsService.completeJob` after a
  completed+paid job via `supabaseAdmin.rpc` (service_role), swallowing per-
  referral errors so earning never breaks completion. All referral RPCs
  (`earn_referral`, `reverse_referral_reward`, `release_referral_rewards`,
  `campaign_spend`, `referral_monthly_count`) are service_role-only
  (anon/authenticated denied) — regression-asserted in the PG suite.
- Adjudication: `POST /referrals/:id/adjudicate` now delegates `reversed` to
  `reverse_referral_reward` (referral + linked credit atomic), not a bare
  status write; `20261264700000` adds the non-reversible guard
  (rejected/reversed terminal for reversal). Release/reject keep the guarded
  status write.
- Tests: referral-lifecycle PG 14/14 (adds caller/access audit), new
  `referral-adjudication.spec.ts` 3/3, manifest-drift 2/2; full rehearsal
  green (640–647).
No deployment, automatic activation, archive rebuild or Africa work.

## Driver ranking — real-PG verification

- `scripts/driver-ranking/` disposable-PG suite applies the canonical
  `driver_ranking_scores_v23` RPC and seeds rating histories: 100×5.0 (strong),
  100×3.0 (weak), 1×5.0 (insufficient), 0 (new driver), invalid-only (excluded:
  non-completed, self-rating, out-of-range, non-integer, mismatched customer),
  and 105 (latest-100 window). Asserts exact persisted avg/count + the agreed
  ordering `strong > single-review > new-driver-prior > weak` and new-driver
  treatment (absent → prior 4.5). Road-ETA ordering covered by
  `maps-provider-v23.spec.ts`.
- Fixed a demonstrated test-fixture defect: `driver-ranking-v23.spec.ts`
  dispatch fixture lacked `registration_country_code`/`tenant_id`, so
  `driverMatchesJobMarket` excluded every candidate (3 failing tests); now
  37/37 + maps 38/38 = 75/75.
No deployment, automatic activation, archive rebuild or Africa work.

## Driver ranking — actual-function wiring + implementation gap

- `scripts/driver-ranking/postgres-tests.cjs` now feeds the real
  `driver_ranking_scores_v23` rows into the ACTUAL `rankEligibleDrivers` +
  `confidenceAdjustedRating` (required from `server/services/driver-ranking.ts`
  via Node's native TS) — no formula reimplementation. Asserts ordering
  strong > single-review > new-driver-prior > weak, the confidence tie-break
  (100 reviews beats 1 review at equal raw 5.0), distance-dominance, and the
  new-driver 4.5 prior. ETA ordering is covered by `maps-provider-v23.spec.ts`.
- Implementation gap (recorded, not fixed): production ordering is distance +
  review-rating only. Acceptance/cancellation reliability are computed
  (`driver-offer-metrics.service.ts` acceptanceRate/cancellationRate;
  `logistics.service.ts` persists cancellation_rate) and `SmartMatchingSettings`
  exposes rating/completion/distance/response/acceptance/cancellation weights
  (acceptance/cancellation default 0.0), but NONE are consumed by
  `rankEligibleDrivers`. There is no fair new-driver exposure beyond the
  neutral Bayesian prior (4.5) — no boost/rotation/exploration.
No deployment, automatic activation, archive rebuild or Africa work.

## Driver ranking — reliability + new-driver exposure wired

- `rankEligibleDrivers` now takes optional reliability + weights (backward
  compatible). Scoring: `priority = distance_km + ratingOffset + newDriverOffset
  + acceptanceOffset + cancellationOffset`, then distance, recency (≤30s), id.
  `ratingOffset = (5 − confidenceAdjustedRating) × 0.15` (Bayesian 4.5/20 prior,
  insufficient → 4.5); `acceptanceOffset = acceptanceRateWeight × (1 −
  acceptanceRate) × 1.0` (null → 0); `cancellationOffset = cancellationRateWeight
  × cancellationRate × 1.0` (null → 0); `newDriverOffset = −min(newDriverExposureKm,
  0.15)` for drivers with no review score. Zero weights / null rates reproduce
  the old order; `orderDriversByRoadEta` still applies last (preserves order
  within an ETA minute). Gates (vehicle/market/approval/availability) run before.
- `dispatch.service.ts` reads `getSmartMatchingSettings` and reuses
  `reportDriverOfferMetrics` only when an acceptance/cancellation weight is
  non-zero (zero weights skip the reads). `SmartMatchingSettings` gains
  `newDriverExposureKm` (default 0.0).
- Tests: `driver-ranking-v23.spec.ts` 43 (zero-weights preserve, acceptance/
  cancellation reorder, insufficient neutral, new-driver exposure, ineligible
  excluded) + `maps-provider-v23.spec.ts` 38 = 81/81; real-PG ranking suite
  still green.
No deployment, automatic configuration activation, archive rebuild or Africa work.

## Suspension / session revocation (protected HTTP path)

- New `src/testing/suspension-session-revocation.spec.ts` exercises the REAL
  `requireAuthenticatedUser` middleware through `GET /debts`: the same Bearer
  token succeeds while `account_status='active'`, then returns 403
  `ACCOUNT_SUSPENDED` after the status flips to `suspended`; a different active
  user's token is unaffected; an invalid token is 401. No implementation
  defect found — the existing per-call status check + admin `ban_duration`
  revocation work as designed.
No deployment, activation, archive rebuild or Africa work.

## Suspension / session revocation — real GoTrue fixture

- The disposable GoTrue integration test (`bike-authenticated-routes.integration.spec.ts`)
  now signs up two synthetic users, suspends one through the REAL admin
  `/api/admin/account-status` endpoint, and asserts over HTTP: the same access
  token is denied (403) after suspension, the suspended refresh token cannot
  refresh (≥400), and the other user still accesses + refreshes (200).
- Demonstrated defects fixed: (1) `profiles.moderated_by` was missing
  (`20261264800000`), (2) `protect_driver_operating_market_v23` was SECURITY
  INVOKER and its `auth.role()` call failed as service_role
  (`20261264900000` makes it SECURITY DEFINER). The disposable test's network
  cleanup also force-removes the network (previously leaked).
No deployment, activation, archive rebuild or Africa work.

## Traffic route behaviour

- New `src/testing/traffic-route.spec.ts` exercises the real `GET /:jobId/traffic`
  route: green/amber/red thresholds, an `observedAt` ISO timestamp on every
  response, explicit `unavailable` state on absent congestion data and on
  provider failure, and three consecutive refreshes leave the frozen
  `agreed_fare`/`price` unchanged with zero `jobs` writes (no duplicate delay
  charge). No defect found; the route is read-only.
No deployment, activation, archive rebuild or Africa work.
