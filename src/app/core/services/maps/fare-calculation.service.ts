import { Injectable, inject } from '@angular/core';
import { ServiceTypeSlug } from '../../models/maps/map-marker.model';
import { PricingInput, FareEstimate } from '../../models/maps/fare-estimate.model';
import { PricingConfigService } from '../pricing/pricing-config.service';
import { FarePricingConfig } from '../../models/pricing-config.model';

@Injectable({
  providedIn: 'root'
})
export class FareCalculationService {
  private pricingConfigService = inject(PricingConfigService);

  /**
   * Calculate fare based on route and service type
   */
  calculateFare(input: PricingInput): FareEstimate {
    const serviceType = input.serviceType || 'ride';
    const config = this.getPricingConfig(serviceType, {
      baseFare: input.basePriceOverride || undefined
    });

    const distanceMeters = Math.max(0, input.distanceMeters || 0);
    const durationSeconds = Math.max(0, input.durationSeconds || 0);

    const distanceKm = distanceMeters / 1000;
    const durationMinutes = durationSeconds / 60;

    const distanceFare = this.normalizeMoney(distanceKm * config.distanceRatePerKm);
    const timeFare = this.normalizeMoney(durationMinutes * config.timeRatePerMinute);
    const baseFare = this.normalizeMoney(config.baseFare);
    const serviceFee = this.normalizeMoney(config.serviceFee);

    const subtotal = this.normalizeMoney(baseFare + distanceFare + timeFare);
    let totalBeforeMinimum = this.normalizeMoney(subtotal + serviceFee);
    
    // Apply Surge Multiplier
    const surgeMultiplier = input.surgeMultiplier || 1.0;
    let surgeAmount = 0;
    if (surgeMultiplier > 1.0) {
      const originalTotal = totalBeforeMinimum;
      totalBeforeMinimum = this.normalizeMoney(totalBeforeMinimum * surgeMultiplier);
      surgeAmount = this.normalizeMoney(totalBeforeMinimum - originalTotal);
    }

    // Apply errand-specific logic
    if (serviceType === 'errand' && input.errandDetails) {
      const mode = input.errandDetails.mode || 'collect_deliver';
      
      // Mode-specific service fee additions
      switch (mode) {
        case 'quick_buy':
          totalBeforeMinimum += 2.0; // Extra £2 for quick buy
          break;
        case 'shop_deliver':
          totalBeforeMinimum += 5.0; // Extra £5 for full shopping
          break;
        default:
          // collect_deliver uses base service fee
          break;
      }
      
      totalBeforeMinimum = this.normalizeMoney(totalBeforeMinimum);
    }

    // Apply van-moving multipliers if applicable
    if (serviceType === 'van-moving' && input.moveDetails) {
      const details = input.moveDetails;
      let multiplier = 1.0;
      
      // Size multiplier
      switch (details.size) {
        case 'medium': multiplier = 1.3; break;
        case 'large': multiplier = 1.7; break;
        case 'full-house': multiplier = 2.5; break;
        default: multiplier = 1.0;
      }
      
      totalBeforeMinimum *= multiplier;
      
      // Add-ons
      if (details.helperCount > 0) {
        totalBeforeMinimum += (details.helperCount * 15.0); // £15 per helper
      }
      if (details.stairsInvolved) {
        totalBeforeMinimum += 10.0;
      }
      if (details.packingAssistance) {
        totalBeforeMinimum += 25.0;
      }
      if (details.fragileItems) {
        totalBeforeMinimum += 5.0;
      }
      
      totalBeforeMinimum = this.normalizeMoney(totalBeforeMinimum);
    }

    const minimumFare = config.minimumFare;
    const minimumFareApplied = totalBeforeMinimum < minimumFare;
    const total = minimumFareApplied ? minimumFare : totalBeforeMinimum;

    return {
      serviceType,
      currencyCode: input.currencyCode || 'GBP',
      distanceKm: Number(distanceKm.toFixed(2)),
      durationMinutes: Math.ceil(durationMinutes),
      baseFare,
      distanceFare,
      timeFare,
      serviceFee,
      subtotal,
      minimumFareApplied,
      surgeMultiplier,
      surgeAmount,
      total: this.normalizeMoney(total),
      breakdownLabel: config.label
    };
  }

  /**
   * Round to 2 decimal places
   */
  normalizeMoney(value: number): number {
    if (isNaN(value) || value < 0) return 0;
    return Math.round(value * 100) / 100;
  }

  /**
   * Get pricing configuration with optional overrides
   */
  getPricingConfig(serviceType: ServiceTypeSlug, overrides?: Partial<FarePricingConfig>): FarePricingConfig {
    const baseConfig = this.pricingConfigService.getConfig(serviceType);
    return {
      ...baseConfig,
      ...overrides
    };
  }
}
