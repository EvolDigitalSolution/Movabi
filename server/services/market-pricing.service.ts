import { supabaseAdmin } from './supabase.service';
import {
    MarketPricingInput,
    MarketPricingResult,
    MarketPricingSettings,
    MarketPricingStrategy,
    MarketPricingStrategyType
} from '../types/market-pricing.types';

/**
 * Inputs required by the pure, DB-free calculation function. Kept separate
 * from MarketPricingInput so the maths can be unit tested without a database.
 */
export interface ComputeMarketAdjustmentInput {
    baseServiceFare: number;
    distanceKm: number;
    durationMinutes: number;
    platformFeePercent: number;
    driverCommissionPercent: number;

    /** null when no enabled strategy resolves for this request. */
    strategy: MarketPricingStrategy | null;

    /** median competitor fare, or null when there is not enough market data. */
    marketReferenceFare: number | null;
    lowestCompetitorFare?: number | null;
    benchmarkCount: number;

    /** master feature flag (market_pricing_enabled). */
    featureEnabled: boolean;
    /** market_pricing_shadow_mode. Shadow mode always calculates but never applies. */
    shadowMode: boolean;
    driverProtectionEnabled: boolean;
    platformMarginProtectionEnabled: boolean;

    calculationVersion?: string;
}

const MINIMUM_BENCHMARKS_REQUIRED = 2;

function roundMoney(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

function requiresMarketData(strategy: MarketPricingStrategyType): boolean {
    return strategy === 'match_market' || strategy === 'beat_market' || strategy === 'premium' || strategy === 'lowest_sustainable';
}

/**
 * Pure calculation core for the market intelligence pricing layer.
 *
 * Calculation order (see task Phase 4 §9):
 *   A-B. baseServiceFare is the service fare AFTER the existing pricing engine
 *        and existing dynamic-pricing/surge logic have already run (this
 *        function does not know about or alter surge behaviour).
 *   C-D. Resolve the market target fare from the strategy + market reference.
 *   E.   Apply maximum discount / maximum adjustment caps.
 *   F.   Apply the driver protection floor.
 *   G.   Apply the platform margin floor.
 *   H-I. Platform fee and driver commission are computed separately, from the
 *        same effective service fare. They are never merged.
 *   J.   Money is rounded once, only on the values returned from this function.
 */
export function computeMarketAdjustment(input: ComputeMarketAdjustmentInput): MarketPricingResult {
    const {
        baseServiceFare,
        distanceKm,
        durationMinutes,
        platformFeePercent,
        driverCommissionPercent,
        strategy,
        marketReferenceFare,
        lowestCompetitorFare,
        benchmarkCount,
        featureEnabled,
        shadowMode,
        driverProtectionEnabled,
        platformMarginProtectionEnabled,
        calculationVersion = 'market-v1'
    } = input;

    const safeBaseFare = Number.isFinite(baseServiceFare) ? Math.max(0, baseServiceFare) : 0;

    let fallbackReason: string | null = null;
    let targetFare = safeBaseFare;

    if (!strategy) {
        fallbackReason = 'no_market_strategy';
    } else if (strategy.strategy === 'manual') {
        targetFare = safeBaseFare;
    } else if (requiresMarketData(strategy.strategy) && (marketReferenceFare === null || marketReferenceFare === undefined || benchmarkCount < MINIMUM_BENCHMARKS_REQUIRED)) {
        fallbackReason = 'insufficient_market_data';
    } else {
        const reference = Number(marketReferenceFare);
        const diffPercent = Number(strategy.targetDifferencePercent) || 0;

        switch (strategy.strategy) {
            case 'match_market':
                targetFare = reference;
                break;
            case 'beat_market':
                targetFare = reference * (1 - diffPercent / 100);
                break;
            case 'premium':
                targetFare = reference * (1 + diffPercent / 100);
                break;
            case 'lowest_sustainable':
                targetFare = Number.isFinite(Number(lowestCompetitorFare)) ? Number(lowestCompetitorFare) : reference;
                break;
            default:
                targetFare = safeBaseFare;
        }
    }

    // --- E. Discount / adjustment caps (only meaningful when a strategy is active) ---
    let cappedTargetFare = targetFare;
    if (strategy && !fallbackReason && strategy.strategy !== 'manual') {
        const maxDiscountPercent = Number(strategy.maximumCustomerDiscountPercent) || 0;
        const maxAdjustmentPercent = Number(strategy.maximumMarketAdjustmentPercent) || 0;

        const maximumDiscountFloor = safeBaseFare * (1 - maxDiscountPercent / 100);
        const maxAdjustmentAmount = safeBaseFare * (maxAdjustmentPercent / 100);
        const adjustmentLowerBound = safeBaseFare - maxAdjustmentAmount;
        const adjustmentUpperBound = safeBaseFare + maxAdjustmentAmount;

        cappedTargetFare = Math.max(cappedTargetFare, maximumDiscountFloor);
        cappedTargetFare = Math.max(adjustmentLowerBound, Math.min(adjustmentUpperBound, cappedTargetFare));
    }

    // --- F. Driver protection floor (expressed as required SERVICE FARE, pre-commission) ---
    let driverProtectionFloor = 0;
    if (strategy && driverProtectionEnabled) {
        const commissionPercent = Math.min(99.99, Math.max(0, driverCommissionPercent));
        const distanceFloor = Number.isFinite(Number(strategy.minimumDriverPerKm)) && Number(strategy.minimumDriverPerKm) > 0
            ? distanceKm * Number(strategy.minimumDriverPerKm)
            : 0;
        const hourlyFloor = Number.isFinite(Number(strategy.minimumDriverHourlyRate)) && Number(strategy.minimumDriverHourlyRate) > 0
            ? (durationMinutes / 60) * Number(strategy.minimumDriverHourlyRate)
            : 0;
        const minimumPayoutFloor = Number.isFinite(Number(strategy.minimumDriverPayout)) && Number(strategy.minimumDriverPayout) > 0
            ? Number(strategy.minimumDriverPayout)
            : 0;

        const requiredDriverPayout = Math.max(distanceFloor, hourlyFloor, minimumPayoutFloor);
        driverProtectionFloor = requiredDriverPayout > 0
            ? requiredDriverPayout / (1 - commissionPercent / 100)
            : 0;
    }

    // --- G. Platform margin floor (expressed as required SERVICE FARE) ---
    // Platform revenue = platformFeeAmount + driverCommissionAmount, both derived
    // from the same effective service fare. In a pure-percentage fee model the
    // margin RATIO (revenue / customerTotal) is constant regardless of service
    // fare, so only the absolute `minimum_platform_revenue` floor can actually be
    // enforced by raising the service fare; the percentage floor is evaluated
    // for transparency/logging but cannot be "fixed" by scaling alone.
    let platformMarginFloor = 0;
    let marginRatioBelowFloor = false;
    if (strategy && platformMarginProtectionEnabled) {
        const feeRatio = (Number(platformFeePercent) + Number(driverCommissionPercent)) / 100;
        const minRevenue = Number(strategy.minimumPlatformRevenue) || 0;
        if (minRevenue > 0 && feeRatio > 0) {
            platformMarginFloor = minRevenue / feeRatio;
        }

        const minMarginPercent = Number(strategy.minimumPlatformMarginPercent) || 0;
        if (minMarginPercent > 0) {
            const customerTotalRatio = 1 + Number(platformFeePercent) / 100;
            const marginRatio = customerTotalRatio > 0 ? feeRatio / customerTotalRatio : 0;
            marginRatioBelowFloor = marginRatio < minMarginPercent / 100;
        }
    }

    // Protection floors are a safety net and take priority over the discount/
    // adjustment caps computed above.
    const adjustedServiceFare = fallbackReason
        ? safeBaseFare
        : Math.max(cappedTargetFare, driverProtectionFloor, platformMarginFloor);

    const marketAdjustment = roundMoney(adjustedServiceFare - safeBaseFare);

    const strategyEnabled = !!strategy?.enabled;
    const validMarketData = !fallbackReason;
    const adjustmentApplied = featureEnabled && !shadowMode && strategyEnabled && validMarketData;

    const effectiveServiceFare = adjustmentApplied ? adjustedServiceFare : safeBaseFare;

    const platformFeeAmount = roundMoney(effectiveServiceFare * (Number(platformFeePercent) || 0) / 100);
    const customerTotal = roundMoney(effectiveServiceFare + platformFeeAmount);
    const driverCommissionAmount = roundMoney(effectiveServiceFare * (Number(driverCommissionPercent) || 0) / 100);
    const driverPayout = roundMoney(effectiveServiceFare - driverCommissionAmount);

    return {
        enabled: featureEnabled,
        shadowMode,
        adjustmentApplied,
        baseServiceFare: roundMoney(safeBaseFare),
        marketReferenceFare: marketReferenceFare === null || marketReferenceFare === undefined ? null : roundMoney(marketReferenceFare),
        targetFare: fallbackReason ? null : roundMoney(cappedTargetFare),
        driverProtectionFloor: roundMoney(driverProtectionFloor),
        platformMarginFloor: roundMoney(platformMarginFloor),
        adjustedServiceFare: roundMoney(adjustedServiceFare),
        marketAdjustment,
        platformFeeAmount,
        customerTotal,
        driverCommissionAmount,
        driverPayout,
        strategyId: strategy?.id ?? null,
        marketSnapshotId: null,
        fallbackReason: fallbackReason || (marginRatioBelowFloor ? 'platform_margin_percent_unreachable_via_scaling' : null),
        calculationVersion
    };
}

// ---------------------------------------------------------------------------
// DB-backed orchestration. Never throws into the active booking flow: every
// database call is wrapped so a missing table/row/setting safely falls back
// to "no market pricing applied" instead of failing the quote.
// ---------------------------------------------------------------------------

function toNumberSetting(value: unknown, fallback: number): number {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function toBoolSetting(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (value === 'true') return true;
        if (value === 'false') return false;
    }
    return fallback;
}

async function getFlatSetting(key: string): Promise<unknown | null> {
    try {
        const { data, error } = await supabaseAdmin
            .from('marketplace_settings')
            .select('value')
            .eq('key', key)
            .is('tenant_id', null)
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (error) {
            console.warn(`[MarketPricingService] setting lookup failed for ${key}:`, error.message);
            return null;
        }

        return data ? (data as any).value : null;
    } catch (err: any) {
        console.warn(`[MarketPricingService] setting lookup threw for ${key}:`, err?.message || err);
        return null;
    }
}

export async function getMarketPricingSettings(): Promise<MarketPricingSettings> {
    const defaults: MarketPricingSettings = {
        marketPricingEnabled: false,
        competitorBenchmarksEnabled: false,
        driverProtectionEnabled: true,
        platformMarginProtectionEnabled: true,
        shadowMode: true,
        auditEnabled: true,
        defaultTargetPercent: 7,
        maxDiscountPercent: 15,
        benchmarkMaxAgeHours: 168,
        version: 'market-v1'
    };

    try {
        const [
            marketPricingEnabled,
            competitorBenchmarksEnabled,
            driverProtectionEnabled,
            platformMarginProtectionEnabled,
            shadowMode,
            auditEnabled,
            defaultTargetPercent,
            maxDiscountPercent,
            benchmarkMaxAgeHours,
            version
        ] = await Promise.all([
            getFlatSetting('market_pricing_enabled'),
            getFlatSetting('market_competitor_benchmarks_enabled'),
            getFlatSetting('market_driver_protection_enabled'),
            getFlatSetting('market_platform_margin_protection_enabled'),
            getFlatSetting('market_pricing_shadow_mode'),
            getFlatSetting('market_pricing_audit_enabled'),
            getFlatSetting('market_pricing_default_target_percent'),
            getFlatSetting('market_pricing_max_discount_percent'),
            getFlatSetting('market_benchmark_max_age_hours'),
            getFlatSetting('market_pricing_version')
        ]);

        return {
            marketPricingEnabled: toBoolSetting(marketPricingEnabled, defaults.marketPricingEnabled),
            competitorBenchmarksEnabled: toBoolSetting(competitorBenchmarksEnabled, defaults.competitorBenchmarksEnabled),
            driverProtectionEnabled: toBoolSetting(driverProtectionEnabled, defaults.driverProtectionEnabled),
            platformMarginProtectionEnabled: toBoolSetting(platformMarginProtectionEnabled, defaults.platformMarginProtectionEnabled),
            shadowMode: toBoolSetting(shadowMode, defaults.shadowMode),
            auditEnabled: toBoolSetting(auditEnabled, defaults.auditEnabled),
            defaultTargetPercent: toNumberSetting(defaultTargetPercent, defaults.defaultTargetPercent),
            maxDiscountPercent: toNumberSetting(maxDiscountPercent, defaults.maxDiscountPercent),
            benchmarkMaxAgeHours: toNumberSetting(benchmarkMaxAgeHours, defaults.benchmarkMaxAgeHours),
            version: typeof version === 'string' ? version : defaults.version
        };
    } catch (err: any) {
        console.warn('[MarketPricingService] settings lookup failed entirely, using safe defaults:', err?.message || err);
        return defaults;
    }
}

function mapStrategyRow(row: any): MarketPricingStrategy {
    return {
        id: row.id,
        countryCode: row.country_code,
        marketCity: row.market_city ?? null,
        zoneId: row.zone_id ?? null,
        serviceType: row.service_type,
        vehicleClass: row.vehicle_class ?? null,
        strategy: row.strategy,
        targetDifferencePercent: Number(row.target_difference_percent) || 0,
        minimumDriverHourlyRate: row.minimum_driver_hourly_rate === null ? null : Number(row.minimum_driver_hourly_rate),
        minimumDriverPerKm: row.minimum_driver_per_km === null ? null : Number(row.minimum_driver_per_km),
        minimumDriverPayout: row.minimum_driver_payout === null ? null : Number(row.minimum_driver_payout),
        minimumPlatformMarginPercent: Number(row.minimum_platform_margin_percent) || 0,
        minimumPlatformRevenue: Number(row.minimum_platform_revenue) || 0,
        maximumCustomerDiscountPercent: Number(row.maximum_customer_discount_percent) || 0,
        maximumMarketAdjustmentPercent: Number(row.maximum_market_adjustment_percent) || 0,
        currency: row.currency,
        enabled: row.enabled === true,
        validFrom: row.valid_from ?? null,
        validUntil: row.valid_until ?? null
    };
}

/**
 * Resolves the most specific enabled strategy for the given context, trying
 * progressively broader filter combinations (Phase 4 §1).
 */
async function resolveStrategy(input: MarketPricingInput): Promise<MarketPricingStrategy | null> {
    const country = String(input.countryCode || '').toUpperCase();
    const city = input.marketCity || null;
    const zone = input.zoneId || null;
    const service = input.serviceType;
    const vehicle = input.vehicleClass || null;
    const now = new Date().toISOString();

    const attempts: Array<Record<string, unknown>> = [];
    if (city && zone) attempts.push({ country_code: country, market_city: city, zone_id: zone, service_type: service, vehicle_class: vehicle });
    if (city) attempts.push({ country_code: country, market_city: city, service_type: service, vehicle_class: vehicle });
    attempts.push({ country_code: country, service_type: service, vehicle_class: vehicle });
    if (city && zone) attempts.push({ country_code: country, market_city: city, zone_id: zone, service_type: service });
    if (city) attempts.push({ country_code: country, market_city: city, service_type: service });
    attempts.push({ country_code: country, service_type: service });

    try {
        for (const filters of attempts) {
            let query = supabaseAdmin
                .from('market_pricing_strategies')
                .select('*')
                .eq('enabled', true);

            for (const [key, value] of Object.entries(filters)) {
                if (value === null) {
                    query = query.is(key, null);
                } else {
                    query = query.eq(key, value);
                }
            }

            query = query
                .or(`valid_from.is.null,valid_from.lte.${now}`)
                .or(`valid_until.is.null,valid_until.gte.${now}`)
                .limit(1);

            const { data, error } = await query.maybeSingle();

            if (error) {
                console.warn('[MarketPricingService] strategy lookup error, trying next specificity level:', error.message);
                continue;
            }

            if (data) return mapStrategyRow(data);
        }
    } catch (err: any) {
        console.warn('[MarketPricingService] strategy resolution threw:', err?.message || err);
        return null;
    }

    return null;
}

interface EligibleBenchmark {
    id: string;
    observedFare: number;
    distanceKm: number | null;
    durationMinutes: number | null;
}

async function resolveBenchmarks(
    input: MarketPricingInput,
    settings: MarketPricingSettings
): Promise<EligibleBenchmark[]> {
    if (!settings.competitorBenchmarksEnabled) return [];

    try {
        const country = String(input.countryCode || '').toUpperCase();
        const city = input.marketCity || null;

        let profileQuery = supabaseAdmin
            .from('competitor_profiles')
            .select('id, vehicle_class, market_city')
            .eq('enabled', true)
            .eq('country_code', country)
            .eq('service_type', input.serviceType);

        const { data: profiles, error: profileError } = await profileQuery;
        if (profileError || !profiles?.length) return [];

        const matchingProfiles = profiles.filter((p: any) => {
            const cityMatches = !p.market_city || p.market_city === city;
            const vehicleMatches = !p.vehicle_class || p.vehicle_class === (input.vehicleClass || null);
            return cityMatches && vehicleMatches;
        });

        if (!matchingProfiles.length) return [];

        const profileIds = matchingProfiles.map((p: any) => p.id);
        const maxAgeMs = settings.benchmarkMaxAgeHours * 60 * 60 * 1000;
        const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
        const now = new Date().toISOString();

        const { data: benchmarks, error: benchmarkError } = await supabaseAdmin
            .from('competitor_fare_benchmarks')
            .select('*')
            .in('competitor_profile_id', profileIds)
            .eq('currency', input.currency)
            .gte('observed_at', cutoff)
            .or(`expires_at.is.null,expires_at.gte.${now}`)
            .gte('confidence_score', 50);

        if (benchmarkError || !benchmarks?.length) return [];

        const eligible: EligibleBenchmark[] = benchmarks.map((b: any) => ({
            id: b.id,
            observedFare: Number(b.observed_fare),
            distanceKm: b.distance_km === null ? null : Number(b.distance_km),
            durationMinutes: b.duration_minutes === null ? null : Number(b.duration_minutes)
        }));

        // Prefer route-similar benchmarks: distance within +-25%, duration within +-35%.
        const closeMatches = eligible.filter((b) => {
            const distanceOk = b.distanceKm === null || input.distanceKm <= 0
                ? true
                : Math.abs(b.distanceKm - input.distanceKm) / input.distanceKm <= 0.25;
            const durationOk = b.durationMinutes === null || input.durationMinutes <= 0
                ? true
                : Math.abs(b.durationMinutes - input.durationMinutes) / input.durationMinutes <= 0.35;
            return distanceOk && durationOk;
        });

        return closeMatches.length >= MINIMUM_BENCHMARKS_REQUIRED ? closeMatches : eligible;
    } catch (err: any) {
        console.warn('[MarketPricingService] benchmark resolution threw:', err?.message || err);
        return [];
    }
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function persistSnapshotAndAudit(
    input: MarketPricingInput,
    settings: MarketPricingSettings,
    benchmarks: EligibleBenchmark[],
    result: MarketPricingResult
): Promise<string | null> {
    if (!settings.auditEnabled) return null;

    let snapshotId: string | null = null;

    try {
        if (benchmarks.length > 0) {
            const fares = benchmarks.map((b) => b.observedFare);
            const { data: snapshot, error: snapshotError } = await supabaseAdmin
                .from('market_price_snapshots')
                .insert({
                    country_code: String(input.countryCode || '').toUpperCase(),
                    market_city: input.marketCity || null,
                    service_type: input.serviceType,
                    vehicle_class: input.vehicleClass || null,
                    distance_km: input.distanceKm,
                    duration_minutes: input.durationMinutes,
                    competitor_count: fares.length,
                    lowest_competitor_fare: Math.min(...fares),
                    average_competitor_fare: fares.reduce((a, b) => a + b, 0) / fares.length,
                    median_competitor_fare: median(fares),
                    highest_competitor_fare: Math.max(...fares),
                    currency: input.currency,
                    benchmark_ids: benchmarks.map((b) => b.id)
                })
                .select('id')
                .single();

            if (snapshotError) {
                console.warn('[MarketPricingService] snapshot insert failed (non-fatal):', snapshotError.message);
            } else {
                snapshotId = snapshot?.id ?? null;
            }
        }
    } catch (err: any) {
        console.warn('[MarketPricingService] snapshot insert threw (non-fatal):', err?.message || err);
    }

    try {
        await supabaseAdmin.from('quote_market_adjustments').insert({
            job_id: input.jobId || null,
            booking_id: input.bookingId || null,
            quote_reference: input.quoteReference || null,
            strategy_id: result.strategyId || null,
            market_snapshot_id: snapshotId,
            base_service_fare: result.baseServiceFare,
            market_reference_fare: result.marketReferenceFare,
            requested_difference_percent: null,
            requested_target_fare: result.targetFare,
            driver_protection_floor: result.driverProtectionFloor,
            platform_margin_floor: result.platformMarginFloor,
            applied_market_adjustment: result.marketAdjustment,
            adjusted_service_fare: result.adjustedServiceFare,
            platform_fee_amount: result.platformFeeAmount,
            customer_total: result.customerTotal,
            driver_commission_amount: result.driverCommissionAmount,
            driver_payout: result.driverPayout,
            currency: input.currency,
            feature_enabled: result.enabled,
            adjustment_applied: result.adjustmentApplied,
            fallback_reason: result.fallbackReason || null,
            calculation_version: result.calculationVersion
        });
    } catch (err: any) {
        // Hard rule: audit insertion failures must never fail the booking quote.
        console.warn('[MarketPricingService] audit insert threw (non-fatal):', err?.message || err);
    }

    return snapshotId;
}

export class MarketPricingService {
    /**
     * Evaluates market pricing for the given context. Never throws: any
     * internal failure results in a safe "unchanged pricing" result.
     *
     * @param persist When false (used by the Admin simulator), no snapshot or
     *                audit rows are written.
     */
    static async evaluate(input: MarketPricingInput, options: { persist?: boolean } = {}): Promise<MarketPricingResult> {
        const persist = options.persist !== false;

        try {
            const settings = await getMarketPricingSettings();
            const strategy = await resolveStrategy(input);
            const benchmarks = strategy && requiresMarketData(strategy.strategy)
                ? await resolveBenchmarks(input, settings)
                : [];

            const fares = benchmarks.map((b) => b.observedFare);
            const marketReferenceFare = fares.length >= MINIMUM_BENCHMARKS_REQUIRED ? median(fares) : null;
            const lowestCompetitorFare = fares.length >= MINIMUM_BENCHMARKS_REQUIRED ? Math.min(...fares) : null;

            const result = computeMarketAdjustment({
                baseServiceFare: input.baseServiceFare,
                distanceKm: input.distanceKm,
                durationMinutes: input.durationMinutes,
                platformFeePercent: input.platformFeePercent,
                driverCommissionPercent: input.driverCommissionPercent,
                strategy,
                marketReferenceFare,
                lowestCompetitorFare,
                benchmarkCount: fares.length,
                featureEnabled: settings.marketPricingEnabled,
                shadowMode: settings.shadowMode,
                driverProtectionEnabled: settings.driverProtectionEnabled,
                platformMarginProtectionEnabled: settings.platformMarginProtectionEnabled,
                calculationVersion: settings.version
            });

            if (persist) {
                result.marketSnapshotId = await persistSnapshotAndAudit(input, settings, benchmarks, result);
            }

            console.log('[MarketPricing] evaluation', {
                quoteReference: input.quoteReference || null,
                countryCode: input.countryCode,
                marketCity: input.marketCity || null,
                serviceType: input.serviceType,
                vehicleClass: input.vehicleClass || null,
                baseServiceFare: result.baseServiceFare,
                marketReferenceFare: result.marketReferenceFare,
                strategy: strategy?.strategy || null,
                targetDifferencePercent: strategy?.targetDifferencePercent ?? null,
                requestedTargetFare: result.targetFare,
                driverProtectionFloor: result.driverProtectionFloor,
                platformMarginFloor: result.platformMarginFloor,
                adjustedServiceFare: result.adjustedServiceFare,
                marketAdjustment: result.marketAdjustment,
                platformFeePercent: input.platformFeePercent,
                platformFeeAmount: result.platformFeeAmount,
                customerTotal: result.customerTotal,
                driverCommissionPercent: input.driverCommissionPercent,
                driverCommissionAmount: result.driverCommissionAmount,
                driverPayout: result.driverPayout,
                shadowMode: result.shadowMode,
                adjustmentApplied: result.adjustmentApplied,
                fallbackReason: result.fallbackReason || null,
                version: result.calculationVersion
            });

            return result;
        } catch (err: any) {
            console.warn('[MarketPricingService] evaluate failed entirely, returning unchanged pricing:', err?.message || err);
            const safeBase = Number.isFinite(input.baseServiceFare) ? Math.max(0, input.baseServiceFare) : 0;
            return {
                enabled: false,
                shadowMode: true,
                adjustmentApplied: false,
                baseServiceFare: roundMoney(safeBase),
                marketReferenceFare: null,
                targetFare: null,
                driverProtectionFloor: 0,
                platformMarginFloor: 0,
                adjustedServiceFare: roundMoney(safeBase),
                marketAdjustment: 0,
                platformFeeAmount: 0,
                customerTotal: roundMoney(safeBase),
                driverCommissionAmount: 0,
                driverPayout: roundMoney(safeBase),
                strategyId: null,
                marketSnapshotId: null,
                fallbackReason: 'market_pricing_service_error',
                calculationVersion: 'market-v1'
            };
        }
    }
}
