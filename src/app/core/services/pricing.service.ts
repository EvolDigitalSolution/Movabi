import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase/supabase.service';
import { ServiceTypeEnum } from '../../shared/models/booking.model';

@Injectable({
  providedIn: 'root'
})
export class PricingService {
  private supabase = inject(SupabaseService);

  async calculatePrice(serviceTypeId: string, serviceCode: ServiceTypeEnum, distanceKm: number): Promise<number> {
    // 1. Check for fixed fare bands (primarily for Rides)
    if (serviceCode === ServiceTypeEnum.RIDE) {
      const { data: band } = await this.supabase
        .from('fixed_fare_bands')
        .select('flat_rate')
        .eq('service_type_id', serviceTypeId)
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
      .single();

    if (!rule) {
      // Last resort: fetch from service_type directly if rules aren't set up
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

  // Future: Add logic for dynamic surge pricing here
}
