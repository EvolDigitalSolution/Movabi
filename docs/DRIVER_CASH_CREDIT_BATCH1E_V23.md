# Batch 1E — disabled cash-Ride credit pilot

## Scope

This is a new backend pilot, not a live wallet/top-up launch. All four applied
migrations (1A–1D) remain byte-identical. Existing provider routes, collection
gates, bank payouts, saved cards, legacy balances and driver layout are unchanged.
The new gate starts false (no configuration row); no driver is enrolled.
No application migration/activation command is included in the package.

The first supported service is Ride, with the full customer charge collected
by the driver in cash. Deliveries, shopping budgets, mixed cash/card payments,
cancellation penalties, customer debt collection, promotions, bonuses and
referrals are not silently added to this collateral pool.

## Accounting and settings

The accepted `fare-split-v1` snapshot is the monetary authority; current live fee
settings are not re-read/reapplied to an accepted job. Percentage-mode snapshots
must carry the actual frozen fee amounts, currency and driver-specific commission.
Amounts are converted exactly to the existing canonical currency exponent. No
5%/10% defaults or exchange rates are hardcoded into application SQL.

Example (NGN major units): base fare 1,000; frozen customer platform fee 50;
frozen driver commission 100; customer pays driver 1,050. The driver owes the
platform 150, retains net cash 900, and must have 150 of eligible prepaid credit.
Reserving only the 100 commission would omit the platform fee collected in cash.
Subscription commission can be zero; the existing driver-specific BEFORE trigger
freezes it first and this pilot's AFTER trigger reserves the resulting amount.
Zero total fees create an auditable zero hold without invalid zero ledger legs.

Only credited, unreversed 1C `driver_cash_credit` deposits, cross-checked against
the matching immutable ledger event, create eligibility. Legacy wallet balances,
customer credit, promotional credit, earnings and unrelated diagnostic ledger
adjustments do not. Both eligible deposits minus obligations and actual ledger
availability bound the amount available for a new hold. The balance is scoped by
tenant/driver/currency. The operating country must also match the authoritative
profile, approved enrolment and job. No currency conversion or cross-market
assignment is introduced. Account balances/amounts return decimal minor-unit
strings to avoid JavaScript integer precision loss.

Reservation moves `driver_cash_credit` to `driver_cash_credit_reserved` through
the existing balanced posting function. Completion moves the reserve to
`cash_fee_clearing`; cancellation/failure reverses the original reservation.
Neither action credits driver earnings or a second spendable wallet. The driver
already holds the cash; this pool is collateral/recovery, not bank-payout money.
Terminal outcomes cannot reopen, switch, double-release or double-settle.

## Enforcement and authorization

The gate and driver enrolment/consent are private administrative records. An
accepted hold freezes the consent version/time and the entire accepted financial
snapshot. A Ride must explicitly carry
`jobs.metadata.cash_collection_mode = full_customer_charge` and no digital payment
intent. Unsupported or incomplete custody records fail closed.

When the pilot is enabled, server-managed assignment inserts the hold atomically:
insufficient credit aborts assignment. Client direct job changes cannot cause
cash spending. PostgreSQL's actual SET ROLE context is checked, not a client
pricing-plan label or request payload. Completion/cancellation resolves exactly
once through an AFTER jobs trigger. Existing BEFORE fare/subscription guards run
first. Disabling the pilot stops new holds, while existing obligations still
resolve through server transitions.

All new tables are private, RLS enabled, and client table/column/RPC access is
revoked. The service can read holds and use the four controlled public RPCs but
cannot directly insert/edit/delete/truncate pilot records. New private helpers
and trigger functions are not executable by clients. Catalog checks reject
incompatible rerun tables, defaults, constraints, indexes, foreign keys, triggers,
policies, owners, overloads and inherited permissions instead of dropping guards.
Existing financial RPC bodies are not rewritten.

A scope advisory lock serializes eligibility checks and ledger posting. A BEFORE
INSERT ledger-event trigger acquires that same lock before the existing account
locks, including for 1C credits/refunds. This prevents concurrent acceptances from
spending the same eligible deposit. Job/hold resolution is transactional and
idempotent. A confirmed refund/chargeback can leave a deficit after an already
accepted/finished cash ride: availability is clamped to zero and new acceptance
is blocked for explicit reconciliation. No automatic debt repayment/charge is
invented, and no verified refund history is discarded.

## Integration gates before any enablement

Keep both provider collection and this pilot disabled. A live rollout still
requires verified Stripe/Kora SDK/webhook integration, merchant approval, usable
funds, real driver consent, a server-only cash acceptance/completion path, UI/API
error mapping and review of cash earnings versus withdrawable payout balances.
The new service RPC is not a client wallet read endpoint; a future endpoint must
scope it to the authenticated driver. This package does not change bank payout
eligibility, subscription providers, pricing administration or the driver layout.

## Tests and evidence

Executed here: supplemental source/baseline hashes, shell syntax, package/install/
rollback checks. PostgreSQL 15, Vitest and database concurrency are NOT RUN in the
authoring environment. Run the bundled isolated PostgreSQL suite before considering
application migration. Source markers are not runtime proof.

The disposable fixture reuses the owner-supplied financial definitions, existing
market matcher and exact driver-commission freeze body. It uses a minimal booking/
subscription schema and a clearly marked synthetic canonical-finalizer stub from
the earlier fixture. Synthetic credited deposits model already verified 1C records;
no Kora approval/readiness guard is weakened and no network/provider call is made.

Tests cover disabled/default behavior; exact minor units and zero fees; raw/legacy,
wrong-tenant and wrong-currency credit exclusion; the 1,000/50/100/900 split;
assignment rollback on insufficient credit; replay; market/tenant checks; frozen
terms; cancellation release; completion settlement; actual subscription freeze
ordering; verified refund deficit; client/service privilege boundaries and client
job-update bypass. Four barrier-synchronized races cover two jobs/one balance,
same-hold replay, completion versus cancellation, and refund versus acceptance.
Five negative regressions cover index/default/trigger/overload/inherited-access
mismatches and compare schema/ACL dumps after failure. Safe rerun is included.

Use `run-driver-cash-credit-batch1e-isolated.sh` from the extracted archive. It
creates disposable PostgreSQL 15 with no network/application mounts, retains the
log and removes the test container. Fixture/regression files must never be run
on an application database. Source installation is reversible; it does not undo
an independently applied database migration. Ignored SQL files require explicit
tracking when a commit is later prepared. Nothing is staged by the installer.
