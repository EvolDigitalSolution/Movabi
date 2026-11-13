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
