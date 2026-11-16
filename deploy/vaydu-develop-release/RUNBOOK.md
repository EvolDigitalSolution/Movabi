# Current gate — tooling-only replacement `f949a14` (2026-11-16)

**Current activation handoff:** use `../vaydu-develop-activation/P8-RECONCILIATION.md` and its
small checksummed P8 artifact. It inspects all activation prerequisites together, reconciles the
four captured GB strategies, preserves inherited non-GB defaults, and runs the unchanged
activation guard/body with correction under one dry-run/apply transaction. It includes the prior
legacy UK scope correction only when still needed. The 3.35 minimum and both AI shadow controls
stay; no new pricing decision. Existing backup/release gates still apply; no host run is inferred.
The paired API-only candidate fixes the booking payload's missing tenant context; deploy it
between inspection and atomic data apply. Its tenant binding stays off until that transaction.
It uses f949a14 plus only two quote routes/one helper; web/release SQL stay identical and unfinished
P3/P10/P11/P12 work is excluded. Do not deploy the current branch wholesale.

**Activation mismatch follow-up:** user live evidence shows four blank-country legacy UK GBP
pricing rows and an existing ride minimum of **GBP 3.35**. Do not alter the minimum or relax the
activation guard. Use the separate checksummed scope-correction tools described in
`../vaydu-develop-activation/LEGACY-GB-SCOPE.md`, then the corrected activation copy from that
artifact. It fixes blank/NULL profile lookup too and verifies actual GB/NG quotes before/after.
The f949a14 archive remains immutable; this data/activation correction replaces none of its
API, web or release SQL. The real-backup/release verification gate below still applies.

**Use this gate before the historical release instructions below.** API baseline reported by the
user is `c972037`; web baseline is `3c91991`. Both require a fresh host check. Do not retry rejected
SSH authentication. Deployment/activation remain gated on the corrected shipped drill against the
existing backup; do not create another backup for diagnosis.

- Archive: `release/vaydu-develop-f949a14-release-linux.tar.gz`.
- SHA-256: `58dcdbaf0b27769bcf15bfbfa584e4e64002c4ab27ada42cd4f5f57cc089488a`.
- API, web and release SQL are byte-identical to `c5526f6` / `e4a64c1` (644 payload files).
- Upload the archive and `deploy/vaydu-develop-release/verify-and-drill-f949a14.sh` to
  `/home/edsadmin`. From an authenticated host terminal run this exact command:

```bash
bash /home/edsadmin/verify-and-drill-f949a14.sh
```

The complete script verifies archive/internal checksums, runs the shipped silent-failure
regressions, checks the actual API/web baseline and PREREQ, records live configuration, and runs
the drill against `/home/edsadmin/vaydu-develop-backups/develop-before-release-e4a64c1-20261114T201704Z.dump`.
It requires all nine suites, data preservation, preamble cleanup, exact public-schema rollback,
PREREQ after rollback and pre-release data preservation. It checks both drill and log exit statuses.
Expected final line: `HOST_DRILL_GATE_PASSED evidence=...`. It does not deploy or activate anything.
Keep the output and live-config evidence for review before proceeding.

Globals restoration now omits only exact standalone CREATE ROLE statements matching roles
inventoried in the fresh disposable container, once each. ALTER ROLE, grants and all other SQL
remain strict. Globals uses ON_ERROR_STOP; pg_restore uses --exit-on-error; both exit statuses
are checked explicitly. No error-text matching establishes restore success.

# Historical develop release `3c91991`: database, API and web

**Authorised by the user on 2026-11-12, for shared DEVELOP only.** Production and go-live stay separately
gated. This release enables nothing: no cash-ride market, no cancellation-fee policy, no PIN policy, no
campaign. Those all wait on the decisions in `docs/ROADMAP_COMPLETION_MATRIX.md`.

Run these steps on `edsadmin@87.106.64.25`; the agent has no host access. Stop at the first result that
differs from **Expected** and paste the output.

| | Value |
|---|---|
| Running now (inventory `20261112T203946Z`) | API `movabi-api:release-f6e8c00-topup` (SOURCE_SHA f6e8c00), web `movabi-web:release-f6e8c00-topup-linux` |
| Package | `release/vaydu-develop-3c91991-release-linux.tar.gz` |
| SHA-256 | `e398335d55c0400ff6b165b520ff7fe4b770aeb8cf42d894468f1831c0824caa` |
| API source | `3c91991` (shipped API files identical to `26863d7`); web built on Linux at `d472487` from identical web inputs |
| Database | 7 pending migrations as **one transaction** (`release-up.sql`); exact rollback `release-down.sql` |
| New tags | API `movabi-api:release-3c91991`, web `movabi-web:release-3c91991-linux` |
| Order | 0 upload → 1 verify → 2 predeploy → 3 backup → 4 restore drill → 5 gate + dry run → 6 migrate → 7 API → 8 web → 9 checks |

## What this release changes

**Database:** `20261266000000`–`20261266300000` (cash-ride chain, all markets disabled), `20261267000000` (D9
driver cancellation attribution), `20261268000000` (cancellation-fee quote; no policy enabled) and `20261269000000`
(the merge that keeps the roadmap cash rules). Develop already has the other 42 migrations; this was
reconciled against the live schema. Batch 1E (`20261248000000`) is already applied history and is
never run.

**API (29 files vs running):** listed in `release/expected-api-changes-3c91991.txt`.
- Top-up 3DS resume and form reset.
- D9 metrics.
- Cancellation-fee quote, collection and compensation.
- Cash-ride code, unused while every market is off.
- Triage fixes:
  - dispatch, go-online and approval had refused every driver;
  - negotiation acceptance now runs the payout gate;
  - the submission path now runs the canonical checks;
  - card authorisation fails closed if the payable lookup errors.
- Intent-aware search. Mapbox `permanent=false` is unchanged.

**Web:** 97 of 368 files (48 renamed bundles plus `index.html`), listed in
`release/expected-web-changes-3c91991.txt`.

## Evidence before you start (local, at `3c91991`)

- **Live-schema rehearsal:** `scripts/release/rehearse-live-upgrade.sh`, on a postgres:15.1 copy of
  develop's live schema. **26/26** checks pass:
  - an injected failure leaves the schema untouched;
  - the dry run changes nothing;
  - the combined file equals the 7 files applied one by one, and equals the reconciled chain;
  - the cash, merge, D9 and fee suites pass (140 checks);
  - release-down restores the **exact** pre-release schema;
  - re-applying works and the release is idempotent;
  - `PREREQ.sql` and `VERIFY.sql` each accept and refuse the right state.
- **Route rehearsal:** real GoTrue, PostgREST and the API routers on the live schema plus the release.
  It passes with the new source and with the **running f6e8c00 API**, so applying the migrations
  before the new API is safe.

## 0) Upload (Windows PowerShell, one line)

```
scp "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\release\vaydu-develop-3c91991-release-linux.tar.gz" "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\release\vaydu-develop-3c91991-release-linux.tar.gz.sha256" edsadmin@87.106.64.25:~/
```

## 1) Verify the package and the host scripts (read-only)

```
cd ~
sha256sum -c vaydu-develop-3c91991-release-linux.tar.gz.sha256
sha256sum host-predeploy.sh host-rollback.sh rollout-develop-52097ef.sh
mkdir -p ~/vaydu-release-3c91991 && tar -xzf vaydu-develop-3c91991-release-linux.tar.gz -C ~/vaydu-release-3c91991
REL=~/vaydu-release-3c91991/vaydu-develop-3c91991-release-linux
(cd "$REL" && sha256sum -c --quiet SHA256SUMS && sha256sum -c --quiet ALL_SHA256SUMS && echo BUNDLE_OK; cat SOURCE_SHA)
sha256sum "$REL/host-db-release.sh"
```

**Expected:**
- `OK`.
- Exactly these three host-script hashes:
  `306adf03c8742a3433a7737aabc2ea9dca1247eaffe6b7d7b0aab8a8ad644af2  host-predeploy.sh`,
  `0259bd51acdcc09f41be998efce3bdbb982cccbe0faf090182271cd23c24b96e  host-rollback.sh`,
  `54de2e6be3bad38ede117414fd6ca5480b110b10541c4c5b4e81c7ed34c6675d  rollout-develop-52097ef.sh`.
- `BUNDLE_OK` and `3c91991`.
- host-db-release.sh `d47fd59c0dab0d3913f2e9f4acfba2d31a01c8c67175a9a7276ee91790fe8c40`.

## 2) Predeploy record (read-only)

```
bash host-predeploy.sh vaydu-develop-3c91991-release-linux.tar.gz
PRE=$(ls -td ~/vaydu-topup-fix-predeploy-* | head -1); echo "$PRE"
cat "$PRE/running-source-sha.txt"; grep -E 'API_IMAGE=|WEB_IMAGE=' "$PRE/previous.env"
wc -l < "$PRE/api-changes.txt"; wc -l < "$PRE/web-changes.txt"; cat "$PRE/api-changes.txt"
```

**Expected:**
- `f6e8c00`.
- `API_IMAGE=movabi-api:release-f6e8c00-topup` and `WEB_IMAGE=movabi-web:release-f6e8c00-topup-linux`.
- `29` API changes and `97` web changes; the API list is identical to `release/expected-api-changes-3c91991.txt`.

The script's own "Expected (fix only)" text refers to an older release; ignore it. **Keep `$PRE`:** it is
the application rollback record.

## 3) Database backup (no change)

```
bash "$REL/host-db-release.sh" "$REL" backup
DUMP=$(ls -t ~/vaydu-develop-backups/develop-before-release-3c91991-*.dump | head -1); echo "$DUMP"
```

**Expected:** `BACKUP_OK <path> size=… table-data-entries=<n>0 tables-counted=<n>`. It also writes
`.globals.sql` (roles, no passwords), `.counts.tsv` (exact row counts), `.image` and `.sha256`.

## 4) Restore drill and real-data rehearsal (throwaway container, no network; develop untouched)

```
bash "$REL/host-db-release.sh" "$REL" drill "$DUMP"
```

**Expected:** every line `PASS`:
- the restored row counts equal the backup's;
- `PREREQ`, `release-up.sql` and `VERIFY` pass on the restored copy, with real data;
- the 7 behaviour suites pass;
- release-down restores the exact pre-release schema;
- then `DRILL_DONE`.

`pg_restore` error lines are listed. Paste them: Supabase-internal objects that already exist in a
fresh database are expected, but anything in `public` is not. The drill is also the first restore
test of a current develop backup (roadmap row 9b).

## 5) Gate and dry run on develop (no change)

```
bash "$REL/host-db-release.sh" "$REL" prereq
bash "$REL/host-db-release.sh" "$REL" dryrun
```

**Expected:** `PREREQ OK: 4 replaced functions match, 11 release functions absent, cash tables absent, no
cash-mode jobs`, the payment_status values, then `DRYRUN_OK` and `PASS: develop still in the pre-release
state`.

## 6) Migrate (one transaction)

```
bash "$REL/host-db-release.sh" "$REL" apply
```

**Expected:**
- `PREREQ OK …`;
- `RELEASE_APPLIED <time>`;
- `VERIFY OK: release schema present (15 functions), no cash-ride market enabled`;
- `enabled_cash_markets 0` and `enabled_cancellation_policies 0`.

If it fails, PostgreSQL rolls the whole release back; rerun `prereq` to confirm, then STOP. The
running f6e8c00 API works with the migrated schema (proven), so there is no hurry to deploy the API.

## 6b) Reload the PostgREST schema cache

This step was missed in the 3c91991 run; `release-up.sql` has included it since.

```
docker exec -i movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -c "NOTIFY pgrst, '\''reload schema'\''"'
sleep 3; docker logs --since 1m movabi-develop-rest 2>&1 | tail -5
```

Without it, PostgREST keeps its pre-migration schema cache. Every RPC the release adds
(`cancel_job_with_actor`, `cancellation_fee_quote`, `driver_offer_metrics_v2` and the rest) then fails
with "not in the schema cache". If no reload line appears, run `docker restart movabi-develop-rest`
(it is stateless).

## 7) API (wallet override and every other compose override preserved)

```
cd ~
export ARCHIVE=vaydu-develop-3c91991-release-linux.tar.gz BUNDLE_DIR=vaydu-develop-3c91991-release-linux EXPECTED_SOURCE_SHA=3c91991
API_TAG=release-3c91991 WEB_TAG=release-f6e8c00-topup-linux bash rollout-develop-52097ef.sh --deploy-api-only --preflight
API_TAG=release-3c91991 WEB_TAG=release-f6e8c00-topup-linux bash rollout-develop-52097ef.sh --deploy-api-only
docker inspect -f '{{.Config.Image}} {{.State.Status}}' movabi-develop-api
docker exec movabi-develop-api cat /app/SOURCE_SHA
curl -s https://movabi-api-develop.apps.evolsolution.com/health
docker logs --since 5m movabi-develop-api 2>&1 | grep -iE 'error|fatal' | head
```

The rollout runs this release's `VERIFY.sql` before it builds anything, so it refuses to deploy if
step 6 is not in place.

**Expected:**
- `movabi-api:release-3c91991 running`;
- `3c91991`;
- `{"status":"ok"}`;
- no new errors.

**On failure:** `bash host-rollback.sh "$PRE" api`.

## 8) Web

```
API_TAG=release-3c91991 WEB_TAG=release-3c91991-linux bash rollout-develop-52097ef.sh --deploy-web-only
docker ps --filter label=com.docker.compose.service=web --filter label=com.docker.compose.project=movabi-develop --format '{{.Image}} {{.Status}}'
```

**Expected:** `movabi-web:release-3c91991-linux Up …`. Then tell the agent; it hash-compares the live web
assets with the bundle over HTTPS. **On failure:** `bash host-rollback.sh "$PRE" web`.

## 9) After deployment

```
bash "$REL/host-db-release.sh" "$REL" verify
docker exec movabi-develop-api printenv | grep -E '^VAYDU_(CASH_RIDE_BOOKING|DRIVER_TOPUP_API|MAPBOX_GEOCODING_V23)='
```

**Expected:** `VERIFY OK`, no `VAYDU_CASH_RIDE_BOOKING`, top-up and geocoding flags unchanged. Then the
acceptance journeys below.

## Recovery plan (application rollback alone does not undo database changes)

| Where it failed | What to do | Effect |
|---|---|---|
| Steps 1–5 | Nothing to undo | Develop unchanged |
| Step 6 errors | Nothing: the single transaction rolled back. Run `prereq` to confirm | Develop unchanged |
| After step 6, before step 7 | Keep the schema, or `host-db-release.sh "$REL" rollback` | Rollback restores develop's exact pre-release schema (rehearsed on the live schema and in the step-4 drill). The f6e8c00 API runs on either. |
| Step 7/8 or acceptance | `bash host-rollback.sh "$PRE" api` / `web` / `both` restores the recorded f6e8c00 images | f6e8c00 is proven to work on the migrated schema, so this is safe without a DB change |
| Need the old schema too | First roll the app back to f6e8c00, **then** `host-db-release.sh "$REL" rollback`; it must end with `PREREQ OK` | New release tables and functions are dropped. Their data is lost: cash holds and fee quotes, empty while nothing is enabled. Cancellation actor metadata on jobs is kept. |
| Data corruption (last resort; a separate decision) | Restore `$DUMP` into a **new** database, stop the API, repoint and verify with `.counts.tsv`. Never restore over `movabi_develop` in place. | Loses every write after the backup. Only on explicit instruction. |

## Acceptance after deployment (fill in with evidence)

| Journey | How | Result |
|---|---|---|
| Live web = bundle | agent: HTTPS asset hashes vs `mobile/browser` | |
| Health / logs | step 7 | |
| Real landmark, business and category search; `permanent=false` | `scripts/verify-server-place-search.cjs` in the API container (must now pass the POI checks) | |
| Driver top-up (Stripe test card): one credit, form closes and resets, balance and history refresh | GB test driver; then `DEVELOP-LEDGER-AND-CASH-RIDE-CHECKS.txt` section 1 | |
| Cash-ride gate stays off | Driver Wallet shows "not enabled"; customer sees no cash option; `enabled_cash_markets 0` | |
| D9 metrics on the driver dashboard and in the admin driver modal | test driver accepts then cancels one test job | |
| Cancellation fee absent while no policy is enabled; customer cancel shows "no fee" | customer test booking | |
| Driver inspection / submission (canonical checks) | test driver application | |
| Completion PIN | **not enabled** (D5) | n/a |

## Follow-up release `c972037` (API only, 2026-11-13)

Two fixes, decided by the user, both for gaps that predate 3c91991:
- **D15:** the inspection market is auto-assigned from the registration market.
- **Payment-account status without the setup module:** GB drivers get their Stripe status instead of a
  503; every setup action stays 503.

The release has no database change. The web is byte-identical to 3c91991, so it is not redeployed.

| | Value |
|---|---|
| Package | `release/vaydu-develop-c972037-release-linux.tar.gz`, sha256 `ad9a90019579f7ae34357351abf6e77287d99b5c6e94afe290b9d943952fb3f5` |
| vs running API 3c91991 | 2 files CHANGED: `server/routes/driver-payment-account-develop.routes.ts`, `server/routes/verification.routes.ts` |
| vs running web | 0 files |
| Rollback record | the new `$PRE` from `host-predeploy.sh`; the image to return to is `movabi-api:release-3c91991` |

```
sha256sum -c vaydu-develop-c972037-release-linux.tar.gz.sha256
bash host-predeploy.sh vaydu-develop-c972037-release-linux.tar.gz
PRE2=$(ls -td ~/vaydu-topup-fix-predeploy-* | head -1); cat "$PRE2/running-source-sha.txt"; cat "$PRE2/api-changes.txt"; wc -l < "$PRE2/web-changes.txt"
export ARCHIVE=vaydu-develop-c972037-release-linux.tar.gz BUNDLE_DIR=vaydu-develop-c972037-release-linux EXPECTED_SOURCE_SHA=c972037
API_TAG=release-c972037 WEB_TAG=release-3c91991-linux bash rollout-develop-52097ef.sh --deploy-api-only
```

Expected: running `3c91991`; exactly the 2 API files above; `0` web changes; `VERIFY OK`; then
`movabi-api:release-c972037` running.

On failure: `bash host-rollback.sh "$PRE2" api` returns to `movabi-api:release-3c91991`. No database change
is involved.

## Follow-up release `39fc5ce` (API + web, 2026-11-13)

**Vehicle inspection in readiness and enforcement.** The review screen shows "Vehicle details" and
"Vehicle inspection" as separate sections. Inspection reads "Missing photos" until every required slot
has a saved upload, and admin approval is tracked separately. The backend now requires the applicable
inspection at submission, admin approval, go-online and job acceptance:
- bicycles: front, rear and side;
- other vehicles: 6 slots.

It also carries `c972037` (D15 and payment-account status) if that release was not deployed.

The release has no database change: it uses the existing inspection tables and RPCs.

**Behaviour change on develop:** a driver who is already approved but has no admin-approved photos for
the current vehicle revision can no longer go online or accept jobs. They see "Upload and get approval
for all required vehicle inspection photos before accepting work." This is the intended enforcement.
Test drivers need their photos uploaded and approved in admin.

| | Value |
|---|---|
| Package | `release/vaydu-develop-39fc5ce-release-linux.tar.gz`, sha256 `af0c6a6958c859c03ef02389a9bb20ed0f4ea75006ad71a0567e13e4d3d9e39b` (web built on Linux from 39fc5ce) |
| vs c972037 API | 7 files: `server/routes/{booking,driver-onboarding,market-availability,verification}.routes.ts`, `server/services/driver-requirement.service.ts`, new `server/services/driver-inspection-{evidence,progress}.ts` (plus `driver-payment-account-develop.routes.ts` if the host still runs 3c91991) |
| Release SQL | byte-identical to 3c91991/c972037 (no database step) |
| Running before | `c972037` (or `3c91991` if c972037 was not deployed) |
| Rollback record | the new `$PRE3` from `host-predeploy.sh`; the images to return to are the ones it records |

```
sha256sum -c vaydu-develop-39fc5ce-release-linux.tar.gz.sha256
bash host-predeploy.sh vaydu-develop-39fc5ce-release-linux.tar.gz
PRE3=$(ls -td ~/vaydu-topup-fix-predeploy-* | head -1); cat "$PRE3/running-source-sha.txt"; cat "$PRE3/api-changes.txt"; wc -l < "$PRE3/web-changes.txt"
export ARCHIVE=vaydu-develop-39fc5ce-release-linux.tar.gz BUNDLE_DIR=vaydu-develop-39fc5ce-release-linux EXPECTED_SOURCE_SHA=39fc5ce
API_TAG=release-39fc5ce WEB_TAG=release-3c91991-linux bash rollout-develop-52097ef.sh --deploy-api-only
docker exec movabi-develop-api cat /app/SOURCE_SHA; curl -s https://movabi-api-develop.apps.evolsolution.com/health
API_TAG=release-39fc5ce WEB_TAG=release-39fc5ce-linux bash rollout-develop-52097ef.sh --deploy-web-only
docker ps --filter label=com.docker.compose.service=web --filter label=com.docker.compose.project=movabi-develop --format '{{.Image}} {{.Status}}'
```

**Expected:**
- the running SHA is printed;
- the API changes are the files listed below;
- the web changes count is non-zero;
- `VERIFY OK`;
- `39fc5ce` and `{"status":"ok"}`;
- `movabi-web:release-39fc5ce-linux Up …`.

**On failure:** `bash host-rollback.sh "$PRE3" api` (or `web` / `both`). No database change is involved.

**Acceptance:** the agent hash-compares the live web assets with the bundle. Then, on your own driver
application:
- the review screen shows "Vehicle inspection — Missing photos" with the right count;
- uploading all slots changes it to "Under review";
- admin approves each photo in the admin app;
- the section shows "Complete", and submission and going online are allowed.

## Follow-up release `be0c761` (API + web, 2026-11-13)

This release contains everything in `39fc5ce` (inspection readiness and enforcement, separate review
sections), plus:
- **Area 8:** market readiness reports collection, payout and cash ride as separate states. It is tenant-scoped and fails closed.
- **Area 1c:** a driver handoff no longer shows the driver's own words to the customer.
- **Driver Setup:** fits 320 px phones.
- **Read-only checks:** `host-live-config.sh` + `live-config.sql`, and `trace-driver-inspection.sql`.

There is **no database change** (release SQL byte-identical) and **nothing is switched on**.

| | Value |
|---|---|
| Package | `release/vaydu-develop-be0c761-release-linux.tar.gz`, sha256 `a125f43a1e6c4217f00f2b266d291525827bb79a78b7d791170f5e54987b04a2` (web built on Linux from be0c761) |
| vs 39fc5ce API | 3 files: `server/routes/admin.routes.ts`, `server/routes/booking.routes.ts`, `server/services/market-readiness.service.ts` (more if the host still runs c972037 or 3c91991: `host-predeploy.sh` lists them) |
| vs 39fc5ce web | 7 files (Driver Setup page) |
| Rollback | `$PRE4` from `host-predeploy.sh` records the running images; `host-rollback.sh "$PRE4" api|web|both` returns to them. No database step is involved. |

```
sha256sum -c vaydu-develop-be0c761-release-linux.tar.gz.sha256
tar xzf vaydu-develop-be0c761-release-linux.tar.gz
(cd vaydu-develop-be0c761-release-linux && bash host-live-config.sh) > live-config-before-be0c761.txt 2>&1
bash host-predeploy.sh vaydu-develop-be0c761-release-linux.tar.gz
PRE4=$(ls -td ~/vaydu-topup-fix-predeploy-* | head -1); cat "$PRE4/running-source-sha.txt"; cat "$PRE4/api-changes.txt"; wc -l < "$PRE4/web-changes.txt"
export ARCHIVE=vaydu-develop-be0c761-release-linux.tar.gz BUNDLE_DIR=vaydu-develop-be0c761-release-linux EXPECTED_SOURCE_SHA=be0c761
API_TAG=release-be0c761 WEB_TAG=release-3c91991-linux bash rollout-develop-52097ef.sh --deploy-api-only
docker exec movabi-develop-api cat /app/SOURCE_SHA; curl -s https://movabi-api-develop.apps.evolsolution.com/health
docker logs --since 5m movabi-develop-api 2>&1 | grep -iE 'error|fatal' | head
API_TAG=release-be0c761 WEB_TAG=release-be0c761-linux bash rollout-develop-52097ef.sh --deploy-web-only
docker ps --filter label=com.docker.compose.service=web --filter label=com.docker.compose.project=movabi-develop --format '{{.Image}} {{.Status}}'
(cd vaydu-develop-be0c761-release-linux && bash host-live-config.sh) > live-config-after-be0c761.txt 2>&1
diff <(grep -v '^== taken at\|^== images\|movabi-develop\|source sha' live-config-before-be0c761.txt) <(grep -v '^== taken at\|^== images\|movabi-develop\|source sha' live-config-after-be0c761.txt) && echo "SWITCHES UNCHANGED"
```

**Expected:**
- `VERIFY OK` from the rollout;
- `be0c761` and `{"status":"ok"}`, with no new errors;
- `movabi-web:release-be0c761-linux Up …`;
- `SWITCHES UNCHANGED` (this release turns nothing on);
- every Mapbox `permanent` occurrence in the code check reads `permanent=false`/`permanent: false`.

**On failure:** stop, then `bash host-rollback.sh "$PRE4" api` (or `web` / `both`).

**Paste back:** `live-config-after-be0c761.txt`, plus the outputs above. The agent then:
- hash-compares the live web with the bundle;
- checks the readiness report for GB and NG;
- walks your Driver Setup review (inspection "Missing photos", then upload, then admin approval).

## Release 2: API + web + DATABASE (bundle `c5526f6`, 2026-11-14)

**This release has a database step.** The "no database step" instructions of `be0c761`, `39fc5ce` and
`c972037` do not apply. Earlier release-2 bundles `2381e96` and `4509243` were never deployed and are
superseded; `c5526f6`, never deployed, replaced `e4a64c1` after the restore drill failed on the host (see step 2). Stop at the first result that differs from **Expected**, and paste every output.

### What it is

| | Value |
|---|---|
| Archive | `vaydu-develop-c5526f6-release-linux.tar.gz` |
| Archive sha256 | `7c99e467dd8b67284970324aad9e9f0bc5a06ae59b603770e0de6e560ba47b62` |
| Source | `c5526f6` (API source byte-identical to the commit; web built on Linux from `d9fea62`, whose web inputs are identical) |
| `release-up.sql` | `1d56e0a5a9d3b5a8ae4b35e5b6011ff4cbec113a5d6d7dd6dc9dfd8b91b9a298` (byte-identical to the rehearsed file) |
| `release-dryrun.sql` | `3c097d50443eb8a662299ca423d5bbc173f98decb402385c8b957043f7ec6ec1` |
| `release-down.sql` | `7941596e4c9bb218864adcfe9d043deff82c4213ebebff0468f166fe1caf6b10` |
| `PREREQ.sql` / `VERIFY.sql` | `b4d32be4bd45c868099e792b6726069352ab6a0425d6f65f34215cbb55ec6a7b` / `4bccce60d008e6795b9e5c25012846df0deb1f4297a02ba24ac81950a95c83ab` |
| `host-db-release.sh` | `7c5d018f254d5908c28290be036030dc2ff42f39b0579a577421c2a20d520749` (corrected drill: fails closed, applies the preamble, checks data preservation) |
| `drill-preamble.sql` / `tests/SUITES.txt` | `47236799eb0ac8159a8e30c7a17596c03316b0ce200f45fc8eb17f4dc61abdc0` / `5b83cedfb1751ad043835284127a9222d61ac49e83fdb6ff39f75123b1f16b1c` (9 suites) |
| Host scripts (unchanged) | `host-predeploy.sh` `306adf03…f2`, `host-rollback.sh` `0259bd51…6e`, `rollout-develop-52097ef.sh` `54de2e6b…5d` (full values in step 1 above) |

**Code, database and activation are identical to `e4a64c1`:** the same `release-up.sql`, `PREREQ.sql` and `VERIFY.sql`, and the same API and web. Only the drill tooling (`host-db-release.sh`, `drill-preamble.sql`, `tests/SUITES.txt`) changed.

**Contents:**
- inspection readiness, enforcement and layout (2a);
- the server's no-driver reason (1c);
- separate readiness states (8);
- the Driver Setup narrow-phone fix;
- per-driver PIN control (3);
- the promo and referral money fixes (7a, 7b);
- per-market matching (P7) and surge (P8);
- the ops alert sender (P14);
- the GB activation scripts.

**Not included:** the P3 debt reminders, P10 account-sharing detection, P11 driver bonus and P12 exemptions. They are approved but not built (matrix).

### Migration order (one transaction, `release-up.sql`; release 1 must already be applied exactly)

| # | Migration | Effect on develop |
|---|---|---|
| 1 | `20261270000000_capture_develop_inspection_drift.sql` | No change: develop already has the column and the 6-argument function. They are created only when absent and never dropped. |
| 2 | `20261270100000_completion_pin_effective.sql` | Adds 3 functions and 2 triggers on `jobs`: the PIN policy is frozen at assignment, and a PIN is minted when a driver override needs one. |
| 3 | `20261270200000_referral_fare_minor_units.sql` | Replaces `earn_referral` (develop's body `98e50e33…` becomes `bbc10e72…`): fares converted to minor units exactly, rewards rounded down, other market or currency refused. |
| — | `NOTIFY pgrst, 'reload schema'` | Delivered at COMMIT only. |

### 0. Upload (from Windows)

```
scp "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\release\vaydu-develop-c5526f6-release-linux.tar.gz" "C:\Users\fedri\source\repos\Movabi-topup-on-2385da7\release\vaydu-develop-c5526f6-release-linux.tar.gz.sha256" edsadmin@87.106.64.25:~/
```

### 1. Verify the package, the host scripts and what is running (read-only)

```
cd ~
sha256sum -c vaydu-develop-c5526f6-release-linux.tar.gz.sha256
sha256sum host-predeploy.sh host-rollback.sh rollout-develop-52097ef.sh
mkdir -p ~/vaydu-release-c5526f6 && tar -xzf vaydu-develop-c5526f6-release-linux.tar.gz -C ~/vaydu-release-c5526f6
B=~/vaydu-release-c5526f6/vaydu-develop-c5526f6-release-linux
(cd "$B" && sha256sum -c --quiet SHA256SUMS && sha256sum -c --quiet ALL_SHA256SUMS && sha256sum -c --quiet RELEASE-MIGRATIONS.sha256 && echo BUNDLE_OK; cat SOURCE_SHA; cat ORDER.txt)
docker inspect -f '{{.Config.Image}} {{.State.Status}}' movabi-develop-api; docker exec movabi-develop-api cat /app/SOURCE_SHA
docker ps --filter label=com.docker.compose.service=web --filter label=com.docker.compose.project=movabi-develop --format '{{.Image}} {{.Status}}'
bash "$B/host-db-release.sh" "$B" prereq
(cd "$B" && bash host-live-config.sh) > ~/live-config-before-r2.txt 2>&1; grep -A3 "API flags" ~/live-config-before-r2.txt | head -4
```

**Expected:**
- `vaydu-develop-c5526f6-release-linux.tar.gz: OK`.
- The three host-script hashes from step 1 above.
- `BUNDLE_OK`, then `c5526f6`, then the three migrations in order.
- The API runs one of `be0c761`, `39fc5ce`, `c972037` or `3c91991`, status `running`.
- `PREREQ OK: release 1 exact, release 2 not applied`.

**On failure:** stop. Nothing has changed.

### 2. Backup and restore drill (no change to develop)

```
bash "$B/host-db-release.sh" "$B" backup
DUMP=$(ls -t ~/vaydu-develop-backups/develop-before-release-$(cat "$B/SOURCE_SHA")-*.dump | head -1); echo "$DUMP"
bash "$B/host-db-release.sh" "$B" drill "$DUMP"; echo "DRILL_EXIT=$?"
```

**Expected:**
- `BACKUP_OK <dump>`.
- The drill uses a throwaway container with no network. Develop is never touched. It prints:
  - `PASS: pg_restore reported no errors`;
  - `PASS: restored row counts equal the backup's`;
  - `PASS` for PREREQ, release-up and VERIFY;
  - **`PASS` for each of the 9 suites listed in `tests/SUITES.txt`, then `suites passed: 9 of 9`**;
  - `PASS: restored data byte-identical after the suites`;
  - `PASS: preamble left nothing behind`;
  - `PASS` for release-down, the exact schema, PREREQ again, and `restored data byte-identical to before the release`;
  - `DRILL_OK: …`;
  - `DRILL_EXIT=0`.

**Any** failure prints `FAIL: …`, then `DRILL_FAILED`, and **exits 1**. Stop there and paste the output.

**Why the `e4a64c1` drill failed** (reconciled 2026-11-14):
- **The fix never reached the shipped drill.** The earlier real-data fix (`drill-preamble.sql`) was applied only by the separate step-4b script
  `host-drill-suites.sh`. It was never added to `host-db-release.sh drill`, and the bundle did not ship it.
- **The drill failed open.** It also printed `DRILL_DONE` and exited 0 with failing suites.
- **What changed:**
  - the drill now applies `drill-preamble.sql` inside each suite's rolled-back transaction;
  - it refuses a bundle whose suites differ from `tests/SUITES.txt`;
  - it checks that restored data is unchanged, and fails closed.
- **Evidence:** reproduced and verified locally on develop's exact image with develop-like data
  (`docs/roadmap-evidence/host-drill-reproduction-2026-11-14.md`).
- **The merge-suite failures** (23503, MB003, no reservation, CE006, CE002) all came from develop owning the
  ride/delivery service-type slugs. The suite's fixture service types were skipped, and that cascaded through the merge suite.

### 3. Dry run on develop's real data (ends in ROLLBACK)

```
bash "$B/host-db-release.sh" "$B" dryrun
```

**Expected:** `DRYRUN_OK (rolled back; develop unchanged)` and `PASS: develop still in the pre-release state`.

### 4. Record the running images, then apply release 2

```
bash host-predeploy.sh vaydu-develop-c5526f6-release-linux.tar.gz
PRE6=$(ls -td ~/vaydu-topup-fix-predeploy-* | head -1); echo "$PRE6"; cat "$PRE6/running-source-sha.txt"; grep -E 'API_IMAGE=|WEB_IMAGE=' "$PRE6/previous.env"
bash "$B/host-db-release.sh" "$B" apply
sleep 3; docker logs --since 2m movabi-develop-rest 2>&1 | tail -3
```

**Expected:**
- `RELEASE_APPLIED`, then `VERIFY OK: release 1 + release 2 present (20 functions, 2 triggers), D12 captured, no cash-ride market outside GB/GBP`.
- PostgREST logs a schema reload. If not, run `docker restart movabi-develop-rest`.

**On failure:** the one transaction rolled back by itself. Run `bash "$B/host-db-release.sh" "$B" prereq` to confirm develop is unchanged.

### 5. API, then web (overrides preserved; the rollout runs release 2's VERIFY before building)

```
export ARCHIVE=vaydu-develop-c5526f6-release-linux.tar.gz BUNDLE_DIR=vaydu-develop-c5526f6-release-linux EXPECTED_SOURCE_SHA=c5526f6
API_TAG=release-c5526f6 WEB_TAG=release-3c91991-linux bash rollout-develop-52097ef.sh --deploy-api-only
docker exec movabi-develop-api cat /app/SOURCE_SHA; curl -s https://movabi-api-develop.apps.evolsolution.com/health
docker logs --since 5m movabi-develop-api 2>&1 | grep -iE 'error|fatal' | head
API_TAG=release-c5526f6 WEB_TAG=release-c5526f6-linux bash rollout-develop-52097ef.sh --deploy-web-only
docker ps --filter label=com.docker.compose.service=web --filter label=com.docker.compose.project=movabi-develop --format '{{.Image}} {{.Status}}'
bash "$B/host-db-release.sh" "$B" verify
(cd "$B" && bash host-live-config.sh) > ~/live-config-after-r2.txt 2>&1
diff <(grep -vE '^== taken at|movabi-develop|source sha|^== health' ~/live-config-before-r2.txt) <(grep -vE '^== taken at|movabi-develop|source sha|^== health' ~/live-config-after-r2.txt) && echo SWITCHES_UNCHANGED
```

**Expected:**
- `c5526f6` and `{"status":"ok"}`, with no new errors.
- `movabi-web:release-c5526f6-linux Up`.
- `VERIFY OK`.
- `SWITCHES_UNCHANGED`: the deploy itself turns nothing on, and `permanent=false` stays.

**On failure:** `bash host-rollback.sh "$PRE6" api` (or `web` / `both`) returns to the recorded images. The previous API runs on the release-2 schema, so the database can stay.

### 6. Turn on the approved GB values (P1, P4–P8)

```
docker exec -i movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -P pager=off' < "$B/activation/activate-gb.sql"
```

**Expected:**
- One `cancellation` row per GB tenant: `300/300/120/<50% of the GB minimum fare>`.
- `FIRST5GB` and `REFERGB`, GB/GBP.
- `setting` rows whose GB value is:
  - `"required"` (PIN);
  - the P7 weights (matching);
  - `enabled true, maxSurge 1.5, trafficEnabled false` (surge).
- `non-GB rows enabled (must be 0) | 0`.

If it stops, the message says which check failed, and nothing has changed. Undo: `deactivate-gb.sql`.

### 7. Cash rides for ONE GB test driver, and the ops alerts (API configuration)

```
docker exec -i movabi-develop-db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -U supabase_admin -d movabi_develop -P pager=off -v driver_email="GB_TEST_DRIVER_EMAIL"' < "$B/activation/activate-gb-cash.sql"
cp ~/vaydu-develop-overrides/docker-compose.develop-wallet.override.yml ~/vaydu-develop-overrides/docker-compose.develop-wallet.override.yml.bak-$(date -u +%Y%m%dT%H%M%SZ)
```

**Expected:** only `GB | GBP | t`.

Then add these lines to the **api** service's `environment:` in
`~/vaydu-develop-overrides/docker-compose.develop-wallet.override.yml`, using the same style as the existing entries
there (`KEY: "value"` or `- KEY=value`):

```
VAYDU_CASH_RIDE_BOOKING: "true"
VAYDU_OPS_ALERTS: "true"
VAYDU_OPS_ALERT_RECIPIENTS: "<the address you choose>"
```

The address is never committed to the repository. Then redeploy the API with the same bundle and check:

```
API_TAG=release-c5526f6 WEB_TAG=release-c5526f6-linux bash rollout-develop-52097ef.sh --deploy-api-only
docker exec movabi-develop-api printenv | grep -E '^VAYDU_(CASH_RIDE_BOOKING|OPS_ALERTS)='
docker logs --since 2m movabi-develop-api 2>&1 | grep '\[OpsAlert\]'
docker exec movabi-develop-api node server/ops/send-test-ops-alert.cjs
```

**Expected:**
- Both variables are `true`.
- `[OpsAlert] schedule on: every 15 min, recipients 1`.
- `DELIVERED to 1 recipient(s)`, and the test email arrives.

**Undo:**
- `deactivate-gb-cash.sql`;
- remove the three lines and redeploy the API (restore the `.bak` copy if needed).

### 8. Post-deploy journeys (these, and only these, move features to Verified)

1. **Web:** the agent hash-compares the live web assets with `mobile/browser`.
2. **2a:** your review shows **Vehicle details** and **Vehicle inspection — Missing photos (0 of 6 uploaded)**.
   A GB test driver then uploads 6 photos and sees **Under review**; an admin approves them and the driver sees **Complete**.
3. **3 (PIN):**
   1. In Admin → Drivers → Completion PIN, set **Not used** with a reason, assign a job, and complete it without a PIN.
   2. Set **Follow the booking market**: the next job needs the PIN, a wrong PIN is refused, the right one completes.
   3. Check the `audit_logs` rows.
4. **6a/6b/6c:** a GB customer cancels more than 120 s after acceptance.
   - The confirmation shows £3.00, and the Stripe test capture is £3.00.
   - The driver's earnings show £2.40 (80%) once.
   - With no card authorisation, the fee becomes an open debt.
5. **7a:** a new GB customer's first booking of £8.00 or more shows and charges 5%, up to £5.00. A second booking gets no discount.
6. **7b:** a referee's qualifying ride (£8.00 or more) credits the referrer 5%, up to £5.00, once.
7. **1b (P7) and 4b (P8):** a GB dispatch with two drivers ranks as configured. A quote at high demand shows a surge of at most 1.5×, and traffic shows but does not change the fare. An NG quote is unchanged.
8. **5b:** the selected driver takes a GB cash ride through to completion, and the ledger shows the 2.50 reservation settled. A second GB driver cannot take it.
9. **8 / 1c / layout:** the GB and NG readiness reports; a no-driver reason; Driver Setup on a narrow phone.
10. **9a:** the test alert in step 7 arrived.

### Compatibility

- **Order: database first, then API.** VERIFY in the rollout refuses the API before the migration.
- **The previous API on the release-2 schema** (reasoned from the code, not executed):
  - it writes `completion_pin_required` and reads `effective_completion_pin_policy` (unchanged) at completion;
  - the triggers set `completion_pin_required` to the frozen policy, so its apps behave consistently;
  - with the old API, `earn_referral` just becomes correct.
- **Jobs already accepted when a PIN policy changes:**
  - jobs assigned after release 2 keep the policy frozen at assignment, and a reassignment re-resolves;
  - jobs assigned before release 2 read the driver's current override at completion, as before.
- **Referral rewards earned before release 2** are not recalculated.

### Rollback limits

- **Database:** `bash "$B/host-db-release.sh" "$B" rollback`, as one transaction:
  - drops the PIN triggers and functions;
  - restores develop's exact `earn_referral` (`98e50e33…`);
  - keeps the D12 objects;
  - keeps frozen PIN metadata and minted PINs, because customers may have seen them.

  PREREQ must pass afterwards. Turn the activation off **first** (`deactivate-gb*.sql`): the old `earn_referral` would pay wrong amounts.
- **Application:** `bash host-rollback.sh "$PRE6" api|web|both`.
- **Never undone by any rollback:**
  - admin PIN overrides;
  - audit rows;
  - PIN attempts;
  - fees, debts, discounts and rewards already recorded (they are valid obligations);
  - cash rides completed, together with their ledger entries.
- **Restoring the step-2 backup** loses every write made after it. It is a last resort and a separate decision: restore into a **new** database, never over `movabi_develop` in place.
