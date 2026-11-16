# Corrected P8 deployment, reconciliation and verification

Tooling source: **28452fb**. Artifact: `release/vaydu-gb-p8-fix-28452fb.tar.gz`.
SHA-256: `8b342b6a7eb8312809cca6a1ac4f4d9bd84e8b637a132e15513a761338103a90`.
This supersedes the earlier eef726b operator tools; the paired eef726b API archive is unchanged.

Verified current baseline: API f949a14, web movabi-web:release-f949a14-linux.
Prior inspection: `/home/edsadmin/vaydu-p8-reconciliation.Q8xr7I`.
Fresh inspection requires exact web tag, matching running/tag image IDs, served-file hashes and
exact inventory from the pinned f949a14 bundle. Actual image/container IDs are recorded and must
remain unchanged across API-only rollout. This does not merely remove the earlier baseline guard.

Upload this one artifact to `/home/edsadmin/`, then run on the develop host:

```bash
(
  set -euo pipefail
  cd /home/edsadmin
  printf '%s  %s\n' \
    8b342b6a7eb8312809cca6a1ac4f4d9bd84e8b637a132e15513a761338103a90 \
    vaydu-gb-p8-fix-28452fb.tar.gz | sha256sum -c -
  D=$(mktemp -d /home/edsadmin/vaydu-p8-tools.XXXXXX)
  tar --no-same-owner -xzf vaydu-gb-p8-fix-28452fb.tar.gz -C "$D"
  F="$D/vaydu-gb-p8-fix-28452fb"
  (cd "$F" && sha256sum -c --quiet P8_SHA256SUMS)
  bash "$F/reconcile-gb-p8.sh" --inspect 2>&1 | tee "$D/inspect.log"
  bash "$F/deploy-p8-api.sh" 2>&1 | tee "$D/api-deploy.log"
  bash "$F/reconcile-gb-p8.sh" --apply 2>&1 | tee "$D/apply.log"
  grep -F 'P8_RECONCILIATION_ACTIVATION_OK' "$D/apply.log"
  printf 'P8_RUN_EVIDENCE=%s\n' "$D"
)
```

Reuse the passing corrected f949a14 real-backup drill evidence: the tools search existing
`/home/edsadmin/vaydu-f949a14-drill.*/drill.log`; an exported RESTORE_DRILL_LOG takes precedence
if the passed log is elsewhere. Its path/hash are retained in fresh inspection evidence.
All nine suites, data preservation and exact schema rollback remain mandatory. No new backup,
repeat drill, SSH retry, migration replay or web build. Original backup remains
`/home/edsadmin/vaydu-develop-backups/develop-before-release-e4a64c1-20261114T201704Z.dump`.

Packaging confirms only these API source paths differ from f949a14:

- server/routes/global-ai-pricing.routes.ts
- server/routes/payment.routes.ts
- server/services/gb-quote-tenant.ts

Only SOURCE_SHA, checksum manifests and provenance metadata also differ. Calculators, web,
release SQL and all remaining base bytes are unchanged; unfinished followups are excluded.
The entire nested API archive is byte-identical to the reviewed eef726b candidate.

Inspection collects prerequisites and runs the complete projected SQL with ROLLBACK. Apply
captures baseline quotes, atomically commits approved GB correction plus unchanged activation
guards, then verifies demand/supply <=1.5, neutral traffic/weather, GB session tenant binding,
AI shadow and identical other-market quotes. GBP 3.35, row IDs/unrelated fields and NG stay.
Expected: OTHER_MARKET_QUOTES_UNCHANGED, P8_ACTUAL_QUOTES_OK and final
P8_RECONCILIATION_ACTIVATION_OK. Detailed quotes/SQL are in the printed reconciliation directory.
Any failure exits nonzero; keep all evidence and stop further rollout.

Deployment prints P8_API_EVIDENCE with actual previous API/web image IDs, original compose
identity, recovery image pin and override. If API deployment succeeds but activation does not
commit, retaining the candidate is safe because its GB switch is off. For explicit API recovery,
set F to the extracted tools and E to that printed API evidence directory, then run:

```bash
bash "$F/recover-p8-api.sh" "$E"
```

Recovery refuses after a committed GB binding or failed database/identity check. If a post-commit
quote check fails, retain the paired API and investigate; never blindly revert financial data
or restore a backup. See P8-RECOVERY.md for full recovery boundaries and configuration caveats.

Local checks: six web guard and three recovery guard regressions, bash syntax and Python compile
pass. Previous 39 tests and nine-suite/rollback rehearsal cover unchanged API/SQL payloads.
Outer/inner manifests, unchanged paired archive and exact source difference set verified.
No new host execution, served-web verification, deployment or activation is claimed here.
