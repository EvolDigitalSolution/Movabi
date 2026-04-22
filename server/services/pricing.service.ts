import { supabaseAdmin } from './supabase.service';
import { CityConfig } from './city.service';

export interface PricingOptions {
  lat: number;
  lng: number;
  serviceSlug?: string;
  distanceKm?: number;
  basePrice?: number; // Legacy fallback
  countryCode?: string;
  currencyCode?: string;
  city?: CityConfig | null;
}

export interface PricingResult {
  basePrice: number;
  surgeMultiplier: number;
  totalPrice: number;
  source: string;
  city?: string;
}

export class PricingService {
  /**
   * Resolves the base price using DB config with precedence:
   * 1. City Fixed Band -> 2. Country Fixed Band -> 3. City Rule -> 4. Country Rule -> 5. Converted Fallback -> 6. Legacy Fallback
   */
  static async resolvePrice(options: PricingOptions): Promise<PricingResult> {
    const { lat, lng, serviceSlug = 'ride', distanceKm, basePrice: legacyBasePrice, city } = options;
    const countryCode = options.countryCode || 'GB';
    const currencyCode = options.currencyCode || 'GBP';

    let resolvedBasePrice = legacyBasePrice || 0;
    let source = 'legacy_fallback';

    try {
      // 0. Get Service Type ID
      const { data: serviceType } = await supabaseAdmin
        .from('service_types')
        .select('id')
        .eq('slug', serviceSlug)
        .single();

      if (serviceType && distanceKm !== undefined) {
        const serviceTypeId = serviceType.id;

        // 1. City-specific fixed fare band
        if (city) {
          const { data: cityBand } = await supabaseAdmin
            .from('fixed_fare_bands')
            .select('flat_rate')
            .eq('service_type_id', serviceTypeId)
            .eq('city_id', city.id)
            .lte('min_distance_km', distanceKm)
            .gte('max_distance_km', distanceKm)
            .maybeSingle();

          if (cityBand) {
            resolvedBasePrice = Number(cityBand.flat_rate);
            source = 'city_fixed_band';
          }
        }

        // 2. Country-level fixed fare band
        if (source === 'legacy_fallback') {
          const { data: countryBand } = await supabaseAdmin
            .from('fixed_fare_bands')
            .select('flat_rate')
            .eq('service_type_id', serviceTypeId)
            .eq('country_code', countryCode)
            .eq('currency_code', currencyCode)
            .is('city_id', null)
            .lte('min_distance_km', distanceKm)
            .gte('max_distance_km', distanceKm)
            .maybeSingle();

          if (countryBand) {
            resolvedBasePrice = Number(countryBand.flat_rate);
            source = 'country_fixed_band';
          }
        }

        // 3. City-specific pricing rule (Promo aware)
        if (source === 'legacy_fallback' && city) {
          const { data: cityRule } = await supabaseAdmin
            .from('pricing_rules')
            .select('*')
            .eq('service_type_id', serviceTypeId)
            .eq('city_id', city.id)
            .order('is_promo', { ascending: false }) // Promos first
            .maybeSingle();

          if (cityRule) {
            resolvedBasePrice = Number(cityRule.base_fare) + (distanceKm * Number(cityRule.per_km_rate));
            resolvedBasePrice = Math.max(resolvedBasePrice, Number(cityRule.minimum_fare));
            source = cityRule.is_promo ? 'city_promo_rule' : 'city_pricing_rule';
          }
        }

        // 4. Country-level pricing rule (Promo aware)
        if (source === 'legacy_fallback') {
          const { data: countryRule } = await supabaseAdmin
            .from('pricing_rules')
            .select('*')
            .eq('service_type_id', serviceTypeId)
            .eq('country_code', countryCode)
            .eq('currency_code', currencyCode)
            .is('city_id', null)
            .order('is_promo', { ascending: false }) // Promos first
            .maybeSingle();

          if (countryRule) {
            resolvedBasePrice = Number(countryRule.base_fare) + (distanceKm * Number(countryRule.per_km_rate));
            resolvedBasePrice = Math.max(resolvedBasePrice, Number(countryRule.minimum_fare));
            source = countryRule.is_promo ? 'country_promo_rule' : 'country_pricing_rule';
          }
        }

        // 5. Converted Fallback from a base market
        if (source === 'legacy_fallback') {
          const { data: convRule } = await supabaseAdmin
            .from('pricing_conversion_rules')
            .select('*')
            .eq('target_country_code', countryCode)
            .eq('is_active', true)
            .or(`service_type_slug.eq.${serviceSlug},service_type_slug.is.null`)
            .order('service_type_slug', { ascending: false, nullsFirst: false }) // Specific service first
            .limit(1)
            .maybeSingle();

          if (convRule) {
            // Fetch base market rule
            const { data: baseRule } = await supabaseAdmin
              .from('pricing_rules')
              .select('*')
              .eq('country_code', convRule.base_country_code)
              .eq('currency_code', convRule.base_currency_code)
              .eq('service_type_id', serviceTypeId)
              .is('city_id', null)
              .maybeSingle();

            if (baseRule) {
              const fx = Number(convRule.exchange_rate);
              const multiplier = Number(convRule.pricing_multiplier);
              const minMultiplier = Number(convRule.minimum_fare_multiplier);

              const convBaseFare = Number(baseRule.base_fare) * fx * multiplier;
              const convPerKm = Number(baseRule.per_km_rate) * fx * multiplier;
              const convMinFare = Number(baseRule.minimum_fare) * fx * minMultiplier;

              let calculated = convBaseFare + (distanceKm * convPerKm);
              calculated = Math.max(calculated, convMinFare);

              // Rounding
              const roundTo = Number(convRule.rounding_increment) || 0.01;
              resolvedBasePrice = Math.round(calculated / roundTo) * roundTo;
              source = 'converted_fallback';
            }
          }
        }
      }
    } catch (err) {
      console.error('[PricingService] Error resolving price from DB, falling back:', err);
    }

    console.log(`[PricingService] Price resolved: ${resolvedBasePrice} via ${source} for ${serviceSlug} in ${countryCode}`);

    return {
      basePrice: resolvedBasePrice,
      surgeMultiplier: 1.0,
      totalPrice: resolvedBasePrice,
      source,
      city: city?.name
    };
  }

  /**
   * Calculate surge multiplier based on demand and supply
   */
  static getSurgeMultiplier(demand: number, supply: number): number {
    if (supply === 0) return 2.0;

    const ratio = demand / supply;

    if (ratio > 3) return 2.0;
    if (ratio > 2) return 1.6;
    if (ratio > 1.5) return 1.3;
    if (ratio > 1.2) return 1.1;

    return 1.0;
  }

  /**
   * Simple ETA calculation
   */
  static calculateETA(distanceKm: number, avgSpeedKmh: number = 25): number {
    if (distanceKm <= 0) return 0;
    return Math.ceil((distanceKm / avgSpeedKmh) * 60);
  }
}
