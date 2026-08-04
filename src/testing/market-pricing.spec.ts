import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildStrategyResolutionAttempts, computeMarketAdjustment, ComputeMarketAdjustmentInput, mapMarketPricingStrategyRow } from '../../server/services/market-pricing.service';
import { MarketPricingStrategy } from '../../server/types/market-pricing.types';
import { PricingService } from '../../server/services/pricing.service';

function baseStrategy(overrides: Partial<MarketPricingStrategy> = {}): MarketPricingStrategy {
  return {
    id: 'strategy-1',
    countryCode: 'GB',
    marketCity: null,
    zoneId: null,
    serviceType: 'ride',
    vehicleClass: null,
    strategy: 'beat_market',
    targetDifferencePercent: 8,
    minimumDriverHourlyRate: null,
    minimumDriverPerKm: null,
    minimumDriverPayout: null,
    minimumPlatformMarginPercent: 0,
    minimumPlatformRevenue: 0,
    maximumCustomerDiscountPercent: 15,
    maximumMarketAdjustmentPercent: 15,
    currency: 'GBP',
    enabled: true,
    ...overrides
  };
}

function baseInput(overrides: Partial<ComputeMarketAdjustmentInput> = {}): ComputeMarketAdjustmentInput {
  return {
    baseServiceFare: 30.5,
    distanceKm: 32.3,
    durationMinutes: 29,
    platformFeePercent: 2,
    driverCommissionPercent: 10,
    strategy: baseStrategy(),
    marketReferenceFare: 30,
    lowestCompetitorFare: 27,
    benchmarkCount: 3,
    featureEnabled: true,
    shadowMode: false,
    driverProtectionEnabled: true,
    platformMarginProtectionEnabled: true,
    ...overrides
  };
}

describe('computeMarketAdjustment', () => {
  it('1. feature disabled returns original quote exactly (adjustment computed but never applied)', () => {
    const disabled = computeMarketAdjustment(baseInput({ featureEnabled: false }));
    const unchanged = computeMarketAdjustment(baseInput({ featureEnabled: false, strategy: null }));

    // The service may still calculate a hypothetical adjustedServiceFare for
    // analysis/simulation purposes - that is allowed and expected. What must
    // never change is anything that feeds the persisted quote.
    expect(disabled.adjustmentApplied).toBe(false);
    expect(disabled.customerTotal).toBe(unchanged.customerTotal);
    expect(disabled.driverPayout).toBe(unchanged.driverPayout);
    expect(disabled.platformFeeAmount).toBe(unchanged.platformFeeAmount);
    expect(disabled.customerTotal).toBe(30.5 * 1.02);
    expect(disabled.driverPayout).toBe(30.5 - 30.5 * 0.10);
    expect(disabled.platformFeeAmount).toBe(30.5 * 0.02);
  });

  it('2. shadow mode calculates a target but never applies it', () => {
    const result = computeMarketAdjustment(baseInput({ shadowMode: true }));
    expect(result.adjustmentApplied).toBe(false);
    expect(result.targetFare).not.toBeNull();
    expect(result.adjustedServiceFare).not.toBe(result.baseServiceFare);
    expect(result.customerTotal).toBe(30.5 * 1.02);
  });

  it('3. manual strategy returns the original quote unchanged', () => {
    const result = computeMarketAdjustment(baseInput({ strategy: baseStrategy({ strategy: 'manual' }) }));
    expect(result.adjustmentApplied).toBe(true);
    expect(result.marketAdjustment).toBe(0);
    expect(result.adjustedServiceFare).toBe(30.5);
  });

  it('4. beat_market applies the correct percentage below the market reference', () => {
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({ strategy: 'beat_market', targetDifferencePercent: 10 }),
      marketReferenceFare: 30
    }));
    expect(result.targetFare).toBeCloseTo(27, 2);
  });

  it('5. match_market uses the median (marketReferenceFare) directly', () => {
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({ strategy: 'match_market' }),
      marketReferenceFare: 28.4
    }));
    expect(result.targetFare).toBeCloseTo(28.4, 2);
  });

  it('6. premium increases the fare above market correctly', () => {
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({ strategy: 'premium', targetDifferencePercent: 8, maximumMarketAdjustmentPercent: 50 }),
      marketReferenceFare: 30
    }));
    expect(result.targetFare).toBeCloseTo(32.4, 2);
  });

  it('7. lowest_sustainable respects the driver protection floor', () => {
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({
        strategy: 'lowest_sustainable',
        minimumDriverPayout: 25,
        maximumCustomerDiscountPercent: 50,
        maximumMarketAdjustmentPercent: 50
      }),
      lowestCompetitorFare: 20,
      driverCommissionPercent: 10
    }));
    // required service fare so payout (after 10% commission) >= 25 is 25 / 0.9
    expect(result.adjustedServiceFare).toBeCloseTo(25 / 0.9, 2);
  });

  it('8. driver minimum hourly floor applies', () => {
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({ strategy: 'beat_market', targetDifferencePercent: 50, minimumDriverHourlyRate: 20, maximumCustomerDiscountPercent: 90, maximumMarketAdjustmentPercent: 90 }),
      durationMinutes: 60,
      driverCommissionPercent: 0
    }));
    // hourly floor = (60/60)*20 = 20; commission 0% => protection floor = 20
    expect(result.driverProtectionFloor).toBeCloseTo(20, 2);
    expect(result.adjustedServiceFare).toBeGreaterThanOrEqual(20);
  });

  it('9. driver minimum per-km floor applies', () => {
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({ strategy: 'beat_market', targetDifferencePercent: 50, minimumDriverPerKm: 1, maximumCustomerDiscountPercent: 90, maximumMarketAdjustmentPercent: 90 }),
      distanceKm: 10,
      driverCommissionPercent: 0
    }));
    expect(result.driverProtectionFloor).toBeCloseTo(10, 2);
  });

  it('10. platform minimum revenue floor applies', () => {
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({ strategy: 'beat_market', targetDifferencePercent: 50, minimumPlatformRevenue: 5, maximumCustomerDiscountPercent: 90, maximumMarketAdjustmentPercent: 90 }),
      platformFeePercent: 2,
      driverCommissionPercent: 10
    }));
    // feeRatio = 0.12 => floor service fare = 5 / 0.12
    expect(result.platformMarginFloor).toBeCloseTo(5 / 0.12, 2);
  });

  it('10b. effective commission and configured platform minimum revenue produce a non-zero margin floor', () => {
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({ minimumPlatformRevenue: 0 }),
      platformFeePercent: 2,
      driverCommissionPercent: 10,
      platformMinimumRevenue: 3,
      shadowMode: true
    }));

    expect(result.platformMarginFloor).toBeCloseTo(3 / 0.12, 2);
    expect(result.minimumSustainableFare).toBeGreaterThan(0);
    expect(result.adjustmentApplied).toBe(false);
  });

  it('11. maximum discount cap applies', () => {
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({ strategy: 'beat_market', targetDifferencePercent: 90, maximumCustomerDiscountPercent: 15, maximumMarketAdjustmentPercent: 90 }),
      marketReferenceFare: 30,
      baseServiceFare: 30.5
    }));
    const floor = 30.5 * (1 - 15 / 100);
    expect(result.adjustedServiceFare).toBeCloseTo(floor, 2);
  });

  it('12. maximum adjustment cap applies (upper bound)', () => {
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({ strategy: 'premium', targetDifferencePercent: 90, maximumCustomerDiscountPercent: 15, maximumMarketAdjustmentPercent: 5 }),
      marketReferenceFare: 30,
      baseServiceFare: 30.5
    }));
    // 30.5 * 1.05 = 32.025, which the service's money-rounding helper rounds
    // to two decimal places using round-half-up (32.03), matching production
    // rounding behaviour (see roundMoney in market-pricing.service.ts).
    expect(result.adjustedServiceFare).toBe(32.03);
  });

  it('15. insufficient benchmarks with no configured floor fall back to base fare', () => {
    const result = computeMarketAdjustment(baseInput({ benchmarkCount: 1, marketReferenceFare: null }));
    expect(result.fallbackReason).toBe('no_matching_benchmark');
    expect(result.adjustmentApplied).toBe(false);
    expect(result.adjustedServiceFare).toBe(result.baseServiceFare);
    expect(result.benchmarkUsed).toBe(false);
  });

  it('16. missing strategy triggers a safe fallback', () => {
    const result = computeMarketAdjustment(baseInput({ strategy: null }));
    expect(result.fallbackReason).toBe('no_market_strategy');
    expect(result.adjustmentApplied).toBe(false);
    expect(result.adjustedServiceFare).toBe(result.baseServiceFare);
  });

  it('19. platform fee and driver commission remain separate (never merged)', () => {
    const result = computeMarketAdjustment(baseInput({ platformFeePercent: 2, driverCommissionPercent: 10 }));
    expect(result.platformFeeAmount).toBeCloseTo(result.adjustedServiceFare * 0.02, 2);
    expect(result.driverCommissionAmount).toBeCloseTo(result.adjustedServiceFare * 0.10, 2);
    expect(result.customerTotal).toBeCloseTo(result.adjustedServiceFare + result.platformFeeAmount, 2);
    expect(result.driverPayout).toBeCloseTo(result.adjustedServiceFare - result.driverCommissionAmount, 2);
  });

  it('20. disabled protections do not raise the adjusted fare', () => {
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({ strategy: 'beat_market', targetDifferencePercent: 50, minimumDriverPayout: 1000 }),
      driverProtectionEnabled: false,
      platformMarginProtectionEnabled: false
    }));
    expect(result.driverProtectionFloor).toBe(0);
    expect(result.platformMarginFloor).toBe(0);
  });

  it('21. no competitor data + configured floor defaults suggested fare to the minimum sustainable fare', () => {
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({
        strategy: 'beat_market',
        minimumDriverPayout: 20,
        maximumCustomerDiscountPercent: 90,
        maximumMarketAdjustmentPercent: 90
      }),
      driverCommissionPercent: 0,
      benchmarkCount: 0,
      marketReferenceFare: null,
      featureEnabled: true,
      shadowMode: false
    }));
    // floor = 20 (0% commission), base = 30.5 -> suggestion should default to the floor.
    expect(result.minimumSustainableFare).toBeCloseTo(20, 2);
    expect(result.adjustedServiceFare).toBeCloseTo(20, 2);
    expect(result.benchmarkUsed).toBe(false);
    expect(result.fallbackReason).toBe('no_matching_benchmark');
    // live mode + valid strategy => the floor-derived suggestion IS applied.
    expect(result.adjustmentApplied).toBe(true);
    expect(result.customerTotal).toBeCloseTo(20 * 1.02, 2);
  });

  it('22. competitor target below the sustainability floor is clamped up to the floor', () => {
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({
        strategy: 'beat_market',
        targetDifferencePercent: 5,
        minimumDriverPayout: 6.8,
        maximumCustomerDiscountPercent: 90,
        maximumMarketAdjustmentPercent: 90
      }),
      driverCommissionPercent: 0,
      marketReferenceFare: 6.5,
      lowestCompetitorFare: 6.5,
      benchmarkCount: 3
    }));
    // target = 6.5 * 0.95 = 6.175, which is below the 6.8 floor -> clamp to 6.8.
    expect(result.targetFare).toBeCloseTo(6.175, 2);
    expect(result.minimumSustainableFare).toBeCloseTo(6.8, 2);
    expect(result.adjustedServiceFare).toBeCloseTo(6.8, 2);
    expect(result.fallbackReason).toBe('below_sustainability_floor');
  });

  it('23. competitor target above the sustainability floor is used as-is', () => {
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({
        strategy: 'beat_market',
        targetDifferencePercent: 5,
        minimumDriverPayout: 6.8,
        maximumCustomerDiscountPercent: 90,
        maximumMarketAdjustmentPercent: 90
      }),
      driverCommissionPercent: 0,
      marketReferenceFare: 8,
      lowestCompetitorFare: 8,
      benchmarkCount: 3
    }));
    // target = 8 * 0.95 = 7.6, which is above the 6.8 floor.
    expect(result.adjustedServiceFare).toBeCloseTo(7.6, 2);
    expect(result.benchmarkUsed).toBe(true);
    expect(result.fallbackReason).toBe('market_adjustment_applied');
  });

  it('24. competitor benchmarks disabled by settings never treated as an error', () => {
    const result = computeMarketAdjustment(baseInput({
      benchmarkCount: 0,
      marketReferenceFare: null,
      benchmarkUnavailableReason: 'competitor_benchmarks_disabled'
    }));
    expect(result.fallbackReason).toBe('competitor_benchmarks_disabled');
    expect(result.adjustmentApplied).toBe(false); // no floor configured -> no change to apply
    expect(result.adjustedServiceFare).toBe(result.baseServiceFare);
  });

  it('25. expired-only benchmarks are reported distinctly from no-match', () => {
    const result = computeMarketAdjustment(baseInput({
      benchmarkCount: 0,
      marketReferenceFare: null,
      benchmarkUnavailableReason: 'expired_benchmark'
    }));
    expect(result.fallbackReason).toBe('expired_benchmark');
  });

  it('26. live mode returns the suggested fare (customer total actually changes)', () => {
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({ strategy: 'beat_market', targetDifferencePercent: 8 }),
      marketReferenceFare: 30,
      featureEnabled: true,
      shadowMode: false
    }));
    expect(result.adjustmentApplied).toBe(true);
    expect(result.customerTotal).not.toBeCloseTo(30.5 * 1.02, 2);
  });

  it('27. floating point money comparisons use currency-safe (cent) rounding at the floor boundary', () => {
    // 0.1 + 0.2 style floating point noise: target and floor effectively equal to the cent.
    const result = computeMarketAdjustment(baseInput({
      strategy: baseStrategy({
        strategy: 'match_market',
        minimumDriverPayout: 6.8,
        maximumCustomerDiscountPercent: 90,
        maximumMarketAdjustmentPercent: 90
      }),
      driverCommissionPercent: 0,
      marketReferenceFare: 6.8000000000000007, // float noise, should compare equal to 6.80
      benchmarkCount: 3
    }));
    expect(result.fallbackReason).not.toBe('below_sustainability_floor');
    expect(result.adjustedServiceFare).toBeCloseTo(6.8, 2);
  });

  it('produces a GB ride example: 32.3km / 29min shadow simulation', () => {
    const result = computeMarketAdjustment(baseInput({
      baseServiceFare: 30.5,
      distanceKm: 32.3,
      durationMinutes: 29,
      shadowMode: true,
      marketReferenceFare: 29,
      strategy: baseStrategy({ strategy: 'beat_market', targetDifferencePercent: 8 })
    }));
    expect(result.marketReferenceFare).toBe(29);
    expect(result.targetFare).toBeCloseTo(29 * 0.92, 2);
    expect(result.adjustmentApplied).toBe(false); // shadow mode never applies
    expect(result.customerTotal).toBeCloseTo(30.5 * 1.02, 2); // unchanged customer-facing total
  });

  it('calibrates a normal short GB ride below £3.99 while remaining in shadow mode', () => {
    const result = computeMarketAdjustment(baseInput({
      baseServiceFare: 3.35,
      platformFeePercent: 2,
      strategy: baseStrategy({ minimumLaunchTargetFare: 3.35 }),
      benchmarkCount: 0,
      marketReferenceFare: null,
      shadowMode: true
    }));

    expect(result.adjustedServiceFare).toBe(3.35);
    expect(result.customerTotal).toBeLessThan(3.99);
    expect(result.adjustmentApplied).toBe(false);
  });

  it('never lets the launch target undercut the sustainability floor', () => {
    const result = computeMarketAdjustment(baseInput({
      baseServiceFare: 3.2,
      strategy: baseStrategy({ minimumLaunchTargetFare: 3.35, minimumDriverPayout: 3.6 }),
      driverCommissionPercent: 10,
      benchmarkCount: 0,
      marketReferenceFare: null,
      shadowMode: true
    }));

    expect(result.minimumSustainableFare).toBe(4);
    expect(result.adjustedServiceFare).toBe(4);
  });

  it('keeps longer trips on their higher distance/time-derived base fare', () => {
    const result = computeMarketAdjustment(baseInput({
      baseServiceFare: 12.45,
      strategy: baseStrategy({ minimumLaunchTargetFare: 3.35 }),
      benchmarkCount: 0,
      marketReferenceFare: null,
      shadowMode: true
    }));

    expect(result.adjustedServiceFare).toBe(12.45);
  });

  it('keeps normal demand at 1x and increases only after the configured threshold', () => {
    const settings = {
      maxMultiplier: 1.5,
      maxSurge: 1.5,
      minimumDemandRatio: 1.25
    } as any;

    expect(PricingService.getSurgeMultiplier(10, 10, settings)).toBe(1);
    expect(PricingService.getSurgeMultiplier(20, 10, settings)).toBeGreaterThan(1);
  });

  it('caps busy-time surge at the configured maximum', () => {
    const settings = {
      maxMultiplier: 1.4,
      maxSurge: 1.4,
      minimumDemandRatio: 1.25
    } as any;

    expect(PricingService.getSurgeMultiplier(100, 1, settings)).toBe(1.4);
  });

  it('resolves scoped configuration from most-specific to country/service default', () => {
    const attempts = buildStrategyResolutionAttempts({
      countryCode: 'GB',
      marketCity: 'Manchester',
      zoneId: 'central',
      serviceType: 'ride',
      vehicleClass: 'standard',
      currency: 'GBP',
      distanceKm: 1,
      durationMinutes: 5,
      baseServiceFare: 3.35,
      platformFeePercent: 2,
      driverCommissionPercent: 10
    });

    expect(attempts[0]).toMatchObject({
      country_code: 'GB', market_city: 'Manchester', zone_id: 'central',
      service_type: 'ride', vehicle_class: 'standard', currency: 'GBP'
    });
    expect(attempts.at(-1)).toMatchObject({
      country_code: 'GB', market_city: null, zone_id: null,
      service_type: 'ride', vehicle_class: null, currency: 'GBP'
    });
  });
});

describe('GB Ride launch calibration migration', () => {
  const migration = readFileSync(resolve(process.cwd(), 'server/gb-ride-launch-calibration-migration.txt'), 'utf8');
  const adminComponent = readFileSync(resolve(process.cwd(), 'src/app/apps/admin/features/pricing/market-intelligence.component.ts'), 'utf8');
  const adminService = readFileSync(resolve(process.cwd(), 'src/app/apps/admin/services/admin-market-pricing.service.ts'), 'utf8');
  const strategyRoute = readFileSync(resolve(process.cwd(), 'server/routes/market-pricing.routes.ts'), 'utf8');

  it('populates every launch field on an existing country-level GB Ride strategy', () => {
    for (const assignment of [
      'minimum_launch_target_fare = c.launch_target',
      'minimum_driver_payout = c.driver_payout',
      'minimum_driver_hourly_rate = c.hourly_rate',
      'minimum_driver_per_km = c.per_km_rate',
      'minimum_platform_revenue = c.platform_revenue',
      'commission_percent = c.commission',
      'normal_demand_multiplier = c.normal_multiplier',
      'busy_multiplier = c.busy_multiplier',
      'maximum_surge_multiplier = c.surge_cap',
      'target_difference_percent = 8.00',
      'maximum_customer_discount_percent = 15.00',
      'maximum_market_adjustment_percent = 15.00',
      "currency = 'GBP'",
      'enabled = TRUE'
    ]) expect(migration).toContain(assignment);

    expect(migration).toMatch(/WHERE s\.country_code = 'GB'[\s\S]*s\.service_type = c\.service_type[\s\S]*s\.market_city IS NULL[\s\S]*s\.zone_id IS NULL[\s\S]*s\.vehicle_class IS NULL/);
    for (const service of ['ride', 'errand', 'delivery', 'van-moving']) {
      expect(migration).toContain(`('${service}'`);
    }
  });

  it('inserts at most one fresh strategy and remains idempotent on re-run', () => {
    expect(migration.match(/INSERT INTO public\.market_pricing_strategies/g)).toHaveLength(1);
    expect(migration).toMatch(/INSERT INTO public\.market_pricing_strategies[\s\S]*WHERE NOT EXISTS/);
    expect(migration).toContain('vehicle_class IS NULL');
  });

  it('populates previously-null fields and preserves the existing uniqueness mechanism', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS');
    expect(migration).not.toContain('DROP INDEX');
    expect(migration).not.toContain('idx_market_pricing_strategies_unique_specificity');
  });

  it('forces shadow mode on and live market pricing off', () => {
    expect(migration).toMatch(/market_pricing_shadow_mode', 'true'::jsonb/);
    expect(migration).toMatch(/WHERE key = 'market_pricing_shadow_mode'/);
    expect(migration).toMatch(/market_pricing_enabled', 'false'::jsonb/);
    expect(migration).toMatch(/WHERE key = 'market_pricing_enabled'/);
  });

  it('maps the canonical busy multiplier consistently through backend and Admin', () => {
    const mapped = mapMarketPricingStrategyRow({
      country_code: 'GB', service_type: 'ride', strategy: 'manual', currency: 'GBP',
      busy_multiplier: '1.25', enabled: true
    });
    expect(mapped.busyMultiplier).toBe(1.25);
    expect(strategyRoute).toContain("busy_multiplier: body.busyMultiplier ?? body.busy_multiplier ?? null");
    expect(adminComponent).toContain("busyMultiplier: row['busy_multiplier']");
    expect(adminComponent).toContain('busyMultiplier: null');
    expect(adminService).toContain('busyMultiplier?: number | null');
    expect(`${migration}\n${strategyRoute}\n${adminComponent}\n${adminService}`).not.toContain('busy_demand_multiplier');
  });

  it.each([
    ['ride', 3.35, 3.00, 18.00, 0.70, 0.40],
    ['errand', 4.00, 3.50, 18.00, 0.65, 0.50],
    ['delivery', 3.75, 3.25, 18.00, 0.65, 0.45],
    ['van-moving', 12.00, 10.00, 22.00, 1.00, 1.50]
  ])('configures %s with its own launch and sustainability values', (service, launch, payout, hourly, perKm, revenue) => {
    expect(migration).toContain(`('${service}'`);
    for (const value of [launch, payout, hourly, perKm, revenue]) {
      expect(migration).toContain(Number(value).toFixed(2));
    }
  });

  it('keeps shopping budget separate from service fare reconciliation', () => {
    expect(PricingService.validateFareReconciliation({
      baseFare: 4, distanceCost: 0, durationCost: 0, serviceFee: 0,
      taxAmount: 0, dynamicPricingAmount: 0, commissionAmount: 0,
      platformFee: 0, driverPayout: 4, total: 4,
      currencyCode: 'GBP', currencySymbol: '£', multiplier: 1,
      commissionPercent: 0, source: 'test', extras: {},
      serviceFareBeforePlatformFee: 4, serviceFare: 4,
      shoppingBudget: 25, totalAuthorisation: 29
    })).toBe(true);
  });

  it('keeps service option charges itemised and database-configurable', () => {
    for (const field of [
      'included_task_minutes', 'per_additional_task_minute',
      'delivery_medium_package_surcharge', 'delivery_large_package_surcharge',
      'helper_surcharge', 'stairs_surcharge', 'packing_surcharge', 'fragile_items_surcharge'
    ]) expect(migration).toContain(field);
  });

  it('audits every service quote with shadow and surcharge context', () => {
    const pricingService = readFileSync(resolve(process.cwd(), 'server/services/market-pricing.service.ts'), 'utf8');
    for (const field of ['service_type', 'vehicle_class', 'platform_revenue', 'service_specific_surcharges', 'shadow_mode']) {
      expect(pricingService).toContain(field);
      expect(migration).toContain(field);
    }
  });

  it('deduplicates quotes and uses unique address tracking keys', () => {
    const quoteClient = readFileSync(resolve(process.cwd(), 'src/app/core/services/pricing/global-ai-pricing-quote.service.ts'), 'utf8');
    const bookingPage = readFileSync(resolve(process.cwd(), 'src/app/apps/mobile/features/customer/booking-request/booking-request.page.ts'), 'utf8');
    expect(quoteClient).toContain('private pending = new Map');
    expect(quoteClient).toContain('private recent = new Map');
    expect(quoteClient).toContain('if (existing) return existing');
    expect(bookingPage).toContain("result.label + '|' + result.lat + '|' + result.lng + '|' + $index");
  });
});

describe('GB App Store launch controls', () => {
  const calibration = readFileSync(resolve(process.cwd(), 'server/gb-app-store-launch-pricing-migration.txt'), 'utf8');
  const enablement = readFileSync(resolve(process.cwd(), 'server/enable-gb-launch-pricing-migration.txt'), 'utf8');
  const quoteRoute = readFileSync(resolve(process.cwd(), 'server/routes/global-ai-pricing.routes.ts'), 'utf8');

  it('calibrates all four GB fallbacks and explicit London overrides transactionally', () => {
    expect(calibration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(calibration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(calibration).toContain("('ride',2.00,0.70,0.095,0.25,3.35");
    expect(calibration).toContain("('errand',2.95,0.65,0.09,0.25,4.50");
    expect(calibration).toContain("('delivery',2.25,0.55,0.06,0.25,3.75");
    expect(calibration).toContain("('van-moving',8.00,1.00,0.25,1.50,12.00");
    expect(calibration).toContain("'GB','London'");
  });

  it('aborts unless exactly one fallback row exists for every service', () => {
    expect(calibration).toContain("ARRAY['ride','delivery','errand','van-moving']");
    expect(calibration).toContain('IF matching_rows <> 1 THEN');
    expect(calibration).toContain('RAISE EXCEPTION');
  });

  it('keeps initial launch disabled, shadowed, audited and signal-free', () => {
    for (const setting of [
      "'market_pricing_enabled','false'::jsonb",
      "'market_pricing_shadow_mode','true'::jsonb",
      "'market_pricing_audit_enabled','true'::jsonb",
      "'market_competitor_benchmarks_enabled','false'::jsonb",
      "'market_use_internal_signals','false'::jsonb"
    ]) expect(calibration).toContain(setting);
  });

  it('guards live enablement with strategies, tariffs, audits and error checks', () => {
    expect(enablement).toContain('DO NOT execute until release approval');
    expect(enablement).toContain('strategy_count <> 1');
    expect(enablement).toContain('pricing_count <> 1');
    expect(enablement).toContain('audit_count < 1');
    expect(enablement).toContain("fallback_reason = 'market_service_error'");
    expect(enablement).toContain("key = 'market_pricing_enabled'");
    expect(enablement).toContain("key = 'market_pricing_shadow_mode'");
  });

  it('generates every authoritative quote reference on the backend', () => {
    expect(quoteRoute).toContain('const quoteReference = randomUUID()');
    expect(quoteRoute).toContain('quoteReference');
  });

  it('persists and enforces the authoritative quote reference and expiry', () => {
    const bookingPage = readFileSync(resolve(process.cwd(), 'src/app/apps/mobile/features/customer/booking-request/booking-request.page.ts'), 'utf8');
    const paymentRoute = readFileSync(resolve(process.cwd(), 'server/routes/payment.routes.ts'), 'utf8');
    const walletRoute = readFileSync(resolve(process.cwd(), 'server/routes/wallet.routes.ts'), 'utf8');
    expect(bookingPage).toContain('this.lastQuoteReference = response.quoteReference');
    expect(bookingPage).toContain('quote_expires_at: this.lastQuoteExpiresAt');
    expect(bookingPage).toContain('quoteExpiresAt: this.lastQuoteExpiresAt');
    expect(paymentRoute).toContain("code: 'QUOTE_EXPIRED'");
    expect(walletRoute).toContain("code: 'QUOTE_EXPIRED'");
    expect(walletRoute).toContain('const authUserId = await getAuthUserId(req)');
    expect(walletRoute).toContain("status(401).json({ error: 'Authentication required' })");
    expect(walletRoute).toContain('paymentAmount = Number(');
    expect(walletRoute).not.toContain('amount: paymentAmount || amount');
  });

  it('routes Van moving estimates through the backend quote pipeline', () => {
    const vanPage = readFileSync(resolve(process.cwd(), 'src/app/apps/mobile/features/customer/van-moving/create-job.page.ts'), 'utf8');
    const logisticsRoute = readFileSync(resolve(process.cwd(), 'server/routes/logistics.routes.ts'), 'utf8');
    expect(vanPage).toContain('GlobalAiPricingQuoteService');
    expect(vanPage).toContain('await this.pricingQuote.getQuote');
    expect(vanPage).not.toContain('FareCalculationService');
    expect(logisticsRoute).toContain("code: 'AUTHORITATIVE_QUOTE_REQUIRED'");
    expect(logisticsRoute).not.toContain('LogisticsService.calculatePrice(distance)');
  });
});
