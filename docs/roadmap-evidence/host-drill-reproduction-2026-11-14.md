# Host restore drill: reproduction and correction (2026-11-14)

All runs: `scripts/release/reproduce-host-drill.sh`, which uses develop's exact DB image `supabase/postgres:15.1.1.78`, GoTrue's auth schema, develop's live public schema, release 1 and synthetic develop-like data (`scripts/release/develop-like-data.sql`, no real data). It then runs the bundle's own `host-db-release.sh backup` and `drill`.

## 1. Shipped e4a64c1 drill (only the readiness wait lengthened for this slower machine)

8 of 9 suites fail, yet it prints DRILL_DONE and exits 0 (fails open). The merge result matches the host (9 of 21 failing).

```
===== merge-suite diagnosis =====
     2 | INSERT cash delivery with driver, courier off (GB) -> CE001 | FAIL | 23503
     2 | INSERT cash ride with driver in a non-pilot market (NG) -> CE001 | FAIL | 23503
     3 | GB cash ride WITH an authorised hold: enrolled driver acquires it | FAIL | MB003
     3 | merged reserve held the credit (250) on the ride | FAIL | 0
     4 | courier cash needs full custody: the same delivery with a PaymentIntent is not cash-acquirable | FAIL | false
     4 | delivery, courier on: driver B acquires it | FAIL | MB003
     4 | old hold reassigned, one live hold for F | FAIL | 
     4 | roadmap reassignment through the merged reserve: B -> F (a free, enrolled driver) | FAIL | CE006
     5 | reserve for an NG cash job stops at the market gate (CE001) | FAIL | CE002
     2 | INSERT cash delivery with driver, courier off (GB) -> CE001 | FAIL | 23503
     2 | INSERT cash ride with driver in a non-pilot market (NG) -> CE001 | FAIL | 23503
     3 | GB cash ride WITH an authorised hold: enrolled driver acquires it | FAIL | MB003
     3 | merged reserve held the credit (250) on the ride | FAIL | 0
     4 | courier cash needs full custody: the same delivery with a PaymentIntent is not cash-acquirable | FAIL | false
     4 | delivery, courier on: driver B acquires it | FAIL | MB003
     4 | old hold reassigned, one live hold for F | FAIL | 
     4 | roadmap reassignment through the merged reserve: B -> F (a free, enrolled driver) | FAIL | CE006
     5 | reserve for an NG cash job stops at the market gate (CE001) | FAIL | CE002
===== host-db-release.sh backup =====
3c70f45877f7d7db5a2efdb3d904ccc6b30139b12d0801a550d66af885b953e6 */tmp/tmp.w7dAFmRAWw/home/vaydu-develop-backups/develop-before-release-e4a64c1-20261114T213222Z.dump
c279bd7aed5bb521ae12ef5a1d915341ba2113c280d8840511955f5f650938c4 */tmp/tmp.w7dAFmRAWw/home/vaydu-develop-backups/develop-before-release-e4a64c1-20261114T213222Z.dump.globals.sql
a07b33a58b021c96dd6993dc9f5b201f8e016e7fdc4866389bff943a689982ee */tmp/tmp.w7dAFmRAWw/home/vaydu-develop-backups/develop-before-release-e4a64c1-20261114T213222Z.dump.counts.tsv
BACKUP_OK /tmp/tmp.w7dAFmRAWw/home/vaydu-develop-backups/develop-before-release-e4a64c1-20261114T213222Z.dump  size=1335886  table-data-entries=158  tables-counted=158  db-image=supabase/postgres:15.1
backup exit 0
===== host-db-release.sh drill =====
pg_restore reported 0 error line(s) (listed below if any)
PASS: restored row counts equal the backup's (158 tables)
NOTICE:  PREREQ OK: release 1 exact, release 2 not applied
PASS: PREREQ on the restored copy
NOTICE:  column "reason" of relation "driver_vehicle_inspection_photos" already exists, skipping
NOTICE:  trigger "zz_stamp_completion_pin_policy" for relation "public.jobs" does not exist, skipping
NOTICE:  trigger "zz_mint_completion_pin_on_assignment" for relation "public.jobs" does not exist, skipping
PASS: release-up.sql on the restored copy (real data)
NOTICE:  VERIFY OK: release 1 + release 2 present (20 functions, 2 triggers), D12 captured, no cash-ride market outside GB/GBP
PASS: VERIFY on the restored copy
FAIL: realdb-cancellation-fee-test.sql errored
ERROR:  duplicate key value violates unique constraint "profiles_pkey"
DETAIL:  Key (id)=(c0000000-0000-4000-8000-00000000000c) already exists.
FAIL: realdb-cash-booking-acquisition-test.sql errored
ERROR:  duplicate key value violates unique constraint "idx_market_availability_unique_scope"
DETAIL:  Key (upper(country_code::text), lower(COALESCE(market_city, ''::character varying)::text), COALESCE(zone_id::text, ''::text))=(GB, , ) already exists.
FAIL: realdb-cash-booking-chain-test.sql errored
ERROR:  duplicate key value violates unique constraint "idx_market_availability_unique_scope"
DETAIL:  Key (upper(country_code::text), lower(COALESCE(market_city, ''::character varying)::text), COALESCE(zone_id::text, ''::text))=(GB, , ) already exists.
FAIL: realdb-cash-ride-lifecycle-test.sql errored
ERROR:  duplicate key value violates unique constraint "idx_market_availability_unique_scope"
DETAIL:  Key (upper(country_code::text), lower(COALESCE(market_city, ''::character varying)::text), COALESCE(zone_id::text, ''::text))=(GB, , ) already exists.
FAIL: realdb-completion-pin-test.sql errored
ERROR:  duplicate key value violates unique constraint "profiles_pkey"
DETAIL:  Key (id)=(c0000000-0000-4000-8000-00000000000c) already exists.
FAIL: realdb-driver-metrics-test.sql errored
ERROR:  duplicate key value violates unique constraint "profiles_pkey"
DETAIL:  Key (id)=(d0000000-0000-4000-8000-00000000000d) already exists.
FAIL: realdb-market-pilot-test.sql errored
ERROR:  duplicate key value violates unique constraint "idx_market_availability_unique_scope"
DETAIL:  Key (upper(country_code::text), lower(COALESCE(market_city, ''::character varying)::text), COALESCE(zone_id::text, ''::text))=(GB, , ) already exists.
FAIL: realdb-merge-test.sql (9 | 21)
2 | INSERT cash delivery with driver, courier off (GB) -> CE001 | FAIL | 23503
2 | INSERT cash ride with driver in a non-pilot market (NG) -> CE001 | FAIL | 23503
3 | GB cash ride WITH an authorised hold: enrolled driver acquires it | FAIL | MB003
3 | merged reserve held the credit (250) on the ride | FAIL | 0
4 | courier cash needs full custody: the same delivery with a PaymentIntent is not cash-acquirable | FAIL | false
PASS: realdb-referral-units-test.sql (0 | 13/13)
PASS: release-down.sql on the restored copy
PASS: rollback restored the exact pre-release schema on real data
DRILL_DONE (throwaway container removed on exit)
DRILL_EXIT_CODE=0
```

## 2. Corrected drill (bundle db1f599, the same develop-like backup)

```
===== host-db-release.sh drill =====
PASS: pg_restore reported no errors
PASS: restored row counts equal the backup's (158 tables)
PASS: PREREQ on the restored copy
PASS: release-up.sql on the restored copy (real data)
PASS: VERIFY on the restored copy
PASS: realdb-cancellation-fee-test.sql (0 | 22)
PASS: realdb-cash-booking-acquisition-test.sql (0 | 16)
PASS: realdb-cash-booking-chain-test.sql (0 | 13)
PASS: realdb-cash-ride-lifecycle-test.sql (0 | 15)
PASS: realdb-completion-pin-test.sql (0 | 17/17)
PASS: realdb-driver-metrics-test.sql (0 | 38)
PASS: realdb-market-pilot-test.sql (0 | 15)
PASS: realdb-merge-test.sql (0 | 21)
PASS: realdb-referral-units-test.sql (0 | 13/13)
suites passed: 9 of 9
PASS: restored data byte-identical after the suites (158 tables)
PASS: preamble left nothing behind (auth trigger enabled state and slugs restored)
PASS: release-down.sql on the restored copy
PASS: rollback restored the exact pre-release schema on real data
PASS: PREREQ passes again after rollback
PASS: restored data byte-identical to before the release
DRILL_OK: restore, release, 9 of 9 suites, data preservation and rollback all passed (throwaway container removed on exit)
DRILL_EXIT_CODE=0
```

## 3. Fail-closed check: corrected drill with the preamble emptied

```
FAIL: realdb-cancellation-fee-test.sql errored
FAIL: realdb-cash-booking-acquisition-test.sql errored
FAIL: realdb-cash-booking-chain-test.sql errored
FAIL: realdb-cash-ride-lifecycle-test.sql errored
FAIL: realdb-completion-pin-test.sql errored
FAIL: realdb-driver-metrics-test.sql errored
FAIL: realdb-market-pilot-test.sql errored
FAIL: realdb-merge-test.sql (9 | 21)
suites passed: 1 of 9
FAIL: not every listed suite passed
DRILL_FAILED: see FAIL lines above (throwaway container removed on exit)
DRILL_EXIT_CODE=1
```
