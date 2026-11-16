# Exact develop P8 correction and activation handoff

Source commit: `eef726b`. Operator artifact:
`release/vaydu-gb-p8-fix-eef726b.tar.gz`, SHA-256
`c92f2f33a0ae9d61c62bd17a32a722f31c3afa6a3eea98413d620f60f94cf99a`.

Upload that single local artifact to `/home/edsadmin/` using your existing transfer method.
Run this block on the develop host. No SSH authentication retry or new backup is needed.

```bash
(
  set -euo pipefail
  cd /home/edsadmin
  printf '%s  %s\n' \
    c92f2f33a0ae9d61c62bd17a32a722f31c3afa6a3eea98413d620f60f94cf99a \
    vaydu-gb-p8-fix-eef726b.tar.gz | sha256sum -c -
  D=$(mktemp -d /home/edsadmin/vaydu-p8-tools.XXXXXX)
  tar --no-same-owner -xzf vaydu-gb-p8-fix-eef726b.tar.gz -C "$D"
  F="$D/vaydu-gb-p8-fix-eef726b"
  (cd "$F" && sha256sum -c --quiet P8_SHA256SUMS)
  bash "$F/reconcile-gb-p8.sh" --inspect
  bash "$F/deploy-p8-api.sh"
  bash "$F/reconcile-gb-p8.sh" --apply
)
```

Inspection reports all known activation prerequisites and runs the complete projected SQL with
ROLLBACK when SQL prerequisites permit, even if an external prerequisite still blocks rollout.
It freshly inventories the recorded API `c972037` (or reviewed `f949a14`) and web `3c91991`;
unexpected source/image drift blocks deployment for review. Preserve the evidence it prints.

The API-only step requires an already passed corrected f949a14 drill log, covering all nine
suites, data preservation and exact schema rollback against the existing real backup:
`/home/edsadmin/vaydu-develop-backups/develop-before-release-e4a64c1-20261114T201704Z.dump`.
The command searches existing `/home/edsadmin/vaydu-f949a14-drill.*/drill.log` evidence. For an
existing passed log elsewhere, export `RESTORE_DRILL_LOG` to that exact path before this block.
If the gate has not passed, deployment stops. The earlier corrected-drill command in RUNBOOK
uses this same backup; this handoff does not request or create another one.

The nested API candidate uses the immutable reviewed f949a14 base plus two quote routes and
the new GB tenant helper only. Web/release SQL/calculators are unchanged; unfinished followups
are excluded. The verified existing rollout helper runs `--deploy-api-only`, preserves the
actual web tag, and performs no migration replay. Use these P8 tools for data activation,
not the nested base artifact's older activation copy.

The API binding remains off until the atomic correction/activation switch. Apply captures
actual baseline quotes, commits only after unchanged activation guards and isolation assertions
pass, then verifies actual installed-service GB demand/supply <=1.5, traffic/weather neutral,
native authenticated tenant binding, AI shadow and identical other-market quotes (including
platform context and shared tenants). A failed command exits nonzero; retain its evidence and
stop further rollout. Original GBP 3.35 minimum, strategy IDs and unrelated fields remain.

Local evidence: 39/39 focused tests, server typecheck and full release-2 rehearsal pass,
including nine behaviour suites, rollback, simultaneous preflight conflicts and the composed
atomic activation. These are not live host verification; no deployment or activation is claimed.
