# Develop release `3c91991`: host execution record

Run by the user on the develop host (`edsadmin@87.106.64.25`); the outputs below were pasted into the
session verbatim and are copied here unedited, apart from trimming the long statement lists. They
contain no credentials.

| Item | Value |
|---|---|
| Package | `vaydu-develop-3c91991-release-linux.tar.gz`, sha256 `e398335d55c0400ff6b165b520ff7fe4b770aeb8cf42d894468f1831c0824caa` (host: `OK`) |
| Release SQL | `release-up.sql` sha256 `835edf339445830013f53c25c0af9f859230ac1bb250d66c0ea75f243fc34ed5` (verified by `RELEASE-MIGRATIONS.sha256` in every `host-db-release.sh` call) |
| Rollback record `$PRE` | `/home/edsadmin/vaydu-topup-fix-predeploy-20261113T091919Z` |
| Backup | `/home/edsadmin/vaydu-develop-backups/develop-before-release-3c91991-20261113T092040Z.dump`, sha256 `bf25eaad324db80600371bf4711fc0592f54bf0cc96862cc4880461ca489f4db` |
| Migration applied | **2026-11-13 09:46:47 UTC** (`RELEASE_APPLIED`), one transaction |

## Step 1: package and host scripts

```
vaydu-develop-3c91991-release-linux.tar.gz: OK
306adf03c8742a3433a7737aabc2ea9dca1247eaffe6b7d7b0aab8a8ad644af2  host-predeploy.sh
0259bd51acdcc09f41be998efce3bdbb982cccbe0faf090182271cd23c24b96e  host-rollback.sh
54de2e6be3bad38ede117414fd6ca5480b110b10541c4c5b4e81c7ed34c6675d  rollout-develop-52097ef.sh
BUNDLE_OK
3c91991
d47fd59c0dab0d3913f2e9f4acfba2d31a01c8c67175a9a7276ee91790fe8c40  .../host-db-release.sh
```

## Step 2: predeploy (2026-11-13 09:19:19 UTC)

```
API_IMAGE=movabi-api:release-f6e8c00-topup        (sha256:37baf158…)
WEB_IMAGE=movabi-web:release-f6e8c00-topup-linux  (sha256:06e7d806…)
running API SOURCE_SHA: f6e8c00
running API files hashed: 253   bundle API files: 261
api-changes: 29 (identical to release/expected-api-changes-3c91991.txt: 8 ADDED, 21 CHANGED)
running web files hashed: 368   bundle web files: 368
web-changes: 97 (48 ADDED, 48 REMOVED, index.html CHANGED; matches release/expected-web-changes-3c91991.txt)
Saved to /home/edsadmin/vaydu-topup-fix-predeploy-20261113T091919Z
```

## Step 3: backup (2026-11-13 09:20:40 UTC)

```
bf25eaad…f4db  develop-before-release-3c91991-20261113T092040Z.dump
daa46ba0…6a05  ….dump.globals.sql
9d728dbe…5eea  ….dump.counts.tsv
BACKUP_OK …dump  size=1903253  table-data-entries=186  tables-counted=181  db-image=supabase/postgres:15.1.1.78
```

## Step 4: restore drill: core PASSED, behaviour suites FAILED

```
pg_restore reported 0 error line(s)
PASS: restored row counts equal the backup's (181 tables)
NOTICE:  PREREQ OK: 4 replaced functions match, 11 release functions absent, cash tables absent, no cash-mode jobs
PASS: PREREQ on the restored copy
PASS: release-up.sql on the restored copy (real data)
NOTICE:  VERIFY OK: release schema present (15 functions), no cash-ride market enabled
PASS: VERIFY on the restored copy
FAIL: realdb-cancellation-fee-test.sql errored   (profiles_pkey: c0000000-…-00c already exists)
FAIL: realdb-cash-booking-acquisition-test.sql errored   (idx_market_availability_unique_scope: GB)
FAIL: realdb-cash-booking-chain-test.sql errored          (same)
FAIL: realdb-cash-ride-lifecycle-test.sql errored         (same)
FAIL: realdb-driver-metrics-test.sql errored  (profiles_pkey: d0000000-…-00d already exists)
FAIL: realdb-market-pilot-test.sql errored                (idx_market_availability_unique_scope: GB)
FAIL: realdb-merge-test.sql (9 | 21)
PASS: release-down.sql on the restored copy
PASS: rollback restored the exact pre-release schema on real data
DRILL_DONE
```

Cause: the fixtures assume an empty database. Develop's `on_auth_user_created` trigger (migration
`20260407000000`) creates a profile for each fixture user, and develop already has GB market rows.
This was not release or data damage: the ids were the suites' own fixtures, created moments earlier
inside the same rolled-back transaction.

## Step 4b, first run (`host-drill-suites.sh` sha256 `12e9c72c…0135`): 3 PASSED, 4 FAILED

```
PASS: release-up.sql on the restored copy (real data)
PASS: realdb-cancellation-fee-test.sql (0 | 22)
FAIL: realdb-cash-booking-acquisition-test.sql errored  (service_types_slug_key: ride)
FAIL: realdb-cash-booking-chain-test.sql errored         (same)
FAIL: realdb-cash-ride-lifecycle-test.sql errored        (same)
PASS: realdb-driver-metrics-test.sql (0 | 38)
PASS: realdb-market-pilot-test.sql (0 | 15)
FAIL: realdb-merge-test.sql (9 | 21)   (fixture service types skipped by ON CONFLICT -> 23503/MB003/CE006)
auth trigger still enabled after the suites (expect 1): 1
market rows still present after the suites (expect 3): 3
SUITES_DONE: failures above
```

Fix (commit `246ae88`): the preamble also renames develop's service-type slugs inside each suite's
own transaction. Service types are referenced only by id. The fix was reproduced locally first:
without the preamble the suites fail as on the host; with it they pass.

## Step 4b, second run (`host-drill-suites.sh` sha256 `1da1329f…ca60`): ALL PASSED, before step 6

```
PASS: release-up.sql on the restored copy (real data)
PASS: realdb-cancellation-fee-test.sql (0 | 22)
PASS: realdb-cash-booking-acquisition-test.sql (0 | 16)
PASS: realdb-cash-booking-chain-test.sql (0 | 13)
PASS: realdb-cash-ride-lifecycle-test.sql (0 | 15)
PASS: realdb-driver-metrics-test.sql (0 | 38)
PASS: realdb-market-pilot-test.sql (0 | 15)
PASS: realdb-merge-test.sql (0 | 21)
auth trigger still enabled after the suites (expect 1): 1
market rows still present after the suites (expect 3): 3
renamed service-type slugs left after the suites (expect 0): 0
SUITES_DONE: all passed on real data
```

## Step 5: gate and dry run on develop (no change)

```
NOTICE:  PREREQ OK: 4 replaced functions match, 11 release functions absent, cash tables absent, no cash-mode jobs
payment_status values on jobs | authorized, cancelled, paid, pending
… (full release statement list) …
ROLLBACK
DRYRUN_OK (rolled back; develop unchanged)
NOTICE:  PREREQ OK: …
PASS: develop still in the pre-release state
```

## Step 6: migration applied (2026-11-13 09:46:47 UTC)

```
NOTICE:  PREREQ OK: 4 replaced functions match, 11 release functions absent, cash tables absent, no cash-mode jobs
BEGIN … (release statements) … COMMIT
RELEASE_APPLIED Fri Nov 13 09:46:47 UTC 2026
NOTICE:  VERIFY OK: release schema present (15 functions), no cash-ride market enabled
confirm_wallet_topup_with_total | mark_wallet_topup_failed | record_driver_topup_provider_observation | record_wallet_topup_provider_reference
enabled_cash_markets 0
enabled_cancellation_policies 0
```

External check by the agent at 10:15 UTC: `GET /health` 200 ×3 (`{"status":"ok"}`). The old f6e8c00 API
was serving on the migrated schema.
