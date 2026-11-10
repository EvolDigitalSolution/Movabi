# Wallet metadata — Batch 1A (additive, provider-neutral)

Batch 1A adds eight nullable metadata columns to `public.wallet_transactions`
and a partial uniqueness index for provider-scoped idempotency. It changes no
financial behaviour, no live wallet RPC, no historical row, and no
`driver_earnings` record. No balance becomes spendable and no provider is
enabled.

## Added

| Column | Type | Meaning (NULL = unresolved/legacy provenance) |
|---|---|---|
| `tenant_id` | `uuid` | tenant isolation tag (mirrors `jobs.tenant_id`) |
| `currency_code` | `text` | exact ISO-4217 currency of the entry |
| `amount_minor` | `bigint` | exact integer minor units; NULL unless exact |
| `balance_purpose` | `text` | account/purpose dimension (separate from `transaction_type`) |
| `payment_provider` | `text` | canonical provider id (`stripe` \| `kora` \| `fincra`) |
| `merchant_account_ref` | `text` | merchant-account scope from `market_payment_routes` |
| `provider_reference` | `text` | external provider reference (Stripe PI id / Kora reference) |
| `event_key` | `text` | provider-scoped idempotency key |

Index: `wallet_transactions_event_key_uniq` — `UNIQUE (event_key) WHERE event_key IS NOT NULL`.

`transaction_type` (the operation) is unchanged; `balance_purpose` is the new
account/purpose dimension. Existing Stripe columns (`stripe_payment_intent_id`,
`payment_intent_id`) and their dedup indexes are preserved.

**NULL provider metadata is not proof of an internal-only movement.** A NULL
`payment_provider`/`merchant_account_ref`/`provider_reference` means unresolved
legacy provenance: it may be an internal movement or a historical external entry
whose provider was not recorded.

## Validation

- **Migration preconditions** (catalog-level) stop on demonstrated
  incompatibility without modifying anything: required columns must exist with
  exact types; new columns must be exact type, nullable, no default, not
  generated, not identity; a pre-existing same-name index must be unique, valid,
  ready, keyed solely on `event_key` (no expressions, no included columns),
  btree with default operator class/collation, and an EXACT predicate of
  `event_key IS NOT NULL` (narrower/wider predicates are rejected).
- **Rollback-only schema check** (`scripts/check-wallet-metadata-batch1a.sql`)
  re-asserts those definitions with hard `RAISE` assertions, scoped to
  `public.wallet_transactions`.
- **Disposable-database runner** (`scripts/run-wallet-metadata-batch1a-db.sh`)
  is the single documented execution path. It requires an explicit disposable
  database name matching `*_batch1a_test` (canonical name `vaydu_batch1a_test`),
  rejects protected/application names,
  and runs every migration attempt as a separate `psql` invocation with
  exit-status and error-text capture plus reconnect verification of rollback.
  It covers: first application, safe rerun, wrong-type column, correct-type
  NOT NULL column, correct-type non-NULL default column, wrong same-name index
  (non-unique and narrower-predicate), no-partial-on-failure, legacy NULL-metadata
  inserts, multiple NULL and duplicate non-NULL `event_key`, release/settle RPC
  movements, and exact before/after catalog preservation of constraints,
  policies, grants and RPC definitions.
  **Execution environment:** an isolated PostgreSQL 15 container with no
  application volumes and no network. The fixture creates `NOLOGIN`
  `authenticated`/`service_role` roles **only inside that disposable database**;
  it never creates or alters roles in an application cluster.
- **Static source checker** (`scripts/check-wallet-metadata-batch1a.cjs`) is
  **supplemental only**: its regex/string assertions confirm the migration text
  and that no existing INSERT column list references the new columns. They do
  **not** prove nullable columns, intact readiness guards, or successful execution
  of existing writers — those require the disposable-database runner.
- **No scenario is reported as passed until the runner executes it successfully
  against a disposable database.**

### Runtime evidence

- 2026-10-24 — `EXPECTED_DB=vaydu_batch1a_test ./scripts/run-wallet-metadata-batch1a-db.sh`
  passed against an isolated PostgreSQL 15 container (first application, safe
  rerun, hard assertions, negative preconditions, and schema preservation). The
  runner's full stdout was reported by the reviewer but is not transcribed here.

### Deployment evidence

- 2026-10-24 — `20261244000000_wallet_metadata_batch1a.sql` was **applied to
  `movabi_develop`** successfully; the post-application schema check
  (`scripts/check-wallet-metadata-batch1a.sql`) passed.

## Compatibility guarantees

- All eight columns are nullable; existing writers omit them and write NULL.
- The unique index only constrains non-NULL `event_key`, so existing NULL-key
  writes are unaffected.
- Kora/Fincra readiness guards are unchanged; no `collect` capability, adapter,
  routing enablement, or top-up behaviour was added.

## Limitations (not implemented here)

- No spendable balance is exposed; `wallets.available_balance`/`reserved_balance`
  remain authoritative for existing flows.
- No writer, reader, reservation, or reversal populates the new columns.
- No provider-neutral top-up/collection adapter exists; Stripe `finalize_wallet_topup`
  is unchanged and remains Stripe-specific.
- `amount_minor` is not backfilled and is never rounded or inferred.
- `driver_earnings` is untouched.

## Corrected future top-up plan (do not implement in Batch 1A)

1. **Legacy constraint replacement.** Historical Stripe rows have NULL provider
   metadata. Any replacement of `chk_topup_requires_stripe` must explicitly
   accommodate legacy rows while requiring complete provider/account/reference
   for new provider-neutral writes. Validate the replacement against legacy rows
   before proposing it.
2. **Collection ≠ card setup.** A Stripe SetupIntent is card setup, not money
   collection. Keep Stripe collection and saved-card setup separate.
3. **Persist a stable internal top-up attempt before contacting a provider.**
   Use it for initiation retries; bind provider/account/reference afterward.
   Handle an uncertain initiation without creating a duplicate collection.
4. **Preserve exact minor units across DB, server, and JSON.** Use `bigint`/string
   representation or an explicit safe-integer bound; never round or silently
   coerce oversized amounts.
5. **Internal reservation/release identities must be durable and coordinated,**
   not an unprotected sequence generated separately on each retry.
6. **Account purpose, reward source, and transaction operation are distinct.**
   A bonus/compensation/commission entry must not create a separate spendable
   balance by itself.
