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

  async calculatePrice(serviceTypeId: string, serviceSlug: ServiceTypeEnum, distanceKm: number): Promise<number> {
    if (!serviceTypeId) {
      console.warn('PricingService: Missing serviceTypeId, skipping calculation');
      return 0;
    }

    const currencyCode = this.config.currencyCode;
    const countryCode = this.config.currentCountry().code;

    if (!currencyCode || !countryCode) {
      console.warn('PricingService: Missing currency or country config', { currencyCode, countryCode });
      return 0;
    }

    console.log('PricingService: Calculating price', { serviceTypeId, serviceSlug, distanceKm, currencyCode, countryCode });

    try {
      // 1. Check for fixed fare bands (primarily for Rides)
      if (serviceSlug === ServiceTypeEnum.RIDE) {
        const { data: band, error: bandError } = await this.supabase
          .from('fixed_fare_bands')
          .select('flat_rate')
          .eq('service_type_id', serviceTypeId)
          .eq('currency_code', currencyCode)
          .eq('country_code', countryCode)
          .lte('min_distance_km', distanceKm)
          .gte('max_distance_km', distanceKm)
          .single();

        if (bandError && bandError.code !== 'PGRST116') { // PGRST116 is "no rows returned"
          console.error('PricingService: Error fetching fixed fare band', bandError);
        }

        if (band) return band.flat_rate;
      }

      // 2. Fallback to pricing rules (Base + Distance)
      const { data: rule, error: ruleError } = await this.supabase
        .from('pricing_rules')
        .select('*')
        .eq('service_type_id', serviceTypeId)
        .eq('currency_code', currencyCode)
        .eq('country_code', countryCode)
        .single();

      if (ruleError && ruleError.code !== 'PGRST116') {
        console.error('PricingService: Error fetching pricing rule', ruleError);
        // If it's a 400 or other fatal error, we might want to stop here or fallback to service_type
      }

      if (!rule) {
        console.log('PricingService: No pricing rule found, falling back to service_type');
        // Last resort: fetch from service_type directly if rules aren't set up
        const { data: service, error: serviceError } = await this.supabase
          .from('service_types')
          .select('base_price')
          .eq('id', serviceTypeId)
          .single();
        
        if (serviceError) {
          console.error('PricingService: Error fetching service type fallback', serviceError);
          return 0;
        }
        
        if (!service) return 0;
        return service.base_price;
      }

      const price = rule.base_fare + (distanceKm * rule.per_km_rate);
      return Math.max(price, rule.minimum_fare);
    } catch (err) {
      console.error('PricingService: Unexpected error in calculatePrice', err);
      return 0;
    }
  }
}
