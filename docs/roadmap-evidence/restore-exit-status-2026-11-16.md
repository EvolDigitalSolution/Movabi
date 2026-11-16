# Restore exit-status correction (2026-11-16)

Develop-only tooling review. No host SSH retries, deployment or activation performed.
User-reported baseline: API c972037, web 3c91991, requiring a fresh host check.

## Bootstrap roles

Inspected a fresh, network-isolated container from `supabase/postgres:15.1.1.78`
(image sha256:881ac26a02870c6784d9fbec67a6a9c5026905216bbd7dfbfa289ecc48073387).
Its `pg_dumpall --globals-only --no-role-passwords` contains CREATE ROLE statements for
15 roles already bootstrapped in that image: anon, authenticated, authenticator,
dashboard_user, pgbouncer, pgsodium_keyholder, pgsodium_keyiduser, pgsodium_keymaker,
postgres, service_role, supabase_admin, supabase_auth_admin, supabase_read_only_user,
supabase_replication_admin and supabase_storage_admin.

The correction inventories the actual fresh restore container before globals execution.
It omits only exact standalone CREATE ROLE statements matching that inventory, once each.
All ALTER ROLE, grants, new-role creation, tablespaces and other statements remain unchanged.
Repeated bootstrap CREATEs and unrecognised forms are not suppressed. Globals uses
psql ON_ERROR_STOP=1; pg_restore uses --exit-on-error. Both statuses are explicitly checked.
No message matching determines success.

## Replacement artifact

Tooling commit and SOURCE_SHA: `f949a14`. Archive:
`release/vaydu-develop-f949a14-release-linux.tar.gz`, SHA-256
`58dcdbaf0b27769bcf15bfbfa584e4e64002c4ab27ada42cd4f5f57cc089488a`.
All SHA256SUMS, ALL_SHA256SUMS and RELEASE-MIGRATIONS.sha256 entries were verified directly
from the archive. All 644 API/web/release-SQL payload files match c5526f6 byte-for-byte.
The packaged f949a14 drill was then rerun through the full local reproduction: all nine suites,
both data checks, preamble cleanup, exact public-schema rollback and PREREQ passed, exit 0.
The five restore-status regressions also pass against its shipped host-db-release.sh.
Real-backup host verification is still pending.

## Regression checks

`bash scripts/release/test-host-drill-restore.sh` runs the real drill entry point with
Docker boundary failures: inventory exit 71 without output, globals exit 43 without
output or with uppercase ERROR, pg_restore exit 42 without output or with uppercase
ERROR. All five returned 1, printed DRILL_FAILED, stopped before later stages and never
printed DRILL_OK. The same regression script rejects the old c5526f6 drill.
The test also checks that globals uses ON_ERROR_STOP, archive restoration uses
--exit-on-error, exact bootstrap CREATEs are omitted, and ALTER/grant/custom-role SQL
survives unmodified.

## Local full rehearsal (synthetic develop-like data)

Ran `scripts/release/reproduce-host-drill.sh` with a private copy of c5526f6 containing
only the corrected host-db-release.sh. The exact Supabase image, live schema, release 1,
GoTrue schema and synthetic develop-like data were used. This is not evidence from
the real host backup and does not clear the deployment gate.

```text
===== host-db-release.sh drill =====
PASS: inventoried fresh-image bootstrap roles
PASS: globals restore exited 0 (only pre-existing bootstrap CREATE ROLE statements omitted)
PASS: pg_restore exited 0
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
