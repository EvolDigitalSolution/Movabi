# Smoke tests â€” clone-only vs deployed

## Clone-only (automated, run in this bundle)

1. **Schema upgrade**: apply the 18-step manifest to a clone of the current
   develop export; assert historical pricing, wallet event, service types, Kora
   route/bindings/capabilities, hold constraint, RLS and grants survive.
2. **Funded top-up**: Stripe GB sandbox; `initiate_wallet_topup` â†’
   `freeze_wallet_topup_fee` â†’ provider reference â†’ `confirm_wallet_topup_with_total`
   (twice); assert credit 5000, fee 250, total 5250, legs +5000/âˆ’5000, idempotent.
3. **Cash reassignment**: funded success, zero-credit rollback, Car/cross-tenant
   denial, retry, concurrent reassignment, cancellation/completion race.
4. **Bike/Car feed isolation**: PostgREST app query; Bike driver sees the Bike
   job, Car driver does not; customer/admin/history scoped.
5. **Quote/create**: real quote endpoint â†’ persisted fare/snapshot â†’ create;
   persistence failure and mismatched/expired snapshots rejected.

## Deployed smoke tests (after explicit deploy approval only)

1. **Inspection upload/review**: driver uploads the six labelled slots; admin
   reviews/approves; private storage and ownership enforced.
2. **Admin policy publication / margin preview**: publish a versioned
   cancellation policy (still disabled) and preview margins; no automatic
   activation.
3. **Changed refund webhook paths**: Stripe refund/dispute webhooks reach the
   reservation/recovery paths; no duplicate refunds.
4. **Top-up**: driver card top-up availability/checkout/return on the deployed
   sandbox gate; no browser-redirect crediting.
5. **Bike/Car feed isolation**: real Bike vs Car driver tokens; Bike job only
   for the approved Bike driver.
6. **Cash reassignment**: admin reassigns a held cash courier job to a funded
   replacement; denial paths and retry behave as in the clone.
7. **Completion PIN**: valid PIN completes and settles once; missing/wrong/locked
   PIN rejects without financial side effects.

## Sandbox-only (never production activation)

`driver_card_sandbox_enabled`, sandbox scopes, GB Stripe test route, fee
schedule, `ride_cash_credit` pilot config and cash enrolments exist only in the
disposable fixture. No Africa provider change, no commercial-policy activation,
no provider switching.

