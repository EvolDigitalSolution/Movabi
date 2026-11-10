# Batch 1C — disabled wallet collection foundation

This package edits only unapplied Batch 1C source, tests and documentation. Batch
1A and 1B migrations retain their previously applied SHA256 values. No existing
wallet balances, driver layout, payment flags, keys, routes or database are changed
by the local installer. Installation is reversible with its printed rollback command.

## Scope and limitations

Stripe and Korapay (`kora`) share a provider-neutral collection boundary. SDK
clients, authenticated endpoints and a concrete Supabase repository are NOT
installed. Collection capabilities default to denied, the SQL collection gate has
no enabled row, Kora/Fincra readiness constraints remain intact, and legacy wallet
authorization findings are not fixed by this package. Existing Batch 1B balances
remain diagnostic/non-spendable. Do not collect real money into this foundation.
A later reviewed integration must implement owner/tenant/destination eligibility,
provider-specific raw response parsing, credentials, signed webhook handling,
provider/merchant-scoped reference lookup and spendable balance authority.

## Changes

* Catalog checks compare server-parsed capability expressions exactly. Only the
  original known expression is extended; additional restrictions are preserved or
  cause rejection, never discarded through word/regex matching.
* Existing columns, defaults, nullability, constraints, foreign keys and indexes
  are validated. Index uniqueness, key order, access method, opclass, collation,
  included columns, predicate and validity are compared against parsed templates.
* Atomic committed submission claims prevent two callers creating the same
  collection. Adapter identity/capability is checked before the claim.
* Ambiguous submission/binding failure retains an uncertain or submitting record.
  A restarted worker explicitly calls recover; it never repeats collection.
  Missing provider lookup is reported as unavailable, not fabricated success.
* Verification fetches server-side evidence under the frozen adapter, validates
  merchant/reference/currency/exact amount and stores evidence before binding.
  Pending/unknown remain recoverable. Late notifications cannot downgrade credit.
* Evidence-key replay is serialized and compared. Ledger event identities are
  namespaced by durable attempt UUID, avoiding collision with unrelated event keys.
* Full refund SQL checks original payment terms and replay; partial refunds fail.
  SQL accepts only trusted server evidence. No refund transport is wired here.

## Verification

Executed here with Node 24: 20 actual orchestration/adapter behavioral cases,
including synchronized callers, timeout-to-credit recovery, crash recovery,
binding failure, missing lookup, denied capabilities and Kora NGN terms. No network
or provider calls. The supplemental source check passes; all shell scripts pass
bash syntax checking. The source check count is intentionally not runtime proof.

PostgreSQL 15 is unavailable here: database migration, SQL accounting/roles,
7 synchronized database concurrency cases and 11 malformed-object rejection
cases have NOT RUN. Vitest and full project type-check are also NOT RUN here.
The installer/package extraction checks are separate from those runtime checks.

## Run locally after installation

    node --experimental-transform-types scripts/check-wallet-topup-orchestration-runtime.mjs
    npx vitest run src/testing/wallet-topups-batch1c.spec.ts src/testing/wallet-topup-orchestration.spec.ts src/testing/batch2c-api-startup-compile.spec.ts

Node 24 is recommended. The Vitest orchestration wrapper runs the same standalone
runtime harness; these are not two independent sets of 20 tests.

## Run isolated PostgreSQL on the server

Upload the whole hardened archive, extract into a fresh directory, then execute:

    bash run-wallet-batch1c-isolated.sh

The script checks the manifest, copies into a private temporary directory,
normalizes that copy only, and creates a disposable PostgreSQL 15 container with
no network, no application mounts and temporary database storage. It retains
result.log and removes the test container on exit. Runner order: fixture → 1A →
1B → 1C → SQL lifecycle → database concurrency → safe rerun → roles → malformed
schema regressions → clean reapplication. It applies 1B as a dependency; it does
not claim to rerun the entire historical 1B regression suite.

Do not run fixture/regression scripts on any application database. No application
migration/deployment command is included. A passing isolated suite is required
before considering the disabled Batch 1C migration for development.
