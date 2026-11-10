# Flutterwave provider — Batch 2A (additive, disabled by default)

Adds Flutterwave as a configurable provider for driver wallet top-ups in Vaydu's
African markets. Selection is routed by configured **country, currency, method,
capability and merchant approval** — never by continent, and never hardcoded
ahead of Stripe/Kora/Fincra.

## What is delivered

- `flutterwave-wallet-collection.ts` — sandbox-only Flutterwave hosted collection
  following the tested KoraSandbox pattern: durable reserve before POST,
  server-side verification from the persisted attempt (never the browser body),
  HMAC-SHA256 webhook authentication, uncertain → reconcile (no second charge or
  provider switch).
- `wallet-fee-policy.ts` — explicit approved provider/market/method fee policy;
  quotes **wallet credit + provider fee + total charge** with exact minor-unit
  arithmetic for 0/2/3-decimal currencies; fails closed when a fee policy is
  missing.
- `20261254000000_flutterwave_provider_batch2a.sql` — additive migration: fee
  policy table, frozen fee/total/policy-version columns on the attempt, and a
  **disabled** Flutterwave route.
- `install-wallet-flutterwave-batch2a.ps1` — guarded install + test + upload-report.
- `rollback-wallet-flutterwave-batch2a.sql` — manual additive rollback.

## Explicit non-goals (not claimed as available)

- No live key, no enabled route, no real collection or payout.
- Card issuing, virtual accounts and subaccounts are **not** claimed: they require
  verified Flutterwave merchant/country/currency capability and a separate review.
- Android/iOS native deep links are **not** claimed to work without testing;
  checkout return is configured to a server-owned HTTPS URL (`localhost:3000`
  is local development only and must be replaced by a real HTTPS return URL).

## Safety

- The Vaydu ledger (`wallet_accounts` / `wallet_movements`) remains the wallet
  authority; a verified driver top-up credits `driver_cash_credit` exactly once
  and never double-credits the legacy wallet.
- Stripe, Kora and Fincra are preserved; `market-payment-registry` no longer
  hard-rejects Flutterwave but gates it to `collect` only (no booking hold/payout).

## Verification

- `node scripts/check-wallet-flutterwave-batch2a.cjs` — source-level (supplemental).
- PostgreSQL 15 isolated runner + Vitest — NOT RUN in this sandbox; see installer.
