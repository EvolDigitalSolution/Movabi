import { describe, expect, it } from 'vitest';
import { computeMarketAdjustment, ComputeMarketAdjustmentInput } from '../../server/services/market-pricing.service';
import { MarketPricingStrategy } from '../../server/types/market-pricing.types';

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

  it('15. insufficient benchmarks trigger a safe fallback', () => {
    const result = computeMarketAdjustment(baseInput({ benchmarkCount: 1, marketReferenceFare: null }));
    expect(result.fallbackReason).toBe('insufficient_market_data');
    expect(result.adjustmentApplied).toBe(false);
    expect(result.adjustedServiceFare).toBe(result.baseServiceFare);
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
});
