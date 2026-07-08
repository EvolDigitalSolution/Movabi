import { supabaseAdmin } from './supabase.service';
import { CityConfig } from './city.service';
import { MarketplaceConfigService } from './marketplace-config.service';

export interface PricingOptions {
    lat: number;
    lng: number;
    serviceSlug?: string;
    distanceKm?: number;
    durationMinutes?: number;
    basePrice?: number;
    countryCode?: string;
    currencyCode?: string;
    city?: CityConfig | null;
    pricingPlan?: string;
    tenantId?: string | null;
    cityZone?: string | null;
    driverTier?: string | null;
    demand?: number;
    supply?: number;
    requestedAt?: string;
    weatherMultiplier?: number;
    trafficMultiplier?: number;
    itemCount?: number;
    budget?: number;
}

export interface PricingResult {
    basePrice: number;
    surgeMultiplier: number;
    dynamicPricingMultiplier: number;
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
    commissionFee: number;
    driverPayout: number;
    commissionRateUsed: number;
    baseFareUsed: number;
    pricePerKmUsed: number;
    fareBreakdown: FareBreakdown;
    marketplaceFlags: {
        dynamicPricingEnabled: boolean;
        negotiationEnabled: boolean;
        biddingEnabled: boolean;
    };
}

export interface FareBreakdown {
    baseFare: number;
    distanceCost: number;
    durationCost: number;
    serviceFee: number;
    taxAmount: number;
    dynamicPricingAmount: number;
    commissionAmount: number;
    platformFee: number;
    driverPayout: number;
    total: number;
    currencyCode: string;
    currencySymbol: string;
    multiplier: number;
    commissionPercent: number;
    source: string;
    extras: Record<string, number>;
}

export class PricingService {
    static async resolvePrice(options: PricingOptions): Promise<PricingResult> {
        const {
            serviceSlug = 'ride',
            distanceKm = 0,
            durationMinutes = 0,
            basePrice: legacyBasePrice,
            city,
            pricingPlan = 'starter',
            tenantId = null,
            cityZone = null,
            driverTier = null,
            demand = 0,
            supply = 0,
            requestedAt,
            weatherMultiplier = 1,
            trafficMultiplier = 1
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
        let serviceFee = 0;
        let distanceCost = 0;
        let durationCost = 0;

        try {
            // Admin-managed pricing_config is the operational source of truth for
            // simple per-service pricing. Regional rules remain as fallback.
            const { data: configRule, error: configError } = await supabaseAdmin
                .from('pricing_config')
                .select('*')
                .eq('service_type', serviceSlug)
                .eq('is_active', true)
                .maybeSingle();

            if (configError) {
                console.warn('[PricingService] Pricing config lookup failed:', configError.message);
            }

            if (configRule) {
                const baseFare = Number(configRule.base_fare || 0);
                const perKm = Number(configRule.per_km || 0);
                const perMin = Number(configRule.per_min || 0);
                const configServiceFee = Number(configRule.service_fee || 0);
                const minimumFare = Number(configRule.minimum_fare || 0);

                const freeIncludedItems = Math.max(0, Math.round(Number(configRule.free_included_items ?? 1)));
                const extraItemFee = Number(configRule.extra_item_fee ?? 0);
                const largeShoppingSurcharge = Number(configRule.large_shopping_surcharge ?? 0);
                const largeShoppingThreshold = Number(configRule.large_shopping_threshold ?? 50);

                distanceCost = distanceKm * perKm;
                durationCost = durationMinutes * perMin;
                serviceFee = configServiceFee;

                const extraItemCharge = options.itemCount
                    ? Math.max(0, (options.itemCount || 0) - freeIncludedItems) * extraItemFee
                    : 0;
                const largeShopCharge = (options.budget && options.budget > largeShoppingThreshold)
                    ? largeShoppingSurcharge
                    : 0;

                serviceFee += extraItemCharge + largeShopCharge;

                resolvedBasePrice = this.roundMoney(Math.max(minimumFare, baseFare + distanceCost + durationCost + serviceFee));
                resolvedCurrencyCode = configRule.currency_code || this.currencyFromCountry(countryCode);
                currencySymbol = this.symbolFromCurrency(resolvedCurrencyCode);
                baseFareUsed = baseFare;
                pricePerKmUsed = perKm;
                source = 'pricing_config';
            }

            // 0. New multi-region pricing engine
            const { data: regionalRule, error: regionalError } = source === 'legacy_fallback'
                ? await supabaseAdmin
                    .from('regional_pricing_rules')
                    .select('*')
                    .eq('country_code', countryCode)
                    .eq('service_slug', serviceSlug)
                    .eq('pricing_plan', pricingPlan)
                    .eq('is_active', true)
                    .maybeSingle()
                : { data: null, error: null } as any;

            if (regionalError) {
                console.warn('[PricingService] Regional rule lookup failed:', regionalError.message);
            }

            if (regionalRule && source === 'legacy_fallback') {
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

            // Fill in component costs for branches that didn't set them explicitly
            if (source === 'regional_pricing_rule') {
                distanceCost = distanceKm * pricePerKmUsed;
                durationCost = 0;
                serviceFee = 0;
            } else if (source !== 'pricing_config') {
                distanceCost = distanceKm * pricePerKmUsed;
                durationCost = 0;
                serviceFee = 0;
            }

            // Marketplace dynamic pricing: demand/supply, time-of-day, weather/traffic
            const dynamicSettings = await MarketplaceConfigService.getDynamicPricingSettings(tenantId);
            const surgeMultiplier = dynamicSettings.demandSupplyEnabled
                ? this.getSurgeMultiplier(demand, supply)
                : 1.0;
            const timeMultiplier = dynamicSettings.timeOfDayEnabled
                ? this.getTimeOfDayMultiplier(requestedAt)
                : 1.0;
            const dynamicPricingMultiplier = this.roundMoney(
                Math.min(
                    dynamicSettings.maxSurge,
                    surgeMultiplier * timeMultiplier * weatherMultiplier * trafficMultiplier
                )
            );
            const dynamicPricingAmount = this.roundMoney(resolvedBasePrice * (dynamicPricingMultiplier - 1));
            const preCommissionTotal = this.roundMoney(resolvedBasePrice + dynamicPricingAmount);

            // Marketplace commission: read from admin config, apply overrides
            const effectiveCommission = await MarketplaceConfigService.getEffectiveCommissionPercent(
                serviceSlug,
                cityZone,
                driverTier,
                tenantId
            );
            // If a regional rule explicitly defined a commission, it acts as a hard override for that rule.
            commissionRateUsed = source === 'regional_pricing_rule' && commissionRateUsed !== 15
                ? commissionRateUsed
                : effectiveCommission;

            commissionRateUsed = this.roundMoney(commissionRateUsed);
            const commissionFee = this.roundMoney(preCommissionTotal * (commissionRateUsed / 100));
            platformFee = commissionFee;
            driverPayout = this.roundMoney(preCommissionTotal - commissionFee);
            const totalPrice = preCommissionTotal;

            taxAmount = this.roundMoney(taxAmount);

            const fareBreakdown: FareBreakdown = {
                baseFare: this.roundMoney(baseFareUsed),
                distanceCost: this.roundMoney(distanceCost),
                durationCost: this.roundMoney(durationCost),
                serviceFee: this.roundMoney(serviceFee),
                taxAmount,
                dynamicPricingAmount,
                commissionAmount: commissionFee,
                platformFee: commissionFee,
                driverPayout,
                total: totalPrice,
                currencyCode: resolvedCurrencyCode,
                currencySymbol,
                multiplier: dynamicPricingMultiplier,
                commissionPercent: commissionRateUsed,
                source,
                extras: {
                    surgeMultiplier,
                    timeMultiplier,
                    weatherMultiplier,
                    trafficMultiplier
                }
            };

            const jobModes = await MarketplaceConfigService.determineJobModes(serviceSlug, tenantId);
            const marketplaceFlags = {
                dynamicPricingEnabled: dynamicSettings.enabled,
                negotiationEnabled: jobModes.negotiation,
                biddingEnabled: jobModes.bidding
            };

            console.log(
                `[PricingService] Price resolved: ${currencySymbol}${totalPrice} (base ${resolvedBasePrice}, multiplier ${dynamicPricingMultiplier}, commission ${commissionRateUsed}%) via ${source} for ${serviceSlug} in ${countryCode}`
            );

            return {
                basePrice: resolvedBasePrice,
                surgeMultiplier,
                dynamicPricingMultiplier,
                totalPrice,
                source,
                city: city?.name,
                countryCode,
                currencyCode: resolvedCurrencyCode,
                currencySymbol,
                pricingPlanUsed: pricingPlan,
                regionalPricingRuleId,
                taxAmount,
                platformFee,
                commissionFee,
                driverPayout,
                commissionRateUsed,
                baseFareUsed,
                pricePerKmUsed,
                fareBreakdown,
                marketplaceFlags
            };
        } catch (err) {
            console.error('[PricingService] Error resolving price from DB, falling back:', err);
        }

        // Fallback return when the marketplace path throws. Maintains old contract shape.
        const fallbackJobModes = await MarketplaceConfigService.determineJobModes(serviceSlug, tenantId);
        console.log(
            `[PricingService] Price resolved (fallback): ${currencySymbol}${resolvedBasePrice} via ${source} for ${serviceSlug} in ${countryCode}`
        );

        const fallbackCommission = this.roundMoney(15);
        const fallbackPlatformFee = this.roundMoney(resolvedBasePrice * (fallbackCommission / 100));
        const fallbackFareBreakdown: FareBreakdown = {
            baseFare: this.roundMoney(baseFareUsed),
            distanceCost: this.roundMoney(distanceKm * pricePerKmUsed),
            durationCost: 0,
            serviceFee: 0,
            taxAmount,
            dynamicPricingAmount: 0,
            commissionAmount: fallbackPlatformFee,
            platformFee: fallbackPlatformFee,
            driverPayout: this.roundMoney(resolvedBasePrice - fallbackPlatformFee),
            total: resolvedBasePrice,
            currencyCode: resolvedCurrencyCode,
            currencySymbol,
            multiplier: 1,
            commissionPercent: fallbackCommission,
            source,
            extras: {}
        };

        return {
            basePrice: resolvedBasePrice,
            surgeMultiplier: 1.0,
            dynamicPricingMultiplier: 1.0,
            totalPrice: resolvedBasePrice,
            source,
            city: city?.name,
            countryCode,
            currencyCode: resolvedCurrencyCode,
            currencySymbol,
            pricingPlanUsed: pricingPlan,
            regionalPricingRuleId,
            taxAmount,
            platformFee: fallbackPlatformFee,
            commissionFee: fallbackPlatformFee,
            driverPayout: this.roundMoney(resolvedBasePrice - fallbackPlatformFee),
            commissionRateUsed: fallbackCommission,
            baseFareUsed,
            pricePerKmUsed,
            fareBreakdown: fallbackFareBreakdown,
            marketplaceFlags: {
                dynamicPricingEnabled: false,
                negotiationEnabled: fallbackJobModes.negotiation,
                biddingEnabled: fallbackJobModes.bidding
            }
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

    static getTimeOfDayMultiplier(requestedAt?: string): number {
        const date = requestedAt ? new Date(requestedAt) : new Date();
        const hour = date.getHours();

        // Peak hours: 7-9 AM and 5-8 PM
        if ((hour >= 7 && hour < 10) || (hour >= 17 && hour < 21)) {
            return 1.15;
        }

        // Night premium
        if (hour >= 23 || hour < 5) {
            return 1.25;
        }

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

    /**
     * Re-derive the price-related fields on a job when the fare has been
     * negotiated/locked to a different amount. This keeps driver payout,
     * platform fee and tax proportional to the agreed fare.
     */
    static applyAgreedFare(job: any, agreedFare: number): Partial<any> {
        const originalTotal = Number(job?.total_price || job?.price || agreedFare) || agreedFare;
        const safeAgreed = Math.max(0, Number(agreedFare) || 0);
        const ratio = originalTotal > 0 ? safeAgreed / originalTotal : 1;

        const round = this.roundMoney;

        const platformFee = round(Number(job?.platform_fee || 0) * ratio);
        const driverPayout = round(Number(job?.driver_payout || 0) * ratio);
        const taxAmount = round(Number(job?.tax_amount || 0) * ratio);
        const baseFareUsed = round(Number(job?.base_fare_used || job?.base_fare || 0) * ratio);
        const pricePerKmUsed = Number(job?.price_per_km_used || 0);

        const fareBreakdown = job?.fare_breakdown || {};
        const scaledBreakdown: Record<string, number> = {};
        for (const key of Object.keys(fareBreakdown)) {
            const value = Number(fareBreakdown[key]);
            scaledBreakdown[key] = Number.isFinite(value) ? round(value * ratio) : fareBreakdown[key];
        }

        return {
            price: safeAgreed,
            total_price: safeAgreed,
            estimated_price: safeAgreed,
            app_confirmed_price: safeAgreed,
            frontend_total_price: safeAgreed,
            regional_price: round(Number(job?.regional_price || 0) * ratio),
            platform_fee: platformFee,
            driver_payout: driverPayout,
            tax_amount: taxAmount,
            base_fare_used: baseFareUsed,
            price_per_km_used: pricePerKmUsed,
            commission_rate_used: Number(job?.commission_rate_used || 15),
            fare_breakdown: scaledBreakdown
        };
    }
}
