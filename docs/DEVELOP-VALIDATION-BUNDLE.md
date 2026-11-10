# Develop validation bundle — candidate `ddf441e`

Everything below is develop-only. Nothing here touches production or activates
unsupported markets/providers.

## 1. Exact migrations + order

Apply in this order on a migrated develop DB (additive, ON_ERROR_STOP-safe):

```
20261255500000_cash_acquisition_eligibility.sql
20261255600000_cash_disabled_acquisition_gate.sql
20261255700000_commercial_policies_v2.sql
20261255800000_promo_policy_v2.sql
20261255900000_reward_credit_spends.sql
20261256000000_secured_zero_payable.sql
20261256100000_job_refund_allocations.sql
20261256200000_refund_allocations_v2.sql
```

Prerequisite chain already present on develop (verified in the fresh-DB chain):
`errand_wallet_system`, `payment_customers_and_card_consent`,
`market_payment_routes`, `driver_market_isolation`, `wallet_metadata_batch1a`,
`wallet_accounting_foundation_batch1b`, `wallet_topups_batch1c`,
`03_wallet_topup_support`, `settlement_idempotency(+corrective)`,
`release_final_hardening`, `fare_agreement_payment_deadline`,
`wallet_booking_lifecycle_atomic`, `customer_cancel_request_terminal`,
`money_authority_wallet_acl`, `wallet_authorization_batch1d`,
`cancellation_debt`, `campaigns_referrals`.

## 2. Prerequisites

- Migrated develop Supabase project (the 2026 chain above applied).
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET` for develop.
- Server running the candidate build (`ddf441e`) — required before any
  new-schema route check; do not run `/create-intent` funding or
  `/refund` allocation checks against the previous build.
- Isolated test data: fresh tenant + customer + driver + campaign with
  funded budget; reward credit seeded via a referral RPC call, never
  direct insert; one card-funded booking and one fully-credit-funded
  booking.

## 3. Automated checks (no human interaction)

**Pre-deploy checks (no candidate deployment needed):**

| Check | Command |
|---|---|
| Migration chain on fresh disposable PG | `scripts/check-cash-credit-lifecycle-pg.sh` |
| Isolated backup restore to scratch DB | restore a develop snapshot; verify wallet/credit/breakdown integrity |
| Route specs (mocked services) | `npx vitest run src/testing/payment-intent-funding.spec.ts src/testing/payment-refund-allocation.spec.ts src/testing/stripe-webhook-refund.spec.ts src/testing/admin-cash-operator-routes.spec.ts src/testing/admin-receivables-resolve.spec.ts` |
| Builds | `ng build admin && ng build mobile` |
| Server typecheck | `npx tsc --noEmit` on changed server files |

**Candidate-required smoke (needs migrated develop + deployed `ddf441e`):**

| Check | Command |
|---|---|
| Concurrent cash on real DB | `scripts/verify-develop-integration.sh` |
| Real Stripe webhook replay (refund paths) | replay `charge.refund.updated` + `refund.updated` events |
| Device inspection upload | on-device six-slot flow |
| Admin policy smoke | `/admin/policies` publish + preview |

## 4. Interactive checks (require migrated develop + deployed candidate)

- **Concurrent cash:** two parallel driver assignments on one seeded credit
  — exactly one wins; loser gets CE004; no duplicate holds.
- **Stripe webhook replay:** replay a `charge.refund.updated` succeeded
  event twice + one `refund.updated` duplicate — exactly one
  `job_refund_allocations` row per `provider_ref`; credit restored once.
- **Device inspection upload:** six-slot photo upload on a real device.
- **Isolated backup restore:** restore a develop snapshot to a scratch DB;
  verify wallet/credit/funding-breakdown integrity.
- **Admin policy smoke:** publish a test policy + margin preview in the
  admin `/policies` UI; confirm version + audit rows.

## 5. Recovery

- All new migrations are additive (new tables/columns/functions/triggers,
  no drops/renames). Rollback = `DROP FUNCTION/TRIGGER/TABLE` of the named
  objects; no data rewrite required.
- `job_funding_breakdown`, `reward_credit_spends`, `job_refund_allocations`
  are new tables — drop order: allocations → spends → breakdown.
- Pre-existing failures unrelated to this bundle (batch2c settlement
  vm-loader, wallet-booking-lifecycle `customer-wallet-sandbox`,
  batch1a `'collect'` assertion, market-navigation) remain out of scope —
  verify against `a257afb` baseline before attributing.
