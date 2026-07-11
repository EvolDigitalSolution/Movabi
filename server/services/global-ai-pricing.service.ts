import { supabaseAdmin } from './supabase.service';
import { PricingOptions, PricingResult, PricingService } from './pricing.service';

type JsonRecord = Record<string, any>;

export interface GlobalAiPricingInput extends PricingOptions {
  cityName?: string | null;
  pricingZoneId?: string | null;
  vehicleClass?: string | null;
  pickupLat?: number | null;
  pickupLng?: number | null;
  dropoffLat?: number | null;
  dropoffLng?: number | null;
  liveTraffic?: number | null;
  weather?: JsonRecord | null;
  averageDriverEtaMinutes?: number | null;
  driverPickupDistanceKm?: number | null;
  scheduledBooking?: boolean;
  loadComplexity?: number | null;
  accessibilityRequirements?: string[] | null;
}

export interface GlobalAiPricingQuote {
  market: {
    countryCode: string;
    currency: string;
    city: string | null;
    zoneId: string | null;
  };
  price: {
    baseFareMinor: number;
    distanceFareMinor: number;
    durationFareMinor: number;
    waitingAllowanceMinor: number;
    surgeAmountMinor: number;
    serviceChargesMinor: number;
    feesMinor: number;
    taxMinor: number;
    tollParkingEstimateMinor: number;
    platformFeeMinor: number;
    commissionMinor: number;
    driverGrossEarningsMinor: number;
    driverNetEarningsMinor: number;
    totalMinor: number;
  };
  ai: {
    recommendedTotalMinor: number;
    finalTotalMinor: number;
    confidence: number;
    multiplier: number;
    reasons: string[];
    modelVersion: string;
    configurationVersion: number;
    shadowMode: boolean;
    livePricingEnabled: boolean;
  };
  guardrails: {
    minimumMinor: number;
    maximumMinor: number;
    wasCapped: boolean;
    capReason: string | null;
  };
  priceLockedUntil: string;
  fallback: {
    used: boolean;
    reason: string | null;
    source: string;
  };
}

type MarketConfig = {
  country_code: string;
  currency_code: string;
  timezone: string | null;
  distance_unit: string | null;
  tax_inclusive_display: boolean | null;
  tax_rate: number | string | null;
  minimum_charge_unit_minor: number | null;
  pricing_model: string | null;
  market_enabled: boolean | null;
  ai_pricing_enabled?: boolean | null;
  shadow_mode_enabled?: boolean | null;
  confidence_threshold?: number | string | null;
  emergency_pricing_disabled?: boolean | null;
  model_version?: string | null;
  configuration_version?: number | null;
};

type ZoneConfig = {
  zone_id: string;
  max_surge_multiplier: number | string | null;
  minimum_driver_earnings_minor: number | null;
  base_cost_index: number | string | null;
  congestion_index: number | string | null;
  driver_cost_index: number | string | null;
  fuel_cost_index: number | string | null;
  regulatory_fee_minor: number | null;
  airport_fee_minor: number | null;
  enabled_services: string[] | null;
};

type ServiceRule = {
  service_slug: string;
  base_fare_minor: number | null;
  per_distance_unit_minor: number | null;
  per_minute_minor: number | null;
  minimum_fare_minor: number | null;
  booking_fee_minor: number | null;
  waiting_fee_per_minute_minor: number | null;
  maximum_fare_minor: number | null;
  maximum_surge_multiplier: number | string | null;
  commission_percent: number | string | null;
  tax_treatment: string | null;
  toll_treatment: string | null;
  payment_rules: JsonRecord | null;
  ai_pricing_enabled?: boolean | null;
  surge_enabled?: boolean | null;
};

export class GlobalAiPricingService {
  static async resolveQuote(input: GlobalAiPricingInput): Promise<{
    legacyPricing: PricingResult;
    quote: GlobalAiPricingQuote;
  }> {
    const legacyPricing = await PricingService.resolvePrice(input);

    try {
      const countryCode = String(input.countryCode || legacyPricing.countryCode || 'GB').toUpperCase();
      const serviceSlug = this.canonicalServiceSlug(input.serviceSlug || 'ride');
      const market = await this.loadMarket(countryCode);

      if (!market || market.market_enabled === false) {
        return {
          legacyPricing,
          quote: this.fallbackQuote(input, legacyPricing, 'No enabled pricing market configuration')
        };
      }

      const zone = await this.loadZone(countryCode, input.pricingZoneId || input.cityZone || input.cityName || legacyPricing.city || null, serviceSlug);
      const rule = await this.loadServiceRule(countryCode, zone?.zone_id || null, serviceSlug);

      if (!rule) {
        return {
          legacyPricing,
          quote: this.fallbackQuote(input, legacyPricing, 'No service market rule configured')
        };
      }

      const quote = this.calculateGuardedQuote(input, legacyPricing, market, zone, rule);
      await this.auditQuote(input, legacyPricing, quote);

      return { legacyPricing, quote };
    } catch (error: any) {
      const missingConfig = ['42P01', '42703'].includes(String(error?.code || ''));
      const reason = missingConfig
        ? 'Global AI pricing tables are not deployed yet'
        : (error?.message || 'Global AI pricing failed');

      console.warn('[GlobalAiPricingService] using fallback:', reason);
      return {
        legacyPricing,
        quote: this.fallbackQuote(input, legacyPricing, reason)
      };
    }
  }

  private static calculateGuardedQuote(
    input: GlobalAiPricingInput,
    legacyPricing: PricingResult,
    market: MarketConfig,
    zone: ZoneConfig | null,
    rule: ServiceRule
  ): GlobalAiPricingQuote {
    const currencyCode = String(market.currency_code || legacyPricing.currencyCode || 'GBP').toUpperCase();
    const currencyExponent = this.currencyExponent(currencyCode);
    const unit = Math.max(1, Number(market.minimum_charge_unit_minor || 1));
    const distance = Math.max(0, Number(input.distanceKm || 0));
    const duration = Math.max(0, Number(input.durationMinutes || 0));
    const demand = Math.max(0, Number(input.demand || 0));
    const supply = Math.max(0, Number(input.supply || 0));
    const confidenceThreshold = this.clamp(Number(market.confidence_threshold ?? 0.7), 0, 1);

    const baseFareMinor = this.ruleMinor(rule.base_fare_minor, legacyPricing.baseFareUsed, currencyExponent);
    const distanceFareMinor = Math.round(distance * Number(rule.per_distance_unit_minor || 0));
    const durationFareMinor = Math.round(duration * Number(rule.per_minute_minor || 0));
    const serviceChargesMinor = Number(rule.booking_fee_minor || 0);
    const waitingAllowanceMinor = 0;
    const tollParkingEstimateMinor = this.estimateTollsParking(rule, zone);

    const rawBeforeSurge = baseFareMinor + distanceFareMinor + durationFareMinor + serviceChargesMinor + tollParkingEstimateMinor;
    const surge = this.forecastSurge(input, zone, rule, demand, supply);
    const surgeAmountMinor = rule.surge_enabled === false
      ? 0
      : Math.max(0, Math.round(rawBeforeSurge * (surge.multiplier - 1)));

    const taxableSubtotal = rawBeforeSurge + surgeAmountMinor;
    const taxMinor = this.calculateTaxMinor(taxableSubtotal, market, rule);
    const feesMinor = Number(zone?.regulatory_fee_minor || 0) + Number(zone?.airport_fee_minor || 0);
    const recommendedTotalMinor = this.roundToUnit(taxableSubtotal + taxMinor + feesMinor, unit);

    const minimumMinor = Math.max(
      Number(rule.minimum_fare_minor || 0),
      Number(zone?.minimum_driver_earnings_minor || 0)
    );
    const maximumMinor = Math.max(
      minimumMinor || recommendedTotalMinor,
      Number(rule.maximum_fare_minor || 0) || this.roundToUnit(recommendedTotalMinor * 3, unit)
    );
    const bounded = this.bound(recommendedTotalMinor, minimumMinor, maximumMinor);
    const confidence = this.estimateConfidence(input, market, rule, zone, surge.confidence);
    const fallbackToRule = confidence < confidenceThreshold || market.emergency_pricing_disabled === true;
    const livePricingEnabled = Boolean(market.ai_pricing_enabled && rule.ai_pricing_enabled && !fallbackToRule);
    const shadowMode = market.shadow_mode_enabled !== false || !livePricingEnabled;
    const finalTotalMinor = shadowMode
      ? this.majorToMinor(legacyPricing.totalPrice, currencyExponent)
      : bounded.value;

    const commissionPercent = this.clamp(Number(rule.commission_percent ?? legacyPricing.commissionRateUsed ?? 0), 0, 100);
    const commissionMinor = Math.round(finalTotalMinor * (commissionPercent / 100));
    const platformFeeMinor = commissionMinor;
    const driverGrossEarningsMinor = Math.max(0, finalTotalMinor - taxMinor - feesMinor);
    const driverNetEarningsMinor = Math.max(0, driverGrossEarningsMinor - commissionMinor);

    return {
      market: {
        countryCode: market.country_code,
        currency: currencyCode,
        city: input.cityName || legacyPricing.city || null,
        zoneId: zone?.zone_id || null
      },
      price: {
        baseFareMinor,
        distanceFareMinor,
        durationFareMinor,
        waitingAllowanceMinor,
        surgeAmountMinor,
        serviceChargesMinor,
        feesMinor,
        taxMinor,
        tollParkingEstimateMinor,
        platformFeeMinor,
        commissionMinor,
        driverGrossEarningsMinor,
        driverNetEarningsMinor,
        totalMinor: finalTotalMinor
      },
      ai: {
        recommendedTotalMinor,
        finalTotalMinor,
        confidence,
        multiplier: surge.multiplier,
        reasons: surge.reasons,
        modelVersion: market.model_version || 'global-pricing-v1',
        configurationVersion: Number(market.configuration_version || 1),
        shadowMode,
        livePricingEnabled
      },
      guardrails: {
        minimumMinor,
        maximumMinor,
        wasCapped: bounded.wasCapped,
        capReason: bounded.capReason
      },
      priceLockedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      fallback: {
        used: fallbackToRule || shadowMode,
        reason: fallbackToRule ? 'Low confidence or emergency pricing disabled' : (shadowMode ? 'Shadow mode active' : null),
        source: legacyPricing.source
      }
    };
  }

  private static async loadMarket(countryCode: string): Promise<MarketConfig | null> {
    const { data, error } = await supabaseAdmin
      .from('pricing_markets')
      .select('*')
      .eq('country_code', countryCode)
      .maybeSingle();

    if (error) throw error;
    return data as MarketConfig | null;
  }

  private static async loadZone(countryCode: string, zoneHint: string | null, serviceSlug: string): Promise<ZoneConfig | null> {
    let query = supabaseAdmin
      .from('pricing_zones')
      .select('*')
      .eq('country_code', countryCode)
      .eq('is_active', true);

    if (zoneHint) {
      query = query.or(`zone_id.eq.${zoneHint},city_name.eq.${zoneHint}`);
    }

    const { data, error } = await query.order('priority', { ascending: true }).limit(5);
    if (error) throw error;

    const zones = (data || []) as ZoneConfig[];
    return zones.find(zone => !Array.isArray(zone.enabled_services) || zone.enabled_services.includes(serviceSlug)) || zones[0] || null;
  }

  private static async loadServiceRule(countryCode: string, zoneId: string | null, serviceSlug: string): Promise<ServiceRule | null> {
    const { data, error } = await supabaseAdmin
      .from('service_market_rules')
      .select('*')
      .eq('country_code', countryCode)
      .eq('service_slug', serviceSlug)
      .eq('is_active', true)
      .or(zoneId ? `zone_id.eq.${zoneId},zone_id.is.null` : 'zone_id.is.null')
      .order('zone_id', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data as ServiceRule | null;
  }

  private static forecastSurge(
    input: GlobalAiPricingInput,
    zone: ZoneConfig | null,
    rule: ServiceRule,
    demand: number,
    supply: number
  ): { multiplier: number; confidence: number; reasons: string[] } {
    const reasons: string[] = [];
    const ratio = supply <= 0 ? demand : demand / Math.max(1, supply);
    const eta = Number(input.averageDriverEtaMinutes || 0);
    const traffic = Number(input.liveTraffic || input.trafficMultiplier || 1);
    const maxSurge = Math.max(
      1,
      Math.min(
        Number(rule.maximum_surge_multiplier || 1.5),
        Number(zone?.max_surge_multiplier || rule.maximum_surge_multiplier || 1.5)
      )
    );

    let score = 0;
    if (ratio > 1.2) {
      score += Math.min(35, (ratio - 1) * 18);
      reasons.push('High demand in the pickup area');
    }
    if (supply <= 2 && demand > 0) {
      score += 20;
      reasons.push('Fewer compatible drivers nearby');
    }
    if (eta >= 8) {
      score += 12;
      reasons.push('Nearby driver ETA is higher than normal');
    }
    if (traffic > 1.15) {
      score += 12;
      reasons.push('Traffic is increasing journey time');
    }
    if (input.scheduledBooking) {
      score += 4;
      reasons.push('Scheduled service availability reserved');
    }
    if (Number(input.loadComplexity || 0) > 0) {
      score += Math.min(10, Number(input.loadComplexity) * 2);
      reasons.push('Service complexity included');
    }

    const recommended = 1 + Math.min(0.9, score / 100);
    return {
      multiplier: Number(Math.min(maxSurge, Math.max(1, recommended)).toFixed(2)),
      confidence: this.clamp(0.62 + Math.min(0.25, (demand + supply) / 100), 0.35, 0.92),
      reasons: reasons.length ? reasons : ['Standard local market pricing']
    };
  }

  private static fallbackQuote(input: GlobalAiPricingInput, legacyPricing: PricingResult, reason: string): GlobalAiPricingQuote {
    const currencyCode = String(legacyPricing.currencyCode || input.currencyCode || 'GBP').toUpperCase();
    const exponent = this.currencyExponent(currencyCode);
    const totalMinor = this.majorToMinor(legacyPricing.totalPrice, exponent);
    const baseMinor = this.majorToMinor(legacyPricing.baseFareUsed || legacyPricing.basePrice, exponent);
    const distanceMinor = this.majorToMinor(legacyPricing.fareBreakdown?.distanceCost || 0, exponent);
    const durationMinor = this.majorToMinor(legacyPricing.fareBreakdown?.durationCost || 0, exponent);
    const commissionMinor = this.majorToMinor(legacyPricing.commissionFee || 0, exponent);
    const taxMinor = this.majorToMinor(legacyPricing.taxAmount || 0, exponent);
    const platformFeeMinor = this.majorToMinor(legacyPricing.platformFee || legacyPricing.commissionFee || 0, exponent);
    const driverPayoutMinor = this.majorToMinor(legacyPricing.driverPayout || 0, exponent);

    return {
      market: {
        countryCode: String(legacyPricing.countryCode || input.countryCode || 'GB').toUpperCase(),
        currency: currencyCode,
        city: input.cityName || legacyPricing.city || null,
        zoneId: input.pricingZoneId || input.cityZone || null
      },
      price: {
        baseFareMinor: baseMinor,
        distanceFareMinor: distanceMinor,
        durationFareMinor: durationMinor,
        waitingAllowanceMinor: 0,
        surgeAmountMinor: this.majorToMinor(legacyPricing.fareBreakdown?.dynamicPricingAmount || 0, exponent),
        serviceChargesMinor: this.majorToMinor(legacyPricing.fareBreakdown?.serviceFee || 0, exponent),
        feesMinor: 0,
        taxMinor,
        tollParkingEstimateMinor: 0,
        platformFeeMinor,
        commissionMinor,
        driverGrossEarningsMinor: Math.max(0, totalMinor - taxMinor),
        driverNetEarningsMinor: driverPayoutMinor,
        totalMinor
      },
      ai: {
        recommendedTotalMinor: totalMinor,
        finalTotalMinor: totalMinor,
        confidence: 0,
        multiplier: legacyPricing.dynamicPricingMultiplier || 1,
        reasons: ['Deterministic pricing fallback used'],
        modelVersion: 'global-pricing-v1',
        configurationVersion: 0,
        shadowMode: true,
        livePricingEnabled: false
      },
      guardrails: {
        minimumMinor: totalMinor,
        maximumMinor: totalMinor,
        wasCapped: false,
        capReason: null
      },
      priceLockedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      fallback: {
        used: true,
        reason,
        source: legacyPricing.source
      }
    };
  }

  private static async auditQuote(input: GlobalAiPricingInput, legacyPricing: PricingResult, quote: GlobalAiPricingQuote): Promise<void> {
    try {
      await supabaseAdmin.from('ai_pricing_audits').insert({
        country_code: quote.market.countryCode,
        currency_code: quote.market.currency,
        service_slug: this.canonicalServiceSlug(input.serviceSlug || 'ride'),
        zone_id: quote.market.zoneId,
        input_snapshot: input,
        rule_price_minor: this.majorToMinor(legacyPricing.totalPrice, this.currencyExponent(quote.market.currency)),
        recommended_price_minor: quote.ai.recommendedTotalMinor,
        final_price_minor: quote.ai.finalTotalMinor,
        guardrails: quote.guardrails,
        confidence: quote.ai.confidence,
        reasons: quote.ai.reasons,
        model_version: quote.ai.modelVersion,
        configuration_version: quote.ai.configurationVersion,
        shadow_mode: quote.ai.shadowMode,
        fallback_used: quote.fallback.used,
        fallback_reason: quote.fallback.reason
      });
    } catch (error: any) {
      console.warn('[GlobalAiPricingService] audit skipped:', error?.message || error);
    }
  }

  private static calculateTaxMinor(subtotalMinor: number, market: MarketConfig, rule: ServiceRule): number {
    if (rule.tax_treatment === 'exempt') return 0;
    const rate = Math.max(0, Number(market.tax_rate || 0));
    if (rate <= 0) return 0;
    if (market.tax_inclusive_display) {
      return Math.round(subtotalMinor - (subtotalMinor / (1 + rate / 100)));
    }
    return Math.round(subtotalMinor * (rate / 100));
  }

  private static estimateTollsParking(rule: ServiceRule, zone: ZoneConfig | null): number {
    const rules = rule.payment_rules || {};
    if (rules.tollsIncluded === false || rule.toll_treatment === 'actual') return 0;
    return Number(zone?.airport_fee_minor || 0);
  }

  private static estimateConfidence(
    input: GlobalAiPricingInput,
    market: MarketConfig,
    rule: ServiceRule,
    zone: ZoneConfig | null,
    surgeConfidence: number
  ): number {
    let confidence = surgeConfidence;
    if (!zone) confidence -= 0.12;
    if (!rule.base_fare_minor && !rule.minimum_fare_minor) confidence -= 0.15;
    if (!input.distanceKm && !input.durationMinutes) confidence -= 0.15;
    if (!market.pricing_model) confidence -= 0.05;
    return this.clamp(Number(confidence.toFixed(2)), 0, 1);
  }

  private static bound(value: number, minimum: number, maximum: number): { value: number; wasCapped: boolean; capReason: string | null } {
    if (minimum && value < minimum) {
      return { value: minimum, wasCapped: true, capReason: 'Market minimum fare' };
    }
    if (maximum && value > maximum) {
      return { value: maximum, wasCapped: true, capReason: 'Market maximum fare' };
    }
    return { value, wasCapped: false, capReason: null };
  }

  private static ruleMinor(ruleValue: number | null, fallbackMajor: number, exponent: number): number {
    return Number(ruleValue || 0) > 0 ? Number(ruleValue) : this.majorToMinor(fallbackMajor || 0, exponent);
  }

  private static roundToUnit(value: number, unit: number): number {
    return Math.round(value / unit) * unit;
  }

  private static majorToMinor(value: number, exponent: number): number {
    return Math.round(Number(value || 0) * Math.pow(10, exponent));
  }

  private static currencyExponent(currencyCode: string): number {
    const zeroDecimal = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
    const threeDecimal = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);
    const code = String(currencyCode || '').toUpperCase();
    if (zeroDecimal.has(code)) return 0;
    if (threeDecimal.has(code)) return 3;
    return 2;
  }

  private static canonicalServiceSlug(value: unknown): string {
    const raw = String(value || '').trim().toLowerCase();
    if (['shop', 'shopping', 'errands', 'errand'].includes(raw)) return 'errand';
    if (['courier', 'parcel', 'package', 'delivery'].includes(raw)) return 'delivery';
    if (['van', 'moving', 'move', 'van-moving', 'van moving', 'van_moving'].includes(raw)) return 'van-moving';
    return raw || 'ride';
  }

  private static clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }
}
