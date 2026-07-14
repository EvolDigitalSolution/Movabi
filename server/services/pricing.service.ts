import { supabaseAdmin } from './supabase.service';
import { CityConfig } from './city.service';
import { MarketplaceConfigService, DynamicPricingSettings, PlatformFeeMode, PlatformFeeSettings, EffectiveDynamicPricingSettings } from './marketplace-config.service';

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
    preAdjustmentFare?: number;
    pricingAdjustmentType?: 'surge' | 'discount' | 'none';
    pricingMultiplier?: number;
    pricingAdjustmentAmount?: number;
    postAdjustmentFare?: number;
    minimumFareAdjustment?: number;
    maximumFareAdjustment?: number;
    negotiationAdjustment?: number;
    serviceFareBeforePlatformFee?: number;
    platformFeeType?: PlatformFeeMode;
    platformFeeFixed?: number;
    platformFeePercent?: number;
    platformFeeAmount?: number;
    platformFeeSource?: string;
    platformFeeConfigVersion?: string | null;
    commissionSource?: string;
    commissionConfigVersion?: string | null;
    serviceFare?: number;
    shoppingBudget?: number;
    totalAuthorisation?: number;
    driverGrossEarnings?: number;
    calculationVersion?: string;
    reconciliationValid?: boolean;
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

        const canonicalServiceSlug = MarketplaceConfigService.canonicalServiceSlug(serviceSlug);
        const countryCode = String(options.countryCode || 'GB').toUpperCase();
        const currencyCode = String(options.currencyCode || '').toUpperCase();

        let resolvedBasePrice = Number(legacyBasePrice || 0);
        let source = 'legacy_fallback';

        let currencySymbol = this.symbolFromCurrency(currencyCode || 'GBP');
        let resolvedCurrencyCode = currencyCode || 'GBP';
        let regionalPricingRuleId: string | null = null;
        let pricingConfigId: string | null = null;
        let taxAmount = 0;
        let platformFee = 0;
        let driverPayout = 0;
        let commissionRateUsed = 0;
        let baseFareUsed = 0;
        let pricePerKmUsed = 0;
        let serviceFee = 0;
        let distanceCost = 0;
        let durationCost = 0;
        let itemCharges = 0;

        try {
            const pricingConfig = await MarketplaceConfigService.getEffectivePricingConfig(
                canonicalServiceSlug,
                { countryCode, currencyCode: currencyCode || undefined, city: city?.name },
                cityZone
            );

            if (pricingConfig.source === 'pricing_config') {
                distanceCost = distanceKm * pricingConfig.perKm;
                durationCost = durationMinutes * pricingConfig.perMin;
                serviceFee = pricingConfig.serviceFee;

                const extraItemCharge = options.itemCount
                    ? Math.max(0, (options.itemCount || 0) - pricingConfig.freeIncludedItems) * pricingConfig.extraItemFee
                    : 0;
                const largeShopCharge = (options.budget && options.budget > pricingConfig.largeShoppingThreshold)
                    ? pricingConfig.largeShoppingSurcharge
                    : 0;

                itemCharges = this.roundMoney(extraItemCharge + largeShopCharge);
                serviceFee += itemCharges;

                resolvedBasePrice = this.roundMoney(Math.max(
                    pricingConfig.minimumFare,
                    pricingConfig.baseFare + distanceCost + durationCost + serviceFee
                ));
                resolvedCurrencyCode = pricingConfig.currencyCode || this.currencyFromCountry(countryCode);
                currencySymbol = this.symbolFromCurrency(resolvedCurrencyCode);
                baseFareUsed = pricingConfig.baseFare;
                pricePerKmUsed = pricingConfig.perKm;
                pricingConfigId = pricingConfig.pricingConfigId;
                source = pricingConfig.source;
            }

            // 0. New multi-region pricing engine
            const { data: regionalRule, error: regionalError } = source === 'legacy_fallback'
                ? await supabaseAdmin
                    .from('regional_pricing_rules')
                    .select('*')
                    .eq('country_code', countryCode)
                    .eq('service_slug', canonicalServiceSlug)
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

                const subtotal = Math.max(minimumFare, baseFare + distanceKm * perKm);
                taxAmount = this.roundMoney(subtotal * (taxPercent / 100));
                resolvedBasePrice = this.roundMoney(subtotal + taxAmount);

                resolvedCurrencyCode = regionalRule.currency_code || this.currencyFromCountry(countryCode);
                currencySymbol = regionalRule.currency_symbol || this.symbolFromCurrency(resolvedCurrencyCode);
                regionalPricingRuleId = regionalRule.id;
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
                                .or(`service_type_slug.eq.${canonicalServiceSlug},service_type_slug.is.null`)
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
            const dynamicSettings = await MarketplaceConfigService.getEffectiveDynamicPricingConfig(
                canonicalServiceSlug,
                { countryCode, currencyCode: resolvedCurrencyCode, city: city?.name },
                cityZone,
                tenantId
            );
            const surgeMultiplier = dynamicSettings.demandSupplyEnabled
                ? this.getSurgeMultiplier(demand, supply, dynamicSettings)
                : 1.0;
            const timeMultiplier = dynamicSettings.timeOfDayEnabled
                ? this.getTimeOfDayMultiplier(dynamicSettings, requestedAt)
                : 1.0;
            const configuredWeatherMultiplier = Number(dynamicSettings.weatherMultiplier ?? 1);
            const configuredTrafficMultiplier = Number(dynamicSettings.trafficMultiplier ?? 1);
            const configuredDemandMultiplier = Number(dynamicSettings.demandMultiplier ?? 1);
            const configuredFuelMultiplier = Number(dynamicSettings.fuelMultiplier ?? 1);
            const effectiveWeatherMultiplier = weatherMultiplier * (Number.isFinite(configuredWeatherMultiplier) ? configuredWeatherMultiplier : 1);
            const effectiveTrafficMultiplier = trafficMultiplier * (Number.isFinite(configuredTrafficMultiplier) ? configuredTrafficMultiplier : 1);
            const effectiveDemandMultiplier = Number.isFinite(configuredDemandMultiplier) ? configuredDemandMultiplier : 1;
            const effectiveFuelMultiplier = Number.isFinite(configuredFuelMultiplier) ? configuredFuelMultiplier : 1;
            const dynamicPricingMultiplier = this.roundMoney(
                Math.min(
                    dynamicSettings.maxMultiplier || dynamicSettings.maxSurge || 1,
                    surgeMultiplier *
                        timeMultiplier *
                        effectiveWeatherMultiplier *
                        effectiveTrafficMultiplier *
                        effectiveDemandMultiplier *
                        effectiveFuelMultiplier
                )
            );
            const displayedBaseFare = this.roundMoney(baseFareUsed);
            const displayedDistanceCost = this.roundMoney(distanceCost);
            const displayedDurationCost = this.roundMoney(durationCost);
            const displayedServiceFee = this.roundMoney(serviceFee);
            console.log('[Pricing] resolved components', {
                pricingConfigId,
                countryCode,
                serviceSlug: canonicalServiceSlug,
                dbBaseFare: displayedBaseFare,
                dbServiceFee: displayedServiceFee - itemCharges,
                fixedFareInput: Number(legacyBasePrice || 0),
                serviceOptionSurcharge: 0,
                itemCharges,
                baseFareApplied: displayedBaseFare,
                serviceExtrasApplied: displayedServiceFee
            });
            const rawPreAdjustmentFare = this.roundMoney(
                displayedBaseFare + displayedDistanceCost + displayedDurationCost + displayedServiceFee + taxAmount
            );
            const minimumFareAdjustment = this.roundMoney(Math.max(0, resolvedBasePrice - rawPreAdjustmentFare));
            const preAdjustmentFare = this.roundMoney(rawPreAdjustmentFare + minimumFareAdjustment);
            const adjustedFare = this.roundMoney(preAdjustmentFare * dynamicPricingMultiplier);
            const dynamicPricingAmount = this.roundMoney(adjustedFare - preAdjustmentFare);
            const preCommissionTotal = adjustedFare;

            const commissionConfig = await MarketplaceConfigService.getEffectiveCommissionConfig(
                canonicalServiceSlug,
                cityZone,
                driverTier,
                tenantId
            );
            commissionRateUsed = commissionConfig.enabled === false ? 0 : this.roundMoney(commissionConfig.percent);
            const rawCommissionFee = this.roundMoney(preCommissionTotal * (commissionRateUsed / 100));
            const commissionFee = this.applyFeeBounds(rawCommissionFee, commissionConfig.minFee, commissionConfig.maxFee);
            const platformFeeConfig = await MarketplaceConfigService.getEffectivePlatformFeeConfig(
                canonicalServiceSlug,
                { countryCode, currencyCode: resolvedCurrencyCode, city: city?.name },
                tenantId
            );
            platformFee = this.calculatePlatformFee(preCommissionTotal, platformFeeConfig);
            driverPayout = this.roundMoney(preCommissionTotal - commissionFee);
            const totalPrice = this.roundMoney(preCommissionTotal + platformFee);

            taxAmount = this.roundMoney(taxAmount);

            const fareBreakdown: FareBreakdown = {
                baseFare: displayedBaseFare,
                distanceCost: displayedDistanceCost,
                durationCost: displayedDurationCost,
                serviceFee: displayedServiceFee,
                taxAmount,
                dynamicPricingAmount,
                commissionAmount: commissionFee,
                platformFee,
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
                    weatherMultiplier: effectiveWeatherMultiplier,
                    trafficMultiplier: effectiveTrafficMultiplier,
                    demandMultiplier: effectiveDemandMultiplier,
                    fuelMultiplier: effectiveFuelMultiplier
                },
                preAdjustmentFare,
                pricingAdjustmentType: dynamicPricingAmount > 0 ? 'surge' : (dynamicPricingAmount < 0 ? 'discount' : 'none'),
                pricingMultiplier: dynamicPricingMultiplier,
                pricingAdjustmentAmount: dynamicPricingAmount,
                postAdjustmentFare: preCommissionTotal,
                minimumFareAdjustment,
                maximumFareAdjustment: 0,
                negotiationAdjustment: 0,
                serviceFareBeforePlatformFee: preCommissionTotal,
                platformFeeType: platformFeeConfig.type,
                platformFeeFixed: platformFeeConfig.fixedAmount,
                platformFeePercent: platformFeeConfig.percent,
                platformFeeAmount: platformFee,
                platformFeeSource: platformFeeConfig.source,
                platformFeeConfigVersion: platformFeeConfig.configVersion,
                commissionSource: commissionConfig.source,
                commissionConfigVersion: commissionConfig.configVersion,
                serviceFare: totalPrice,
                shoppingBudget: 0,
                totalAuthorisation: totalPrice,
                driverGrossEarnings: preCommissionTotal,
                calculationVersion: 'marketplace-v1'
            };
            fareBreakdown.reconciliationValid = this.validateFareReconciliation(fareBreakdown);

            if (!fareBreakdown.reconciliationValid) {
                console.error('[PricingService] fare reconciliation error', {
                    serviceSlug,
                    source,
                    fareBreakdown
                });
            }

            const jobModes = await MarketplaceConfigService.determineJobModes(serviceSlug, tenantId);
            const marketplaceFlags = {
                dynamicPricingEnabled: dynamicSettings.enabled,
                negotiationEnabled: jobModes.negotiation,
                biddingEnabled: jobModes.bidding
            };

            console.log(
                `[PricingService] Price resolved: ${currencySymbol}${totalPrice} (base ${resolvedBasePrice}, multiplier ${dynamicPricingMultiplier}, commission ${commissionRateUsed}%) via ${source} for ${canonicalServiceSlug} in ${countryCode}`
            );
            console.log('[MarketplaceCommissionAudit]', {
                source,
                serviceSlug: canonicalServiceSlug,
                commissionSource: commissionConfig.source,
                commissionPercent: commissionRateUsed,
                platformFeeSource: platformFeeConfig.source,
                platformFee,
                serviceFare: totalPrice,
                serviceFareBeforePlatformFee: preCommissionTotal,
                commissionAmount: commissionFee,
                driverPayout
            });

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
        console.warn(
            `[PricingService] Price resolved (fallback): ${currencySymbol}${resolvedBasePrice} via ${source} for ${serviceSlug} in ${countryCode}`
        );

        const fallbackCommissionSettings = await MarketplaceConfigService.getEffectiveCommissionConfig(
            canonicalServiceSlug,
            cityZone,
            driverTier,
            tenantId
        );
        const fallbackCommission = fallbackCommissionSettings.enabled === false ? 0 : this.roundMoney(fallbackCommissionSettings.percent);
        const fallbackCommissionFee = this.applyFeeBounds(
            this.roundMoney(resolvedBasePrice * (fallbackCommission / 100)),
            fallbackCommissionSettings.minFee,
            fallbackCommissionSettings.maxFee
        );
        const fallbackPlatformFeeConfig = await MarketplaceConfigService.getEffectivePlatformFeeConfig(
            canonicalServiceSlug,
            { countryCode, currencyCode: resolvedCurrencyCode, city: city?.name },
            tenantId
        );
        const fallbackPlatformFee = this.calculatePlatformFee(resolvedBasePrice, fallbackPlatformFeeConfig);
        const fallbackDriverPayout = this.roundMoney(resolvedBasePrice - fallbackCommissionFee);
        const fallbackTotalPrice = this.roundMoney(resolvedBasePrice + fallbackPlatformFee);
        const fallbackFareBreakdown: FareBreakdown = {
            baseFare: this.roundMoney(baseFareUsed),
            distanceCost: this.roundMoney(distanceKm * pricePerKmUsed),
            durationCost: 0,
            serviceFee: 0,
            taxAmount,
            dynamicPricingAmount: 0,
            commissionAmount: fallbackCommissionFee,
            platformFee: fallbackPlatformFee,
            driverPayout: fallbackDriverPayout,
            total: fallbackTotalPrice,
            currencyCode: resolvedCurrencyCode,
            currencySymbol,
            multiplier: 1,
            commissionPercent: fallbackCommission,
            source,
            extras: {},
            preAdjustmentFare: resolvedBasePrice,
            pricingAdjustmentType: 'none',
            pricingMultiplier: 1,
            pricingAdjustmentAmount: 0,
            postAdjustmentFare: resolvedBasePrice,
            minimumFareAdjustment: 0,
            maximumFareAdjustment: 0,
            negotiationAdjustment: 0,
            serviceFareBeforePlatformFee: resolvedBasePrice,
            platformFeeType: fallbackPlatformFeeConfig.type,
            platformFeeFixed: fallbackPlatformFeeConfig.fixedAmount,
            platformFeePercent: fallbackPlatformFeeConfig.percent,
            platformFeeAmount: fallbackPlatformFee,
            platformFeeSource: fallbackPlatformFeeConfig.source,
            platformFeeConfigVersion: fallbackPlatformFeeConfig.configVersion,
            commissionSource: fallbackCommissionSettings.source,
            commissionConfigVersion: fallbackCommissionSettings.configVersion,
            serviceFare: fallbackTotalPrice,
            shoppingBudget: 0,
            totalAuthorisation: fallbackTotalPrice,
            driverGrossEarnings: resolvedBasePrice,
            calculationVersion: 'marketplace-v1',
            reconciliationValid: true
        };

        return {
            basePrice: resolvedBasePrice,
            surgeMultiplier: 1.0,
            dynamicPricingMultiplier: 1.0,
            totalPrice: fallbackTotalPrice,
            source,
            city: city?.name,
            countryCode,
            currencyCode: resolvedCurrencyCode,
            currencySymbol,
            pricingPlanUsed: pricingPlan,
            regionalPricingRuleId,
            taxAmount,
            platformFee: fallbackPlatformFee,
            commissionFee: fallbackCommissionFee,
            driverPayout: fallbackDriverPayout,
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

    static getSurgeMultiplier(
        demand: number,
        supply: number,
        dynamicSettings?: EffectiveDynamicPricingSettings
    ): number {
        const maxMultiplier = Math.max(1, Number(dynamicSettings?.maxMultiplier ?? dynamicSettings?.maxSurge ?? 1));
        const minimumDemandRatio = Math.max(0, Number(dynamicSettings?.minimumDemandRatio ?? 0));
        if (maxMultiplier <= 1 || demand <= 0) return 1.0;
        if (supply <= 0) return maxMultiplier;

        const ratio = demand / supply;
        if (ratio <= minimumDemandRatio) return 1.0;

        const denominator = Math.max(minimumDemandRatio || 1, 1);
        const scaled = 1 + ((ratio - minimumDemandRatio) / denominator) * (maxMultiplier - 1);
        return Math.min(maxMultiplier, Math.max(1, scaled));
    }

    static getTimeOfDayMultiplier(
        dynamicSettings?: DynamicPricingSettings,
        requestedAt?: string
    ): number {
        const date = requestedAt ? new Date(requestedAt) : new Date();
        const hour = date.getHours();
        const asAny = dynamicSettings as any;

        const peakHours = Array.isArray(asAny?.peakHours) ? asAny.peakHours : [];
        if (peakHours.includes(hour)) {
            return Number(dynamicSettings?.peakMultiplier ?? 1);
        }

        const nightHours = Array.isArray(asAny?.nightHours) ? asAny.nightHours : [];
        if (nightHours.includes(hour)) {
            return Number(dynamicSettings?.nightMultiplier ?? 1);
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

    private static applyFeeBounds(value: number, minFee?: number | null, maxFee?: number | null): number {
        let bounded = this.roundMoney(value);
        const min = Number(minFee ?? 0);
        const max = maxFee === null || maxFee === undefined ? null : Number(maxFee);
        if (Number.isFinite(min) && min > 0) bounded = Math.max(bounded, min);
        if (max !== null && Number.isFinite(max) && max > 0) bounded = Math.min(bounded, max);
        return this.roundMoney(bounded);
    }

    private static calculatePlatformFee(amount: number, config: PlatformFeeSettings): number {
        if (!config.enabled) return 0;
        const percentFee = this.roundMoney(amount * (Number(config.percent || 0) / 100));
        const fixedFee = this.roundMoney(Number(config.fixedAmount || 0));
        const raw = config.type === 'fixed'
            ? fixedFee
            : config.type === 'fixed_plus_percentage'
                ? fixedFee + percentFee
                : percentFee;
        return this.applyFeeBounds(raw, config.minFee, config.maxFee);
    }

    static validateFareReconciliation(result: FareBreakdown): boolean {
        const tolerance = 0.01;
        const serviceFareBeforePlatformFee = this.roundMoney(
            Number(result.serviceFareBeforePlatformFee ?? result.postAdjustmentFare ?? 0)
        );
        const platformFee = this.roundMoney(Number(result.platformFeeAmount ?? result.platformFee ?? 0));
        const serviceFare = this.roundMoney(Number(result.serviceFare ?? result.total ?? 0));
        const shoppingBudget = this.roundMoney(Number(result.shoppingBudget ?? 0));
        const totalAuthorisation = this.roundMoney(Number(result.totalAuthorisation ?? serviceFare + shoppingBudget));

        const serviceMatches = Math.abs(this.roundMoney(serviceFareBeforePlatformFee + platformFee) - serviceFare) <= tolerance;
        const totalMatches = Math.abs(this.roundMoney(serviceFare + shoppingBudget) - totalAuthorisation) <= tolerance;

        return serviceMatches && totalMatches;
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
     * negotiated/locked to a different amount. The agreed fare is treated as
     * the customer-visible service fare; any shopping budget remains separate.
     */
    static applyAgreedFare(job: any, agreedFare: number): Partial<any> {
        const originalTotal = Number(job?.total_price || job?.price || agreedFare) || agreedFare;
        const safeAgreed = Math.max(0, Number(agreedFare) || 0);
        const ratio = originalTotal > 0 ? safeAgreed / originalTotal : 1;

        const round = this.roundMoney;

        const fareBreakdown = job?.fare_breakdown || {};
        const originalPlatformFee = Number(
            fareBreakdown.platformFeeAmount ??
            fareBreakdown.platformFee ??
            job?.platform_fee ??
            0
        );
        const platformFee = round(originalPlatformFee * ratio);
        const serviceFareBeforePlatformFee = round(Math.max(0, safeAgreed - platformFee));
        const commissionRateUsed = Number.isFinite(Number(job?.commission_rate_used))
            ? Number(job?.commission_rate_used)
            : Number(fareBreakdown.commissionPercent ?? 0);
        const commissionFee = round(serviceFareBeforePlatformFee * (commissionRateUsed / 100));
        const driverPayout = round(Math.max(0, serviceFareBeforePlatformFee - commissionFee));
        const taxAmount = round(Number(job?.tax_amount || 0) * ratio);
        const baseFareUsed = round(Number(job?.base_fare_used || job?.base_fare || 0) * ratio);
        const pricePerKmUsed = Number(job?.price_per_km_used || 0);

        const scaledBreakdown: Record<string, unknown> = {};
        for (const key of Object.keys(fareBreakdown)) {
            const value = Number(fareBreakdown[key]);
            scaledBreakdown[key] = Number.isFinite(value) ? round(value * ratio) : fareBreakdown[key];
        }

        // Commission percent is a rate, not a monetary amount; preserve the original value.
        const originalCommissionPercent = Number(
            (job?.fare_breakdown as Record<string, unknown> | undefined)?.['commissionPercent'] ??
            job?.commission_rate_used ??
            0
        );
        scaledBreakdown['commissionPercent'] = Number.isFinite(originalCommissionPercent)
            ? originalCommissionPercent
            : 0;
        scaledBreakdown['platformFee'] = platformFee;
        scaledBreakdown['platformFeeAmount'] = platformFee;
        scaledBreakdown['commissionFee'] = commissionFee;
        scaledBreakdown['serviceFareBeforePlatformFee'] = serviceFareBeforePlatformFee;
        scaledBreakdown['serviceFare'] = safeAgreed;
        scaledBreakdown['total'] = safeAgreed;
        scaledBreakdown['shoppingBudget'] = Number(fareBreakdown.shoppingBudget ?? 0);
        scaledBreakdown['totalAuthorisation'] = round(safeAgreed + Number(scaledBreakdown['shoppingBudget'] ?? 0));
        scaledBreakdown['driverGrossEarnings'] = serviceFareBeforePlatformFee;
        scaledBreakdown['driverNetEarnings'] = driverPayout;
        scaledBreakdown['reconciliationValid'] = this.validateFareReconciliation(scaledBreakdown as unknown as FareBreakdown);

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
            commission_rate_used: commissionRateUsed,
            fare_breakdown: scaledBreakdown
        };
    }
}
