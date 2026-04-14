import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SupabaseService } from './supabase/supabase.service';
import { ServiceTypeEnum } from '../../shared/models/booking.model';
import { AppConfigService } from './config/app-config.service';
import { ApiUrlService } from './api-url.service';

@Injectable({
  providedIn: 'root'
})
export class PricingService {
  private supabase = inject(SupabaseService);
  private config = inject(AppConfigService);
  private http = inject(HttpClient);
  private apiUrlService = inject(ApiUrlService);

  surgeMultiplier = signal<number>(1.0);

  async calculatePrice(serviceTypeId: string, serviceSlug: ServiceTypeEnum, distanceKm: number, lat?: number, lng?: number): Promise<number> {
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

    try {
      let basePrice = 0;

      // 1. Check for fixed fare bands (primarily for Rides)
      if (serviceSlug === ServiceTypeEnum.RIDE) {
        const { data: band } = await this.supabase
          .from('fixed_fare_bands')
          .select('flat_rate')
          .eq('service_type_id', serviceTypeId)
          .eq('currency_code', currencyCode)
          .eq('country_code', countryCode)
          .lte('min_distance_km', distanceKm)
          .gte('max_distance_km', distanceKm)
          .single();

        if (band) basePrice = band.flat_rate;
      }

      if (basePrice === 0) {
        // 2. Fallback to pricing rules (Base + Distance)
        const { data: rule } = await this.supabase
          .from('pricing_rules')
          .select('*')
          .eq('service_type_id', serviceTypeId)
          .eq('currency_code', currencyCode)
          .eq('country_code', countryCode)
          .single();

        if (rule) {
          basePrice = rule.base_fare + (distanceKm * rule.per_km_rate);
          basePrice = Math.max(basePrice, rule.minimum_fare);
        } else {
          // Last resort: fetch from service_type directly
          const { data: service } = await this.supabase
            .from('service_types')
            .select('base_price')
            .eq('id', serviceTypeId)
            .single();
          
          basePrice = service?.base_price || 0;
        }
      }

      // 3. Apply Surge if coordinates provided
      if (lat !== undefined && lng !== undefined) {
        try {
          const surgeData = await firstValueFrom(
            this.http.post<{ surgeMultiplier: number; totalPrice: number }>(this.apiUrlService.getApiUrl('/api/payment/calculate-price'), {
              lat,
              lng,
              basePrice
            })
          );
          this.surgeMultiplier.set(surgeData.surgeMultiplier || 1.0);
          return surgeData.totalPrice;
        } catch (e) {
          console.error('Failed to fetch surge pricing, using base price', e);
          this.surgeMultiplier.set(1.0);
        }
      }

      this.surgeMultiplier.set(1.0);
      return basePrice;
    } catch (err) {
      console.error('PricingService: Unexpected error in calculatePrice', err);
      return 0;
    }
  }
}
