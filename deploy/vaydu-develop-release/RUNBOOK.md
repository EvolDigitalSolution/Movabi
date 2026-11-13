# Develop release `3c91991`: database, API and web

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

## Next release: API + web + **DATABASE release 2** (bundle cut after the decision table is reviewed)

This release **has a database step**, so the "no database step" instructions of `be0c761` and
`39fc5ce` do **not** apply. It includes everything in `be0c761`, plus:
- **Area 3:** per-driver completion PIN control. The policy is frozen onto the job at assignment.
  - Admin control in the driver modal: tenant-scoped, a reason is required, and changes are audited.
  - The booking market's policy comes from the tenant setting, for that market only.
- **D12:** develop's out-of-band inspection objects are captured in a migration. Nothing is dropped.

The bundle is cut with `RELEASE_DIR=deploy/vaydu-develop-release-2`, so its `release-*.sql`, `PREREQ.sql`,
`VERIFY.sql`, `ORDER.txt` and drill suites are release 2's. Release 1 stays applied and unchanged.

### Exact migration order (one transaction, `release-up.sql`)

| # | Migration | Effect on develop |
|---|---|---|
| — | release 1 (applied 2026-11-13 09:46:47 UTC) | PREREQ requires its 15 functions to be exact |
| 1 | `20261270000000_capture_develop_inspection_drift.sql` | **No change.** The column and the 6-argument function already exist and are only created when absent. A fingerprint check aborts the transaction if develop's copy differs. |
| 2 | `20261270100000_completion_pin_effective.sql` | Adds `completion_pin_market_policy(jsonb)`, `stamp_completion_pin_policy()` and `mint_completion_pin_on_assignment()`, plus triggers `zz_stamp_completion_pin_policy` (BEFORE) and `zz_mint_completion_pin_on_assignment` (AFTER) on `jobs`. No client role can execute these functions. |
| — | `NOTIFY pgrst, 'reload schema'` | Delivered at COMMIT only |

### Evidence before it reaches develop (local, 2026-11-13)

`scripts/release/rehearse-release-2.sh` (log: `docs/roadmap-evidence/rehearse-release-2.log`) ran on PostgreSQL 15.1 with
develop's live schema plus release 1, seeded with inspection photos in every status (approved, rejected with reason,
under review, replaced, uploaded, plus the develop-only `reason` value) and an inspection storage policy:
- **Gates:** PREREQ accepts develop's state and VERIFY refuses it.
- **Atomicity:** an injected failure and the dry run leave the schema byte-identical; the release applies as one transaction.
- **D12 on develop:**
  - every pre-existing function is unchanged;
  - the columns, **every photo row** (statuses, approvals, reviewers, reasons) and the table grants, RLS and policies are unchanged;
  - the **storage policies** and `storage.objects` grants are unchanged;
  - both `register_driver_inspection_photo` grants are unchanged;
  - the release SQL contains no `storage.` reference.
- **Fresh database** (no drift): it installs the column and the 6-argument function with develop's exact fingerprint
  (`f180b0b8…`, CR removed; develop's raw `65e2f700…` includes CRLF bytes) and develop's grants. Existing photo rows are
  kept, and a second apply is a no-op.
- **Suites with release 2 in place:** VERIFY 2 passes; release 1 VERIFY still passes; the PIN real-DB suite passes
  17/17; all 7 release-1 suites pass (140 checks).
- **Rollback:** release-down restores the **exact** pre-release-2 schema, and re-apply passes VERIFY.

`bike-authenticated-routes.integration.spec.ts` (real GoTrue, PostgREST and routers) passes with release 2:
- **Admin PIN routes:**
  - a driver gets 403;
  - no reason or an unknown policy gets 400;
  - another tenant's driver, or a body tenant that isn't the driver's, gets 404 and nothing is written;
  - set and read back are stored for the driver's own tenant.
- **Real admin assignment** (`assign_driver_to_job`, every trigger on) freezes `disabled|driver`. Clearing the override
  leaves the assigned job unchanged.
- **`/api/jobs/complete`:**
  - the frozen disabled job asks for no PIN and no PIN is minted;
  - a new assignment follows the market (required) and a PIN is minted;
  - the customer gets 403; a missing PIN is refused; a wrong PIN is refused and counted (`attempts 1`);
  - the correct PIN passes and is recorded once.
- **Audit:** `audit_logs` rows `admin_pin_policy_changed` and `admin_pin_policy_cleared`, each with the admin and the reason.

### Host steps (stop at the first failure)

```
sha256sum -c <bundle>.tar.gz.sha256 && tar xzf <bundle>.tar.gz && B=~/<bundle-dir>
(cd "$B" && bash host-live-config.sh) > live-config-before-r2.txt 2>&1
bash "$B/host-db-release.sh" "$B" backup                 # BACKUP_OK <dump> (+ globals, exact row counts, sha256)
bash "$B/host-db-release.sh" "$B" drill <dump>           # restore into a throwaway container: counts equal, PREREQ,
                                                         # release-up, VERIFY, 8 suites, release-down = exact schema
bash "$B/host-db-release.sh" "$B" prereq                 # PREREQ OK: release 1 exact, release 2 not applied
bash "$B/host-db-release.sh" "$B" dryrun                 # DRYRUN_OK, develop unchanged
bash host-predeploy.sh <bundle>.tar.gz; PRE5=$(ls -td ~/vaydu-topup-fix-predeploy-* | head -1)
bash "$B/host-db-release.sh" "$B" apply                  # PREREQ -> release-up (one transaction) -> VERIFY OK
docker logs --since 2m movabi-develop-rest 2>&1 | tail -3 # schema cache reloaded
# then the API and web steps exactly as in the be0c761 section, with this bundle's names and SHA
(cd "$B" && bash host-live-config.sh) > live-config-after-r2.txt 2>&1
```

### Compatibility

- **Order: database first, then API.** The rollout runs this bundle's VERIFY (release 2) before building
  anything, so it refuses to deploy the API before the migration.
- **Running API (be0c761 or earlier) on the release-2 schema** (reasoned from the code, not executed):
  - it keeps writing `completion_pin_required`, which the trigger reads as the market policy;
  - it reads `effective_completion_pin_policy` (unchanged) at completion and gets the same override the trigger used;
  - its driver and customer apps read `completion_pin_required`, which the trigger sets to the frozen policy.
- **New API on the old schema** (not supported; prevented by VERIFY): no stamping, so a driver override of
  "required" in a market that disables the PIN would have no minted PIN.
- **Jobs already accepted when a policy changes:**
  - after release 2, the policy is frozen at assignment; later override or market changes apply from that
    driver's next assignment, and a reassignment re-resolves for the new driver;
  - jobs assigned **before** release 2 carry no stamp, so the server reads the driver's current override at
    completion (as before release 2).

### Rollback limits

- **`host-db-release.sh "$B" rollback`** (release-down, one transaction):
  - drops the two triggers and three functions;
  - **keeps** every frozen job metadata value and every minted PIN, because customers may already have seen them;
  - keeps both D12 objects, by instruction.

  After that, PREREQ must pass again.
- **Application rollback:** `bash host-rollback.sh "$PRE5" api|web|both`. The previous API runs on the release-2 schema
  (see Compatibility), so the database can stay.
- **Not undone by any rollback:** admin overrides set after apply, `audit_logs` rows, PIN attempts and verifications.
- **Restoring the backup** loses every write made after it. It is a last resort and a separate decision: restore into a
  **new** database, never over `movabi_develop` in place.
