import { describe, expect, it } from 'vitest';
import { FareCalculationService } from './fare-calculation.service';
import { FarePricingConfig } from '../../models/pricing-config.model';

const configs: Record<string, FarePricingConfig> = {
  ride: {
    baseFare: 2.5,
    distanceRatePerKm: 0.95,
    timeRatePerMinute: 0.12,
    serviceFee: 0.25,
    minimumFare: 3.99,
    label: 'Ride'
  },
  delivery: {
    baseFare: 2.25,
    distanceRatePerKm: 0.55,
    timeRatePerMinute: 0.04,
    serviceFee: 0.1,
    minimumFare: 2.99,
    label: 'Delivery'
  },
  errand: {
    baseFare: 5,
    distanceRatePerKm: 0.95,
    timeRatePerMinute: 0.12,
    serviceFee: 0.5,
    minimumFare: 6.5,
    label: 'Errand'
  },
  'van-moving': {
    baseFare: 25,
    distanceRatePerKm: 1.6,
    timeRatePerMinute: 0.25,
    serviceFee: 1.5,
    minimumFare: 30,
    label: 'Van Moving'
  }
};

function createService(): FareCalculationService {
  const service = Object.create(FareCalculationService.prototype) as FareCalculationService & {
    pricingConfigService: { getConfig: (serviceType: string) => FarePricingConfig };
  };

  service.pricingConfigService = {
    getConfig: (serviceType: string) => configs[serviceType] || configs['ride']
  };

  return service;
}

describe('FareCalculationService', () => {
  const service = createService();

  it('keeps short package delivery competitively priced', () => {
    const estimate = service.calculateFare({
      serviceType: 'delivery',
      distanceMeters: 870,
      durationSeconds: 128,
      currencyCode: 'GBP'
    });

    expect(estimate.total).toBe(2.99);
    expect(estimate.total).toBeLessThan(4);
    expect(estimate.minimumFareApplied).toBe(true);
  });

  it('does not calculate negative fares for invalid route values', () => {
    const estimate = service.calculateFare({
      serviceType: 'ride',
      distanceMeters: -1000,
      durationSeconds: -60,
      currencyCode: 'GBP'
    });

    expect(estimate.distanceKm).toBe(0);
    expect(estimate.durationMinutes).toBe(0);
    expect(estimate.total).toBe(3.99);
  });

  it('does not invent client-only errand mode surcharges', () => {
    const collectDeliver = service.calculateFare({
      serviceType: 'errand',
      distanceMeters: 5000,
      durationSeconds: 1200,
      errandDetails: { mode: 'collect_deliver' }
    });
    const shopDeliver = service.calculateFare({
      serviceType: 'errand',
      distanceMeters: 5000,
      durationSeconds: 1200,
      errandDetails: { mode: 'shop_deliver' }
    });

    expect(Number((shopDeliver.total - collectDeliver.total).toFixed(2))).toBe(0);
  });

  it('prices larger moving jobs above small moves with boundary add-ons', () => {
    const small = service.calculateFare({
      serviceType: 'van-moving',
      distanceMeters: 5000,
      durationSeconds: 900,
      moveDetails: { size: 'small', helperCount: 0, stairsInvolved: false, packingAssistance: false, fragileItems: false }
    });
    const fullHouse = service.calculateFare({
      serviceType: 'van-moving',
      distanceMeters: 5000,
      durationSeconds: 900,
      moveDetails: { size: 'full-house', helperCount: 2, stairsInvolved: true, packingAssistance: true, fragileItems: true }
    });

    expect(fullHouse.total).toBeGreaterThan(small.total);
    expect(fullHouse.total).toBeGreaterThanOrEqual(30);
  });
});
