import { supabaseAdmin } from './supabase.service';
import { CityConfig } from './city.service';

export interface PricingOptions {
    lat: number;
    lng: number;
    serviceSlug?: string;
    distanceKm?: number;
    basePrice?: number;
    countryCode?: string;
    currencyCode?: string;
    city?: CityConfig | null;
    pricingPlan?: string;
}

export interface PricingResult {
    basePrice: number;
    surgeMultiplier: number;
    totalPrice: number;
    source: string;
    city?: string;
    countryCode: string;
    currencyCode: string;
    currencySymbol: string;
    pricingPlanUsed: string;
    regionalPricingRuleId?: string | null;
    taxAmount: number;
    platformFee: number;
    driverPayout: number;
    commissionRateUsed: number;
    baseFareUsed: number;
    pricePerKmUsed: number;
}

export class PricingService {
    static async resolvePrice(options: PricingOptions): Promise<PricingResult> {
        const {
            serviceSlug = 'ride',
            distanceKm = 0,
            basePrice: legacyBasePrice,
            city,
            pricingPlan = 'starter'
        } = options;

        const countryCode = String(options.countryCode || 'GB').toUpperCase();
        const currencyCode = String(options.currencyCode || '').toUpperCase();

        let resolvedBasePrice = Number(legacyBasePrice || 0);
        let source = 'legacy_fallback';

        let currencySymbol = this.symbolFromCurrency(currencyCode || 'GBP');
        let resolvedCurrencyCode = currencyCode || 'GBP';
        let regionalPricingRuleId: string | null = null;
        let taxAmount = 0;
        let platformFee = 0;
        let driverPayout = 0;
        let commissionRateUsed = 15;
        let baseFareUsed = 0;
        let pricePerKmUsed = 0;

        try {
            // 0. New multi-region pricing engine
            const { data: regionalRule, error: regionalError } = await supabaseAdmin
                .from('regional_pricing_rules')
                .select('*')
                .eq('country_code', countryCode)
                .eq('service_slug', serviceSlug)
                .eq('pricing_plan', pricingPlan)
                .eq('is_active', true)
                .maybeSingle();

            if (regionalError) {
                console.warn('[PricingService] Regional rule lookup failed:', regionalError.message);
            }

            if (regionalRule) {
                const baseFare = Number(regionalRule.base_fare || 0);
                const perKm = Number(regionalRule.price_per_km || 0);
                const minimumFare = Number(regionalRule.minimum_fare || 0);
                const taxPercent = Number(regionalRule.tax_percent || 0);
                const commissionPercent = Number(regionalRule.platform_commission_percent || 15);

                const subtotal = Math.max(minimumFare, baseFare + distanceKm * perKm);
                taxAmount = this.roundMoney(subtotal * (taxPercent / 100));
                resolvedBasePrice = this.roundMoney(subtotal + taxAmount);

                platformFee = this.roundMoney(resolvedBasePrice * (commissionPercent / 100));
                driverPayout = this.roundMoney(resolvedBasePrice - platformFee);

                resolvedCurrencyCode = regionalRule.currency_code || this.currencyFromCountry(countryCode);
                currencySymbol = regionalRule.currency_symbol || this.symbolFromCurrency(resolvedCurrencyCode);
                regionalPricingRuleId = regionalRule.id;
                commissionRateUsed = commissionPercent;
                baseFareUsed = baseFare;
                pricePerKmUsed = perKm;
                source = 'regional_pricing_rule';
            }

            // 1. Existing engine fallback
            if (source === 'legacy_fallback') {
                const { data: serviceType } = await supabaseAdmin
                    .from('service_types')
                    .select('id')
                    .eq('slug', serviceSlug)
                    .maybeSingle();

                if (serviceType && distanceKm !== undefined) {
                    const serviceTypeId = serviceType.id;

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

                    if (source === 'legacy_fallback') {
                        const { data: countryBand } = await supabaseAdmin
                            .from('fixed_fare_bands')
                            .select('flat_rate')
                            .eq('service_type_id', serviceTypeId)
                            .eq('country_code', countryCode)
                            .eq('currency_code', resolvedCurrencyCode)
                            .is('city_id', null)
                            .lte('min_distance_km', distanceKm)
                            .gte('max_distance_km', distanceKm)
                            .maybeSingle();

                        if (countryBand) {
                            resolvedBasePrice = Number(countryBand.flat_rate);
                            source = 'country_fixed_band';
                        }
                    }

                    if (source === 'legacy_fallback' && city) {
                        const { data: cityRule } = await supabaseAdmin
                            .from('pricing_rules')
                            .select('*')
                            .eq('service_type_id', serviceTypeId)
                            .eq('city_id', city.id)
                            .eq('is_active', true)
                            .order('is_promo', { ascending: false })
                            .order('priority', { ascending: true })
                            .maybeSingle();

                        if (cityRule) {
                            const baseFare = Number(cityRule.base_fare || cityRule.base_fee || 0);
                            const perKm = Number(cityRule.per_km_rate || cityRule.per_km_fee || 0);
                            const minimumFare = Number(cityRule.minimum_fare || 0);

                            resolvedBasePrice = Math.max(minimumFare, baseFare + distanceKm * perKm);
                            baseFareUsed = baseFare;
                            pricePerKmUsed = perKm;
                            source = cityRule.is_promo ? 'city_promo_rule' : 'city_pricing_rule';
                        }
                    }

                    if (source === 'legacy_fallback') {
                        const { data: countryRule } = await supabaseAdmin
                            .from('pricing_rules')
                            .select('*')
                            .eq('service_type_id', serviceTypeId)
                            .eq('country_code', countryCode)
                            .eq('currency_code', resolvedCurrencyCode)
                            .eq('is_active', true)
                            .is('city_id', null)
                            .order('is_promo', { ascending: false })
                            .order('priority', { ascending: true })
                            .maybeSingle();

                        if (countryRule) {
                            const baseFare = Number(countryRule.base_fare || countryRule.base_fee || 0);
                            const perKm = Number(countryRule.per_km_rate || countryRule.per_km_fee || 0);
                            const minimumFare = Number(countryRule.minimum_fare || 0);

                            resolvedBasePrice = Math.max(minimumFare, baseFare + distanceKm * perKm);
                            baseFareUsed = baseFare;
                            pricePerKmUsed = perKm;
                            source = countryRule.is_promo ? 'country_promo_rule' : 'country_pricing_rule';
                        }
                    }

                    if (source === 'legacy_fallback') {
                        const { data: convRule } = await supabaseAdmin
                            .from('pricing_conversion_rules')
                            .select('*')
                            .eq('target_country_code', countryCode)
                            .eq('is_active', true)
                            .or(`service_type_slug.eq.${serviceSlug},service_type_slug.is.null`)
                            .order('service_type_slug', { ascending: false, nullsFirst: false })
                            .limit(1)
                            .maybeSingle();

                        if (convRule) {
                            const { data: baseRule } = await supabaseAdmin
                                .from('pricing_rules')
                                .select('*')
                                .eq('country_code', convRule.base_country_code)
                                .eq('currency_code', convRule.base_currency_code)
                                .eq('service_type_id', serviceTypeId)
                                .is('city_id', null)
                                .maybeSingle();

                            if (baseRule) {
                                const fx = Number(convRule.exchange_rate || 1);
                                const multiplier = Number(convRule.pricing_multiplier || 1);
                                const minMultiplier = Number(convRule.minimum_fare_multiplier || 1);

                                const convBaseFare = Number(baseRule.base_fare || baseRule.base_fee || 0) * fx * multiplier;
                                const convPerKm = Number(baseRule.per_km_rate || baseRule.per_km_fee || 0) * fx * multiplier;
                                const convMinFare = Number(baseRule.minimum_fare || 0) * fx * minMultiplier;

                                let calculated = convBaseFare + distanceKm * convPerKm;
                                calculated = Math.max(calculated, convMinFare);

                                const roundTo = Number(convRule.rounding_increment) || 0.01;
                                resolvedBasePrice = Math.round(calculated / roundTo) * roundTo;
                                baseFareUsed = convBaseFare;
                                pricePerKmUsed = convPerKm;
                                source = 'converted_fallback';
                            }
                        }
                    }
                }
            }

            resolvedBasePrice = this.roundMoney(resolvedBasePrice);

            if (source !== 'regional_pricing_rule') {
                platformFee = this.roundMoney(resolvedBasePrice * (commissionRateUsed / 100));
                driverPayout = this.roundMoney(resolvedBasePrice - platformFee);
            }
        } catch (err) {
            console.error('[PricingService] Error resolving price from DB, falling back:', err);
        }

        console.log(
            `[PricingService] Price resolved: ${currencySymbol}${resolvedBasePrice} via ${source} for ${serviceSlug} in ${countryCode}`
        );

        return {
            basePrice: resolvedBasePrice,
            surgeMultiplier: 1.0,
            totalPrice: resolvedBasePrice,
            source,
            city: city?.name,
            countryCode,
            currencyCode: resolvedCurrencyCode,
            currencySymbol,
            pricingPlanUsed: pricingPlan,
            regionalPricingRuleId,
            taxAmount,
            platformFee,
            driverPayout,
            commissionRateUsed,
            baseFareUsed,
            pricePerKmUsed
        };
    }

    static getSurgeMultiplier(demand: number, supply: number): number {
        if (supply === 0) return 2.0;

        const ratio = demand / supply;

        if (ratio > 3) return 2.0;
        if (ratio > 2) return 1.6;
        if (ratio > 1.5) return 1.3;
        if (ratio > 1.2) return 1.1;

        return 1.0;
    }

    static calculateETA(distanceKm: number, avgSpeedKmh: number = 25): number {
        if (distanceKm <= 0) return 0;
        return Math.ceil((distanceKm / avgSpeedKmh) * 60);
    }

    private static roundMoney(value: number): number {
        return Number(Number(value || 0).toFixed(2));
    }

    private static currencyFromCountry(countryCode: string): string {
        const map: Record<string, string> = {
            GB: 'GBP',
            US: 'USD',
            NG: 'NGN',
            AE: 'AED',
            CA: 'CAD',
            AU: 'AUD',
            IE: 'EUR',
            FR: 'EUR',
            DE: 'EUR',
            ES: 'EUR',
            IT: 'EUR',
            NL: 'EUR',
            BE: 'EUR',
            PT: 'EUR'
        };

        return map[String(countryCode || 'GB').toUpperCase()] || 'GBP';
    }

    private static symbolFromCurrency(currencyCode: string): string {
        const map: Record<string, string> = {
            GBP: '£',
            USD: '$',
            NGN: '₦',
            AED: 'د.إ',
            CAD: '$',
            AUD: '$',
            EUR: '€'
        };

        return map[String(currencyCode || 'GBP').toUpperCase()] || '£';
    }
}