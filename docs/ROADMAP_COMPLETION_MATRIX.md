# Vaydu go-live roadmap — completion matrix

Single source of truth for the nine mandatory roadmap areas. Supersedes the status tables in
`LAUNCH-ROADMAP-HANDOFF.md` and `BIKE_COMPLETION_MATRIX.md` (those remain as history).
Update this file in the same commit as any change that moves a state.

## How to read the states

| State | Meaning (all must hold) |
|---|---|
| **Impl** | Code/migration exists for the agreed behaviour (server + DB + every needed UI). |
| **Integ** | Present in the release line (`release/topup-3ds-on-2385da7`) and wired into the real user journey, not only a helper. |
| **Verif-L** | Re-verified **this session** by a real-DB / real-browser / route test at the cited commit. `prior` = only a previous record claims it; not re-run here. |
| **Dev** | Deployed to shared develop (API/web image *and* DB objects). |
| **On** | Enabled for the approved develop test scope only (market/cohort/flags). Never global, never production. |

`✓` yes · `✗` no · `~` partial · `?` unverifiable without develop host access · `n/a`.
Mocked provider ≠ sandbox: provider evidence is labelled **mock** or **sandbox**.

## Baseline (established 2026-11-12)

| Item | Finding | How established |
|---|---|---|
| Release line | `release/topup-3ds-on-2385da7`, worktree `Movabi-topup-on-2385da7`. HEAD before this session `635a285`. | `git worktree list`, graph |
| v2.3 roadmap code | Present in the release line by content (squash-merged; commits are not ancestors). | file presence of every roadmap migration/service/spec at HEAD |
| Deployed web (develop) | **`f6e8c00`** (`release-f6e8c00-topup-linux`): all 12 entry assets byte-identical to the bundle. | sha256 of live `movabi-develop.apps.evolsolution.com` assets vs `release/vaydu-develop-f6e8c00-topup-linux` |
| Deployed API (develop) | Up (`/health` 200; `/api/payment/driver-topup/availability` 401 = route mounted). Revision **not** fingerprinted: no host access (SSH is password-only, not available to the agent). Prior record: `release-f6e8c00-topup`. | public HTTP |
| Develop DB | Last committed schema export (`supabase/baseline/deployed_public_schema.sql`, commit `95d745b`, 10 Nov) contains cash-credit 1E, wallet top-up attempts, ranking RPC — and **none** of: `driver_offer_events`, `driver_pin_policies`, `cancellation_policies`, `customer_receivables`, `campaigns`, `referrals`, `reward_credit_spends`, `job_funding_breakdown`, compensation RPCs. Later deployments (inspection photos, card sandbox scopes) post-date that export. Current DB state is **?**. | grep of the export |
| Prepared, not deployed | `release/vaydu-develop-635a285-topup-linux.tar.gz` (sha256 `cbd60346…14a6`) + cash-ride migrations 1–4; `deploy/vaydu-topup-verify-fix/NEXT-STEPS.txt` says "NOT YET RUN". | file + note |
| Other lines | `origin/develop` (`e596989`) has 33 divergent commits incl. a separate top-up `recover()` line and admin market badges — **not** in the release line; must be reconciled before go-live. | `git rev-list` |

## 0. Current unfinished work (started first)

| Sub-requirement | Impl | Integ | Verif-L | Dev | On | Evidence / gap |
|---|---|---|---|---|---|---|
| Top-up form closes/resets after **server-confirmed** credit; balance + history refresh | ✓ | ✓ | ✓ | ✗ | n/a | `3734ddd`. Playwright (real Chromium, real Angular; Stripe.js stub that succeeds; API mocked) `e2e/driver-topup-lifecycle.spec.ts` 3/3 + `driver-topup-continue-payment.spec.ts` 2/2 (real Stripe.js, develop **test** publishable key) — 5/5 this session at `635a285`. Card element destroyed, storage cleared, reopen clean, reload/focus never re-verify. Gap: only Driver Hub tab is browser-tested; `/driver/wallet` page relies on the same component (unit-level only). Deployed web is `f6e8c00`, which does **not** have this fix. |
| Cash-ride message vs Top up action not contradictory; from actual server decisions | ✓ | ✓ | ✓ | ✗ | n/a | Message = `driver_cash_credit_status_v1f` (pilot/enrolment/consistency); Top up = `/driver-topup/availability`. Browser: both directions (cash off + top-up on; cash on + top-up off). Server side: real-PG `realdb-market-pilot-test.sql` 15/15 proves `pilotEnabled` equals the acquisition gate (CE001/CE002) per market. |
| Exactly one correct ledger credit per successful payment (GB Stripe path) | ✓ | ✓ | ✓ (mock provider) | ? | ~ | **Fixed this session:** the disposable Auth+PostgREST+PostgreSQL integration still mocked Stripe *Checkout Sessions* while the adapter creates *PaymentIntents* — it failed (`409 PAYMENT_RECONCILIATION_REQUIRED`) and so proved nothing for the deployed path. Now: concurrent submissions → 1 PaymentIntent; unpaid verify → `PAYMENT_NOT_COMPLETED`, ledger `0:0`; two concurrent paid verifies → same event, ledger exactly `1:10000` on a 10500 charge; provider fee 700 recorded; cross-owner 404; collection shutdown still reconciles. `scripts/test-driver-topup-db.ps1 -Integration` exit 0. Real develop ledger: read-only SQL in `deploy/vaydu-topup-verify-fix/DEVELOP-LEDGER-AND-CASH-RIDE-CHECKS.txt` — **not yet run** (needs host). Real Stripe sandbox payment → credit on develop: claimed by user report only, unverified here. |
| Develop test cohort enablement (cash rides, GB/GBP) | ✓ | ✓ | ✓ | ✗ | ✗ | Market-scoped pilot (`20261266000000`) + cash booking (`20261266100000..300000`) + API (`VAYDU_CASH_RIDE_BOOKING`) + customer/driver UI. Real-PG this session: pilot 15/15, acquisition 16/16, chain 13/13, lifecycle 15/15; full rollback restores the deployed schema byte-identically (`bash scripts/cash-ride/run-realdb-tests.sh`). Browser: `e2e/customer-cash-booking.spec.ts` (prior). **Blocked:** deploy to shared develop + enable needs explicit authorisation and host execution; step 4 needs driver id, tenant id, accepted terms version. |
| Bank-account (payout) setup failure — kept visible | ~ | ~ | ✗ | ? | ✗ | Separate from top-up and cash rides. Repository records: NG Flutterwave driver payment-account (subaccount) first creation not demonstrated; empty-list HTTP 400 normalised (`NG_SUBACCOUNT_FIRST_ONBOARDING_TEST.md`); app-DB binding for the co-hosted service unresolved. **Current failure as last observed by the user must be confirmed** — not reproduced here. Distinct readiness: *collection* (top-up) ≠ *payout* (bank account) ≠ *cash-ride eligibility*. |

## 1–9. Mandatory areas

States below are from repository records unless marked **this session**. `prior` evidence is a claim to re-run, not proof.

| # | Area / sub-requirement | Impl | Integ | Verif-L | Dev | On | Evidence / missing work |
|---|---|---|---|---|---|---|---|
| 1a | Driver offer events + acceptance/cancellation metrics | ✓ | ✓ | migrations apply on deployed schema (rehearsal, this session); metrics not re-checked | ✗ (not in export) | ✗ | `20261101000000_driver_offer_events.sql`, `driver-offer-metrics.service.ts`; ack-only denominator. Need: metrics reconciled against recorded events on real PG. |
| 1b | Location-aware matching using reliability | ✓ | ✓ | prior | ? | ✗ | `rankEligibleDrivers` weights default 0 → reliability **off**. Decision D3. |
| 1c | Accurate availability messages = server decision | ~ | ✓ | prior | ? | n/a | `no_driver_reason` messages; cash-ride/top-up split done (row 0). Need browser test binding customer "no driver" text to server reason. |
| 2a | Six-slot vehicle inspection | ✓ | ✓ | prior | ~ (inspection release deployed per records) | ? | Vehicle-scoped slots, signed URLs, admin review. On-device upload: unverified. |
| 2b | Account-sharing protections / suspension revocation | ✓ | ✓ | prior | ? | n/a | Real GoTrue suspension test in `bike-authenticated-routes.integration.spec.ts`. Need: device/session-binding policy beyond suspension (what "sharing" detection is agreed?) — D4. |
| 3 | Backend per-driver completion PIN policy | ✓ | ✓ | prior | ✗ | ✗ | `driver_pin_policies` driver>market>default, 5×15-min lock. Need default per market — D5. |
| 4a | Traffic indicators | ✓ | ✓ | prior | ? | ? | `/:jobId/traffic` green/amber/red, read-only (`traffic-route.spec.ts`). Live TomTom key unverified. |
| 4b | Traffic-aware pricing + surge | ~ | ~ | prior | ? | ✗ | Surge capped by `maxSurge` (default 1 = off), frozen in fare snapshot. No approved surge cap or traffic-pricing rule — D1. |
| 4c | Approved map styling | ? | ? | ✗ | ? | ✗ | No approved style recorded — D2. |
| 5a | Driver cash wallet + verified top-ups | ✓ | ✓ | ✓ **this session** | ~ (`f6e8c00`) | ~ | See row 0. GB Stripe card 5% fee (`vaydu-driver-card-5pct-wallet-v1`, approved). Africa providers: **deferred** (D-AF). |
| 5b | Complete cash-job accounting (reserve, settle, release, reassign, early-stop, no-show) | ✓ | ✓ | ✓ **this session** (booking/complete/cancel/no-show) / prior (reassign, early-stop) | ✗ | ✗ | Real-PG 59/59 this session. Reassign/early-stop RPCs exist on v2.3 content; not re-run here. |
| 6a | Cancellation fees + policy publish | ✓ | ✓ | prior | ✗ | ✗ | `cancellation_policies` versioned, disabled; admin `/policies` UI. |
| 6b | Driver compensation 80% of collected | ✓ | ✓ | prior | ✗ | ✗ | Approved 80/20, `on_collection`. |
| 6c | Customer debt + repayment | ✓ | ✓ | prior | ✗ | ✗ | Threshold 50% market min fare (approved). Overdue terms missing — D6. Real Stripe repayment return path unverified. |
| 7a | Customer promotion (5% first booking, platform-funded) | ✓ | ✓ | prior | ✗ | ✗ | Approved rate. Caps/min fare/budget missing — D6. |
| 7b | Referrals (customer 5% / driver 5% × 20 jobs) | ✓ | ✓ | prior | ✗ | ✗ | Real-PG referral lifecycle 14/14 (prior). |
| 7c | Driver bonuses | ~ | ~ | ✗ | ✗ | ✗ | Campaign kind exists; no approved bonus rule/amount — D7. |
| 8 | Ride-market readiness validation | ~ | ✓ | prior | ? | n/a | `GET /admin/market-readiness` read-only. Must also report cash-ride eligibility, payout readiness and collection readiness separately. |
| 9a | Operational reporting + monitoring | ~ | ~ | prior | ? | ✗ | `report-unresolved-payment-ops.cjs` exit 0/2/3; no scheduled consumer/alert target. |
| 9b | Backup restoration + recovery drill | ~ | n/a | ✗ | ~ | n/a | 27 Oct isolated restore of develop archive passed (prior record). Need a fresh drill covering the current schema (incl. top-up ledger) in isolation. |

## Business decisions required (cannot be invented)

| ID | Decision needed |
|---|---|
| D1 | Surge: maximum multiplier per market, trigger rule, and whether traffic delay changes the fare (and how), or stays display-only. |
| D2 | Approved map style (provider + style id / spec) per platform. |
| D3 | Matching weights for acceptance and cancellation rate, and new-driver exposure; or confirm they stay 0. |
| D4 | What counts as account sharing (concurrent devices? device binding? face check?) and the action taken. |
| D5 | Default PIN mode per market (optional / required / disabled). |
| D6 | Monetary values per market+currency: promo max discount + min qualifying fare, referral caps + min fare, funded campaign budgets, overdue-debt terms. |
| D7 | Driver bonus rules and amounts. |
| D8 | Develop cash-ride cohort: driver id, tenant id, accepted terms version (runbook step 4). |
| D-AF | Africa payment providers: **explicitly deferred** (branch `africa/deferred-2026-11-01`); architecture retained. |

## Open verification failures

| Check | Result this session | Next step |
|---|---|---|
| Upgraded-clone rehearsal `src/testing/bike-authenticated-routes.integration.spec.ts` (deployed schema + roadmap migrations 20261101…20261264900000, real GoTrue/PostgREST, real admin/booking routers) | **RESOLVED — passes at the release line after two harness fixes.** (1) Root cause proven by instrumentation: 5.09 s idle (event loop blocked by synchronous docker/psql) let `fetch` reuse a pooled socket in the same tick Node's overdue 5 s keep-alive destroyed it → `ECONNRESET`; the GoTrue `ECONNREFUSED` was a request finishing after cleanup. Identical failure on `v2.3` (not a regression). Fix: test server `keepAliveTimeout` 10 min; concurrency assertions unchanged. (2) The extracted-API step hard-coded an untracked extract of the old `9abfd8f` release; it now runs the current source as a separate process (or `VAYDU_EXTRACTED_API_ROOT`). Original record follows. ~~Fails, reproducibly (2/2)~~ at line 708: the two *concurrent* `/api/admin/cash-jobs/:id/reassign` calls — the in-process `requireAdmin` → `supabaseAdmin.auth.getUser` gets `ECONNREFUSED` to the disposable stack and the client sees `ECONNRESET`. All earlier steps (migration chain, bike guards, feed visibility, suspension, single reassignments, hold ACL/RLS) passed. GoTrue container was still up with no errors. Records say this passed at `v2.3`. | Re-run the same spec on a `v2.3` checkout in this environment to separate an environment (Docker Desktop port proxy under concurrency) failure from a regression; if environmental, fix the harness without weakening the concurrency assertion. (Correction: an earlier note called `requireAdmin`'s unguarded `getUser` a crash defect. Express is 5.2.1, which forwards async rejections to the error handler at `server/index.ts:218`, so an auth outage returns 500 — not a defect.) |

## Access / authorisation blockers

- Shared develop: deploying `635a285` + cash-ride migrations 1–4 with cash rides **off** was **authorised by the user on 2026-11-12**. Runbook: `deploy/vaydu-topup-verify-fix/DEVELOP-DEPLOY-635a285.md`. Waiting on someone with host access to run it (agent has no SSH). Enabling GB/GBP cash rides is **not** authorised yet and also needs D8.
- Develop DB is missing the roadmap schemas (areas 1, 3, 6, 7): a reviewed migration chain against the current deployed schema is needed before those features can be verified on develop.

## Reproduce this session's evidence (release worktree)

```
npx vitest run src/testing/driver-topup-verify-states.spec.ts src/testing/stripe-driver-topup-sandbox.spec.ts src/testing/driver-wallet-topup-http.spec.ts src/testing/driver-card-approved-policy.spec.ts src/testing/cash-ride-booking.spec.ts src/testing/cash-ride-booking-migration.spec.ts src/testing/cash-ride-activation-migration.spec.ts src/testing/driver-cash-credit-market-pilot.spec.ts src/testing/cash-ride-earnings-label.spec.ts   # 109/109
npx playwright test -c playwright.driver-topup.config.ts                 # 5/5
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-driver-topup-db.ps1 -Integration   # exit 0
bash scripts/cash-ride/run-realdb-tests.sh                               # 59/59 + rollback identical
```
