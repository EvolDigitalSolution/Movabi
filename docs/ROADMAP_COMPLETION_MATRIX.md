# Vaydu go-live roadmap — completion matrix

Single source of truth for the nine mandatory roadmap areas. Supersedes the status tables in
`LAUNCH-ROADMAP-HANDOFF.md` and `BIKE_COMPLETION_MATRIX.md` (kept as history). Update this file in
the same commit as any change that moves a state. Last updated 2026-11-14.

**Go-live gate:** no release packaging or go-live until every mandatory, non-deferred row is
Implemented, Integrated and Verified and every decision below is resolved. Not met.

## States

| State | Meaning (all must hold) |
|---|---|
| **Implemented** | Code/migration for the agreed behaviour exists: server + DB + every needed UI. |
| **Integrated** | In the release line (`release/topup-3ds-on-2385da7`) and wired into the real user journey, not only a helper. |
| **Verified** | Re-run **this session** by a real-DB, real-browser or real-route test at the cited commit. `prior` = only an earlier record claims it (to re-run; not proof). |
| **Deployed** | On shared develop (API/web image *and* DB objects). Observed, not assumed. |
| **Enabled** | Switched on for the approved develop test scope only. Never global, never production. |

`✓` yes · `✗` no · `~` partial · `?` cannot be established without develop host access · `n/a`.
Provider evidence is labelled **mock** (simulated provider) or **sandbox** (real provider test mode).

## Baseline and deployment source

| Item | Finding | How established |
|---|---|---|
| Release line | `release/topup-3ds-on-2385da7`, worktree `Movabi-topup-on-2385da7`. | `git worktree list` |
| Roadmap code | v2.3 roadmap content is in the release line (squash-merged; v2.3 commits are not ancestors). | presence of every roadmap migration/service/spec at HEAD |
| Develop web | **`3c91991`** since 2026-11-13 ~11:15 UTC (12/12 entry assets and index.html byte-identical to `release/vaydu-develop-3c91991-release-linux`). Before that, f6e8c00. | sha256 of live assets |
| Develop API | **`3c91991`** since 2026-11-13 11:12:41 UTC (`movabi-api:release-3c91991`; rollback image f6e8c00 recorded in ``). Stripe test mode; flags unchanged. Payment-account setup integration: unavailable (module not shipped, as on f6e8c00; NG providers deferred). | host output |
| Develop DB | PostgreSQL 15.1, 28 MB, 80 jobs, no migration-tracking table. Live public schema (138 tables, 261 functions) versioned as `supabase/baseline/develop_live_public_schema_20261112.sql`; its function fingerprints reproduce the host's exactly. Applied: the rehearsal chain up to `20261264900000` plus `20261265*` (42 migrations). **Pending: 7** (`20261266000000`–`20261266300000`, `20261267`, `20261268`, `20261269`). Develop-only drift (untouched, unused by the code): `driver_vehicle_inspection_photos.reason` and a 6-argument `register_driver_inspection_photo`. | `scripts/release/reconcile-live-schema.sh` + `classify-live.cjs` |
| Other line | `origin/develop` (`e596989`) has 33 commits not in the release line (separate top-up `recover()` work, admin market badges). Must be reconciled before go-live. | `git rev-list` |

### Deployment source: `635a285`, not the current branch tip

The intended develop deployment source is **`635a285`**, packaged as
`release/vaydu-develop-635a285-topup-linux.tar.gz` (sha256 `cbd60346fbc52db7ac99fd56c2f8226c7249185dfa204456cbb8862a7f8e14a6`,
`SOURCE_SHA` 635a285). Commits after it are **verification, evidence and runbook changes only**. None
of their files is in the package (each path checked against the extracted bundle: no overlap). The
package therefore contains **none** of the verification changes below; it contains the same API/web
code those verifications exercise.

| Commit | Change | In the 635a285 package? |
|---|---|---|
| `2217bd2` | Matrix created; top-up DB integration mock moved to PaymentIntents; `test-driver-topup-db.ps1` PS 5.1 fix; versioned 2 older migrations (`20261246000000`, `20261254000000`) + 3 SQL check fixtures that existed only as ignored files; `scripts/cash-ride/run-realdb-tests.sh` | No |
| `9e28620` | Matrix: rehearsal failure recorded | No |
| `c9d10a1` | `DEVELOP-DEPLOY-635a285.md` runbook; `NEXT-STEPS.txt` versioned with a superseded note | No |
| `18aaf2b` | Rehearsal harness: test-server keep-alive; extracted-API root no longer the untracked old 9abfd8f extract | No |
| `a421583` | Rehearsal: API started with the image entry (`--project server/tsconfig.json`); startup-mode label | No |
| `b56d808` | Matrix rewrite + rehearsal evidence logs | No |
| `0965669` | D9 driver cancellation attribution + metrics v2 (migration, route, services, tests) | No — **not** in 635a285; needs its own release |
| `7320c62`, `23cb912` | Matrix: commit reference; handoff decision recorded | No |
| `bcd6ab9` | D9 completion: assignment identity, exclusions, negotiated assignments, admin/driver reporting, rehearsal + extracted-bundle checks | No — **not** in 635a285 |
| `7162d04` | Matrix: D9 completion evidence; area-6 finding | No |
| `cc3b909` | Area 6: cancellation fee quote (migration 20261268000000), route/preview/admin fixes, tests, rehearsal | No — **not** in 635a285 |
| `87ed19b` | Matrix: area 6a evidence; 6b gap | No |
| `46eafb8` | 6b: captured cancellation fee booked as a collection (receivable + driver compensation), route + webhook, retry fix, tests | No — **not** in 635a285 |
| `29c4a75`, `6067f30` | 6b cash rides + matrix (conflict found) | No |
| `fbab3fb` | Merge migration 20261269000000 (cash pilot + roadmap cash), restored disabled gate, rehearsal with both chains, fixture fix | No — **not** in 635a285 |
| `54d182e` | Matrix: 6b evidence | No |
| `29c4a75` | 6b cash rides: fee from the ride hold booked as a collection; migration conflict found | No — **not** in 635a285 |

The two migrations versioned in `2217bd2` are older wallet migrations used by the disposable top-up
test. They are not deployment content, and the runbook does not apply them.

### Develop deployment authorisation (explicit, scoped)

- **Authorised:** on 2026-11-12, I asked "Do you authorise deploying 635a285 and its 4 migrations to
  shared develop, with GB cash rides staying off?" and the user replied **"Authorise, prepare steps"**.
  The scope is the API/web `635a285` package plus cash-ride migrations `20261266000000`–`20261266300000`,
  with no market enabled and no `VAYDU_CASH_RIDE_BOOKING`. Runbook:
  `deploy/vaydu-topup-verify-fix/DEVELOP-DEPLOY-635a285.md`.
- **Status: pending.** The user said they would run it, but no host output has been received and develop
  web still serves f6e8c00 (09:45 UTC). The agent has no host access and has not deployed anything.
- **Not authorised:** enabling GB/GBP (or any) cash rides, the API cash flag, other markets/cohorts,
  production, packaging for go-live.

### Develop release `3c91991`: DEPLOYED to develop 2026-11-13 (acceptance journeys in progress)

The user authorised deploying the completed, integrated roadmap changes to shared develop, and enabling
features whose approved policies and prerequisites are met. Production and go-live stay gated.
The earlier 635a285 plan is **superseded**: it never ran (develop is still f6e8c00), and this release
contains its content.

| Item | State |
|---|---|
| Package | `release/vaydu-develop-3c91991-release-linux.tar.gz` (sha256 `e398335d55c0400ff6b165b520ff7fe4b770aeb8cf42d894468f1831c0824caa`). API source `3c91991` (shipped API files identical to `26863d7`); web built on Linux (`node:22-alpine`, `npm ci --legacy-peer-deps`) at `d472487` from identical web inputs. |
| Runbook | `deploy/vaydu-develop-release/RUNBOOK.md`: upload, verify, predeploy, backup, restore drill, gate + dry run, migrate, API, web, checks, recovery. |
| vs running API | exactly the 29 files of `git diff f6e8c00 3c91991`; no unexpected host change (`release/expected-api-changes-3c91991.txt`) |
| vs running web | 97 of 368 files (48 renamed bundles + `index.html`; `release/expected-web-changes-3c91991.txt`) |
| Database | `release-up.sql`: the 7 pending migrations as ONE transaction (generated; asserted outer BEGIN/COMMIT removal). `release-down.sql`: their rollbacks, then develop's exact pre-release bodies of the 4 replaced functions (the older cash rollbacks restored pre-roadmap bodies, which would have dropped the cash-custody exemption and hold-reopen guard). `release-dryrun.sql` ends in ROLLBACK. `PREREQ.sql` / `VERIFY.sql` gates. |
| Batch 1E | `20261248000000` versioned as already-applied history. It is a no-op on the 10 Nov baseline; on live its own guard refuses it (its tables were extended later). Never applied. |
| Live-schema rehearsal | `bash scripts/release/rehearse-live-upgrade.sh .tmp-release/live_public_schema.sql <reconcile-dir>` on postgres:15.1: **26/26** (`docs/roadmap-evidence/rehearse-live-3c91991.log`) |
| Route rehearsal on live + release | current source: pass; **running f6e8c00 API** as a separate process: pass (migration-first is safe). Env: `VAYDU_REHEARSAL_SCHEMA/PG_IMAGE/CHAIN/SEED` (+ `VAYDU_EXTRACTED_API_ROOT`). |
| Full unit/route suite at the release source | **3,473 passed, 1 failed; 2 files fail** (`docs/roadmap-evidence/full-suite-failures-release-3c91991.txt`). Both are environment items, not code. `bike-assignment-trigger-pg` needs local container `vaydu-pg-fresh`; its bike-only guards are exercised by the route rehearsal on live + release, which passed. `wallet-minimal-overlay` checks a one-off October patch script that is not in the repository. Fixed since the triage: lineage (batch 1E versioned), manifest drift (guards the release SQL) and the 17 payout tests (now run on the shipped worker). |
| Real-data rehearsal | **PASSED before migration** ([host record](roadmap-evidence/develop-release-3c91991-host.md)). Backup restored (0 errors, 181 tables equal); PREREQ, release, VERIFY and exact rollback passed on real data. The first drill and the first 4b run failed on fixture collisions with real data (auth trigger, market rows, service-type slugs). After the fix, the 4b rerun passed all 7 suites (140 checks). Backup restore drill (9b): **done**. |
| Deployed | **Yes, 2026-11-13.** Database 09:46:47 UTC; API `movabi-api:release-3c91991` 11:12:41 UTC (0 restarts, 0 errors, /health 200); web `movabi-web:release-3c91991-linux` about 11:15 UTC (live assets = bundle). [Host record](roadmap-evidence/develop-release-3c91991-host.md). Still off: 0 cash markets, 0 fee policies, no cash flag. |
| Post-deploy defects (2026-11-13) | (1) **PostgREST schema cache not reloaded after the migration.** New RPCs fail with "not in the schema cache": seen for `driver_offer_metrics_v2`, and cancellations through `cancel_job_with_actor` are affected the same way. Fix on develop: `NOTIFY pgrst, 'reload schema'` (runbook 6b), **pending host execution**. Prevention (`4cc9d03`): `release-up.sql`/`release-down.sql` now end with that NOTIFY, delivered only on COMMIT. The rehearsal missed this because it starts PostgREST after migrating. (2) **`inspection_market_code` and `tenant_id` are never assigned by any code path.** The inspection release added them and they are server-managed. Drivers without them cannot preview, upload or submit their inspection ("no inspection market assigned"). This predates this release; decision D15. (3) **Payment-account setup returns 503 `PAYMENT_ACCOUNT_SETUP_UNAVAILABLE`.** The module was never shipped, as on f6e8c00; the NG providers are deferred. |
| Enabled by this release | **nothing new.** Every feature still off depends on an unresolved decision (below). Already on and kept: GB Stripe driver top-ups (sandbox scope), Mapbox/TomTom search and routing. |


## Rehearsal: upgraded database clone (PASSING)

`src/testing/bike-authenticated-routes.integration.spec.ts` builds a disposable stack: `postgres:16.15`,
the committed deployed develop schema, the reviewed roadmap migration chain
(`20261101000000` … `20261264900000`, incl. offer events, inspection, PIN, cancellation debt,
campaigns/referrals, cash 1E/1F, reward credits, refunds, bike, compensation, referral lifecycle,
**plus `20261267000000_driver_cancellation_attribution` since `bcd6ab9` and `20261268000000_cancellation_fee_quote` since `cc3b909`**),
real GoTrue `v2.132.3` and PostgREST `v10.1.2`. The real booking/pricing/admin routers run in-process.

| Check | Command (release worktree) | Commit | Result | Evidence |
|---|---|---|---|---|
| **1. Current-source API** — in-process routers + a separately spawned API from the current source against the upgraded clone | `npx vitest run src/testing/bike-authenticated-routes.integration.spec.ts --silent=false --reporter=verbose` | `cc3b909` (earlier passes at `a421583`, `bcd6ab9`) | **Pass** (1/1) | `docs/roadmap-evidence/rehearsal-current-source.log` (`API_STARTUP_CHECK mode=current-source`) |
| **2. Extracted release bundle** — the spawned API is the extracted `635a285` package (checksums verified, `SOURCE_SHA` 635a285, own `npm install --legacy-peer-deps --include=dev`) | as above with `VAYDU_EXTRACTED_API_ROOT=<extract>/vaydu-develop-635a285-topup-linux` | `cc3b909` (earlier passes at `a421583`, `bcd6ab9`) | **Pass** (1/1) | `docs/roadmap-evidence/rehearsal-extracted-bundle-635a285.log` (`API_STARTUP_CHECK mode=extracted-bundle source=635a285`) |

D9 steps added at `bcd6ab9` (run in-process from the current source in both checks): assigned driver
cancels through `/api/jobs/cancel` (actor recorded from the session), retry keeps the original actor,
another driver is refused 403 with the job untouched, customer cancel records the customer, a voluntary
handback through `/driver-unable` succeeds once and a repeat is refused 403 with one `declined` event,
`/offer-metrics` returns 3 assignments / 1 cancelled / 1 handback / rate 0.667, the admin route returns
the identical body, a driver is refused 403 on it, and another tenant's driver and a non-driver are 404.
Area-6 steps added at `cc3b909` (same in both checks): publish for another tenant 403; publish creates a disabled version; the list returns it with the UI field names; enable for another tenant 403 and by a driver 403; admin enables it; customer preview within grace = not due, after grace = 400 (least of fee 500, cap 400, fare 1200) with currency, exponent and version; driver preview = `not_customer`; non-participant 404; customer late cancel creates exactly one receivable (400, version, GBP) and a retry adds none; early cancel and a driver late cancel create none; disabling turns fees off.
Spawned-API step (mode-aware, **migration-before-API compatibility**): a customer cancel through the
spawned API returns 200 in both checks. The current source records the customer actor; the 635a285
package (which predates this work) cancels through `cancel_job_safely` and records no actor, so its
cancellations appear as `unattributedCancellations` and are never counted against a driver.

Scope of each, so neither is read as the other:
- Check 1 does **not** show that the package starts. Check 2 does **not** re-test the in-process steps
  against the package: in both checks those steps (bike acceptance guards, driver feed, admin assignment,
  cash reassignment incl. the concurrent one, holds RLS, ledger currency isolation) run the **current
  source**. In check 2 only the spawned API is the package. Its assertions are `/health`, authenticated
  `/api/payment/cards`, `/api/booking/debts` with a seeded receivable, the DB guard on contradictory
  metadata, and suspension (same access token denied, refresh denied, other user unaffected).
- Check 2 ran the package with Windows Node 22 and a Windows `npm install`. The develop image is
  `node:22-alpine` built by `server/Dockerfile`. Image build and startup on Linux is proven only by the
  host deployment itself (runbook step 4).
- Harness changes (no assertion weakened): the longer keep-alive is set on the **test's own**
  `http.createServer` only (`server.keepAliveTimeout`). No server or API code was changed. Root cause,
  proven by instrumentation: about 5.09 s of idle time while synchronous `docker exec`/psql blocked the
  event loop. `fetch` reused a pooled socket in the same tick the overdue 5 s keep-alive destroyed it,
  giving `ECONNRESET`. The failure was identical on `v2.3`, so it is not a regression. The concurrent
  reassignment assertions are unchanged: exactly one 200, one 409, the winner assigned, no duplicate
  wallet events.
- Correction to an earlier note: `requireAdmin`'s unguarded `getUser` is not a crash defect. Express
  5.2.1 forwards async rejections to the error handler (`server/index.ts:218`), so the client gets a 500.

## Develop enablement status (2026-11-14)

Four separate states:
- **Implemented**: code and migrations exist in the release line.
- **Deployed**: observed on develop.
- **Enabled**: its switch is on for the develop test scope.
- **Verified on develop**: a real journey on develop was observed.

Mock tests, local rehearsals and readiness reports never count as Verified on develop.

**Policy values: all approved by the user on 2026-11-14** ("Approve all proposals": P1, P3–P14; values below).
Activation permission is the user's standing instruction. The agent has no host access, so nothing is switched
on until the host steps run. Live state is read with `host-live-config.sh` before and after.

**Defects found while preparing activation (fixed; they would have paid wrong amounts if enabled):**
- **7a promo:** `/campaigns/apply` sent the quote's `driverBase` (MAJOR units, 12.50) as `p_fare_minor` (12), so
  every minimum-fare check failed and discounts were 100 times too small. It now converts with the currency
  exponent, and refuses another tenant, market or currency (`campaign-promo-units.spec.ts` 5/5).
- **7b referrals (database):** `earn_referral` cast the MAJOR-unit job fare to minor units (12.50 became 12),
  so 5% rewards were 0 and an 800 qualifying fare was never met. Fixed in release 2 (`20261270200000`),
  together with a job/campaign market and currency check (`realdb-referral-units-test.sql` 8/8).
- **7b referrals (API):** `/referrals/redeem` froze only the rate. The cap, the qualifying fare and the
  approved driver terms (20 jobs / 30 days / 7-day review) never reached the referral row. Any referrer or
  referee market was accepted. Fixed (`campaign-referral-acceptance.spec.ts` 7/7).

| Feature | Implemented | Deployed | Enabled | Verified on develop | Next step |
|---|---|---|---|---|---|
| 5a Driver top-up (GB, Stripe test) | ✓ | ✓ 3c91991 | ✓ (baseline) | ✗ | Sandbox top-up journey |
| 1a Acceptance/cancellation metrics | ✓ | ✓ | ✓ no switch | ✗ | Accept/cancel journey |
| 4a Traffic indicators | ✓ | ✓ | ✓ (baseline) | ✗ | Seen in a quote |
| 2a Inspection readiness + layout | ✓ | ✗ (bundle) | on deploy | ✗ | Deploy; review screen + admin approval |
| 1c / 8 / Driver Setup layout | ✓ | ✗ (bundle) | no switch | ✗ | Deploy; journeys |
| 3 Per-driver completion PIN | ✓ | ✗ (release 2) | no switch | ✗ | Release 2; set/clear an override; complete a job |
| 3 GB default PIN (P6 required) | ✓ | ✗ | ✗ → `activate-gb.sql` | ✗ | Activation |
| 6a Cancellation fee (P1) | ✓ | ✓ | ✗ → `activate-gb.sql` (300/300/120 s) | ✗ | Activation; customer cancels after grace (Stripe test capture) |
| 6b Compensation 80/20 | ✓ | ✓ | follows 6a | ✗ | Captured fee settles 80/20 once |
| 6c Debt threshold (approved 50%) | ✓ | ✓ | follows 6a | ✗ | Receivable from an uncollectable fee |
| 6c Overdue debt terms (P3) | **✗ not built**: 24 h reminder, 30-day admin review | — | ✗ | ✗ | **T7** build |
| 7a First-booking promo (P4) | ✓ (fixed 2026-11-14) | ✗ (bundle) | ✗ → `activate-gb.sql` | ✗ | Activation; first booking shows and charges 5% |
| 7b Referrals (P5) | ✓ (fixed 2026-11-14) | ✗ (release 2 + bundle) | ✗ → `activate-gb.sql` | ✗ | Activation; referee's qualifying ride earns once |
| 5b Cash rides (GB) | ✓ | ✓ | ✗ → `activate-gb-cash.sql` + `VAYDU_CASH_RIDE_BOOKING` | ✗ | Activation for one GB test driver; cash booking → completion → ledger |
| 1b Matching weights (P7) | ✓ 2026-11-14: per-market switch + weights (`smart_matching.markets.<CC>`); other markets unchanged (`driver-ranking-v23.spec.ts` 48/48) | ✗ (bundle `e4a64c1`) | ✗ → `activate-gb.sql` (GB 0.5 / 1.0 / 0.15 km, ranking on; road ETA stays off) | ✗ | Deploy, activate; a GB dispatch with two drivers |
| 4b Surge (P8) | ✓ 2026-11-14: per-market `dynamic_pricing.markets.<CC>`, no tenant-level leak (`market-dynamic-pricing.spec.ts` 7/7); traffic display-only via `trafficEnabled:false`; activation stops if a GB strategy cap or live AI pricing would override | ✗ (bundle) | ✗ → `activate-gb.sql` (on, max 1.5, demand/supply) | ✗ | Deploy, activate; a high-demand GB quote ≤ 1.5×, NG unchanged |
| 4c Map style (P9) | ✓ current style kept | ✓ | ✓ (no change) | ✗ | Seen on web and Android |
| 6a Exemptions (P12) | **✗ not built** | — | ✗ | ✗ | **T10**: structured reasons in the cancel flow and the fee quote |
| 6b Fee above cash hold (P13) | ✓ manual review (current) | ✓ | ✓ (no change) | ✗ | — |
| 7c Driver bonus (P11) | **✗ not built** | — | ✗ | ✗ | **T4** |
| 2b Account sharing (P10) | ~ suspension only | ✓ | ✗ | ✗ | **T3** |
| 9a Ops alerts (P14) | ✓ 2026-11-14: scheduled report + email (`ops-alert.service.ts`, 13/13); recipient only from host config | ✗ (bundle) | ✗ → `VAYDU_OPS_ALERTS` + `VAYDU_OPS_ALERT_RECIPIENTS` on the API | ✗ | Address set on the host; `send-test-ops-alert.cjs` delivers |
| 9b Backup restore | ✓ backup + drill in the release-2 host steps | ✓ | n/a | ✗ | Host drill |
| NG payouts | ~ | ~ | ✗ | ✗ | **D-AF** deferred |

**Money rules (2026-11-14):**
- **Promos:** conversion uses `FareSplitService.toMinorExact`, which works on integers and refuses amounts with
  more decimals than the currency has, instead of rounding.
- **Referrals:** `earn_referral` uses exact numeric arithmetic with `wallet_currency_minor_exponent`. Rewards are rounded
  **down** to a whole minor unit.
- **Same table on both sides:** the API and database exponent tables are proven identical (`money-minor-units.spec.ts`, including every amount from 0.00 to 500.00).

**Concurrency (real parallel database sessions, release-2 rehearsal):**
- the same customer from two sessions gets one discount;
- three retries of one redemption give one row, one budget charge and the same answer;
- budget exhaustion never over-spends;
- a burst of 8 gives one discount;
- the same referral earned from three sessions gives one credit.

**Cash activation:** enrols only the selected GB driver. Other GB drivers and NG drivers are neither enabled nor blocked.

**Deactivation keeps** frozen fees and debts, applied discounts, earned rewards, linked referrals, cash rides in flight (settled or released exactly once) and enrolment and credit.

### Remaining technical work (no business decision outstanding except the alert address)

| ID | Work | For |
|---|---|---|
| T1 | Host steps: release-2 bundle, activation scripts, live-config before/after | everything above |
| T2 | Choose one GB test driver email for cash (operator choice, not a policy) | 5b |
| T3 | Account-sharing signals (2 countries in 1 h, >2 devices in 24 h, >200 km in 10 min) → admin review queue | 2b |
| T4 | Weekly driver bonus (£20 after 25 GB rides, Mon–Sun, £200/week budget) | 7c |
| T5 | ✓ built 2026-11-14 (ops alert sender). Remaining: the recipient address in the API configuration (host) | 9a |
| T7 | Overdue debt: booking block at the threshold (exists), 24 h reminder, 30-day admin review | 6c |
| T8 | ✓ built 2026-11-14 (per-market ranking) | 1b |
| T9 | ✓ built 2026-11-14 (per-market surge, traffic display-only) | 4b |
| T10 | Cancellation exemptions (driver >10 min late, not moving 5 min, wrong vehicle, safety) | 6a |

### Approved policy values (2026-11-14)

| ID | Value (GB/GBP, develop) |
|---|---|
| P1 | Cancellation fee £3.00, cap £3.00, grace 120 s after acceptance |
| P3 | Booking blocked at the approved debt threshold; reminder after 24 h; admin review after 30 days; no interest or late fee |
| P4 | First-booking promo: max discount £5.00, minimum fare £8.00, budget £500 |
| P5 | Referrals: reward cap £5.00, qualifying fare £8.00, budget £500 |
| P6 | PIN required for all GB services |
| P7 | Matching: acceptance 0.5, cancellation 1.0, new-driver exposure 0.15 km; review-score ranking on; road-ETA ranking off |
| P8 | Surge on for GB, max 1.5, demand/supply on, traffic display-only, other multipliers 1.0 |
| P9 | Map style: MapTiler streets-v2 |
| P10 | Account-sharing signals as listed in T3; action: admin review, no automatic suspension |
| P11 | Driver bonus £20 after 25 GB rides Mon–Sun, £200/week develop budget |
| P12 | Exemptions as listed in T10 |
| P13 | Fee above the cash hold: manual review |
| P14 | Ops report every 15 min; email recipient **to be supplied** |

## 0. Unfinished work started first

| Sub-requirement | Implemented | Integrated | Verified | Deployed | Enabled | Evidence / gap |
|---|---|---|---|---|---|---|
| Top-up form closes/resets after **server-confirmed** credit; balance + history refresh | ✓ | ✓ | ✓ browser (mock API, Stripe.js stub) | ✗ (in 635a285, not deployed) | n/a | `3734ddd`. `npx playwright test -c playwright.driver-topup.config.ts` 5/5 at 635a285 (2 with real Stripe.js + test key). Gap: `/driver/wallet` page not browser-tested (shares the component). |
| Cash-ride message vs Top up action from separate server decisions | ✓ | ✓ | ✓ browser + real-PG | ✗ | n/a | Both directions in the browser; `realdb-market-pilot-test.sql` 15/15: `pilotEnabled` equals the acquisition gate per market. |
| Exactly one ledger credit per successful payment (GB Stripe) | ✓ | ✓ | ✓ real Auth/PostgREST/PG, **mock** Stripe | ? | ~ (GB sandbox scope, prior record) | `scripts/test-driver-topup-db.ps1 -Integration` exit 0: 1 PaymentIntent for 2 concurrent submissions; unpaid verify writes nothing; concurrent paid verifies → one event, ledger `1:10000` on 10500. Develop ledger check pending (runbook step 6). Real **sandbox** payment → credit: not observed by the agent. |
| Develop test cohort (cash rides GB/GBP) | ✓ | ✓ | ✓ real-PG 59/59 + rollback identity; browser cash booking `prior` | ✗ | ✗ | `bash scripts/cash-ride/run-realdb-tests.sh`. Deploy authorised + pending; enablement **not** authorised; needs D8. |
| Bank-account (payout) setup failure | ~ | ~ | ✗ | ? | ✗ | Separate from collection and cash-ride eligibility. NG Flutterwave subaccount first creation not demonstrated; app-DB binding for the co-hosted service unresolved. The user's last observed failure is still to be recorded (not reproduced here). |

## 1–9. Mandatory areas

| # | Feature | Implemented | Integrated | Verified | Deployed | Enabled | Evidence / missing work |
|---|---|---|---|---|---|---|---|
| 1a | Driver acceptance/cancellation metrics from offer events (incl. driver + admin reporting) | ✓ | ✓ | ✓ at `bcd6ab9`: real-PG **38/38** + 7 migration-lifecycle checks (`bash scripts/driver-metrics/run-realdb-tests.sh`, `docs/roadmap-evidence/driver-metrics-realdb.log`); upgraded-clone rehearsal checks 1 + 2 (above); specs 121/121 (`driver-offer-metrics`, `driver-offer-metrics-view`, `batch2c-phase-b-transition`, `wallet-auth-payment-consistency`, `driver-ranking-v23`, `batch2c-schema-lineage-guard`, `campaign-admin-controls`); `npm run build:mobile:develop` and `ng build admin` pass | ✗ | ✗ | **D9 (user, 2026-11-12): driver-initiated only; a voluntary handback of an accepted assignment counts once and is also reported as `driverHandoffs` — settled, not to be re-asked.** `20261267000000`: `cancel_job_with_actor` (actor recorded in the cancelling transaction; `cancel_job_safely` unchanged); `record_negotiated_assignment` (negotiated acceptances enter the denominator; owner-only; idempotent); `driver_offer_metrics_v2` (SQL aggregate, no row limit). **Identity + window:** one assignment = (driver, job) whose acceptance is in the window, counted once however many offers/re-acceptances; numerator and every exclusion class are subsets of exactly those assignments, each classified once (invariant tested for every driver; the service fails closed if violated). **Proven on real PG:** reason text never decides; repeated offers (3) = 1 assignment, 2 accepted offers; duplicate handback event = 1 row, 1 handoff; handback then re-accept then cancel = counted once; assignment accepted 40 days ago and cancelled now is in neither side; customer, admin (dispute refund now records the admin), other-driver and customer no-show are excluded and reported; historical no-actor = `unattributedCancellations`; guards 42501/22023; retries never overwrite the actor; service_role-only on all three functions; 1,500 assignments counted exactly. **Migration/API order:** migration first is compatible (old API keeps working, its cancels are unattributed — proven with the 635a285 package). An API calling `cancel_job_with_actor` without the migration is refused and changes nothing (proven post-rollback). Re-apply is idempotent; rollback restores the schema exactly and keeps recorded history. **Reporting:** driver dashboard and admin driver modal (`GET /api/admin/drivers/:driverId/offer-metrics`, tenant-scoped) show counted vs not-counted cancellations. **Gaps:** admin-assigned jobs (no offer, no negotiation) are outside the metric; no browser test of the two UI cards yet. |
| 1b | Location-aware matching using reliability | ✓ | ✓ | prior (unit 81/81) | ? | ✗ | Weights default 0 → reliability off until D3. |
| 1c | Availability messages = server decision | ✓ | ✓ | ✓ 2026-11-13: `e2e/customer-no-driver-reason.spec.ts` 5/5 (the real tracking page renders the three dispatch reasons and the handoff reason verbatim, with a generic fallback when there is none); `no-driver-reason-customer-text.spec.ts` 3/3 (fails on the old code) | ~ (handoff fix pending the next bundle) | n/a | **Fixed:** `/driver-unable` wrote the driver's own free text into the customer-visible reason. It is now fixed server text; the driver's text stays in `metadata.driver_handoff_history`. |
| 2a | Vehicle inspection (6 slots for motor vehicles, 3 for bikes) **in readiness, submission, approval and eligibility** | ✓ | ✓ | ✓ local (2026-11-13), on a **real backend** and the **real review screen**; see below | ✗ (develop still runs 3c91991, which shows "Complete" with no photos) | n/a | **NOT complete until deployed to develop and your own application is re-checked there.** On-device upload still unverified. |
| 2b | Account-sharing protections | ~ | ✓ | ✓ suspension revokes the same token + refresh (rehearsal, both checks) | ? | n/a | Only suspension/revocation exists; the sharing policy itself is undefined (D4). |
| 3 | Backend per-driver completion PIN policy | ✓ | ✓ | ✓ 2026-11-13: real-PG `realdb-completion-pin-test.sql` 17/17 (release-2 rehearsal); real routes (admin PIN routes, real `assign_driver_to_job`, `/api/jobs/complete`, `audit_logs`); unit 21 | ✗ (release 2 pending) | ✓ no switch once deployed; market default unset = required (P6) | Frozen at assignment; reassignment re-resolves; pre-release-2 jobs read the current override at completion. |
| 4a | Traffic indicators | ✓ | ✓ | prior (`traffic-route.spec.ts`) | ? | ? | Live TomTom key unverified. |
| 4b | Traffic-aware pricing + surge | ~ | ~ | prior | ? | ✗ | `maxSurge` default 1 (off). Needs D1. |
| 4c | Approved map styling | ? | ? | ✗ | ? | ✗ | Needs D2. |
| 5a | Driver cash wallet + verified top-ups | ✓ | ✓ | ✓ (row 0) | ~ (f6e8c00 lacks the reset/message fixes) | ~ GB sandbox scope | Africa providers deferred (D-AF). |
| 5b | Cash-job accounting | ✓ | ✓ (both chains reconciled by `20261269000000`) | ✓ book/activate/complete/cancel/no-show (real-PG, 59/59 also on the merged schema); reassign incl. concurrency (rehearsal with both chains + merge); restored disabled-acquisition gate (merge test); early-stop prior | ✗ | ✗ | Courier cash off in every market (D10 resolved). |
| 6a | Cancellation fees + policy publish/enable + customer preview | ✓ | ✓ | ✓ at `cc3b909`: real-PG **22/22** + 6 lifecycle checks (`bash scripts/cancellation-fee/run-realdb-tests.sh`, `docs/roadmap-evidence/cancellation-fee-realdb.log`); route spec 11/11 with **mock** Stripe (`src/testing/cancellation-fee-routes.spec.ts`; 8 of 11 fail on the previous route); upgraded-clone rehearsal checks 1 + 2 through real admin/booking routes; `cancellation-fee-preview` 4/4; mobile + admin builds | ✗ | ✗ (no policy enabled anywhere; amounts are D6) | **Fixed (were broken, proven):** fee read from `jobs.cancellation_fee`, a column the deployed `jobs` lacks (preview always 404, no fee ever captured or recorded); a published version could never be enabled; admin policy list selected non-existent columns (always 500, hidden by the UI as an empty list); publish/list not tenant-scoped; card capture used `fee×100` regardless of currency; `accepted`/`heading_to_pickup`/`driver_en_route` could not be cancelled through the API. **Now:** `20261268000000` — `cancellation_fee_quote`: due only when the customer cancels, an enabled policy exists for the booking's tenant+market, the market currency equals the booking currency (else fail closed), and a driver accepted more than `grace_seconds` ago; amount `least(fee_minor, fee_cap_minor, fare)` in the booking currency's minor units (0/2/3 decimals proven); highest enabled version applies. The quote is frozen into `metadata.cancellation_fee_quote` in the cancelling transaction; later policy changes and retries never re-price it. `/cancel` acts only on the frozen quote: card capture via the Stripe currency rule, capped at `amount_capturable`, idempotency key `vaydu-cancel-fee:<job>`; a receivable (frozen version) when nothing can be captured or there is no PaymentIntent; one receivable on retry; driver/admin cancellations never create customer debt. Customer sees the same server quote in the cancel confirmation. Admin: audited enable/disable with confirmation, tenant-scoped publish/list/enable. Rollback restores the `20261267` function, keeps frozen history; the API then charges nothing. **Interpretation recorded (from the recorded design, not a new value):** the grace period runs from the driver's acceptance (`jobs.accepted_at`). **Open:** `exempt_reasons` are not applied (matching the customer's free text would let anyone avoid the fee; needs structured reasons); `/policies/audit` lists all tenants' policy audit entries; no browser test of the cancel confirmation or the admin enable control yet. |
| 6b | Driver compensation 80% of collected | ✓ | ✓ card bookings and cash-ride holds (code); cash-ride DB path blocked by the migration conflict below | ✓ card at `46eafb8`; cash at `29c4a75`: rehearsal checks 1 + 2 book a fee from a captured cash-ride HOLD over real PostgREST/PostgreSQL (hold table only, as a documented stand-in — see the conflict below): only the hold intent counts, merchant taken from the hold row (never the caller), 320/80 split, replay converges; route spec +3 cash cases and webhook spec +2 cash cases (**mock** Stripe), `cash-ride-booking` 25/25 incl. read-only `capturedFeeIntent`. Earlier card evidence at `46eafb8`: upgraded-clone rehearsal (real service code over real PostgREST/PostgreSQL, **mock** captured PaymentIntent object) checks 1 + 2; route spec 15/15 and webhook spec 6/6 with **mock** Stripe; existing debt-repayment webhook spec 7/7; `stripe-ledger-inverse` 2/2; 179/179 in the affected set; earlier PG 14 + webhook 7 for the settlement RPCs (prior) | ✗ | ✗ | Approved 80/20, on collection. **Linked (2026-11-12):** a cancellation fee captured from the booking's own authorisation is now booked as a collection. `server/services/cancellation-fee-collection.ts`: receivable (idempotent per job + reason, frozen policy version, amount actually collected, converted back from Stripe units exactly — never rounded) → existing `settle_cancellation_compensation` (frozen version, deduped on provider + merchant + environment + PaymentIntent id). Called by `/cancel` right after capture and by the Stripe webhook for the same PaymentIntent (storage failure → 500, Stripe re-delivers), so a crash between capture and settlement converges exactly once. **Proven on real PG:** policy disabled before collection → frozen version still applies; receivable paid 400 → driver 320 / platform 80, earnings row `cancellation_compensation` 3.2000/0.8000; replay → `already_settled`, one event, one receivable; another PaymentIntent → not applicable; more than the fee (charged before cancelling) → nothing booked; a confirmed full refund reverses the compensation to 0 (existing reversal authority, which finds the receivable by this PaymentIntent). **Fixed in passing:** a retried cancel after the fee was captured used to mark the booking `requires_refund`; it now settles idempotently and stays `paid` (an earlier full charge still goes to refund; an unreadable state goes to `requires_review`). The webhook never re-activates a cancelled booking. A currency with no configured Stripe route (e.g. KWD) is refused, so the card path fails closed. **Cash rides (added):** when the hold covers the whole frozen fee, `/cancel` captures it once and books it through the same service against the HOLD intent (`capturedFeeIntent`, read-only, provider-verified) under the hold row's merchant; the webhook resolves hold intents by `vaydu_cash_fee_hold` and settles the same event. No-show fees from the hold were already compensated by the no-show path. **Rare case kept explicit:** if the fee now exceeds the hold disclosed at booking (policy raised after booking), the remainder stays the customer's debt as designed, the hold part is captured but NOT auto-compensated (one receivable per job+reason cannot be both paid and open), and the booking goes to `requires_review`. **Open:** that partial-cover compensation needs a partial-collection receivable model; no real Stripe sandbox capture observed by the agent. |
| 6c | Customer debt + repayment | ✓ | ✓ | ✓ authenticated `/debts` returns a seeded receivable on the upgraded clone (both checks); repayment prior | ✗ | ✗ | Real Stripe repayment return unverified; overdue terms D6. |
| 7a | Customer promotion (5% first booking) | ✓ | ✓ | prior | ✗ | ✗ | Caps/min fare/budget D6. |
| 7b | Referrals (5% customer / 5% × 20 jobs driver) | ✓ | ✓ | ~ migrations apply (rehearsal); lifecycle prior (14/14) | ✗ | ✗ | |
| 7c | Driver bonuses | ~ | ~ | ✗ | ✗ | ✗ | Needs D7. |
| 8 | Ride-market readiness validation | ✓ | ✓ | ✓ 2026-11-13: `market-readiness-states.spec.ts` 10/10 | ✗ (next bundle) | n/a | `collection`, `payout` and `cash_ride` are each `ready`/`blocked`/`unknown` with reasons, read from the runtime gates: legacy GB/GBP Stripe or `market_payment_routes`; Stripe Connect or `driver_payout_markets` plus the sandbox runtime; `VAYDU_CASH_RIDE_BOOKING` plus `driver_cash_credit_market_enabled_v1e`. **Fixed:** the tenant id was ignored, so drivers were counted across tenants; it is now enforced for tenant admins. Read errors were silently "not configured" and are now `unknown`. City rows no longer shadow the country row. Report only: it enables nothing. No admin UI yet (API only). |
| 9a | Operational reporting + monitoring | ~ | ~ | ✓ `report-unresolved-payment-ops.cjs` exit 0 / 2 / 3 against the upgraded clone (rehearsal) | ? | ✗ | No scheduled consumer or alert target. |
| 9b | Backup restoration + recovery | ~ | n/a | ✗ | ~ | n/a | Fresh isolated restore drill of a current develop backup outstanding (runbook step 2 creates one). |

### Vehicle inspection in readiness (2026-11-13; area 2a)

**Defect (reported by the user):** the review screen showed "Vehicle / Bicycle requirements — Complete" with
no inspection images.
- **Cause:** the canonical readiness response (`DriverRequirementService.resolve`) had no inspection
  requirement for cars or vans. For bikes it read only the `bike_inspection_approved` profile flag, which is set at
  submission time, not the saved photos.
- **Consequences:** the review section, progress, overall status and online eligibility could all say
  complete with zero images. The submission RPC (`submit_driver_with_current_inspection`) did check for approved
  photos, so the screen and the backend disagreed.

**Fix:**
- **Evidence:** `server/services/driver-inspection-evidence.ts` loads the photos saved for the driver's
  **current** vehicle and inspection revision. `driver-inspection-progress.ts` is the pure part, also
  bundled into the admin app.
- **Slot policy** is the existing one (`server/shared/driver-inspection.ts`): 6 motor slots, and 3 for bikes,
  which keeps the bicycle exemption.
- **What counts:** replaced photos never count; a rejected photo must be replaced; a vehicle change
  rotates the revision, so earlier photos stop counting.
- **Readiness** has a new `inspection` category and section with two separate rows:
  - **Inspection photos** (upload completion): "Missing photos: … (n of 6 uploaded)";
  - **Inspection review** (admin approval): "Awaiting admin review (n of 6 approved)".

  Both block submission and going online. For bikes the evidence replaces the old flag-based row.
- **Enforced on the backend:**
  - readiness: `GET /api/driver-onboarding/status`;
  - submit-review and `/api/verification/driver-submission`;
  - admin pre-verify and `manual-approve` (refused with "Missing photos …");
  - go-online (`market-availability`);
  - **acquisition**: `requirePayoutEligible` covers direct accept, negotiation accept and claim, with
    `INSPECTION_NOT_APPROVED` checked before any cash or payout shortcut.
- **Review screen:** "Vehicle details" and "Vehicle inspection" are separate groups. Inspection reads
  "Missing photos" until every required slot has a valid saved upload. A driver with missing photos resumes
  at stage 4.

**Evidence (local, real backend):**
- **Unit and readiness:** `src/testing/vehicle-inspection-readiness.spec.ts`, 17/17. Covers zero, partial,
  removed (replaced or deleted), rejected, all uploaded, all approved, the bike 3-slot exemption, no vehicle,
  and callers that pass no evidence.
- **Real backend:** `src/testing/vehicle-inspection-readiness.integration.spec.ts`, 1/1. Runs postgres:15.1
  restored from develop's live schema plus the release, with GoTrue, PostgREST and the real onboarding and
  verification routers called as a driver and as an admin:
  - zero, partial, all uploaded;
  - submission refused ("Inspection photos still need approval …");
  - the admin approves 6 photos (a driver attempt gets 403);
  - submission 200, then admin approval 200;
  - a removed photo gives "Missing photos: front (5 of 6 uploaded)" and acquisition is refused;
  - a vehicle change gives 0 of 6 and admin approval is refused (422).
- **Real review screen:** `e2e/driver-inspection-review.spec.ts` (`npx playwright test -c
  playwright.inspection-review.config.ts`), 5/5. The real Angular page renders the **real** readiness responses
  saved by the integration test (`e2e/fixtures/inspection-readiness/*.json`).
- **Regressions brought into line:**
  - The route harness's approved fixture drivers now have approved photos, and the bike row's `capacity` is
    `'bike'` as the app saves it.
  - The harness default chain now includes the inspection migrations `20261265*`, which develop has.
  - Batch 1F acquisition check: +1 case (38).
  - `verify-merge.sh` was silently extracting an **empty** chain since the spec edit; fixed, with a guard.
- **Full suite:** 3,507 passed; only the 2 known environment items fail. Server and app typecheck.

**Develop trace of the reporting driver's own application (2026-11-13, read-only `trace-driver-inspection.sql`):**
- **Profile:** role driver, NG registration market, `verification_status` draft.
  - `inspection_market_code` is **empty**: D15 has not assigned it yet.
- **Vehicle:** one car (`capacity` standard), so 6 slots are required.
- **Saved inspection photos:** **0 rows** in any status, revision or vehicle. All 6 slots are `missing`.
- **Confirmed:** develop's "Complete" was a false positive. With `39fc5ce`, the same data gives "Vehicle
  inspection — Missing photos (0 of 6 uploaded)" and blocks submission and going online.
- **Release for develop:** `release/vaydu-develop-39fc5ce-release-linux.tar.gz`, sha256
  `af0c6a6958c859c03ef02389a9bb20ed0f4ea75006ad71a0567e13e4d3d9e39b`. Steps are in RUNBOOK.md. **Not yet deployed.**

**Your own application on develop:** run `deploy/vaydu-develop-release/trace-driver-inspection.sql`, which is
read-only and takes your email as a parameter. It shows the saved photos per slot and revision, and what the
new readiness logic will report. The develop review screen will still show the old wording until this
release is deployed.

## Unresolved policies (cannot be invented)

| ID | Decision needed |
|---|---|
| D1 | Surge maximum per market, trigger rule, and whether traffic changes the fare or is display-only. |
| D2 | Approved map style (provider + style id) per platform. |
| D3 | Matching weights for acceptance/cancellation rate and new-driver exposure, or confirm 0. |
| D4 | What counts as account sharing, and the action taken. |
| D5 | Default PIN mode per market. |
| D6 | Per market+currency money values: promo cap + min fare, referral caps + min fare, funded campaign budgets, overdue-debt terms. |
| D7 | Driver bonus rules and amounts. |
| D8 | GB develop cash-ride cohort: driver id, tenant id, accepted terms version (and separate approval to enable). |
| ~~D10~~ | **Resolved 2026-11-12 by the user: "Keep them off".** Courier (delivery/errand) cash stays off in every market, including cash-pilot markets; cash applies to Rides only, with a card hold. Already enforced by `20261269000000`: `courier_enabled` defaults to false; no migration, API route or runbook sets it (only disposable test fixtures do); the markets table is writable by the database owner only, so the API cannot switch it on. Turning it on later needs a new decision and an owner-level change. |
| ~~D9~~ | **Resolved 2026-11-12 by the user: "Driver-initiated only".** Implemented as above; handoff after acceptance counts as driver-initiated — confirmed by the user ("Yes, count handoffs"). |
| ~~D11~~ | **Verified on develop 2026-11-13** (release 3c91991, real provider requests through the deployed adapter). Address, postcode, country isolation, fallback, reverse and `permanent=false` passed on 2026-11-12. Landmark (exact Terminal 2), business (Tesco Extra) and category (restaurant within 10 km) now pass too, through intent-aware TomTom place and category search ([record](roadmap-evidence/develop-release-3c91991-host.md)). |
| D-AF | Africa payment providers: **explicitly deferred** (`africa/deferred-2026-11-01`); multi-region architecture retained. |

### Decisions for review, with options (2026-11-12)

Each blocked feature is built and tested, but stays **off** until you choose. No option below fills in
a value on your behalf: where a value is needed, the option names it.

| ID | Blocks | Options |
|---|---|---|
| D1 | Surge / traffic pricing (4b) | (a) Display-only traffic: no fare change; surge stays at `maxSurge` 1. (b) Traffic-aware fares with a surge cap, trigger rule and markets you supply. (c) Keep off for launch. |
| D2 | Map styling (4c) | (a) Keep the current MapLibre/MapTiler base style. (b) A named provider + style id per platform (you supply). |
| D3 | Reliability weights in matching (1b) | (a) Confirm 0: location only, reliability reported but not ranked. (b) Weights for acceptance rate, cancellation rate and new-driver exposure (you supply). Separately, (c) enable road-ETA ranking: this needs `VAYDU_TOMTOM_MATRIX_V23`, currently `false`, which adds TomTom matrix spend; or keep it off. |
| D4 | Account-sharing policy (2b) | (a) Detection only: report signals to admins and take no automatic action. (b) Signals + action (e.g. suspend for review), with the signal definition you supply. Today only suspension/token revocation exists. |
| D5 | Completion PIN (3) | Default per market: (a) off; (b) on for rides only; (c) on for all services. Per-driver overrides already exist. |
| D6 | Promotions, referrals, campaigns, cancellation fees, overdue debt (6a/6c/7a/7b) | The rates are approved (5% promo, referrals, 80/20, debt threshold 50% of the minimum fare). Missing per market+currency: promo cap and minimum fare; referral caps and minimum fare; campaign budgets; cancellation fee amount, cap and grace period; overdue-debt terms. (a) Supply values for GB/GBP develop only. (b) Keep off. |
| D7 | Driver bonuses (7c) | (a) Bonus rules and amounts (you supply). (b) Keep out of launch. |
| D8 | GB develop cash-ride cohort (5b) | Supply the test driver id, the tenant id and the accepted cash terms version, plus separate approval to enable. (b) Keep off. |
| ~~D12~~ | **Resolved 2026-11-13 (user: capture, do not drop):** `20261270000000` captures both objects; no-op on develop; proven to preserve rows, grants, RLS and storage policies; fresh install matches develop. |
| D13 | Cancellation-fee `exempt_reasons` (6a) | (a) Structured reasons the customer picks (e.g. driver late, wrong pickup), list supplied by you. (b) No exemptions (current behaviour). Matching free text is not offered: anyone could avoid the fee. |
| D14 | Fee larger than the cash-ride hold disclosed at booking (6b) | (a) Build a partial-collection receivable model so the hold part is compensated automatically. (b) Keep the current manual review (`requires_review`). |
| D-AF | Africa payment providers | Deferred, as instructed. |

Approved and recorded: driver card top-up fee 5% (`vaydu-driver-card-5pct-wallet-v1`), promo 5%,
customer referral 5% (90-day credit, ≤5/month), driver referral 5% × 20 jobs/30 days (≤3/month,
7-day review), debt threshold 50% of market minimum fare, compensation 80/20 on collection, cash-ride
fee hold / immediate-only / fixed-fare decisions (`CASH-BOOKING-PLAN.md`).

## Full unit/route suite vs baseline (2026-11-12)

`npx vitest run src/testing --exclude "**/*.integration.spec.ts"` at the deployment source `635a285`
(clean checkout) and at `fbab3fb`, failing tests compared by exact name
(`docs/roadmap-evidence/full-suite-failures-635a285.txt`, `...-current.txt`):

| | Failing tests | Failing files | Passing tests |
|---|---|---|---|
| `635a285` (baseline) | 108 distinct (110 reported) | 29 | 3,293 |
| `fbab3fb` (now) | 109 distinct (111 reported) | 29 | 3,329 |

- **New since baseline: exactly one** — `manifest-drift` "packaged ORDER.txt matches the executed
  list". `deploy/vaydu-develop-validation/` is the **frozen** `35b2590` validation bundle (archive
  already built); the tested chain has since grown (20261267/68, cash chain, merge). Its checksum test
  already failed at baseline. Not updated on purpose: re-cutting the bundle is release packaging, which
  is not authorised. It must be regenerated when a new validation bundle is authorised.
- **Fixed by this work:** none at `fbab3fb`; see the triage below (36 fixed, 5 real defects).
- **Pre-existing (108, unchanged):** spread over 28 files — e.g. place search (business/heigit/
  local-shop/named-landmark/geofence: 52), deployed wallet payout regression (20), driver onboarding/
  eligibility/requirements (~15), settlement remediation (5), wallet booking lifecycle (4), and single
  failures in cash-credit 1E/1G/placement, inspection route, market pricing, payment agreement
  authority, protected quote audit, wallet metadata/overlay. **These are go-live blockers in their own
  right** (mandatory areas include matching, onboarding, wallet and market readiness); each needs
  triage against its own history — none was weakened here.


### Triage of the pre-existing failures (2026-11-12, user: "Yes, triage them")

After triage: **73 distinct failing tests (75 reported) in 9 files, 3,368 passing**. After D11 coverage move: **22 failing in 6 files** (`full-suite-failures-after-d11.txt`): wallet artefacts 18, real-PG container 1, manifest drift 2, schema lineage 1. All are environment, artefact or decision items. Before: 109 in 29 files.
**No new failures** (`docs/roadmap-evidence/full-suite-failures-after-triage.txt`, compared by exact name).
No assertion was removed without replacing it with the current, equally strict guarantee.

**Real defects found and fixed (code changes):**

| # | Defect | Since | Fix |
|---|---|---|---|
| 1 | Negotiation accept (`/negotiation/:id/accept`) skipped the payout/market acquisition gate for some methods | `95d745b` | `requirePayoutEligible(acceptedDriverId, res, acquisitionJob)` on every path; test M strengthened |
| 2 | `isDriverEligibleForService` evaluated requirements **without** the payment account, so `payout.payment_account` blocked every driver: dispatch, go-online and admin manual approval refused all drivers | `95d745b` (deployed in `f6e8c00`) | Payment-account state passed explicitly (`verifiedPaymentAccount`, moved to `server/services/driver-payment-account-status.ts`); dispatch passes `'verified_at_acquisition'` (payout re-checked at acquisition) |
| 3 | The app submits through `/api/verification/driver-submission` (since `e54e2a7`), which skipped the canonical submit-review steps: GB MOT re-check, `DriverRequirementService` gate + `driver_requirement_audit` row, server-owned `bike_inspection_approved` (so bike approvals then failed), identity-correction permission consumption and missing-info resolution | `e54e2a7` | Same steps now run in `driver-submission` before/after the atomic `submit_driver_with_current_inspection` RPC; helpers exported from `driver-onboarding.routes` (one definition) |
| 4 | Card authorisation ignored a `job_remaining_payable_minor` RPC error and fell back to the full total, silently dropping discount/reserved credit | reward-credit work | Fails closed (`500 PAYABLE_UNRESOLVED`); null result (no breakdown) still falls back |
| 5 | Three onboarding screens showed raw `error.message` (MOT lookup, vehicle save, payout setup) | `95d745b` | `userFacingError` |

**Stale assertions brought up to the current contract (same strength):** bicycle requirements (make/model/
colour/year are required for every saved vehicle by `parseDriverVehicleInput`; a pedal bike must still
never need registration, licence or motor insurance — now asserted explicitly), onboarding-stage bicycle
fixture (subtype + inspection since `95d745b`), submission path, payout label for `unknown` status
(reconciliation) plus an unrecognised-status case, connect account country = driver's own market,
`requirePayoutEligible(..., job)` call sites, quote dedupe (whitespace-insensitive), Batch 1A "no
collect" scoped to its own migration (`collect` arrived with the top-up batches), cash-credit 1G
placement/actions as durable invariants (the hash-of-whole-file scripts stay as historical evidence).

**Harness fixes:** inspection-photo route stub lacked the tenant lookup (`p_tenant` now asserted);
market-feed harness lacked `MarketSafetyService` (stubbed, plus a new non-Stripe-market case: 9 cases);
wallet booking lifecycle and protected quote audit stubs.

**Remaining 73 — not code defects, cannot pass here honestly:**

| Group | Tests | Reason | Needed |
|---|---|---|---|
| ~~Place search~~ | ~~52~~ | **Resolved 2026-11-12**: coverage moved to the server path, see "Address search (D11)" | Actual-request check on the host |
| Deployed wallet payout regression | 17 | Reads untracked `.temp/` deployment artefacts | Run against the deployment artefacts |
| Wallet minimal overlay | 1 | Same (`.temp/`) | Same |
| Bike assignment trigger (real PG) | 1 | Needs container `vaydu-pg-fresh` | Run with the container |
| Manifest drift | 2 | Frozen `35b2590` validation bundle (see above) | Bundle re-cut when packaging is authorised |
| Schema lineage guard | 1 | Correctly flags the untracked batch 1E migration (open item below) | Decision on versioning that file |

**Open item found during triage:** `supabase/migrations/20261248000000_driver_cash_credit_batch1e.sql` is
**not committed on any branch**. It exists only as an untracked file in this worktree, yet
`driver-cash-credit-batch1e.spec.ts` and `scripts/check-driver-cash-credit-batch1e.cjs` read it, so that
spec passes only locally. The cash-pilot migrations (`20261266*`) are generated from the deployed schema, which
already contains the v1e functions. That suggests the file matches what develop runs, but this is not verified.
Committing it adds a migration to the tested chain, so it is left out of the triage commit. It needs a
check against the develop schema export before being versioned.


### Address search (D11) — server-backed pipeline (2026-11-12)

**State:** configuration ready on develop (host evidence). Implemented and unit-verified with fake
provider responses. **Actual requests are not verified yet.** No configuration change, packaging or
deployment was made.

Path: `GeocodingService.searchPlaces` → `RemoteMapsService` → `/api/maps-v23/search` (signed-in user,
60/min) → `MapsV23` (Mapbox Geocoding v6, then TomTom on Mapbox failure or zero usable results;
configured countries only, as designed in `docs/AUTOMATIC_ADDRESS_COUNTRY_V23.md`). The previous client
pipeline (`legacySearchPlaces`, MapTiler/HeiGIT/ORS, ORS routing) is no longer reachable.

**Defects found and fixed:**
- The server path dropped every provider-independent search rule of the old pipeline. Restored by
  reusing the existing helpers on the server results: location required for nearby categories
  (`location_required`, no request), no proximity bias for postcodes, category radius 10/25 km/country,
  relevance and category/cuisine evidence, terminal identity, explicit town, explicit house number,
  de-duplication with merged categories, nearest-first, invalid-coordinate drop, and `distanceKm`.
- Search failures reached the booking page as the raw HTTP message, which includes the API URL. They
  also lacked the `provider_unavailable` code the page logic expects. They now become coded, user-safe
  errors: `provider_unavailable`, `rate_limited`, `invalid_query` or `auth_required`.
- "Additional listings" repeated the identical server search. The server has one provider chain, so
  it now makes no request.
- TomTom results dropped POI categories and the postcode. Both are now passed through, bounded, so
  category searches can match. This adds no provider requests.

**Billing guard (Mapbox permanent geocoding):** `MapsV23.mapbox()` is the only builder of Mapbox
geocoding URLs, and it always sets `permanent=false` (forward and reverse). Tests assert this on every
geocoding request, including postcodes and reverse, and assert that nothing sends `permanent=true`.
The fallback route uses Mapbox Directions, which is not geocoding. The host script checks the same
on real requests and prints URLs with credentials redacted.

**Coverage:** `src/testing/server-place-search.spec.ts` has 43 tests. 22 of them fail against the previous
`searchPlaces`, so they guard the restored rules. `maps-provider-v23.spec.ts` keeps the adapter suite.
The old suites were reduced to their live-helper tests (business 1, landmark plan/terminal, geofence
policy/geometry). `heigit-place-search` and `local-shop-search` were removed; every requirement maps below.

| Old requirement (52 tests) | Now |
|---|---|
| POI by typed name + local coordinates; ORS venue names; business name when the label is only a street | TomTom POI name kept as `primaryText`, label = name + address, request carries lat/lon (server tests). Mapbox v6 cannot return POIs (D11b). |
| Nearer branch first; unrelated results hidden; spelling variation kept; explicit town wins; invalid coordinates | Client tests on the server path |
| Street search broad; postcode without proximity (GB, CA, IE, NG, NL, US) | Client tests (origin is withheld for postcodes) plus the server "no proximity without origin" test |
| Onboarding/other-market country restriction | Replaced by the documented design: configured countries only, for both providers (server tests) |
| Failed provider isolated; empty answers not cached indefinitely; per-town cache | TomTom fallback on failure/timeout; 60 s memo of successes only; cache keyed by location (server tests) |
| Location required before any call; 10 km vs 25 km vs country; no silent broadening; out-of-circle discarded | Client tests. The server sends proximity only (no bbox); the circle is enforced on the client. |
| All-provider timeout is a retryable error within the deadline; failure ≠ no match; missing configuration ≠ no results | 8 s abort signal per request, `MAP_PROVIDER_UNAVAILABLE` → `provider_unavailable`; `search:false` → `provider_unavailable` |
| Same venue from two providers merged with metadata; no manufactured or different house number | Client tests |
| Terminal 2 beyond radius preferred; no substitute terminal; T2≠T20; distant airport terminal rejected; near-me excludes distant | Client tests |
| HeiGIT additional listings (explicit only, 25 km, category + cuisine, no listing search for address/postcode/explicit town, in-flight sharing) | No second provider exists, so "additional listings" makes no request. Category, cuisine and radius rules are enforced on the main path. In-flight sharing is the server memo (`maps-provider-v23` coalescing test). |
| MapTiler-specific parameters (`types:poi`, `fuzzyMatch`, MapTiler-only calls); default proximity from the device country when no origin | Not applicable: the provider was replaced; no device-country bias, by design (global configured-country search) |
| HeiGIT ORS routing endpoints | Routing is server-side (`/api/maps-v23/route`, TomTom then Mapbox Directions), covered by `maps-provider-v23.spec.ts` |

**Actual-request verification (needed before "verified"):** run on the develop API host. It makes
about 12 provider requests, reads only the container's own environment, and prints no credentials:

    docker cp scripts/verify-server-place-search.cjs movabi-develop-api:/tmp/verify-server-place-search.cjs
    docker exec -e TS_NODE_PROJECT=server/tsconfig.json -w /app movabi-develop-api node -r ts-node/register/transpile-only /tmp/verify-server-place-search.cjs --countries GB,NG

The script checks address, postcode, street with origin, GB-only isolation, configured-country global
search, TomTom fallback (Mapbox blocked locally), reverse geocoding, and `permanent=false` on every
Mapbox geocoding request. For landmark, business and category queries it only records the results;
those are the D11b evidence. Note: it exercises the **deployed** adapter (`f6e8c00`), which lacks the
categories/postcode passthrough above.

**Develop host check, 2026-11-12 (user-run, deployed `f6e8c00` adapter, credentials redacted):**

| Check | Result |
|---|---|
| Provider connectivity (Mapbox, TomTom) | PASS |
| Country filtering (GB-only; configured GB,NG) | PASS |
| Address and postcode search | PASS |
| Reverse geocoding | PASS |
| TomTom fallback when Mapbox fails | PASS |
| Every Mapbox geocoding request `permanent=false`; none `true` | PASS |
| Landmark "Manchester Airport Terminal 2" | **Unsuitable**: roads and neighbourhoods |
| Business "Tesco Extra" | **Unsuitable**: a street |
| Category "restaurant" | **Unsuitable**: "Restaurant Terrace" |

**Intent-aware landmark, business and category search (implemented on this branch, not deployed):**
- The client sends the intent it already derives (`address`, `postcode`, `place`, `landmark` or
  `category`) and, for nearby searches, the radius. Older clients send no intent and keep the original
  address path unchanged.
- **Landmark:** TomTom `poiSearch`. **Category:** TomTom `categorySearch`, with lat/lon and `radius`.
  **Place:** Mapbox first, where only a matching town or locality counts, then TomTom `poiSearch`.
  Mapbox is not called for landmark or category queries: it has no POI layer, so it cannot fulfil them.
- `server/services/place-search-intent.ts` judges every answer, using the app's own helpers:
  - results must be real POIs;
  - the terminal must be exact (T2 ≠ T20 ≠ Terminal 1), and a terminal with no airport name must lie
    within 15 km of the named parent;
  - a business name must contain every distinctive word (one-letter variations allowed);
  - category and cuisine evidence must come from the provider's category or classification data,
    never from a street label;
  - results must fall inside the radius and the configured markets.
- A provider HTTP 200 with unsuitable results returns `fulfilled:false` and no results. A provider
  failure stays `MAP_PROVIDER_UNAVAILABLE`.
- **Mapbox permanent geocoding:** unchanged. `mapbox()` is still the only Mapbox geocoding URL
  builder, and it sets `permanent=false` exactly once. Regression tests reject `permanent=true` in
  three ways: on every request across all intents and reverse; through a source guard over `server/`
  and `src/app`; and through the host script's check. Forcing `permanent=true` fails three tests.
- **Coverage:** `src/testing/place-intent-search.spec.ts` has 38 tests; 14 fail on the previous
  adapter. The host script's former observe-only cases are now pass/fail checks on fulfilment,
  POI type, exact Terminal 2, a "Tesco Extra" name, restaurant category data, the 10 km radius and GB.
  Locally, with fake providers, the script passes on this branch and reproduces the three host
  findings as 8 FAILs on the `f6e8c00` adapter.
- **To verify:** landmark, business and category search can only be verified with real requests
  after this API is deployed to develop, which is not authorised. Then rerun the same host script.

**Follow-up (not done):** delete the unreachable client pipeline (`legacySearchPlaces`, MapTiler/HeiGIT
helpers, ORS routing in `RoutingService`) once the server path is verified with real requests.

## Dependencies

- **RELEASE BLOCKER — migration conflict (found 2026-11-12).** The cash-ride migrations
  `20261266000000`/`20261266100000` replace `enforce_job_payment_eligibility`,
  `enforce_ride_cash_credit_v1e` and `reserve_cash_job_credit_v1e` with bodies generated from the
  **deployed** schema. Roadmap migrations `20261255500000`, `20261255600000`, `20261255700000` and
  `20261263000000` change the same functions, and none of those roadmap versions is on develop. Applying
  both chains in any order silently reverts one side: the cash pilot's market scoping/acquisition rule,
  or the roadmap's cash behaviour (disabled-acquisition gate, commercial policies v2, courier
  reassignment). `jobs_payment_status_check` (`cash_due`, `cash_collected`) is also absent from the
  roadmap chain. The authorised 635a285 develop step is consistent on its own (its prechecks pin the
  deployed fingerprints), but no later rollout may apply both chains until the function bodies are
  merged, regenerated and re-proven (cash real-PG suite + upgraded-clone rehearsal with both chains).
  **RESOLVED at `fbab3fb` by `20261269000000_merge_cash_pilot_with_roadmap_cash`** (generated by
  `scripts/migration-merge/generate-cash-roadmap-merge.cjs` from the verbatim final bodies with asserted
  single edits; `src/testing/cash-roadmap-merge-migration.spec.ts` pins output to generator). It runs
  after both chains in either order. Evidence (`bash scripts/migration-merge/verify-merge.sh`,
  `docs/roadmap-evidence/merge-verify.log`): roadmap→cash→merge and cash→roadmap→merge give the
  **identical** public schema; the conflict was real before the merge; merge behaviour 21/21 in each
  order; the four existing cash-ride suites 59/59 on the merged schema; re-apply idempotent; rollback
  restores the roadmap-final bodies exactly. The upgraded-clone rehearsal now applies the roadmap chain,
  the cash chain and the merge, and passes in both checks (current source and the 635a285 package).
  **Also found and fixed:** inside the roadmap chain, `20261255700000` dropped the disabled-acquisition
  gate that `20261255600000` added (a cash job could acquire a driver with no credit reservation while
  disabled); the merge restores it, market-scoped (INSERT with a driver where cash is off → CE001).
  **Merged rule:** rides follow the cash-ride plan (enabled market + authorised card hold); courier
  (delivery/errand) cash stays OFF (D10 resolved: "Keep them off"); the roadmap code path exists only behind `courier_enabled` (off by
  default) — decision **D10**. **Release order:** any release carrying the roadmap chain onto a database
  that has the cash chain must apply `20261269000000` last, before any API that relies on either.
- Develop deployment: release `3c91991` authorised and prepared (supersedes 635a285); pending host execution (agent has no SSH).
- Roadmap schemas on develop (areas 1, 3, 6, 7): they apply cleanly to the deployed schema in the
  rehearsal, but a reviewed develop rollout for them has **not** been prepared or authorised.
- `origin/develop` reconciliation (33 commits).
- Bank-account setup: user's last observed failure; app-DB binding for the co-hosted service.

## Reproduce this session's evidence (release worktree)

```
npx vitest run src/testing/driver-topup-verify-states.spec.ts src/testing/stripe-driver-topup-sandbox.spec.ts src/testing/driver-wallet-topup-http.spec.ts src/testing/driver-card-approved-policy.spec.ts src/testing/cash-ride-booking.spec.ts src/testing/cash-ride-booking-migration.spec.ts src/testing/cash-ride-activation-migration.spec.ts src/testing/driver-cash-credit-market-pilot.spec.ts src/testing/cash-ride-earnings-label.spec.ts   # 109/109 (635a285)
npx playwright test -c playwright.driver-topup.config.ts                                  # 5/5 (635a285)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-driver-topup-db.ps1 -Integration   # exit 0 (2217bd2)
bash scripts/cash-ride/run-realdb-tests.sh                                                # 59/59 + rollback identical (2217bd2)
npx vitest run src/testing/bike-authenticated-routes.integration.spec.ts --silent=false --reporter=verbose   # check 1 (a421583)
VAYDU_EXTRACTED_API_ROOT=<extract> npx vitest run src/testing/bike-authenticated-routes.integration.spec.ts --silent=false --reporter=verbose   # check 2 (a421583)
```
