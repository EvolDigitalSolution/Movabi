# Vaydu go-live roadmap — completion matrix

Single source of truth for the nine mandatory roadmap areas. Supersedes the status tables in
`LAUNCH-ROADMAP-HANDOFF.md` and `BIKE_COMPLETION_MATRIX.md` (kept as history). Update this file in
the same commit as any change that moves a state. Last updated 2026-11-12.

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
| Develop web | **`f6e8c00`** at 2026-11-12 09:45 UTC: 12/12 entry assets byte-identical to `release/vaydu-develop-f6e8c00-topup-linux`; 5/12 differ from the 635a285 bundle. | sha256 of live assets |
| Develop API | Up (`/health` 200; top-up route mounted). Revision **?** (no host access; prior record: `release-f6e8c00-topup`). | public HTTP |
| Develop DB | Last committed export (`supabase/baseline/deployed_public_schema.sql`, `95d745b`, 10 Nov) lacks `driver_offer_events`, `driver_pin_policies`, `cancellation_policies`, `customer_receivables`, `campaigns`, `referrals`, `reward_credit_spends`, `job_funding_breakdown`, compensation RPCs. Current state **?**. | grep of the export |
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

## Rehearsal: upgraded database clone (PASSING)

`src/testing/bike-authenticated-routes.integration.spec.ts` builds a disposable stack: `postgres:16.15`,
the committed deployed develop schema, the reviewed roadmap migration chain
(`20261101000000` … `20261264900000`, incl. offer events, inspection, PIN, cancellation debt,
campaigns/referrals, cash 1E/1F, reward credits, refunds, bike, compensation, referral lifecycle,
**plus `20261267000000_driver_cancellation_attribution` since `bcd6ab9`**),
real GoTrue `v2.132.3` and PostgREST `v10.1.2`. The real booking/pricing/admin routers run in-process.

| Check | Command (release worktree) | Commit | Result | Evidence |
|---|---|---|---|---|
| **1. Current-source API** — in-process routers + a separately spawned API from the current source against the upgraded clone | `npx vitest run src/testing/bike-authenticated-routes.integration.spec.ts --silent=false --reporter=verbose` | `bcd6ab9` (earlier pass at `a421583`) | **Pass** (1/1) | `docs/roadmap-evidence/rehearsal-current-source.log` (`API_STARTUP_CHECK mode=current-source`) |
| **2. Extracted release bundle** — the spawned API is the extracted `635a285` package (checksums verified, `SOURCE_SHA` 635a285, own `npm install --legacy-peer-deps --include=dev`) | as above with `VAYDU_EXTRACTED_API_ROOT=<extract>/vaydu-develop-635a285-topup-linux` | `bcd6ab9` (earlier pass at `a421583`) | **Pass** (1/1) | `docs/roadmap-evidence/rehearsal-extracted-bundle-635a285.log` (`API_STARTUP_CHECK mode=extracted-bundle source=635a285`) |

D9 steps added at `bcd6ab9` (run in-process from the current source in both checks): assigned driver
cancels through `/api/jobs/cancel` (actor recorded from the session), retry keeps the original actor,
another driver is refused 403 with the job untouched, customer cancel records the customer, a voluntary
handback through `/driver-unable` succeeds once and a repeat is refused 403 with one `declined` event,
`/offer-metrics` returns 3 assignments / 1 cancelled / 1 handback / rate 0.667, the admin route returns
the identical body, a driver is refused 403 on it, and another tenant's driver and a non-driver are 404.
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
| 1c | Availability messages = server decision | ~ | ✓ | prior | ? | n/a | Customer "no driver" text not browser-bound to the server reason yet. |
| 2a | Six-slot vehicle inspection | ✓ | ✓ | prior | ~ (inspection release per records) | ? | On-device upload unverified. |
| 2b | Account-sharing protections | ~ | ✓ | ✓ suspension revokes the same token + refresh (rehearsal, both checks) | ? | n/a | Only suspension/revocation exists; the sharing policy itself is undefined (D4). |
| 3 | Backend per-driver completion PIN policy | ✓ | ✓ | ~ migration applies (rehearsal); PIN flow prior (7/7) | ✗ | ✗ | Needs D5. |
| 4a | Traffic indicators | ✓ | ✓ | prior (`traffic-route.spec.ts`) | ? | ? | Live TomTom key unverified. |
| 4b | Traffic-aware pricing + surge | ~ | ~ | prior | ? | ✗ | `maxSurge` default 1 (off). Needs D1. |
| 4c | Approved map styling | ? | ? | ✗ | ? | ✗ | Needs D2. |
| 5a | Driver cash wallet + verified top-ups | ✓ | ✓ | ✓ (row 0) | ~ (f6e8c00 lacks the reset/message fixes) | ~ GB sandbox scope | Africa providers deferred (D-AF). |
| 5b | Cash-job accounting | ✓ | ✓ | ✓ book/activate/complete/cancel/no-show (real-PG); reassign incl. concurrency (rehearsal); early-stop prior | ✗ | ✗ | |
| 6a | Cancellation fees + policy publish | ~ | ~ | ~ migrations apply (rehearsal); flows prior | ✗ | ✗ | **Open finding (2026-11-12, code + deployed-schema reading, not yet test-proven):** `GET /api/booking/:jobId/cancel-preview` selects `jobs.cancellation_fee`, which the deployed `jobs` table does not have (the column exists only on another table; no migration adds it), and ignores the error → always 404; no app screen calls it. `/cancel` reads `job.cancellation_fee` (always undefined → 0), so this path never records a fee receivable. Next: prove on the upgraded clone, then derive the fee from the published cancellation policy. Also: the API transition table (`logistics.service.ts:123`) has no entry for `accepted`, `heading_to_pickup` or `driver_en_route`, which `cancel_job_safely` allows — such bookings cannot be cancelled through the API. |
| 6b | Driver compensation 80% of collected | ✓ | ✓ | prior (PG 14 + webhook 7) | ✗ | ✗ | Approved 80/20 on collection. |
| 6c | Customer debt + repayment | ✓ | ✓ | ✓ authenticated `/debts` returns a seeded receivable on the upgraded clone (both checks); repayment prior | ✗ | ✗ | Real Stripe repayment return unverified; overdue terms D6. |
| 7a | Customer promotion (5% first booking) | ✓ | ✓ | prior | ✗ | ✗ | Caps/min fare/budget D6. |
| 7b | Referrals (5% customer / 5% × 20 jobs driver) | ✓ | ✓ | ~ migrations apply (rehearsal); lifecycle prior (14/14) | ✗ | ✗ | |
| 7c | Driver bonuses | ~ | ~ | ✗ | ✗ | ✗ | Needs D7. |
| 8 | Ride-market readiness validation | ~ | ✓ | prior | ? | n/a | Must report collection, payout and cash-ride readiness as separate states. |
| 9a | Operational reporting + monitoring | ~ | ~ | ✓ `report-unresolved-payment-ops.cjs` exit 0 / 2 / 3 against the upgraded clone (rehearsal) | ? | ✗ | No scheduled consumer or alert target. |
| 9b | Backup restoration + recovery | ~ | n/a | ✗ | ~ | n/a | Fresh isolated restore drill of a current develop backup outstanding (runbook step 2 creates one). |

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
| ~~D9~~ | **Resolved 2026-11-12 by the user: "Driver-initiated only".** Implemented as above; handoff after acceptance counts as driver-initiated — confirmed by the user ("Yes, count handoffs"). |
| D-AF | Africa payment providers: **explicitly deferred** (`africa/deferred-2026-11-01`); multi-region architecture retained. |

Approved and recorded: driver card top-up fee 5% (`vaydu-driver-card-5pct-wallet-v1`), promo 5%,
customer referral 5% (90-day credit, ≤5/month), driver referral 5% × 20 jobs/30 days (≤3/month,
7-day review), debt threshold 50% of market minimum fare, compensation 80/20 on collection, cash-ride
fee hold / immediate-only / fixed-fare decisions (`CASH-BOOKING-PLAN.md`).

## Pre-existing test failures (not caused by this work)

Fail identically at the committed baseline with the working changes stashed (2026-11-12): 5 in
`src/testing/driver-settlement-remediation.spec.ts` (UK payout scope, earnings label, acquisition
payout eligibility ×3) and 1 in `src/testing/payment-agreement-authority.spec.ts` (server amount
source). They need investigation against their own baseline before go-live; not weakened.

## Dependencies

- Develop deployment of 635a285: authorised, pending host execution (agent has no SSH).
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
