import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase/supabase.service';
import { ServiceTypeEnum } from '../../shared/models/booking.model';
import { AppConfigService } from './config/app-config.service';

@Injectable({
  providedIn: 'root'
})
export class PricingService {
  private supabase = inject(SupabaseService);
  private config = inject(AppConfigService);

  async calculatePrice(serviceTypeId: string, serviceCode: ServiceTypeEnum, distanceKm: number): Promise<number> {
    const currencyCode = this.config.currencyCode;
    const countryCode = this.config.currentCountry().code;

    // 1. Check for fixed fare bands (primarily for Rides)
    if (serviceCode === ServiceTypeEnum.RIDE) {
      const { data: band } = await this.supabase
        .from('fixed_fare_bands')
        .select('flat_rate')
        .eq('service_type_id', serviceTypeId)
        .eq('currency_code', currencyCode)
        .eq('country_code', countryCode)
        .lte('min_distance_km', distanceKm)
        .gte('max_distance_km', distanceKm)
        .single();

      if (band) return band.flat_rate;
    }

    // 2. Fallback to pricing rules (Base + Distance)
    const { data: rule } = await this.supabase
      .from('pricing_rules')
      .select('*')
      .eq('service_type_id', serviceTypeId)
      .eq('currency_code', currencyCode)
      .eq('country_code', countryCode)
      .single();

    if (!rule) {
      // Last resort: fetch from service_type directly if rules aren't set up
      // Note: service_types table doesn't have currency/country yet, 
      // but we should prefer pricing_rules anyway.
      const { data: service } = await this.supabase
        .from('service_types')
        .select('base_price, price_per_km')
        .eq('id', serviceTypeId)
        .single();
      
      if (!service) return 0;
      return service.base_price + (distanceKm * service.price_per_km);
    }

    const price = rule.base_fare + (distanceKm * rule.per_km_rate);
    return Math.max(price, rule.minimum_fare);
  }
}
