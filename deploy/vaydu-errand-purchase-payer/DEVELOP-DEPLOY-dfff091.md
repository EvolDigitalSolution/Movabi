# Develop deployment — release `dfff091` (errand purchase payer + wallet top-up readiness UI)

**Authorised by the user** for shared develop only: apply the reviewed prerequisite/migration chain
and deploy API + web `dfff091` so the local frontend at `http://localhost:3000` can test against
`https://movabi-api-develop.apps.evolsolution.com`. **Not authorised:** production, live payouts
(`VAYDU_DRIVER_PAYOUT_TRANSFERS*` stay unset), `VAYDU_CASH_RIDE_BOOKING`, `KORA_PAYOUT_SECRET_KEY`,
provider switching, or any market/cohort change.

Run by someone with SSH access to `edsadmin@87.106.64.25` (the agent has none — SSH is denied).
Stop at the first result that differs from "Expected". Every step before 4 is read-only toward
running services.

| | Value |
|---|---|
| Currently deployed | API `movabi-api:release-f949a14`, web `movabi-web:release-f949a14-linux` (confirm in step 1a) |
| Package | `release/vaydu-develop-release-dfff091.tar.gz` |
| SHA-256 | recorded in `release/vaydu-develop-release-dfff091.tar.gz.sha256` — re-verify after upload |
| Source | `dfff091` on `release/topup-3ds-on-2385da7` (= `ae917eb` frozen scope + wallet readiness-reason UI) |
| New tags | API `movabi-api:release-dfff091`, web `movabi-web:release-dfff091-linux` |
| Order | 0 upload → 1 prechecks → 2 backup → 3 rehearsal → 4 migrations → 5 API → 6 web → 7 checks |

## CORS — no config change needed

`server/index.ts` at `dfff091` already allowlists `http://localhost:3000` (plus `4200`, `8100`,
Capacitor/Ionic origins) with `Access-Control-Allow-Methods: GET,POST,PUT,PATCH,DELETE,OPTIONS`,
headers including `Authorization`, `Content-Type`, `apikey`, `x-client-info`, and returns `204` on
`OPTIONS`. **Verified live 2026-11-17** against the currently deployed API:

```
curl -s -X OPTIONS https://movabi-api-develop.apps.evolsolution.com/api/customer-wallet/topup-readiness \
  -H "Origin: http://localhost:3000" -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: authorization,content-type" -D -
# → 204, Access-Control-Allow-Origin: http://localhost:3000
```

Re-run this in step 7 against the new API — expected identical.

## 0) Upload (Windows PowerShell, one line)

```
scp "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\release\vaydu-develop-release-dfff091.tar.gz" "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\release\vaydu-develop-release-dfff091.tar.gz.sha256" edsadmin@87.106.64.25:~/
```

## 1) Host prechecks (read-only)

```
cd ~
sha256sum -c vaydu-develop-release-dfff091.tar.gz.sha256
mkdir -p ~/vaydu-release && rm -rf ~/vaydu-release/vaydu-develop-release-dfff091
tar -xzf vaydu-develop-release-dfff091.tar.gz -C ~/vaydu-release
cd ~/vaydu-release/vaydu-develop-release-dfff091 && sha256sum -c CHECKSUMS.sha256 --quiet && cd ~
DBQ() { docker exec -i movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -v ON_ERROR_STOP=1 -P pager=off -tA'; }
```

Expected: both checksum verifications `OK` / silent success. Any failure → STOP (wrong bytes).

1a) Bundle vs running services + **image-pinning overrides**:

```
bash host-predeploy.sh vaydu-develop-release-dfff091.tar.gz
PRE=$(ls -td ~/vaydu-topup-fix-predeploy-* | head -1); echo "$PRE"
cat "$PRE/running-source-sha.txt"; grep -E 'API_IMAGE=|WEB_IMAGE=' "$PRE/previous.env"
```

Expected: `f949a14`; `API_IMAGE=movabi-api:release-f949a14`, `WEB_IMAGE=movabi-web:release-f949a14-linux`.
**Keep `$PRE`** — it is the rollback record.

Then check overrides cannot retain an old image:

```
grep -rniE 'movabi-(api|web)' ~/vaydu-develop-overrides/ /srv/movabi/develop/*.yml 2>/dev/null
```

Expected: every override that pins an image uses a variable (`${API_IMAGE}`/`${WEB_IMAGE}`) or lists
the f949a14 tags that step 5/6 will replace. A hard-pinned tag not equal to the new tag → update the
override to the new tag (or `${API_IMAGE}`) before continuing; otherwise the recreated container
keeps the old API.

1b) Production/live-payout guard:

```
grep -rn VAYDU_CASH_RIDE_BOOKING ~/vaydu-develop-overrides/ /srv/movabi/develop/*.yml 2>/dev/null; echo "flag_grep=$?"
docker exec movabi-develop-api printenv VAYDU_CASH_RIDE_BOOKING; echo "cash_env=$?"
docker exec movabi-develop-api sh -c 'env | grep -E "VAYDU_DRIVER_PAYOUT_TRANSFERS|KORA_PAYOUT_SECRET"'; echo "payout_env=$?"
```

Expected: `flag_grep=1`, `cash_env=1`, `payout_env=1` (none set). Anything else → STOP.

## 2) Database backup (before any change)

```
mkdir -p ~/vaydu-develop-backups; STAMP=$(date -u +%Y%m%dT%H%M%SZ)
B=~/vaydu-develop-backups/develop-before-dfff091-$STAMP.dump
docker exec movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U supabase_admin -d movabi_develop -Fc' > "$B"
sha256sum "$B" | tee "$B.sha256"
docker exec -i movabi-develop-db pg_restore --list < "$B" | grep -c 'TABLE DATA'
echo "$B"
```

Expected: non-empty dump, checksum printed, TABLE DATA count > 0. Record path + checksum in the
release record.

## 3) Corrected restore rehearsal (isolated container — the gate before any apply)

```
cd ~/vaydu-release/vaydu-develop-release-dfff091
bash runbook/rehearse-restore.sh "$B"
```

Expected tail (exact script, real develop backup):

```
== post-suite persistence — suites may leave no persistent changes
REHEARSAL PASS
```

The rehearsal restores the real backup into a disposable container, verifies roles/ownership/grants,
snapshots every public function signature|definition-hash and every pre-existing table's column list
+ row-content hash, applies ONLY the reviewed chain per preflight gates, then proves: no dropped
function signatures, cash×14/PIN×3 definitions byte-identical, all pre-existing row contents
identical (new columns trace to applied `ADD COLUMN`s), GB Stripe payout anchor intact, both shipped
suites pass and leave no persistent changes. Any `REHEARSAL FAIL` → STOP; the chain does not apply to
this database.

## 4) Migrations — only what preflight says is missing

```
cd ~/vaydu-release/vaydu-develop-release-dfff091
DBQ -f db/preflight-schema-check.sql
```

Apply per RUNBOOK §1's decision table: `MISSING`/`DEFINITION-DIFFERS` (convergence rows) → apply that
file; `DEFINITION-DIFFERS` on the `complete_job_with_pending_payout` apply-safety row → STOP;
recorded+missing or unrecorded+verified → drift, STOP.

```
for f in db/prerequisites/20261254700000_flutterwave_payout_outbox.sql \
         db/prerequisites/20261254800000_flutterwave_collection_subaccounts.sql \
         db/migrations/20261270500000_errand_purchase_payer.sql \
         db/migrations/20261270600000_customer_wallet_booking_bridge.sql \
         db/migrations/20261270700000_driver_wallet_settlement.sql \
         db/migrations/20261270800000_driver_settlement_policy.sql \
         db/migrations/20261270900000_kora_payout_adapter.sql \
         db/migrations/20261271000000_customer_collection_account_binding.sql \
         db/migrations/20261271100000_kora_settle_reference.sql; do
  echo "== $f"; DBQ -f "$f" || break
done
```

(Apply only the files preflight gates say to apply, in APPLY-ORDER.txt order — do not run the loop
blindly.)

Then re-run `DBQ -f db/preflight-schema-check.sql` → Expected: **zero MISSING, zero
DEFINITION-DIFFERS**.

## 5) API

```
cd ~
export ARCHIVE=vaydu-develop-release-dfff091.tar.gz BUNDLE_DIR=vaydu-develop-release-dfff091 EXPECTED_SOURCE_SHA=dfff091
API_TAG=release-dfff091 WEB_TAG=release-f949a14-linux bash rollout-develop-52097ef.sh --deploy-api-only --preflight
API_TAG=release-dfff091 WEB_TAG=release-f949a14-linux bash rollout-develop-52097ef.sh --deploy-api-only
```

Check:

```
docker inspect -f '{{.Config.Image}} {{.State.Status}}' movabi-develop-api
curl -s https://movabi-api-develop.apps.evolsolution.com/health
docker exec movabi-develop-api printenv VAYDU_CASH_RIDE_BOOKING; echo "cash_env=$?"
docker exec movabi-develop-api sh -c 'env | grep -E "VAYDU_DRIVER_PAYOUT_TRANSFERS|KORA_PAYOUT_SECRET"'; echo "payout_env=$?"
docker logs --since 5m movabi-develop-api 2>&1 | grep -iE 'error|fatal' | head
```

Expected: `movabi-api:release-dfff091 running`, `{"status":"ok"}`, `cash_env=1`, `payout_env=1`,
no new errors. Failure → `bash host-rollback.sh "$PRE" api`.

## 6) Web

```
API_TAG=release-dfff091 WEB_TAG=release-dfff091-linux bash rollout-develop-52097ef.sh --deploy-web-only
```

Check: `docker ps --filter label=com.docker.compose.service=web --filter label=com.docker.compose.project=movabi-develop --format '{{.Image}} {{.Status}}'`
→ `movabi-web:release-dfff091-linux Up …`. The agent will hash-compare live web assets against the
bundle over HTTPS. Failure → `bash host-rollback.sh "$PRE" web`.

## 7) Post-deploy verification (the agent runs these)

- `GET /health` → `{"status":"ok"}`; `GET /api/app/version` → JSON.
- CORS preflight from `Origin: http://localhost:3000` (command above) → 204 + allow-origin echo.
- `DBQ -f db/preflight-schema-check.sql` → zero missing/differs (re-run).
- Browser at `http://localhost:3000` (local `ng serve mobile --configuration develop --port 3000`)
  → real customer login → wallet page → top-up readiness → screen-level journey.
- `release/expected-api-changes-dfff091.txt` lists the 24 `server/` files changed vs `f949a14`;
  `expected-web-src-changes-dfff091.txt` the 33 `src/` files.

## Rollback

- App: `bash host-rollback.sh "$PRE" api|web|both` (restores f949a14 images; no schema change).
- DB: the new objects are additive/guarded; f949a14 ignores them. Never restore the whole backup over
  develop after new financial activity — see RUNBOOK §6 for the legitimate-restore boundary.

## Record (fill in)

| Item | Value |
|---|---|
| `$PRE` | |
| Backup path / sha256 | |
| Rehearsal result | |
| Preflight missing set + files applied | |
| Post-apply preflight | |
| API image / time | |
| Web image / time | |
| CORS preflight result | |
