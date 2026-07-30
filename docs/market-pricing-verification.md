# Market Pricing (Market Intelligence) — Shadow-Mode Verification Package

**Status:** Verification only. No live pricing enabled. No production code modified. Nothing committed.

**Scope:** Confirms the market-pricing migration and shadow-mode evaluation pipeline
(`server/services/market-pricing.service.ts` + `server/services/pricing.service.ts` integration)
behave correctly against the deployed Supabase instance, without ever affecting a real customer-visible fare.

---

## Safety gates (must remain in this state throughout and after verification)

| Setting | Required value |
|---|---|
| `market_pricing_enabled` | `false` |
| `market_pricing_shadow_mode` | `true` |
| `market_pricing_audit_enabled` | `true` |
| `market_competitor_benchmarks_enabled` | `true` |
| GB Ride strategy `enabled` | `true` (resolvable by shadow evaluation/simulator, but gated by the flags above) |

---

## Execution order

1. Run **Step 1** (migration check) in Supabase SQL editor. If it fails, apply
   `server/market-intelligence-pricing-migration.txt` in full, then re-run Step 1.
2. Run **Step 2** (read current settings). Record the output.
3. Run **Step 3** (defensive update-or-insert for the four settings keys).
4. Re-run **Step 2** — confirm all four rows now exist with correct values.
5. Run **Step 4** (create GB Ride test strategy).
6. Run **Step 5** (create test competitor profile).
7. Run **Step 6** (idempotent test benchmark inserts).
8. Run **Step 7** (verify exactly two benchmark rows: £28.00 and £30.00).
9. Note the current UTC time, then run **Step 8** (curl the quote endpoint). Save the raw JSON response.
10. Run **Step 9** (recent audit query, bounded to last 10 minutes) and locate the row matching your request time.
11. Evaluate against **Pass/Fail Criteria** below.
12. Do **not** commit or change `market_pricing_enabled` / `market_pricing_shadow_mode` regardless of outcome.

---

## Step 1 — Confirm migration applied

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'market_pricing_strategies','competitor_profiles',
    'competitor_fare_benchmarks','market_price_snapshots','quote_market_adjustments'
  )
ORDER BY table_name;
```

Expected: 5 rows. If fewer, apply `server/market-intelligence-pricing-migration.txt` (idempotent, safe to re-run) before continuing.

---

## Step 2 — Read current settings

```sql
SELECT key, value, updated_at
FROM public.marketplace_settings
WHERE tenant_id IS NULL
  AND key IN (
    'market_pricing_enabled',
    'market_pricing_shadow_mode',
    'market_competitor_benchmarks_enabled',
    'market_pricing_audit_enabled',
    'market_pricing_version'
  )
ORDER BY key;
```

---

## Step 3 — Defensive update-or-insert for settings

```sql
DO $$
DECLARE
  setting_record record;
BEGIN
  FOR setting_record IN
    SELECT *
    FROM (
      VALUES
        ('market_pricing_enabled', 'false'::jsonb),
        ('market_pricing_shadow_mode', 'true'::jsonb),
        ('market_pricing_audit_enabled', 'true'::jsonb),
        ('market_competitor_benchmarks_enabled', 'true'::jsonb)
    ) AS settings(key_name, setting_value)
  LOOP
    UPDATE public.marketplace_settings
    SET value = setting_record.setting_value, updated_at = now()
    WHERE key = setting_record.key_name AND tenant_id IS NULL;

    IF NOT FOUND THEN
      INSERT INTO public.marketplace_settings (id, key, value, tenant_id, created_at, updated_at)
      VALUES (gen_random_uuid(), setting_record.key_name, setting_record.setting_value, NULL, now(), now());
    END IF;
  END LOOP;
END $$;
```

Re-run Step 2 afterward and confirm all four rows exist with the values in the safety-gate table above.

---

## Step 4 — Create GB Ride test strategy (idempotent, `enabled = true`)

```sql
INSERT INTO public.market_pricing_strategies (
  country_code, service_type, strategy, target_difference_percent,
  minimum_platform_margin_percent, minimum_platform_revenue,
  maximum_customer_discount_percent, maximum_market_adjustment_percent,
  currency, enabled
)
SELECT 'GB', 'ride', 'beat_market', 8, 0, 0, 15, 15, 'GBP', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.market_pricing_strategies
  WHERE country_code = 'GB' AND COALESCE(market_city,'') = '' AND service_type = 'ride' AND COALESCE(vehicle_class,'') = ''
);
```

---

## Step 5 — Create test competitor profile (idempotent, labeled as test data)

```sql
INSERT INTO public.competitor_profiles (
  country_code, competitor_name, competitor_slug, service_type, enabled, display_order, source_type, notes
)
SELECT
  'GB', 'TEST DATA - Verified Manual Benchmark', 'test-data-verified-benchmark', 'ride', true, 1, 'manual',
  'TEST DATA ONLY - created for shadow-mode QA verification. Not a real competitor. Safe to delete after QA.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.competitor_profiles
  WHERE country_code = 'GB' AND competitor_slug = 'test-data-verified-benchmark' AND service_type = 'ride'
);
```

---

## Step 6 — Idempotent test benchmark inserts (labeled as test data)

```sql
INSERT INTO public.competitor_fare_benchmarks (
  competitor_profile_id, distance_km, duration_minutes, observed_fare,
  currency, fare_type, confidence_score, source_reference, notes
)
SELECT
  profile.id, values_to_insert.distance_km, values_to_insert.duration_minutes, values_to_insert.observed_fare,
  'GBP', 'typical', 95,
  'TEST DATA - manually entered for shadow-mode QA',
  'TEST DATA ONLY - do not use for live pricing decisions'
FROM public.competitor_profiles profile
CROSS JOIN (
  VALUES
    (32.3::numeric, 29::numeric, 28.00::numeric),
    (32.3::numeric, 29::numeric, 30.00::numeric)
) AS values_to_insert(distance_km, duration_minutes, observed_fare)
WHERE profile.competitor_slug = 'test-data-verified-benchmark'
  AND profile.country_code = 'GB'
  AND NOT EXISTS (
    SELECT 1 FROM public.competitor_fare_benchmarks existing
    WHERE existing.competitor_profile_id = profile.id
      AND existing.distance_km = values_to_insert.distance_km
      AND existing.duration_minutes = values_to_insert.duration_minutes
      AND existing.observed_fare = values_to_insert.observed_fare
      AND existing.currency = 'GBP'
      AND existing.source_reference = 'TEST DATA - manually entered for shadow-mode QA'
  );
```

---

## Step 7 — Verify exactly two benchmark rows

```sql
SELECT
  profile.competitor_name, benchmark.distance_km, benchmark.duration_minutes,
  benchmark.observed_fare, benchmark.currency, benchmark.expires_at, benchmark.confidence_score
FROM public.competitor_fare_benchmarks benchmark
JOIN public.competitor_profiles profile ON profile.id = benchmark.competitor_profile_id
WHERE profile.competitor_slug = 'test-data-verified-benchmark'
ORDER BY benchmark.observed_fare;
```

Expected: exactly two rows — `£28.00` and `£30.00`.

---

## Step 8 — Generate a fresh Ride quote

Note the wall-clock time first so the audit query in Step 9 can be bounded correctly. London coordinates are
acceptable here because the test strategy is country-level (GB) with no city restriction — this exercises the
generic GB market rule rather than the Oldham route shown in the app UI specifically.

```bash
date -u
curl -X POST https://movabi-api.apps.evolsolution.com/api/pricing/global-ai/quote \
  -H "Content-Type: application/json" \
  -d '{
    "lat": 51.5074, "lng": -0.1278,
    "serviceSlug": "ride",
    "countryCode": "GB",
    "distanceKm": 32.3,
    "durationMinutes": 29
  }'
```

**Precondition:** `movabi-api.apps.evolsolution.com` must already be running the updated backend code
(`market-pricing.service.ts` and the `pricing.service.ts` integration). If it isn't deployed, market pricing
is silently skipped (safe fallback) and no `quote_market_adjustments` row will be written.

---

## Step 9 — Inspect only recent audit rows

```sql
SELECT
  quote_reference, base_service_fare, market_reference_fare, requested_target_fare,
  adjusted_service_fare, applied_market_adjustment, platform_fee_amount, customer_total,
  driver_payout, feature_enabled, adjustment_applied, fallback_reason, calculation_version, created_at
FROM public.quote_market_adjustments
WHERE created_at >= now() - interval '10 minutes'
ORDER BY created_at DESC
LIMIT 5;
```

Match the row by `created_at` against the timestamp captured in Step 8. Do not inspect an older row.

---

## Expected results

| Field | Expected value |
|---|---|
| `market_reference_fare` | `29.00` (median of 28.00 / 30.00 test benchmarks) |
| `requested_target_fare` | `≈ 26.68` (hypothetical `beat_market` target, 8% below reference, subject to floors/caps) |
| `adjustment_applied` | `false` |
| `fallback_reason` | `null` (strategy resolved, 2 benchmarks found — no fallback) |
| `feature_enabled` | `false` |
| `customer_total` (audit row) | equal to the curl response's `legacy.totalPrice` |
| curl response `legacy.totalPrice` | identical to what the same inputs would return with market pricing entirely absent |

---

## Pass/Fail criteria

**PASS** only if **all** of the following hold:
- Step 1 confirms all 5 tables exist.
- Step 2 (post Step 3) confirms all four settings keys are present with values `false` / `true` / `true` / `true` as specified above.
- Step 7 returns exactly two benchmark rows (£28.00, £30.00), both clearly labeled as test data in `source_reference`/`notes`.
- Step 9 returns a row with `created_at` matching the Step 8 request time.
- `fallback_reason = null` and `market_reference_fare = 29.00` (strategy and benchmarks resolved correctly).
- `adjustment_applied = false` and `feature_enabled = false` (global safety gates held).
- `customer_total` in the audit row equals the `legacy.totalPrice` in the curl response — i.e. the shadow calculation did not alter the returned fare.

**FAIL** if any of the following occur:
- Any table from Step 1 is missing.
- `adjustment_applied = true` at any point.
- `customer_total` or curl `legacy.totalPrice` differs from the expected unaffected production fare.
- `fallback_reason` is unexpectedly non-null (indicates strategy/benchmark resolution failed — investigate before drawing conclusions, but this is not unsafe, just inconclusive).
- `market_pricing_enabled` or `market_pricing_shadow_mode` reads back as anything other than `false` / `true`.

On **FAIL** involving `adjustment_applied = true` or an altered `customer_total`: stop immediately, do not proceed to any deployment or commit, and treat it as a critical bug in `MarketPricingService`/`PricingService` gating logic requiring a code fix before any further testing.

---

## Rollback notes

All test data inserted by this package is explicitly labeled and safe to remove independently of production data:

```sql
-- Remove test benchmarks
DELETE FROM public.competitor_fare_benchmarks
WHERE source_reference = 'TEST DATA - manually entered for shadow-mode QA';

-- Remove test competitor profile
DELETE FROM public.competitor_profiles
WHERE competitor_slug = 'test-data-verified-benchmark' AND country_code = 'GB';

-- Remove test GB Ride strategy (only if it was created by this package,
-- i.e. no other real GB ride strategy existed before Step 4 — verify before deleting)
DELETE FROM public.market_pricing_strategies
WHERE country_code = 'GB' AND service_type = 'ride' AND strategy = 'beat_market'
  AND COALESCE(market_city,'') = '' AND COALESCE(vehicle_class,'') = '';
```

The settings changes made in Step 3 (`market_pricing_enabled=false`, `market_pricing_shadow_mode=true`,
`market_pricing_audit_enabled=true`, `market_competitor_benchmarks_enabled=true`) are the intended safe
defaults and do not need to be rolled back — they should remain in this state until live pricing is
explicitly and separately approved.

No application code, migrations, or `.gitignore` were modified to produce this document. Nothing has been
committed or executed by the assistant.
