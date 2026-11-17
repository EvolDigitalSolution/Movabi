# Full-suite failure inventory — branch `release/topup-3ds-on-2385da7` @ `b09997f`

Command: `npx vitest run` (repo root, Windows, `core.autocrlf=true`)
Result: **7 failed files / 21 failed tests / 3663 passed** (514s)

## Classification

| File | Failing | Class | Evidence |
|---|---|---|---|
| `src/testing/wallet-minimal-overlay.spec.ts` | file-level (0 tests) | environmental — Docker | `Error response from daemon: container 4431f98a… (vaydu-pg-fresh) is not running` |
| `src/testing/bike-assignment-trigger-pg.spec.ts` | 1 | environmental — Docker | `docker exec -i vaydu-pg-fresh psql …` → "container … is not running" (spec line 151) |
| `src/testing/bike-authenticated-routes.integration.spec.ts` | 1 | environmental — Docker | 420s test timeout while orchestrating its own `vaydu-bike-test-*` postgres/rest/auth containers |
| `src/testing/cancellation-terminal-state.spec.ts` | 1 | flake under parallel load | 5s test timeout inside `runMethod` source-contract harness; **passes standalone: `npx vitest run src/testing/cancellation-terminal-state.spec.ts` → 21/21** |
| `src/testing/gb-p8-reconciliation.integration.spec.ts` | 6 | environmental — Docker | `beforeEach` hook timeout: `docker … TRUNCATE market_pricing_strategies…` against a dead container |
| `src/testing/legacy-gb-pricing-scope.integration.spec.ts` | 10 | environmental — Docker | repeated 5s/30s timeouts; every test drives `sql()` against the same dead container |
| `src/testing/status-wallet-browser.spec.ts` | 2 | **regression — fixed** | mocked `payoutContext.requireStripePayoutMarket`; page now calls `refreshWallet()` to branch on provider. Spec updated to the new contract + new NG-branch coverage → **19/19 after fix** |

## Baseline cross-check

- `bike-assignment-trigger-pg` and `wallet-minimal-overlay` are already listed in `docs/roadmap-evidence/full-suite-failures-current.txt` (same Docker cause).
- The `*.integration.spec.ts` files are self-describing: they require a live Postgres container and were never part of the unit-suite green run; identical class of failure as recorded baseline.
- **No failure was caused by the release migrations or the customer-collection/NG-payout changes**, other than `status-wallet-browser`, which is repaired in this commit range.
- Historical baseline files list many additional specs (place-search, driver-* , wallet-booking-lifecycle, wallet-metadata-batch1a, payment-agreement-authority, …) that **all pass in this run** — earlier failures were fixed or were environment-dependent.

## Re-run commands

- Full suite: `npx vitest run`
- Affected scope only:
  `npx vitest run src/testing/status-wallet-browser.spec.ts src/testing/batch2c-money-authority.spec.ts src/testing/customer-wallet-collection.spec.ts src/testing/wallet-booking-lifecycle.spec.ts`
- Collection route/adapter runtime: `npx vitest run src/testing/customer-wallet-collection.spec.ts` (8-step route → service → adapter → RPC chain incl. idempotent replay and fail-closed identity mismatch)
