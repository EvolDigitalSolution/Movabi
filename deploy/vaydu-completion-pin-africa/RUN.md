# Exact develop deployment: explicit completion PIN country defaults

Source `a349f13`; artifact `release/vaydu-pin-africa-a349f13.tar.gz`.
SHA-256 `144236226360cc72ecd5ea274be2d26dcfaaf9f61e7c1087ae8ad061c6372d8e`.
Deployment is authorised; an authenticated host execution channel is still required. Only
local Docker Desktop is available to this agent, and rejected SSH authentication is not retried.

Upload the artifact to `/home/edsadmin`, then run on the develop host:

```bash
(
  set -euo pipefail
  cd /home/edsadmin
  printf '%s  %s\n' \
    144236226360cc72ecd5ea274be2d26dcfaaf9f61e7c1087ae8ad061c6372d8e \
    vaydu-pin-africa-a349f13.tar.gz | sha256sum -c -
  D=$(mktemp -d /home/edsadmin/vaydu-pin-tools.XXXXXX)
  tar --no-same-owner -xzf vaydu-pin-africa-a349f13.tar.gz -C "$D"
  F="$D/vaydu-pin-africa-a349f13"
  (cd "$F" && sha256sum -c --quiet SHA256SUMS)
  bash "$F/deploy.sh" --inspect 2>&1 | tee "$D/inspect.log"
  bash "$F/deploy.sh" --apply 2>&1 | tee "$D/apply.log"
  bash "$F/deploy.sh" --verify 2>&1 | tee "$D/verify.log"
  grep -F 'PIN_POLICY_DEPLOYMENT_VERIFIED' "$D/verify.log"
  printf 'PIN_RUN_EVIDENCE=%s\n' "$D"
)
```

The existing passed f949a14 real-backup log is reused (or set RESTORE_DRILL_LOG to its existing
location). No new backup or repeat drill is requested. API/web images are verified and retained;
the entire update is DB-only with first a rolled-back projection, then a single audited apply.

Scope: NG GH KE ZA UG TZ RW MW EG CM CI SN ZM off by default; GB required; all services.
Authorised same-tenant per-driver overrides retain precedence. Existing jobs, frozen policies,
PIN secrets and driver overrides are not rewritten. First unfrozen assignment reads the current
explicit country entry before the existing stamp/secret triggers. Unlisted markets stay as-is.

Success requires policy/trigger/privilege/audit checks, the unchanged full release VERIFY and
unchanged API/web image/container IDs. Read the printed PIN_POLICY_EVIDENCE paths for details.
No fake jobs, payments or transfers are created on the host for verification.

Local evidence: 25 service/policy tests, 13 real-PG acceptance/isolation/settlement tests, all
nine original behaviour suites, exact schema rollback and shipped SQL/checksum verification.
NG completion success uses an eligible provider/DB-transport fixture; no live Africa-provider
journey is claimed. Normal provider/payment readiness stays enforced and integration deferred.

If the transaction fails, its policy changes, helper and audits roll back together. If verification
fails after commit, keep evidence and investigate; do not reset existing jobs or financial history.
No host execution/deployment has been performed by the agent at this handoff.
