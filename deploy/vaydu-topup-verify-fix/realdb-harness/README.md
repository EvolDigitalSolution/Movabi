# Real-database harness (evidence, not part of the release)

Runs the repository's own `createDriverTopupRouter` + `DriverWalletTopupService` +
`StripeDriverTopupSandbox` + `flutterwaveAttemptStore` against a disposable PostgreSQL 16
loaded with `supabase/baseline/deployed_public_schema.sql` (develop export), Batch 2A
columns (`deploy/vaydu-develop-validation/migrations/003_neutral_2a_columns.sql`) and
migrations 20261254100000–20261254500000 + 20261263100000. Every DB call runs as
`service_role`. Only Stripe is simulated (test-mode semantics, no network).

- `run-realdb.js` – 16 HTTP-level scenarios (fee, states, ownership, 15-way concurrent verify,
  discard/cancel, late success guard, mismatches, checkout replay).
- `race.sh` – 25 trials of concurrent `confirm_wallet_topup_with_total` x2 vs
  `mark_wallet_topup_failed`; invariant: exactly one outcome, at most one ledger event.

Paths (`/home/claude/vaydu`, unix socket `/var/tmp:55432`, DB `vaydu_batch2a_test`) are
from the session sandbox; adjust before reuse. The DB name must end in `_batch2a_test`
because `driver_card_sandbox_enabled()` only allows that or `movabi_develop`.
