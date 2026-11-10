# Batch 1D — client financial authorization

Based on the development preflight supplied on 25 October 2026 (PostgreSQL 15.1).
This is a new migration; applied Batches 1A/1B/1C are not edited. No layout, provider
routing, financial formula, existing function body, trigger, balance or history is
changed. Collection remains disabled and Batch 1B balances remain diagnostic.

## What the actual preflight established

* `wallets` and `wallet_transactions`: client direct writes, including wallet
  column grants, are already denied. Permissive INSERT/UPDATE policies do not by
  themselves prove an exploitable balance-write path when SQL grants deny access.
* `driver_earnings`: anon/authenticated still have table write/TRUNCATE grants.
  RLS does not protect TRUNCATE. The fixture demonstrates this SQL privilege;
  this is not a claim that a public HTTP endpoint exposes arbitrary TRUNCATE.
* Six legacy `auth` financial RPC overloads are executable by clients; two are
  SECURITY DEFINER cancellation aliases and one is a SECURITY DEFINER reservation
  routine without a caller-ownership check. SQL EXECUTE is demonstrated; exposure
  of the auth schema through PostgREST has not been assumed.
* Canonical public reserve/release/settle/cancel/top-up RPCs are already restricted
  to the server. `approve_errand_over_budget(uuid)` is a legitimate authenticated
  customer flow with an ownership check, and remains so.
* `validate_wallet_integrity(uuid)` permits client inspection of another user's
  wallet existence/health; it becomes server-only without changing its definition.
* `tr_calculate_job_payouts` is absent in the supplied jobs trigger inventory.
  This batch neither adds nor drops job triggers. The disabled acquisition trigger
  seen in the report is outside this batch and remains unchanged.

## Changes and boundaries

The migration revokes client table/column financial write privileges, including
TRUNCATE, REFERENCES and TRIGGER. Restrictive no-write policies protect against a
future accidental permissive policy/grant. SELECT grants and existing SELECT
policies remain intact. Every observed service table/RPC privilege is preserved;
already-disabled credit routines are not enabled. Legacy auth aliases remain
available to the trusted service exactly where they were already allowed, but
PUBLIC/anon/authenticated EXECUTE is removed.

All 17 inspected financial signatures are required. Unexpected overloads, changed
service execution grants, client BYPASSRLS/ownership, function-body drift and policy
name collisions abort the transaction. Function-body fingerprints normalize only
whitespace; exact definitions are also compared before/after the ACL changes.
Inherited privileges that survive direct REVOKE cause a hard failure rather than
a false success. An unexpected role hierarchy requires review, not blanket CASCADE.

Known customer budget approval is the explicit client exception. It retains its
existing identity/ownership checks and function body. No new financial client RPC
is granted. No existing server wallet writer is replaced or broadened. The legacy
wallet is still one row/currency per user; this batch does not add multi-currency
spending, debt, cash-job reservations or live top-ups. Currency/profile migration
requires its own reviewed financial rules.

## Tests and limitations

Fixture-only roles recreate JWT auth.uid()/auth.role() and use SET SESSION
AUTHORIZATION to a non-superuser authenticator before SET ROLE. This avoids a
false positive from the existing approval function's session_user=postgres bypass.

The fixture copies the 17 supplied RPC definitions and representative wallet/job
triggers. The unavailable finalize_job_payment dependency is a clearly identified
synthetic stub: successful GBP/NGN reserve/release/settlement tests establish ACL
compatibility with those copied routines, not full live booking/payment correctness.
The driver-earnings table/read policy is representative, not its entire production
schema/eligibility algorithm. Production triggers/policies are preserved by the
migration; they are not inferred from the fixture.

Tests reproduce baseline TRUNCATE/cross-owner legacy reservation inside a rolled-back
transaction, then verify both clients cannot execute financial primitives, fabricate
wallet funds, alter currency, delete history or truncate earnings. Own reads,
service writes and owner budget approval remain available. Restrictive policies
are exercised with hypothetical future table grants/permissive policies; those
changes roll back. Negative tests cover inherited grants, unreviewed overloads and
conflicting policy definitions and compare schema/ACL dumps after rejection.

Executed in the authoring environment: supplemental source/baseline hash checks,
bash syntax checks, package/install/rollback validation. PostgreSQL/Vitest are NOT
RUN here (no PostgreSQL/Docker/Vitest available). The isolated server runner must
pass before considering an application migration. No application apply command
is bundled and no application database has been connected by this package.

## Owner workflow

Run the reversible Node installer from the extracted archive with the repository
path. It checks applied 1A/1B/1C source hashes, refuses unreviewed local collisions,
installs only new Batch 1D files and prints a rollback command. Nothing is staged.
Ignored .sql files still require explicit tracking when a commit is later prepared.

Run `node scripts/check-wallet-authorization-batch1d.cjs` (supplemental) and
`npx vitest run src/testing/wallet-authorization-batch1d.spec.ts` (supplemental).
Upload the archive, extract into a private directory, then run
`bash run-wallet-batch1d-isolated.sh`. That script creates disposable PostgreSQL 15
with no network/application mounts and retains result.log. It never connects to
movabi_develop. All fixture/reset files are disposable-cluster only.
