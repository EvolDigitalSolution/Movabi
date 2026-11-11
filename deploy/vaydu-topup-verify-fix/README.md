# Driver wallet top-up verify fix — develop release package

Base commit: `95d745b` (branch `develop`). **Not deployed.** No schema migration, no provider
change, no live keys. Bank-account setup (`PAYMENT_ACCOUNT_SETUP_FAILED`) is a separate issue
and is not touched here.

## Files in the fix (review diff: `topup-verify-fix.diff`)

Changed:
- `server/routes/driver-wallet-topup.routes.ts` – status mapping for new codes; `POST /resume`, `POST /discard`.
- `server/services/payments/driver-card-topup-contracts.ts` – optional `resume`/`cancel` on the adapter contract.
- `server/services/payments/driver-wallet-topup.ts` – credit-pending code; `resume()`; `discard()`.
- `server/services/payments/stripe-driver-topup-sandbox.ts` – explicit non-success states; `resume()`; `cancel()`.
- `src/app/shared/ui/driver-wallet-topup.component.ts` – card form rendering, outcome-driven actions, server-side discard.

Added:
- `src/app/shared/utils/driver-topup-verify-outcome.ts`
- `src/testing/driver-topup-verify-states.spec.ts`
- `deploy/vaydu-topup-verify-fix/*` (this package; not shipped to the API image)

## 1. Windows: real tests and build (PowerShell, repo root)

```powershell
cd C:\Users\fedri\source\repos\Movabi-mobile-develop
git status --short -uno          # expect exactly the 5 changed files above
npx vitest run src/testing/driver-topup-verify-states.spec.ts src/testing/stripe-driver-topup-sandbox.spec.ts src/testing/driver-wallet-topup-http.spec.ts src/testing/driver-wallet-stripe-branch.spec.ts src/testing/driver-wallet-develop.spec.ts src/testing/driver-topup-fees-v2.spec.ts src/testing/wallet-topup-orchestration.spec.ts
npm test                          # = vitest run (whole suite, vitest.config.ts)
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
git add -- server/routes/driver-wallet-topup.routes.ts server/services/payments/driver-card-topup-contracts.ts server/services/payments/driver-wallet-topup.ts server/services/payments/stripe-driver-topup-sandbox.ts src/app/shared/ui/driver-wallet-topup.component.ts src/app/shared/utils/driver-topup-verify-outcome.ts src/testing/driver-topup-verify-states.spec.ts deploy/vaydu-topup-verify-fix/README.md deploy/vaydu-topup-verify-fix/VERIFY.sql deploy/vaydu-topup-verify-fix/PREREQ.sql deploy/vaydu-topup-verify-fix/ORDER.txt deploy/vaydu-topup-verify-fix/make-bundle.sh deploy/vaydu-topup-verify-fix/host-predeploy.sh deploy/vaydu-topup-verify-fix/host-rollback.sh deploy/vaydu-topup-verify-fix/compare-baseline.ps1 deploy/vaydu-topup-verify-fix/compare-summary.cjs deploy/vaydu-topup-verify-fix/remove-baseline.ps1 deploy/vaydu-topup-verify-fix/topup-verify-fix.diff deploy/vaydu-topup-verify-fix/realdb-harness/README.md deploy/vaydu-topup-verify-fix/realdb-harness/register.js deploy/vaydu-topup-verify-fix/realdb-harness/realdb.js deploy/vaydu-topup-verify-fix/realdb-harness/run-realdb.js deploy/vaydu-topup-verify-fix/realdb-harness/race.sh deploy/vaydu-topup-verify-fix/realdb-harness/stubs.js deploy/vaydu-topup-verify-fix/realdb-harness/stripe-stub.js
git diff --cached --stat          # must list only the paths above
git commit -m "Fix driver top-up verify 409: explicit payment states, resume and safe discard"
npm run build:mobile:develop      # rebuild on the committed tree (bundle script checks this)
```

## 3. Build the release bundle (Git Bash, repo root)

```bash
bash deploy/vaydu-topup-verify-fix/make-bundle.sh
```
Refuses if shipped paths are dirty, the fix is missing, or `dist/mobile` is older than HEAD or
lacks the new component. Output: `release/vaydu-develop-<sha>-topup.tar.gz` + `.sha256`,
layout accepted by `rollout-develop-52097ef.sh` (SHA256SUMS, ALL_SHA256SUMS, SOURCE_SHA,
VERIFY.sql; ORDER.txt empty – API/web-only modes never replay migrations).

## 4. Deploy to develop (only when authorised)

```powershell
$SHA = git rev-parse --short=7 HEAD
scp "release/vaydu-develop-$SHA-topup.tar.gz" "release/vaydu-develop-$SHA-topup.tar.gz.sha256" deploy/vaydu-develop-validation/rollout-develop-52097ef.sh deploy/vaydu-topup-verify-fix/host-predeploy.sh deploy/vaydu-topup-verify-fix/host-rollback.sh edsadmin@87.106.64.25:~/
ssh edsadmin@87.106.64.25
```
On the host (`SHA` = same 7 characters):
```sh
SHA=<sha>; A=vaydu-develop-$SHA-topup.tar.gz
chmod +x rollout-develop-52097ef.sh host-predeploy.sh host-rollback.sh
./host-predeploy.sh $A        # records rollback images; prints API files that would change
```
**Gate:** if `api-changes.txt` lists anything besides the fix files, the running API is not at
`95d745b`; stop and review (deploying would also ship those differences).
```sh
PRE=$(ls -td ~/vaydu-topup-fix-predeploy-* | head -1); . "$PRE/previous.env"   # gives WEB_IMAGE
CUR_WEB_TAG=${WEB_IMAGE#*:}                       # keep the running web image for the API step
export ARCHIVE=$A BUNDLE_DIR=vaydu-develop-$SHA-topup EXPECTED_SOURCE_SHA=$SHA API_TAG=release-$SHA-topup
WEB_TAG=$CUR_WEB_TAG ./rollout-develop-52097ef.sh --preflight
WEB_TAG=$CUR_WEB_TAG ./rollout-develop-52097ef.sh --deploy-api-only     # VERIFY.sql, build + recreate api only
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://movabi-api-develop.apps.evolsolution.com/api/payment/driver-topup/resume   # 401 = new code live (404 = old)
WEB_TAG=release-$SHA-topup ./rollout-develop-52097ef.sh --deploy-web-only # build + recreate web only
```
API first: the old web never calls `/resume` or `/discard`, so the API step alone is backward-compatible.

## 5. Rollback (application only; no schema was changed)

```sh
./host-rollback.sh ~/vaydu-topup-fix-predeploy-<stamp> web    # or: api | both
```
Pins `api`/`web` back to the images recorded by `host-predeploy.sh` and recreates them with
`--no-build`. Attempts discarded while the fix ran remain `failed` with their Stripe
PaymentIntents cancelled – consistent, nothing owed.

## 6. Develop sandbox verification (after deploy; Stripe test cards only)

| Check | Expected |
|---|---|
| Top up £20.00 with `4242 4242 4242 4242` | quote: fee £1.00, total £21.00; one credit of £20.00 |
| `4000 0000 0000 0002` (declined), then retry with 4242 | "card payment failed…", form stays; retry credits once |
| Refresh before entering a card | status check → "not completed" → **Continue payment** reopens same payment |
| `4000 0027 6000 3184` (3DS), refresh during challenge | "still processing"/continue; no credit until success |
| Verify repeatedly / refresh after success | same event id; one ledger event |
| Discard an unpaid attempt | PaymentIntent cancelled in Stripe dashboard, attempt `failed`, no credit |
| Stripe dashboard "resend" `payment_intent.succeeded` | no effect (no job metadata); still one credit |

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
