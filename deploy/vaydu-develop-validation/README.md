# Vaydu develop validation bundle

Candidate SHA: `35b2590` (frozen). Branch `v2.3`. No deployment, activation or
provider switching is performed by this bundle.

## What this bundle contains

| Item | Path |
|---|---|
| Ordered migration manifest (18 steps, SHA-256 per step) | `UPGRADE_MANIFEST.md` |
| Stage/verify/recover commands | `COMMANDS.md` |
| Clone-only vs deployed smoke tests | `SMOKE_TESTS.md` |
| File checksums (migrations, manifest, build artifacts) | `SHA256SUMS` |
| Mobile build (develop configuration) | `dist/mobile/` |
| Admin build | `dist/admin/` |
| Server API (TypeScript source of record) | `server/` at `96b907b` |

The API release is the `server/` tree at the candidate SHA plus the ordered
migrations; `admin.routes.ts` alone is **not** the feature release. The mobile
and admin bundles are built from the same clean snapshot.

## Migration coverage (not just the Bike/cash delta)

The 18-step manifest includes every dependency found by the deployed-schema
upgrade rehearsal:

- `20261104000000_cancellation_debt` Ã¢â‚¬â€ `customer_receivables` (required by 557).
- `20261105000000_campaigns_referrals` Ã¢â‚¬â€ `referrals`/`campaigns` (required by 557).
- `20261253900000` Ã¢â‚¬â€ provider enum prerequisite.
- `candidate/003_neutral_2a_columns` Ã¢â‚¬â€ neutral replacement for raw `20261254000000`
  (its `NG/NGN/card` Flutterwave route insert is excluded to preserve Kora).
- `20261254100000`Ã¢â‚¬â€œ`20261254500000` Ã¢â‚¬â€ fee freeze, provider accept, atomic confirm,
  fee schedules, driver-card 5% sandbox policy and scope.
- `20261255500000`/`20261255600000` Ã¢â‚¬â€ cash acquisition eligibility and disabled-pilot gate.
- `20261255700000` Ã¢â‚¬â€ commercial policies (debt, referrals, cash hold review, reassign).
- `20261257000000`Ã¢â‚¬â€œ`20261263000000` Ã¢â‚¬â€ Bike fulfilment, limits, assignment trigger,
  snapshot guard, feed visibility, courier cash + atomic reassignment.

It does **not** include: Africa provider changes, any commercial-policy activation,
any cash activation, or any `*-activation`/provider-switch step.

## Sandbox gates are test-only

These are enabled only inside the disposable fixture and are **not** production
activation:

- `wallet_collection_config.driver_card_sandbox_enabled='true'`
- `driver_card_topup_sandbox_scopes` rows
- test fee schedule `/` GB Stripe test route
- `driver_cash_credit_config_v1e('ride_cash_credit')=true` and cash enrolments
- fixture DB name `movabi_batch2a_test` (required by `driver_card_sandbox_enabled()`)

Production activation of cash, Flutterwave, new provider routes or commercial
policies is explicitly out of scope.

## Prerequisite checks (read-only)

```sh
# provider routes must be unchanged; Kora stays on NG/NGN/card
psql "$DB" -c "select country_code,currency_code,method,provider,merchant_account_ref,enabled,capabilities
               from market_payment_routes where country_code='NG' and currency_code='NGN' and method='card';"
# expected one row: kora

# no Flutterwave NG/NGN/card route
psql "$DB" -c "select count(*) from market_payment_routes
               where country_code='NG' and currency_code='NGN' and method='card' and provider='flutterwave';"
# expected 0

# required pre-existing objects for the manifest
psql "$DB" -c "select to_regclass('public.wallet_topup_attempts'),
                      to_regclass('public.quote_market_adjustments'),
                      to_regclass('public.profiles');"
```

## Build results

Recorded in `SHA256SUMS` and `COMMANDS.md`; builds run from the clean snapshot
at `96b907b` (`npm run build:mobile:develop`, `npm run build:admin`).

## Artifact provenance

- Code and built assets: `96b907b`.
- Bundle docs/migrations: `eb316cc`, `116bea5`, plus the completion-PIN migration
  correction committed with this review.
- Schema correction added after `96b907b`: `20261103000000_completion_pin_policy.sql`
  (SHA-256 `$((Get-FileHash 'supabase/migrations/20261103000000_completion_pin_policy.sql' -Algorithm SHA256).Hash.ToLower())`),
  required by the completion path that was already tested at `96b907b`. The fixture
  re-ran with it and passed (114.5 s), so the deployed definition for the PIN policy
  matches the tested code.
- No other schema files changed after the freeze; the only functional code change
  in the frozen set is `server/routes/admin.routes.ts` (reassign error mapping,
  included in `96b907b`).
