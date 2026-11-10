# Bike completion matrix (v2.3, through admin assignment coverage)

Evidence levels: **source** / **test present** / **observed run** / **deployed**.
All runs are against the isolated fixture. Nothing was deployed or activated.

## Closed

| Item | Evidence |
|---|---|
| Full server typecheck | `npx tsc --noEmit -p server/tsconfig.json` â†’ exit 0, 0 errors (fixed `PricingResult.fulfilmentSnapshot`) |
| Customer nearby-availability fixture failure | Root cause: `supabase.service` mock lacked `getSupabaseAdmin`, which `DispatchService` imports; route converted the throw to 503. Fixed; HTTP 200 with `observedCount`/`cars` |
| Approval precedence + exact tenant denial | `coalesce(vehicle_verified, is_verified, false)`; stale `is_verified` never overrides canonical false. Wrong tenant â†’ 403 `DRIVER_MARKET_MISMATCH`, unchanged assignment, zero earnings |
| Admin assignment authorisation | Real admin interface is `supabase.rpc('assign_driver_to_job')` (`admin.service.ts` `manualAssignDriver`, caller `booking-list.component.ts`); no general Express assignment route exists. Non-admin JWT â†’ rejected, job unchanged; admin JWT â†’ `true`, `driver_id=<admin-assigned>`, `accepted_driver_id=null`, `status=assigned`; admin assigning across tenants â†’ rejected, job unchanged |

## Still open (original blockers)

| Item | Status |
|---|---|
| Wallet/settlement harness repair and critical test results | Open |
| Representative pre-release schema/data upgrade test | Open |

## Bike HTTP coverage â€” passing

| Scenario | Evidence |
|---|---|
| Carâ†’Bike | 400 `VEHICLE_CLASS_MISMATCH`; `||searching` |
| Bikeâ†’Bike | 200; `driver_id=<bike>`, `accepted_driver_id=null`, `status=assigned` |
| Pending vehicle / restore | 400 unchanged â†’ 200 assigned |
| Approval precedence | conflicting flags 400 â†’ canonical true 200 |
| Forged approval fields | ignored; pending vehicle 400 |
| Wrong tenant | 403 `DRIVER_MARKET_MISMATCH`; unchanged; zero earnings |
| Customer nearby-availability | 200 with `observedCount`/`cars` |
| Quote/create â€” expired | 409 `QUOTE_EXPIRED`; no booking |
| Quote/create â€” missing snapshot | 409 `QUOTE_FULFILMENT_NOT_FROZEN`; count 0 |
| Quote/create â€” contradictory snapshot | 409 `QUOTE_FULFILMENT_MISMATCH`; count 0 |
| Admin assignment / non-admin denial / tenant isolation | Passed via authenticated PostgREST RPC |
| Contradictory metadata (direct SQL) | `VF011`; unchanged |

## Bike HTTP coverage â€” open

| Item | Reason |
|---|---|
| Valid frozen-snapshot quote/create | **Closed**: real /api/pricing/global-ai/quote 200; persisted eturned_customer_fare=6.66 and ulfilment_snapshot.category=bike; /api/jobs/create 200 with frozen snapshot. Root cause was fixture config (no GB/ride pricing_config -> base fare 0 -> evaluate aborted before persisting), not an app defect. Persistence-failure control (audit disabled) returns 400 |
| ~~Actual driver request feed~~ | **Closed**: restrictive vehicle/tenant policy + fixture diagnostic; see passing rows |
| Cash reassignment (`POST /cash-jobs/:jobId/reassign`) | Not covered via HTTP; `admin.routes.ts` not mounted |
| General admin assignment route | Does not exist; capability is the RPC (traced above), so no endpoint is invented |

## Executed evidence

```
npx vitest run src/testing/bike-authenticated-routes.integration.spec.ts \
  src/testing/bike-category-isolation.spec.ts \
  src/testing/bike-assignment-trigger-pg.spec.ts
â†’ 3 files passed, 11 tests passed (73.0s)
```

The authenticated spec restores `supabase/baseline/deployed_public_schema.sql`
(SHA-256 `0e9cade6â€¦e6857`, 119 tables), applies candidate `001_tenants` (no-op)
and the four pending Bike migrations, under pinned
`supabase/gotrue:v2.132.3` + `postgrest/postgrest:v10.1.2`.

## Corrected quote call graph (retraction of the earlier defect claim)

`POST /api/pricing/global-ai/quote` → `GlobalAiPricingService.resolveQuote` →
`PricingService.resolvePrice` → `resolveUnprotectedPrice`, which calls
`MarketPricingService.evaluate({ quoteReference, ... })` (`pricing.service.ts:646`).
`evaluate` → `persistSnapshotAndAudit` inserts the `quote_market_adjustments`
row and the frozen `fulfilment_snapshot`; `resolvePrice` then performs the
protected `UPDATE ... WHERE quote_reference = ...` and verifies `.single()`.

The earlier “application defect” claim was wrong and is retracted. The failure
was fixture configuration: no GB/ride `pricing_config` meant `baseServiceFare=0`,
so `evaluate` threw “The base service fare must be a positive …”, aborted before
persisting, and the protected update found no row. With reviewed GB/ride pricing
seeded, the real path succeeds end to end.

## Optional market adjustment disabled (design retained)

With `market_pricing_enabled=false`, a real Bike quote still returns 200 with a
persisted `fulfilment_snapshot.category=bike`, and `/api/jobs/create` from that
quote still returns 200. No refactor of `evaluate` was required.

## Courier cash + atomic reassignment (candidate `20261263000000`, applied not exercised)

- Courier slugs verified from `booking.routes.ts`: `delivery`, `errand` (plus unchanged `ride`).
- `reserve_cash_job_credit_v1e` and `enforce_ride_cash_credit_v1e` accept `ride|delivery|errand`.
- `driver_cash_credit_holds_v1e`: `UNIQUE(job_id)` replaced by a partial unique index on `status='held'`;
  status adds `reassigned`. History is never deleted.
- `reassign_cash_job_credit_v1f`: job → hold → both credit scopes locked in sorted order; old hold
  `held→reassigned` with one reversal; the job update lets the lifecycle trigger reserve canonically for
  the replacement; any failure rolls the whole transaction back; retry returns the existing held hold.
- **Correction:** the earlier “reassignment verified” claim was false. `838b45f` verified only 401/403/400
  and non-cash refusal. The success path was defective (released-hold reopen guard) until this migration.
- **Not executed:** funded success, insufficient-credit rollback, Car/cross-tenant replacement, retry,
  concurrent reassignment, cancellation/completion races. These need the canonical deposit/enrolment
  fixture (`post_wallet_event` with `driver_cash_credit`) and are not asserted.

## Reviewed provider-neutral wallet upgrade (applied; provider routes unchanged)

Trace of `20261254400000` / `20261254500000`:
- `20261254500000` contains **no** `flutterwave` reference: fee-policy versions, sandbox scope table, `driver_card_sandbox_enabled/permit/attempt_permit` — provider-neutral.
- `20261254400000` contains **no** `market_payment_routes` reference: fee schedules, `freeze_wallet_topup_fee` v2, attempt accounting — provider-neutral.
- Only `20261254000000` seeds a provider route (7-line `NG/NGN/card` Flutterwave insert), which conflicts with the existing Kora route through the unique `(country_code,currency_code,method)` constraint. `20261253900000` only widens the provider enum.

Reviewed path (committed):
`supabase/baseline/candidate/003_neutral_2a_columns.sql` = `20261254000000` with only that
7-line route insert removed. Applied order in the fixture:
`20261104000000` → `20261105000000` → `20261253900000` → `candidate/003_neutral_2a_columns.sql`
→ `20261254100000` → `20261254200000` → `20261254300000` → `20261254400000`
→ `20261254500000` → `20261255700000` → Bike/cash candidates.

Result: chain applies with `ON_ERROR_STOP=1`; authenticated suite passes (85.6 s); the existing
`NG/NGN/card` route remains Kora (no delete, no provider switch, no `ON CONFLICT` masking).
Flutterwave-specific seeding/capability stays inactive.

Executable failing regression (raw chain, kept as evidence):

```
npx vitest run src/testing/bike-authenticated-routes.integration.spec.ts   # with raw 20261254000000 instead of the overlay
psql:/tmp/20261254000000_flutterwave_provider_batch2a.sql:54: ERROR: duplicate key value violates unique constraint
DETAIL: Key (country_code, currency_code, method)=(NG, NGN, card) already exists.
```

## Canonical funded Bike driver (executed)

- Fixture DB renamed `movabi_batch2a_test` so `driver_card_sandbox_enabled()` can pass
  (`current_database() LIKE '%_batch2a_test'`); sandbox gate stays fixture-only.
- Seeded through configuration, not credited writes: `wallet_collection_config`
  (`driver_card_sandbox_enabled`, `max_amount_minor_GBP`, `min_amount_minor_GBP`),
  `wallet_topup_fee_schedules` (Stripe GB/GBP/card, 500 bps, fixed 0, exponent 2),
  GB/GBP `market_availability`, `driver_card_topup_sandbox_scopes`, and a
  `driver_cash_credit_enrolments_v1e` row.
- Funding path: `initiate_wallet_topup` → `freeze_wallet_topup_fee` →
  `record_wallet_topup_provider_reference` → `confirm_wallet_topup_with_total` (twice).
- Observed: attempt `d8d5892b…`; `availableMinor=5000`, `eligibleDepositsMinor=5000`,
  `consistent=true`; attempt terms `5000|250|5250|vaydu-driver-card-5pct-wallet-v1`
  (5% fee = 250, credit excludes fee); ledger legs `5000|-5000`;
  identical event id on duplicate confirmation.
- No credited attempt, movement or hold was inserted directly.

## Funded cash reassignment matrix (executed, passing)

Command: `npx vitest run src/testing/bike-authenticated-routes.integration.spec.ts` — passed (106.4 s).

| Case | Observed |
|---|---|
| Cash courier assignment | held reservation created (`required_credit_minor=51`) |
| Funded Bike replacement | 200; `driver_id=accepted_driver_id=<replacement>`; old hold `reassigned\|<original>`; new hold `held` for replacement |
| Retry same replacement | 200; identical wallet event count; still exactly one held hold |
| Zero-credit replacement | 409 `INSUFFICIENT_CREDIT`; assignment and held hold unchanged; still one reassigned row |
| Car replacement | ≥400; assignment unchanged |
| Cross-tenant replacement | ≥400; assignment unchanged |
| Cancellation | hold `released`; second cancellation creates no duplicate release event |

Supporting fixes committed: `20261263000000` now also permits the server-only `reassigned`
status in `guard_cash_credit_hold_v1e`; `admin.routes.ts` maps reassign failures by SQLSTATE
and message text (so `CE004` yields `INSUFFICIENT_CREDIT` instead of `REASSIGN_REJECTED`).
The fixture chain now also applies `20261255500000_cash_acquisition_eligibility.sql` and
`20261255600000_cash_disabled_acquisition_gate.sql`, because the deployed eligibility trigger
rejects `pending`/`cash_due` cash assignment.

## Cash race, ACL/RLS and terminal-transition guards (executed, passing)

Command: `npx vitest run src/testing/bike-authenticated-routes.integration.spec.ts` — passed (113.1 s).

| Assertion | Result |
|---|---|
| Car replacement denial | 409 `REASSIGN_REJECTED`; assignment/holds unchanged |
| Cross-tenant replacement denial | 409 `REASSIGN_REJECTED`; assignment unchanged |
| Concurrent reassignment (funded vs zero-credit) | one 200, one 409; final driver = funded replacement; exactly one `held` + one `reassigned` hold |
| Cancellation/completion race | exactly one terminal transition succeeds; exactly one `released`/`settled` row |
| Historical liability | `driver_cash_credit_balance_v1e` returns `5000|0` after reassignment/release (reassigned history not counted) |
| ACL/RLS | `relrowsecurity=true`; `authenticated` and `anon` have no SELECT on `driver_cash_credit_holds_v1e` |
| Terminal-class guard | `released` hold cannot complete; `settled` hold cannot be cancelled (`20261263000000`) |

Candidate SHA: recorded below. Remaining develop checks: apply the ordered candidate chain
(539 → neutral 540 → 541–545 → 555/556 → 557 → Bike/cash), run `npx tsc --noEmit -p server/tsconfig.json`,
and run the wallet/settlement harness (still not executed).

## Final freeze — upgrade assertions, manifest, typecheck, harness results

- Manifest regenerated from the executing fixture array (18 ordered steps, per-file SHA-256,
  including `20261104000000_cancellation_debt` and `20261105000000_campaigns_referrals`):
  `supabase/baseline/candidate/UPGRADE_MANIFEST.md`.
- Upgrade test now seeds synthetic pre-upgrade history (legacy `service_types` row) alongside the
  authorised Kora route, then asserts after the candidate delta: the service type survives, the
  `reassigned` hold constraint exists, `driver_cash_credit_holds_v1e` has RLS enabled and no
  `authenticated` SELECT grant, and the Kora route/bindings/capabilities are byte-identical.
- `npx vitest run src/testing/bike-authenticated-routes.integration.spec.ts` — **passed (112.8 s)**.
- `npx tsc --noEmit -p server/tsconfig.json` — **exit 0, 0 errors**.
- Wallet/settlement harness run:
  `batch2c-settlement-behavior`, `wallet-topup-orchestration`, `driver-wallet-topup-http`,
  `agreed-settlement-alignment`, `wallet-accounting-batch1b`
  → **4 files / 39 tests passed; 1 file / 13 tests failed**.
  Failures are all in `batch2c-settlement-behavior.spec.ts`: expected `"Atomic completion failed"`,
  received `"Customer PIN could not be verified. Please retry."` — the completion path now enforces
  the completion PIN before the atomic-settlement assertion. Harness repair remains open.

## Harness repair and extended upgrade history (executed)

- `batch2c-settlement-behavior` mock now stubs `effective_completion_pin_policy` and
  `record_pin_attempt` (verdict derived from the submitted vs expected PIN) and records only
  financial RPCs in `calls`. PIN enforcement is unchanged; invalid/missing PIN tests still reject
  and valid PINs reach the atomic settlement assertions.
- Harness result: **5 files / 52 tests passed**.
- Pre-upgrade seed extended beyond service type and Kora route: historical `pricing_config`
  (`errand`, GBP, base 2.10) and a historical `wallet_business_events` row
  (`hist-wallet-1`, legs +1000/−1000). Post-delta assertions confirm the historical pricing value,
  the wallet event entry, the legacy service type, the Kora route/bindings/capabilities, the
  `reassigned` hold constraint, holds RLS and absent client grants.
- `npx vitest run src/testing/bike-authenticated-routes.integration.spec.ts` — passed (110.5 s).
- Server typecheck unchanged since `1dc855e`: exit 0, 0 errors (no server files modified after).
