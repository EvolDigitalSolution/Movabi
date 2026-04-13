import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { PricingConfig, FarePricingConfig } from '../../models/pricing-config.model';
import { ServiceTypeSlug } from '../../models/maps/map-marker.model';

@Injectable({
  providedIn: 'root'
})
export class PricingConfigService {
  private supabase = inject(SupabaseService);
  
  private configs = new Map<ServiceTypeSlug, FarePricingConfig>();
  private isLoaded = false;

  // Fallback defaults as per spec
  private readonly DEFAULT_CONFIGS: Record<ServiceTypeSlug, FarePricingConfig> = {
    ride: {
      baseFare: 2.5,
      distanceRatePerKm: 0.95,
      timeRatePerMinute: 0.15,
      serviceFee: 0.75,
      minimumFare: 5.0,
      label: 'Estimated ride fare'
    },
    errand: {
      baseFare: 5.0,
      distanceRatePerKm: 0.9,
      timeRatePerMinute: 0.28,
      serviceFee: 1.5,
      minimumFare: 8.0,
      label: 'Estimated errand fee'
    },
    'van-moving': {
      baseFare: 18.0,
      distanceRatePerKm: 1.8,
      timeRatePerMinute: 0.35,
      serviceFee: 3.5,
      minimumFare: 25.0,
      label: 'Estimated moving fare'
    }
  };

  constructor() {
    // Initialize with defaults immediately
    this.initializeWithDefaults();
  }

  private initializeWithDefaults() {
    Object.entries(this.DEFAULT_CONFIGS).forEach(([type, config]) => {
      this.configs.set(type as ServiceTypeSlug, config);
    });
  }

  /**
   * Load pricing configurations from Supabase
   */
  async loadPricingConfigs(): Promise<void> {
    try {
      const { data, error } = await this.supabase
        .from('pricing_config')
        .select('*')
        .eq('is_active', true);

      if (error) throw error;

      if (data && data.length > 0) {
        data.forEach((item: PricingConfig) => {
          const serviceType = item.service_type;
          this.configs.set(serviceType, {
            baseFare: Number(item.base_fare),
            distanceRatePerKm: Number(item.per_km),
            timeRatePerMinute: Number(item.per_min),
            serviceFee: Number(item.service_fee),
            minimumFare: Number(item.minimum_fare),
            label: this.getLabelForService(serviceType)
          });
        });
        this.isLoaded = true;
        console.log('Pricing configurations loaded from database.');
      }
    } catch (error) {
      console.warn('Failed to load pricing from database, using defaults.', error);
      // Fallback is already initialized in constructor
    }
  }

  /**
   * Get pricing configuration for a specific service type
   */
  getConfig(serviceType: ServiceTypeSlug): FarePricingConfig {
    return this.configs.get(serviceType) || this.DEFAULT_CONFIGS[serviceType] || this.DEFAULT_CONFIGS.ride;
  }

  private getLabelForService(serviceType: ServiceTypeSlug): string {
    switch (serviceType) {
      case 'ride': return 'Estimated ride fare';
      case 'errand': return 'Estimated errand fee';
      case 'van-moving': return 'Estimated moving fare';
      default: return 'Estimated fare';
    }
  }
}
