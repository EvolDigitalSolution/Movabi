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
            baseFare: 5,
            distanceRatePerKm: 1.5,
            timeRatePerMinute: 0.2,
            serviceFee: 1,
            minimumFare: 6,
            label: 'Ride'
        },

        delivery: {
            baseFare: 7.5,
            distanceRatePerKm: 1.2,
            timeRatePerMinute: 0.15,
            serviceFee: 1.0,
            minimumFare: 8,
            label: 'Delivery'
        },

        errand: {
            baseFare: 10,
            distanceRatePerKm: 1.5,
            timeRatePerMinute: 0.2,
            serviceFee: 1,
            minimumFare: 12,
            label: 'Errand'
        },

        'van-moving': {
            baseFare: 45,
            distanceRatePerKm: 2.5,
            timeRatePerMinute: 0.4,
            serviceFee: 3,
            minimumFare: 50,
            label: 'Van Moving'
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
