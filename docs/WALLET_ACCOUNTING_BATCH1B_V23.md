# Wallet accounting foundation — Batch 1B (additive, diagnostic)

Provider-neutral double-entry ledger isolating balances by
`(tenant_id, owner_id, currency_code, balance_purpose)` with signed, balanced,
append-only movements, durable business-event identities, and controlled,
idempotent reversals. Purely additive and diagnostic — it does not replace the
existing `wallets`/`wallet_transactions` authority and does not activate a
spendable balance.

## Account meaning and sign convention

- A **debit** is a positive `amount_minor`; a **credit** is negative. An account's
  diagnostic balance is the sum of its signed legs.
- `customer_credit` — customer's pre-funded spendable pool (asset).
- `platform_funding` — clearing/contra account credited when an external top-up
  funds the ledger; a top-up debits `customer_credit` and credits
  `platform_funding`. A top-up **never** creates driver earnings.
- `driver_cash_credit_available` / `driver_cash_credit_reserved` — a cash-job
  reservation is an available→reserved movement (credit available, debit
  reserved); it never requires Stripe Connect.
- `commission`, `bonus`, `compensation` — internal clearing accounts.
- `earnings_payable` — driver payout liability (earnings only, never a top-up
  contra account).

Everything remains diagnostic and non-spendable.

## Semantics

- **Canonical currency authority.** Supported currency is validated against
  `market_availability.supported_currency`; an arbitrary three-letter code such
  as `XXX` is rejected. `wallet_currency_minor_exponent` supplies only the
  ISO-4217 exponent (0/2/3).
- **Balanced.** Events whose canonical legs do not sum to zero are rejected
  (`BP001`).
- **Canonicalization.** Legs are merged by `accountPurpose` and sorted
  server-side before storage, comparison, and account creation; accounts are
  locked in that deterministic order (`FOR UPDATE`).
- **Replay.** Identical terms → idempotent; different terms → `BP002`. The replay
  check runs before the reversal check so a same-key reversal retry is idempotent.
- **Reversal.** `post_wallet_reversal` posts the exact negation; a different key
  for an already-reversed event is rejected (`BP005`). Event-key and
  reversal-uniqueness conflicts are distinguished via
  `GET STACKED DIAGNOSTICS`.
- **Reversible bigint boundary.** `-9223372036854775808` is rejected (its
  negation overflows bigint); amounts are never rounded.
- **Input validation** (`BP003`): non-empty keys/operation/purposes, required
  tenant/owner, 2..20 legs, bounded lengths, whole-number legs, and rejection of
  unexpected per-leg fields.
- **Provider identity** (`BP004`): external events require complete
  provider/merchant/reference; internal events forbid them.
- **Append-only** (`BP006`): events/accounts/movements cannot be updated or
  deleted; direct writes are revoked from every role including `service_role`;
  the SECURITY DEFINER posting functions are the only write path
  (`search_path = pg_catalog, public`).

## Validation

- **Static source checker** (`scripts/check-wallet-accounting-batch1b.cjs`) is
  supplemental (migration text only).
- **Runner** (`scripts/run-wallet-accounting-batch1b-db.sh`) applies the guarded
  fixture (roles + `auth.uid()` + `market_availability`), applies the migration,
  runs the rollback-only test, and re-runs for idempotency.
- **Concurrency** (`scripts/check-wallet-accounting-batch1b-concurrency.sh`) runs
  five independent-session scenarios with bounded timeouts and captures both
  child exit codes: same-key/same-terms (same event ID), same-key/different-terms
  (one `BP002`), different-keys/shared-accounts (exact totals retained),
  same-reversal-key (one reversal), and different-reversal-keys (one `BP005`).
- **Role-boundary** (`scripts/check-wallet-accounting-batch1b-role.sql`) verifies
  under actual `anon`/`authenticated`/`service_role` roles that clients cannot
  execute posting/reversal or read the server-only view, service_role cannot
  directly insert/update/delete ledger records, and the controlled posting
  function remains usable by service_role. The disposable `NOLOGIN` roles are a
  representative approximation: real Supabase maps `anon`/`authenticated` from
  JWTs and grants `service_role` BYPASSRLS, which this fixture does not fully
  reproduce.
- **Post-canonicalization range validation** — after merging duplicate
  `accountPurpose` legs, each merged total must stay within the reversible bigint
  range; a merged sum that overflows is rejected (`BP003`) before any
  event/account/movement is created.
- **Signature regression** (`scripts/check-wallet-accounting-batch1b-regression.sh`)
  proves first application, unchanged rerun, and rejection of an incompatible
  pre-existing `post_wallet_event` overload without leaking changes. The
  migration resolves the expected overload by its exact type signature via
  `to_regprocedure(...)` and validates return type / SECURITY DEFINER / language
  separately.
- **SQL test** (`scripts/check-wallet-accounting-batch1b.sql`) exercises
  balancing, isolation, replay, provider-neutral top-ups (Stripe + Kora),
  controlled reversal + idempotent retry, unsupported currency, incomplete
  provider identity, the reversible bigint boundary, and append-only.

## Limitations

- The projection is diagnostic and server-only; no spendable balance is wired.
- No existing writer populates the ledger yet; wiring is deferred.
- `driver_earnings`, `wallets`, `wallet_transactions`, Stripe/Korapay scope, and
  the driver layout are unchanged.
