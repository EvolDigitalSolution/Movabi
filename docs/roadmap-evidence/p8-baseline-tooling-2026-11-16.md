# P8 verified-baseline tooling correction

User-verified current host: API f949a14; web movabi-web:release-f949a14-linux. Supplied remote
inspection evidence: /home/edsadmin/vaydu-p8-reconciliation.Q8xr7I. No SSH retry or host mutation
was performed by this session. Fresh host content/image verification is performed by the tools.

The old 3c91991 web guard is replaced with a stricter exact-tag plus content/inventory guard,
using hashes derived from the SHA-256-pinned f949a14 archive. The actual running image ID must
match the tag's image ID. Actual web image/container IDs are recorded before rollout and must
match afterwards; web is neither built nor recreated. The baseline allowlist accepts only
f949a14 API or the paired eef726b candidate, replacing the earlier c972037 allowance.

API eef726b candidate is reused byte-for-byte from its pinned previous operator archive.
Packaging checks every nested manifest and asserts that only the two intended routes and
gb-quote-tenant.ts differ as source from f949a14. The remaining differences are SOURCE_SHA,
checksum manifests and provenance metadata. Calculators, web, release SQL and remaining base
files are identical. SQL correction/activation/probes are unchanged from eef726b.

Before deployment, the exact current f949a14 API image ID is recorded and given a unique pin
tag for recovery; original compose identity and image override are saved. Recovery refuses
after a committed GB binding or on any database/identity error. It only restores the recorded
API image when the transaction has not committed, without rebuilding web or changing SQL.
P8-RECOVERY.md documents the separate post-commit verification-failure handling.

Local checks passed:

- bash syntax for all four runtime scripts and two regression scripts; Python packaging compile.
- 6/6 actual web-verifier regressions: accepted exact content/recorded IDs; rejected old tag,
  retagged ID, modified file, missing file and extra file.
- 3/3 recovery guard regressions: active binding, database failure and wrong project all fail
  without any Docker mutation.
- API, frontend and correction/activation/release SQL compare unchanged against eef726b.
- Previous 39 focused tests and full nine-suite/rollback rehearsal remain applicable to those
  unchanged payloads. Packaging independently verifies outer/inner checksum manifests and the
  entire candidate/base difference set before publishing the new local artifact.

The previously passing real-backup drill evidence is reused, with path/hash recorded. No new
backup or repeat drill is requested. Live deployment/activation and served-web verification
still require the supplied host command's output; these local checks do not establish them.
