# Completion PIN African defaults verification

Scope: user's 2026-11-16 instruction, develop-only deployment authorised. Explicit existing
repository African catalogue: NG GH KE ZA UG TZ RW MW EG CM CI SN ZM; GB required. No broader
non-GB inference. Per-driver overrides are preserved; already frozen jobs/secrets are untouched.

Implementation is DB-only. Audited setting entries are read by the existing market resolver.
A new zy_ BEFORE assignment trigger prepares the explicit current country policy for an
unfrozen first assignment; the existing zz_ trigger still resolves same-tenant driver overrides
and freezes policy, and the existing AFTER trigger mints a PIN where required. An explicit
tenant country value wins, then the platform country default; generic tenant settings cannot
hide the approved country default at acceptance. No existing job is mass-updated. All existing
public function definitions, unrelated setting fields/markets, jobs, overrides and secrets are
asserted unchanged inside the apply transaction. No normal acquisition/ownership/completion or
settlement check is removed. Client execution of the new helper is revoked.

Local verification:

- `npx vitest run src/testing/completion-pin-africa.spec.ts src/testing/completion-pin-policy.spec.ts src/testing/completion-pin-market-policy.spec.ts --reporter=verbose --silent`
  **25/25 pass.** Real LogisticsService and policy/fare logic run; only DB transport and external
  payout boundary are fixtures. Eligible NG completes with no PIN and a retry is idempotent;
  GB rejects missing/wrong PIN before settlement and accepts correct PIN. Assignment/ownership/
  readiness guards still reject. Explicit non-African/unknown countries remain required.
- `bash scripts/release/rehearse-release-2.sh supabase/baseline/develop_live_public_schema_20261112.sql`
  **REHEARSAL 2 PASSED.** All nine original real-DB suites, exact release schema rollback,
  grants/data preservation, concurrency/financial isolation and P8 atomic composition pass.
  Added apply twice + unchanged release VERIFY + **13/13 new real-DB checks** cover pending
  jobs accepted under new defaults, existing frozen jobs, platform fallback, own-tenant country
  policy, same-/foreign-tenant driver overrides, GB secret minting, FR isolation, audit/privileges,
  and exactly one earnings/payout-queue record on the unchanged real settlement RPC's retry.
  Fixture onboarding guards are disabled only in the rolled-back isolated PIN fixture, as in
  the existing PIN suite. Normal production trigger/function definitions are unchanged.
- Bash syntax for deploy and rehearsal hook, Python packaging compilation and git diff checks pass.
- The exact composed apply and separate host verify.sql also pass on owned PostgreSQL 16.15
  using the baseline's actual jobs/settings/override/secret/audit table definitions and original
  PIN triggers. No fake host job or provider mutation is used for deployment verification.

Logs: `.tmp-release/pin-africa-unit-20261116.log` and
`.tmp-release/pin-africa-rehearsal-final-20261116.log` (local, intentionally not committed).
The first rehearsal attempt stopped on Windows docker-cp path conversion; streaming the owned
fixture files into the disposable container fixed that. The final rehearsal passed all checks.

No host deployment or live NG payment/provider journey has been executed by this agent. Only
local Docker Desktop contexts exist here; the prior instruction forbids retrying rejected SSH.
An authenticated execution channel was requested while work continued. Deploy tools are ready
to reuse the existing passed real-backup evidence and perform read-only host verification plus
an audited DB-only apply. Provider/payment readiness remains enforced and Africa integration
stays deferred; PIN disabled does not bypass any financial/provider guard.
