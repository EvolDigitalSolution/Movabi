# Driver wallet top-up verify fix — develop release package

Base commit: `95d745b` (branch `develop`); fix on branch `fix/driver-topup-verify-states`.
**Not deployed.** No schema migration, no provider change, no live keys. Bank-account setup
(`PAYMENT_ACCOUNT_SETUP_FAILED`) is a separate issue and is not touched here.

## Files in the fix (review diff: `topup-verify-fix.diff`)

Changed:
- `server/routes/driver-wallet-topup.routes.ts` – status mapping for new codes (incl. `PAYMENT_ACTION_REQUIRED`, 409); `POST /resume`, `POST /discard`.
- `server/services/payments/driver-card-topup-contracts.ts` – optional `resume`/`cancel` on the adapter contract.
- `server/services/payments/driver-wallet-topup.ts` – credit-pending code; `resume()`; `discard()`.
- `server/services/payments/stripe-driver-topup-sandbox.ts` – explicit non-success states (`requires_action` → `PAYMENT_ACTION_REQUIRED`, not pending); `resume()` (returns `nextAction` for 3D Secure); `cancel()`.
- `src/app/shared/ui/driver-wallet-topup.component.ts` – card form rendering, outcome-driven actions, server-side discard, 3D Secure completion after reload (`stripe.handleNextAction` on the same PaymentIntent).

Added:
- `src/app/shared/utils/driver-topup-verify-outcome.ts`
- `src/testing/driver-topup-verify-states.spec.ts`
- `deploy/vaydu-topup-verify-fix/*` (this package; not shipped to the API image)

`PREREQ.sql` and `VERIFY.sql` are identical, read-only checks (SELECTs, `regprocedure` casts,
`has_function_privilege`, `pg_indexes`; no writes, no DDL, no credentials). The repo ignores
`*.sql`, so they are force-added by explicit filename. App-only rollout modes run `VERIFY.sql`;
`PREREQ.sql` only runs on the full-migration path, which this release does not use.

## Test status (Windows, real Vitest; `compare-baseline.ps1`)

| Check | Result |
|---|---|
| Focused top-up specs (7 files) | 87/87 passed, exit 0 (3DS-refresh regression: 3 of these fail on the previous adapter) |
| `npx tsc -p server/tsconfig.json --noEmit` | exit 0 |
| `npm run build:mobile:develop` | exit 0 (pre-existing warnings: unused RouterLink, CSS budget) |
| Full suite `npx vitest run`, patched | **exit 1**: 93 failed / 3,274 passed |
| Full suite at baseline `95d745b` | **exit 1**: 94 failed / 3,244 passed |

Full-suite rows are from the previous package (`1b60214`); the 3DS change was checked with the focused
specs, server `tsc` and the develop build only. The full suite is **not green**. Every one of the 93 failures with the patch also fails at
`95d745b` (same test, same multiplicity; in 27 files, e.g. place search, geofencing, driver
eligibility/onboarding, wallet overlay). The patch introduces **0** failures and one baseline
failure passes with it (`manifest-drift.spec.ts`). The 30 extra passing tests are the new spec.

## 1. Windows: real tests and build (PowerShell, repo root)

```powershell
cd C:\Users\fedri\source\repos\Movabi-mobile-develop
npx vitest run src/testing/driver-topup-verify-states.spec.ts src/testing/stripe-driver-topup-sandbox.spec.ts src/testing/driver-wallet-topup-http.spec.ts src/testing/driver-wallet-stripe-branch.spec.ts src/testing/driver-wallet-develop.spec.ts src/testing/driver-topup-fees-v2.spec.ts src/testing/wallet-topup-orchestration.spec.ts
npm test                          # = vitest run (whole suite; exits 1 on baseline failures, see above)
npx tsc -p server/tsconfig.json --noEmit
npm run build:mobile:develop      # = ng build mobile --configuration develop
```

Baseline comparison (real Vitest on the exact pre-fix commit in a separate worktree; the current
tree is fingerprinted before/after and never stashed or reset):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\fedri\source\repos\Movabi-mobile-develop\deploy\vaydu-topup-verify-fix\compare-baseline.ps1
# later, after review (refuses if the baseline holds anything it did not create):
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\fedri\source\repos\Movabi-mobile-develop\deploy\vaydu-topup-verify-fix\remove-baseline.ps1
```

## 2. Commit (explicit paths only)

```powershell
git switch -c fix/driver-topup-verify-states
git add -- server/routes/driver-wallet-topup.routes.ts server/services/payments/driver-card-topup-contracts.ts server/services/payments/driver-wallet-topup.ts server/services/payments/stripe-driver-topup-sandbox.ts src/app/shared/ui/driver-wallet-topup.component.ts src/app/shared/utils/driver-topup-verify-outcome.ts src/testing/driver-topup-verify-states.spec.ts deploy/vaydu-topup-verify-fix/README.md deploy/vaydu-topup-verify-fix/ORDER.txt deploy/vaydu-topup-verify-fix/make-bundle.sh deploy/vaydu-topup-verify-fix/host-predeploy.sh deploy/vaydu-topup-verify-fix/host-rollback.sh deploy/vaydu-topup-verify-fix/compare-baseline.ps1 deploy/vaydu-topup-verify-fix/compare-summary.cjs deploy/vaydu-topup-verify-fix/remove-baseline.ps1 deploy/vaydu-topup-verify-fix/topup-verify-fix.diff deploy/vaydu-topup-verify-fix/realdb-harness/README.md deploy/vaydu-topup-verify-fix/realdb-harness/register.js deploy/vaydu-topup-verify-fix/realdb-harness/realdb.js deploy/vaydu-topup-verify-fix/realdb-harness/run-realdb.js deploy/vaydu-topup-verify-fix/realdb-harness/race.sh deploy/vaydu-topup-verify-fix/realdb-harness/stubs.js deploy/vaydu-topup-verify-fix/realdb-harness/stripe-stub.js
git add -f -- deploy/vaydu-topup-verify-fix/PREREQ.sql deploy/vaydu-topup-verify-fix/VERIFY.sql   # *.sql is ignored repo-wide
git diff --cached --stat          # must list only the paths above
git commit
npm run build:mobile:develop      # rebuild on the committed tree (bundle script checks this)
```

## 3. Build the release bundle (Git Bash, repo root)

```bash
bash deploy/vaydu-topup-verify-fix/make-bundle.sh
```
Refuses if shipped paths are dirty, the fix is missing, or `dist/mobile` is older than HEAD or
lacks the new component. Source files are archived with `core.autocrlf=false` and every one is
checked against its committed blob id (Windows' default autocrlf would otherwise rewrite LF files
as CRLF); `VERIFY.sql`/`PREREQ.sql`/`ORDER.txt` come from HEAD, not the working tree. Output: `release/vaydu-develop-<sha>-topup.tar.gz` + `.sha256`,
layout accepted by `rollout-develop-52097ef.sh` (SHA256SUMS, ALL_SHA256SUMS, SOURCE_SHA,
VERIFY.sql; ORDER.txt empty – API/web-only modes never replay migrations).

## 4. Deploy to develop (only when authorised)

Before deploying, confirm the fix is not live (no auth token; harmless):
```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{"attemptId":"probe"}' https://movabi-api-develop.apps.evolsolution.com/api/payment/driver-topup/resume
# 404 = old API (fix not live)   401 = fix live.  (An EMPTY body returns 400 on the new API.)
```

From the repo root (Git Bash or PowerShell), copy the bundle and scripts:
```sh
SHA=$(git rev-parse --short=7 HEAD)
scp "release/vaydu-develop-$SHA-topup.tar.gz" "release/vaydu-develop-$SHA-topup.tar.gz.sha256" deploy/vaydu-develop-validation/rollout-develop-52097ef.sh deploy/vaydu-topup-verify-fix/host-predeploy.sh deploy/vaydu-topup-verify-fix/host-rollback.sh edsadmin@87.106.64.25:~/
ssh edsadmin@87.106.64.25
```

On the host (`SHA` = same 7 characters). Step 1 is read-only toward the running services:
```sh
SHA=<sha>; A=vaydu-develop-$SHA-topup.tar.gz
chmod +x rollout-develop-52097ef.sh host-predeploy.sh host-rollback.sh
./host-predeploy.sh $A        # records rollback images, prints running SOURCE_SHA and every API file that would change
```
**Gate:** `api-changes.txt` compares every API build input (`server/`, `src/app/shared/`,
`deploy/vaydu-payment-account-setup/api/`, `package.json`, `package-lock.json`). Expected: only the
6 fix files. Anything else ships too — stop and review. Known possibilities from git:

| `host-predeploy.sh` reports running content of | Extra API changes this release would ship |
|---|---|
| `95d745b` (develop) | none |
| `6837e55` (`inspection-release` tip, 2026-11-10) | `server/routes/driver-onboarding.routes.ts`: inspection-photo 201 response uses `photoId` instead of undeclared `row` (fixes a ReferenceError → 500 after a successful registration) |
| `a898d7c` (`vaydu-develop-52097ef.tar.gz`, the archive `rollout-develop-52097ef.sh` pins; its SOURCE_SHA) | 55 paths: 13 server files (wallet top-up switches from hosted Checkout Sessions to in-app PaymentIntents, fee label "Vaydu fee" → "Card fee", inspection routes, CORS header `X-Inspection-Vehicle`), `package.json` adds `sharp` 0.34.5 (native; image build must install it), `package-lock.json`, and ~40 `src/app/shared` files that archive did not carry — full review required. Unlikely: the reported bug needs the in-app PaymentIntent flow, which `a898d7c` does not have |

```sh
PRE=$(ls -td ~/vaydu-topup-fix-predeploy-* | head -1); . "$PRE/previous.env"   # gives WEB_IMAGE
CUR_WEB_TAG=${WEB_IMAGE#*:}                       # keep the running web image for the API step
export ARCHIVE=$A BUNDLE_DIR=vaydu-develop-$SHA-topup EXPECTED_SOURCE_SHA=$SHA API_TAG=release-$SHA-topup
WEB_TAG=$CUR_WEB_TAG ./rollout-develop-52097ef.sh --preflight             # read-only: must show project movabi-develop, /srv/movabi/develop, db movabi_develop
WEB_TAG=$CUR_WEB_TAG ./rollout-develop-52097ef.sh --deploy-api-only       # VERIFY.sql, build + recreate api only
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{"attemptId":"probe"}' https://movabi-api-develop.apps.evolsolution.com/api/payment/driver-topup/resume   # expect 401
WEB_TAG=release-$SHA-topup ./rollout-develop-52097ef.sh --deploy-web-only # build + recreate web only
```
API first: the old web never calls `/resume` or `/discard`, so the API step alone is backward-compatible.

## 5. Rollback (application only; no schema was changed)

```sh
./host-rollback.sh "$PRE" web     # or: api | both
```
Pins the rolled-back service(s) to the images recorded by `host-predeploy.sh` and recreates them
with `--no-build`. A service that is not rolled back stays pinned to the image it runs now. Image
IDs are checked before anything is written. Attempts discarded while the fix ran remain `failed`
with their Stripe PaymentIntents cancelled – consistent, nothing owed.

## 6. Develop sandbox verification (after deploy; Stripe test mode only)

Preconditions: `VERIFY.sql` output during the API step shows all five functions, the three
service_role grants, the four idempotency indexes, `driver_card_sandbox_enabled=true`, the active
Stripe GB/GBP fee schedule and ≥1 enabled Stripe GB scope. Use a develop driver account inside an
enabled scope, the develop web app (hard refresh after the web step), and the Stripe dashboard in
**test mode**. Test cards: any future expiry, any CVC, any postcode.

| # | Steps | Expected |
|---|---|---|
| 1 | Quote £20.00, agree, Continue to secure checkout | Card form renders in-app (the original bug: it never did). Quote: fee £1.00, total £21.00 |
| 2 | Pay with `4242 4242 4242 4242` | "Payment verified. Wallet credit added." One £20.00 credit; Stripe PI `succeeded`, amount 2100, metadata `vaydu_driver_topup` = attempt id |
| 3 | Click "Check payment status" again / refresh after #2 | Same credited event id; still one ledger row |
| 4 | New top-up, pay with `4000 0000 0000 0002` (decline) | Decline message + "No payment was taken…"; form stays; no credit |
| 5 | Same form, retry with `4242…` | Credits once; same PaymentIntent as #4 (no second PI) |
| 6 | New top-up, open card form, refresh before entering a card | Auto status check → "has not been completed… nothing has been charged"; **Continue payment** and **Discard** shown |
| 7 | Continue payment (from #6), pay with `4242…` | Same PaymentIntent id reopened; credits once |
| 8 | New top-up, open form, refresh, **Discard this unpaid attempt** | "Unpaid attempt discarded. Nothing was charged."; Stripe PI `canceled` (reason `abandoned`); attempt `failed`; no credit |
| 9 | New top-up, `4000 0027 6000 3184` (3DS), complete challenge | Credits once |
| 10 | New top-up, `4000 0027 6000 3184`, refresh during the challenge | Auto status check → "Your bank needs you to confirm this payment. No credit has been added yet"; **Complete bank confirmation** and **Discard** shown; PI stays `requires_action`; no credit |
| 10a | Complete bank confirmation (from #10), complete the challenge | Same PaymentIntent id (no second PI, no card form); credits once. Failing the challenge → "payment failed" + **Try card again** on the same PI |
| 10b | Repeat #10, then **Discard this unpaid attempt** | Stripe PI `canceled`; attempt `failed`; no credit |
| 11 | Stripe dashboard: resend `payment_intent.succeeded` for #2 | No extra credit (webhook has no top-up handling; credit only via server verify) |
| 12 | API, no token: `POST /resume` and `/discard` with `{"attemptId":"probe"}` | 401 `AUTHENTICATION_REQUIRED` |

Evidence query (read-only):
```sql
SELECT a.id, a.status, a.amount_minor, a.provider_fee_minor, a.total_charge_minor,
       (SELECT count(*) FROM public.wallet_movements m WHERE m.event_id=a.credited_event_id) AS ledger_rows,
       c.state, left(c.provider_session_id,3) AS kind,
       (SELECT evidence->>'status' FROM public.wallet_topup_provider_observations o WHERE o.attempt_id=a.id ORDER BY observed_at DESC LIMIT 1) AS last_stripe_status
FROM public.wallet_topup_attempts a
LEFT JOIN public.payment_checkout_attempts c ON c.reference=a.id::text
WHERE a.destination_account_purpose='driver_cash_credit' AND a.created_at > now()-interval '1 day'
ORDER BY a.created_at DESC;
```
Expect: credited attempts have `ledger_rows` = 1 (never 2); discarded attempts are `failed` with
`last_stripe_status` = `canceled` and no `credited_event_id`.
