import { supabaseAdmin } from './supabase.service';
import {
    InternalMarketSignalsInput,
    InternalMarketSignalsResult,
    MarketPricingInput,
    MarketPricingResult,
    MarketPricingSettings,
    MarketPricingStrategy,
    MarketPricingStrategyType
} from '../types/market-pricing.types';

/** Reasons a market reference fare could not be derived from competitor data. */
export type BenchmarkUnavailableReason = 'competitor_benchmarks_disabled' | 'no_matching_benchmark' | 'expired_benchmark';

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
    /** Absolute platform revenue guaranteed by fee configuration (for example platform_fee.minFee). */
    platformMinimumRevenue?: number;

    /** null when no enabled strategy resolves for this request. */
    strategy: MarketPricingStrategy | null;

    /** median competitor fare, or null when there is not enough market data. */
    marketReferenceFare: number | null;
    lowestCompetitorFare?: number | null;
    benchmarkCount: number;
    /** why marketReferenceFare is null, when it is null. Purely informational/audit. */
    benchmarkUnavailableReason?: BenchmarkUnavailableReason | null;

    /** master feature flag (market_pricing_enabled). */
    featureEnabled: boolean;
    /** market_pricing_shadow_mode. Shadow mode always calculates but never applies. */
    shadowMode: boolean;
    driverProtectionEnabled: boolean;
    platformMarginProtectionEnabled: boolean;

    /** Optional additive percentage from the (currently no-op) internal signal provider. */
    internalSignalAdjustmentPercent?: number;
    internalSignalsUsed?: boolean;

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

/** Currency-safe comparison: compares values rounded to the nearest cent. */
function moneyLessThan(a: number, b: number): boolean {
    return roundMoney(a) < roundMoney(b);
}

/**
 * Pure calculation core for the market intelligence "lowest sustainable
 * fare" pricing layer.
 *
 * Calculation order (Sustainability Redesign):
 *   1. baseServiceFare is the service fare AFTER the existing pricing engine
 *      and existing dynamic-pricing/surge logic have already run (this
 *      function does not know about or alter surge behaviour).
 *   2. minimumSustainableFare = max(driverProtectionFloor, platformMarginFloor)
 *      is ALWAYS computed whenever a strategy resolves, independent of
 *      whether competitor data is available. This is Movabi's floor: the
 *      lowest price that still protects the driver's minimum payout and the
 *      platform's minimum commission.
 *   3. When competitor data is available, a competitive target fare is
 *      computed from the strategy type + market reference fare.
 *   4. When competitor data is NOT available (disabled, no match, expired),
 *      that is not an error: the suggested fare simply defaults to the
 *      minimum sustainable fare (Movabi's "lowest sustainable price" goal),
 *      still subject to the existing maximum discount/adjustment caps.
 *   5. The suggested fare is never allowed to fall below the minimum
 *      sustainable fare, regardless of source.
 *   6. Platform fee and driver commission are computed separately, from the
 *      same effective service fare. They are never merged.
 *   7. Money is rounded once, only on the values returned from this function,
 *      and all floor comparisons use currency-safe (cent) rounding.
 */
export function computeMarketAdjustment(input: ComputeMarketAdjustmentInput): MarketPricingResult {
    const {
        baseServiceFare,
        distanceKm,
        durationMinutes,
        platformFeePercent,
        driverCommissionPercent,
        platformMinimumRevenue = 0,
        strategy,
        marketReferenceFare,
        lowestCompetitorFare,
        benchmarkCount,
        benchmarkUnavailableReason,
        featureEnabled,
        shadowMode,
        driverProtectionEnabled,
        platformMarginProtectionEnabled,
        internalSignalAdjustmentPercent = 0,
        internalSignalsUsed = false,
        calculationVersion = 'market-v1'
    } = input;

    const safeBaseFare = Number.isFinite(baseServiceFare) ? Math.max(0, baseServiceFare) : 0;
    const isManual = strategy?.strategy === 'manual';

    // --- Step 2. Minimum sustainable fare (ALWAYS computed for any resolved strategy) ---

    // Driver protection floor, expressed as required SERVICE FARE, pre-commission.
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

    // Platform margin floor, expressed as required SERVICE FARE.
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
        const minRevenue = Math.max(
            Number(strategy.minimumPlatformRevenue) || 0,
            Number(platformMinimumRevenue) || 0
        );
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

    const minimumSustainableFare = strategy ? Math.max(driverProtectionFloor, platformMarginFloor) : 0;
    const launchTargetFare = strategy && Number.isFinite(Number(strategy.minimumLaunchTargetFare))
        ? Math.max(0, Number(strategy.minimumLaunchTargetFare))
        : 0;

    // --- Step 3-4. Resolve the pre-cap suggested fare ---
    const hasCompetitorTarget = !!strategy && !isManual && requiresMarketData(strategy.strategy)
        && marketReferenceFare !== null && marketReferenceFare !== undefined && benchmarkCount >= MINIMUM_BENCHMARKS_REQUIRED;

    let competitiveTarget: number | null = null;
    if (hasCompetitorTarget) {
        const reference = Number(marketReferenceFare);
        const diffPercent = Number(strategy!.targetDifferencePercent) || 0;

        switch (strategy!.strategy) {
            case 'match_market':
                competitiveTarget = reference;
                break;
            case 'beat_market':
                competitiveTarget = reference * (1 - diffPercent / 100);
                break;
            case 'premium':
                competitiveTarget = reference * (1 + diffPercent / 100);
                break;
            case 'lowest_sustainable':
                competitiveTarget = Number.isFinite(Number(lowestCompetitorFare)) ? Number(lowestCompetitorFare) : reference;
                break;
            default:
                competitiveTarget = reference;
        }
    }

    // Optional additive internal-signal adjustment (no-op by default - Step 3.5).
    if (competitiveTarget !== null && internalSignalsUsed && Number.isFinite(internalSignalAdjustmentPercent) && internalSignalAdjustmentPercent !== 0) {
        competitiveTarget = competitiveTarget * (1 + internalSignalAdjustmentPercent / 100);
    }

    let preClampSuggested: number;
    if (isManual || !strategy) {
        preClampSuggested = safeBaseFare;
    } else if (competitiveTarget !== null) {
        preClampSuggested = competitiveTarget;
    } else if (minimumSustainableFare > 0 || launchTargetFare > 0) {
        // No usable competitor data: default to the lowest sustainable fare
        // rather than treating this as an error (Sustainability Redesign §COMPETITOR DATA).
        preClampSuggested = launchTargetFare > 0
            ? Math.max(safeBaseFare, minimumSustainableFare, launchTargetFare)
            : minimumSustainableFare;
    } else {
        preClampSuggested = safeBaseFare;
    }

    // --- Discount / adjustment caps relative to the ORIGINAL base fare (existing safeguards) ---
    let cappedTargetFare = preClampSuggested;
    if (strategy && !isManual) {
        const maxDiscountPercent = Number(strategy.maximumCustomerDiscountPercent) || 0;
        const maxAdjustmentPercent = Number(strategy.maximumMarketAdjustmentPercent) || 0;

        const maximumDiscountFloor = safeBaseFare * (1 - maxDiscountPercent / 100);
        const maxAdjustmentAmount = safeBaseFare * (maxAdjustmentPercent / 100);
        const adjustmentLowerBound = safeBaseFare - maxAdjustmentAmount;
        const adjustmentUpperBound = safeBaseFare + maxAdjustmentAmount;

        cappedTargetFare = Math.max(cappedTargetFare, maximumDiscountFloor);
        cappedTargetFare = Math.max(adjustmentLowerBound, Math.min(adjustmentUpperBound, cappedTargetFare));
    }

    // --- Step 5. Never allow the suggested fare below the sustainability floor ---
    const belowFloorClamped = !!strategy && !isManual && minimumSustainableFare > 0 && moneyLessThan(cappedTargetFare, minimumSustainableFare);

    const adjustedServiceFare = !strategy
        ? safeBaseFare
        : Math.max(cappedTargetFare, minimumSustainableFare, launchTargetFare);

    const marketAdjustment = roundMoney(adjustedServiceFare - safeBaseFare);

    const strategyEnabled = !!strategy?.enabled;
    // There is only something meaningful to apply when: the strategy is an
    // explicit manual no-op, real competitor data produced a target, or a
    // real sustainability floor (> 0) exists to suggest. Competitor data
    // availability alone is never a BLOCKING condition, but the absence of
    // both competitor data AND a configured floor means there is nothing to
    // suggest, so no adjustment is applied (the fare would equal base fare).
    const hasValidSuggestion = isManual || hasCompetitorTarget || minimumSustainableFare > 0 || launchTargetFare > 0;
    const adjustmentApplied = featureEnabled && !shadowMode && strategyEnabled && hasValidSuggestion;

    const effectiveServiceFare = adjustmentApplied ? adjustedServiceFare : safeBaseFare;

    const platformFeeAmount = roundMoney(effectiveServiceFare * (Number(platformFeePercent) || 0) / 100);
    const customerTotal = roundMoney(effectiveServiceFare + platformFeeAmount);
    const driverCommissionAmount = roundMoney(effectiveServiceFare * (Number(driverCommissionPercent) || 0) / 100);
    const driverPayout = roundMoney(effectiveServiceFare - driverCommissionAmount);

    // --- Fallback / outcome label (descriptive, not necessarily blocking) ---
    let fallbackReason: string | null;
    if (!strategy) {
        fallbackReason = 'no_market_strategy';
    } else if (!featureEnabled) {
        fallbackReason = 'feature_disabled';
    } else if (shadowMode) {
        fallbackReason = 'shadow_mode';
    } else if (isManual) {
        fallbackReason = null;
    } else if (belowFloorClamped) {
        fallbackReason = 'below_sustainability_floor';
    } else if (!hasCompetitorTarget) {
        fallbackReason = benchmarkUnavailableReason || 'no_matching_benchmark';
    } else {
        fallbackReason = 'market_adjustment_applied';
    }

    return {
        enabled: featureEnabled,
        shadowMode,
        adjustmentApplied,
        baseServiceFare: roundMoney(safeBaseFare),
        marketReferenceFare: marketReferenceFare === null || marketReferenceFare === undefined ? null : roundMoney(marketReferenceFare),
        targetFare: !strategy ? null : roundMoney(cappedTargetFare),
        driverProtectionFloor: roundMoney(driverProtectionFloor),
        platformMarginFloor: roundMoney(platformMarginFloor),
        minimumSustainableFare: roundMoney(minimumSustainableFare),
        adjustedServiceFare: roundMoney(adjustedServiceFare),
        marketAdjustment,
        platformFeeAmount,
        customerTotal,
        driverCommissionAmount,
        driverPayout,
        strategyId: strategy?.id ?? null,
        marketSnapshotId: null,
        benchmarkUsed: hasCompetitorTarget,
        internalSignalsUsed,
        fallbackReason: marginRatioBelowFloor && fallbackReason === 'market_adjustment_applied'
            ? 'platform_margin_percent_unreachable_via_scaling'
            : fallbackReason,
        calculationVersion
    };
}

/**
 * Forward-looking, currently no-op provider for Movabi's own internal market
 * signals (driver acceptance rate, cancellation rate, completed fare
 * averages, driver supply, demand, time of day, traffic, weather). Never
 * throws. Returns a zero adjustment / zero confidence result until a real
 * signal source is implemented - callers should treat that as "no signal".
 *
 * Intentionally NOT machine-learning based (see task constraints). Kept as a
 * clearly separated function so a future implementation can be swapped in
 * without changing MarketPricingService's control flow.
 */
export async function resolveInternalMarketSignals(_input: InternalMarketSignalsInput): Promise<InternalMarketSignalsResult> {
    return {
        adjustmentPercent: 0,
        confidence: 0,
        signals: null,
        source: 'internal-signals-v0-noop'
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
        useInternalSignals: false,
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
            useInternalSignals,
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
            getFlatSetting('market_use_internal_signals'),
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
            useInternalSignals: toBoolSetting(useInternalSignals, defaults.useInternalSignals),
            version: typeof version === 'string' ? version : defaults.version
        };
    } catch (err: any) {
        console.warn('[MarketPricingService] settings lookup failed entirely, using safe defaults:', err?.message || err);
        return defaults;
    }
}

export function mapMarketPricingStrategyRow(row: any): MarketPricingStrategy {
    return {
        id: row.id,
        countryCode: row.country_code,
        marketCity: row.market_city ?? null,
        zoneId: row.zone_id ?? null,
        serviceType: row.service_type,
        vehicleClass: row.vehicle_class ?? null,
        strategy: row.strategy,
        targetDifferencePercent: Number(row.target_difference_percent) || 0,
        minimumLaunchTargetFare: row.minimum_launch_target_fare === null || row.minimum_launch_target_fare === undefined
            ? null
            : Number(row.minimum_launch_target_fare),
        minimumDriverHourlyRate: row.minimum_driver_hourly_rate === null ? null : Number(row.minimum_driver_hourly_rate),
        minimumDriverPerKm: row.minimum_driver_per_km === null ? null : Number(row.minimum_driver_per_km),
        minimumDriverPayout: row.minimum_driver_payout === null ? null : Number(row.minimum_driver_payout),
        minimumPlatformMarginPercent: Number(row.minimum_platform_margin_percent) || 0,
        minimumPlatformRevenue: Number(row.minimum_platform_revenue) || 0,
        commissionPercent: row.commission_percent === null || row.commission_percent === undefined ? null : Number(row.commission_percent),
        normalDemandMultiplier: row.normal_demand_multiplier === null || row.normal_demand_multiplier === undefined ? null : Number(row.normal_demand_multiplier),
        busyMultiplier: row.busy_multiplier === null || row.busy_multiplier === undefined ? null : Number(row.busy_multiplier),
        maximumSurgeMultiplier: row.maximum_surge_multiplier === null || row.maximum_surge_multiplier === undefined ? null : Number(row.maximum_surge_multiplier),
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
export function buildStrategyResolutionAttempts(input: MarketPricingInput): Array<Record<string, unknown>> {
    const country = String(input.countryCode || '').toUpperCase();
    const city = input.marketCity || null;
    const zone = input.zoneId || null;
    const service = input.serviceType;
    const vehicle = input.vehicleClass || null;
    const currency = String(input.currency || '').toUpperCase();
    const attempts: Array<Record<string, unknown>> = [];
    const addSpecificity = (vehicleClass: string | null) => {
        if (city && zone) attempts.push({ country_code: country, market_city: city, zone_id: zone, service_type: service, vehicle_class: vehicleClass, currency });
        if (city) attempts.push({ country_code: country, market_city: city, zone_id: null, service_type: service, vehicle_class: vehicleClass, currency });
        if (zone) attempts.push({ country_code: country, market_city: null, zone_id: zone, service_type: service, vehicle_class: vehicleClass, currency });
        attempts.push({ country_code: country, market_city: null, zone_id: null, service_type: service, vehicle_class: vehicleClass, currency });
    };
    if (vehicle) addSpecificity(vehicle);
    addSpecificity(null);
    return attempts;
}

export async function resolveMarketPricingStrategy(input: MarketPricingInput): Promise<MarketPricingStrategy | null> {
    const now = new Date().toISOString();
    const attempts = buildStrategyResolutionAttempts(input);

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
                .order('updated_at', { ascending: false })
                .limit(1);

            const { data, error } = await query.maybeSingle();

            if (error) {
                console.warn('[MarketPricingService] strategy lookup error, trying next specificity level:', error.message);
                continue;
            }

            if (data) return mapMarketPricingStrategyRow(data);
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

interface BenchmarkResolution {
    benchmarks: EligibleBenchmark[];
    /** Only meaningful when benchmarks.length < MINIMUM_BENCHMARKS_REQUIRED. */
    reason: BenchmarkUnavailableReason;
}

/**
 * Resolves eligible competitor benchmarks AND explains why, when none (or too
 * few) are found. Only country, city/market, service type, vehicle class,
 * currency, expiry and an acceptable distance/duration range are considered
 * eligible - benchmarks from an unrelated country, service or vehicle class
 * are never used (Sustainability Redesign §MARKET DATA MATCHING).
 */
async function resolveBenchmarks(
    input: MarketPricingInput,
    settings: MarketPricingSettings
): Promise<BenchmarkResolution> {
    if (!settings.competitorBenchmarksEnabled) {
        return { benchmarks: [], reason: 'competitor_benchmarks_disabled' };
    }

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
        if (profileError || !profiles?.length) return { benchmarks: [], reason: 'no_matching_benchmark' };

        const matchingProfiles = profiles.filter((p: any) => {
            const cityMatches = !p.market_city || p.market_city === city;
            const vehicleMatches = !p.vehicle_class || p.vehicle_class === (input.vehicleClass || null);
            return cityMatches && vehicleMatches;
        });

        if (!matchingProfiles.length) return { benchmarks: [], reason: 'no_matching_benchmark' };

        const profileIds = matchingProfiles.map((p: any) => p.id);
        const maxAgeMs = settings.benchmarkMaxAgeHours * 60 * 60 * 1000;
        const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
        const now = new Date().toISOString();

        // First, check whether ANY currency/confidence-eligible benchmarks exist
        // at all for these profiles (ignoring age/expiry), so we can distinguish
        // "no matching benchmark" from "benchmark exists but has expired".
        const { data: anyBenchmarks, error: anyBenchmarkError } = await supabaseAdmin
            .from('competitor_fare_benchmarks')
            .select('id')
            .in('competitor_profile_id', profileIds)
            .eq('currency', input.currency)
            .gte('confidence_score', 50);

        if (anyBenchmarkError || !anyBenchmarks?.length) return { benchmarks: [], reason: 'no_matching_benchmark' };

        const { data: benchmarks, error: benchmarkError } = await supabaseAdmin
            .from('competitor_fare_benchmarks')
            .select('*')
            .in('competitor_profile_id', profileIds)
            .eq('currency', input.currency)
            .gte('observed_at', cutoff)
            .or(`expires_at.is.null,expires_at.gte.${now}`)
            .gte('confidence_score', 50);

        if (benchmarkError || !benchmarks?.length) {
            // Matching benchmarks exist for this country/city/service/vehicle/currency
            // combination, but every one of them is too old or has expired.
            return { benchmarks: [], reason: 'expired_benchmark' };
        }

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

        const finalMatches = closeMatches.length >= MINIMUM_BENCHMARKS_REQUIRED ? closeMatches : eligible;
        return { benchmarks: finalMatches, reason: 'no_matching_benchmark' };
    } catch (err: any) {
        console.warn('[MarketPricingService] benchmark resolution threw:', err?.message || err);
        return { benchmarks: [], reason: 'no_matching_benchmark' };
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
    result: MarketPricingResult,
    originalCustomerTotal: number,
    originalServiceFare: number
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

    console.log('[MarketPricing] about to write audit', {
        quoteReference: input.quoteReference || null,
        jobId: input.jobId || null,
        bookingId: input.bookingId || null,
        fallbackReason: result.fallbackReason || null
    });

    try {
        const { error: auditError } = await supabaseAdmin.from('quote_market_adjustments').insert({
            job_id: input.jobId || null,
            booking_id: input.bookingId || null,
            quote_reference: input.quoteReference || null,
            strategy_id: result.strategyId || null,
            market_snapshot_id: snapshotId,
            base_service_fare: result.baseServiceFare,
            original_service_fare: roundMoney(originalServiceFare),
            original_customer_total: roundMoney(originalCustomerTotal),
            market_reference_fare: result.marketReferenceFare,
            requested_difference_percent: null,
            requested_target_fare: result.targetFare,
            driver_protection_floor: result.driverProtectionFloor,
            platform_margin_floor: result.platformMarginFloor,
            minimum_sustainable_fare: result.minimumSustainableFare,
            applied_market_adjustment: result.marketAdjustment,
            adjusted_service_fare: result.adjustedServiceFare,
            suggested_final_fare: result.adjustedServiceFare,
            platform_fee_amount: result.platformFeeAmount,
            customer_total: result.customerTotal,
            returned_customer_fare: result.customerTotal,
            driver_commission_amount: result.driverCommissionAmount,
            driver_payout: result.driverPayout,
            currency: input.currency,
            feature_enabled: result.enabled,
            adjustment_applied: result.adjustmentApplied,
            benchmark_used: result.benchmarkUsed,
            internal_signals_used: result.internalSignalsUsed,
            fallback_reason: result.fallbackReason || null,
            calculation_version: result.calculationVersion,
            strategy_version: result.calculationVersion
        });

        if (auditError) {
            // supabase-js does NOT throw on a Postgres/PostgREST error - it
            // resolves with { error }. This branch is the actual root cause
            // of silently-empty audit tables (e.g. missing migrated columns,
            // RLS denial, FK violation) and must always be logged loudly.
            console.error('[MarketPricingService] audit write failed', {
                quoteReference: input.quoteReference || null,
                code: (auditError as any).code,
                message: auditError.message,
                details: (auditError as any).details,
                hint: (auditError as any).hint
            });
        } else {
            console.log('[MarketPricing] audit write success', {
                quoteReference: input.quoteReference || null,
                jobId: input.jobId || null,
                bookingId: input.bookingId || null
            });
        }
    } catch (err: any) {
        // Hard rule: audit insertion failures must never fail the booking quote.
        console.error('[MarketPricingService] audit write failed (threw)', {
            quoteReference: input.quoteReference || null,
            message: err?.message || err
        });
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

        console.log('[MarketPricing] BEGIN evaluate', {
            quoteReference: input.quoteReference || null,
            jobId: input.jobId || null,
            bookingId: input.bookingId || null,
            persist
        });

        try {
            const settings = await getMarketPricingSettings();
            console.log('[MarketPricing] settings loaded', {
                quoteReference: input.quoteReference || null,
                marketPricingEnabled: settings.marketPricingEnabled,
                shadowMode: settings.shadowMode,
                auditEnabled: settings.auditEnabled,
                competitorBenchmarksEnabled: settings.competitorBenchmarksEnabled
            });

            const strategy = await resolveMarketPricingStrategy(input);
            const effectiveDriverCommissionPercent = strategy?.commissionPercent !== null && strategy?.commissionPercent !== undefined
                ? Math.max(0, Number(strategy.commissionPercent))
                : input.driverCommissionPercent;
            console.log('[MarketPricing] strategy resolved', {
                quoteReference: input.quoteReference || null,
                strategyId: strategy?.id || null,
                strategyType: strategy?.strategy || null
            });

            const benchmarkResolution = strategy && requiresMarketData(strategy.strategy)
                ? await resolveBenchmarks(input, settings)
                : { benchmarks: [] as EligibleBenchmark[], reason: 'no_matching_benchmark' as BenchmarkUnavailableReason };
            const benchmarks = benchmarkResolution.benchmarks;
            console.log('[MarketPricing] benchmarks resolved', {
                quoteReference: input.quoteReference || null,
                count: benchmarks.length,
                reason: benchmarks.length === 0 ? benchmarkResolution.reason : null
            });

            const fares = benchmarks.map((b) => b.observedFare);
            const marketReferenceFare = fares.length >= MINIMUM_BENCHMARKS_REQUIRED ? median(fares) : null;
            const lowestCompetitorFare = fares.length >= MINIMUM_BENCHMARKS_REQUIRED ? Math.min(...fares) : null;

            // Forward-looking, currently no-op internal signal lookup. Never
            // blocks or errors the quote - see resolveInternalMarketSignals().
            let internalSignals: InternalMarketSignalsResult | null = null;
            if (settings.useInternalSignals) {
                try {
                    internalSignals = await resolveInternalMarketSignals({
                        countryCode: input.countryCode,
                        marketCity: input.marketCity || null,
                        serviceType: input.serviceType,
                        vehicleClass: input.vehicleClass || null
                    });
                } catch (signalErr: any) {
                    console.warn('[MarketPricingService] internal signal lookup threw (non-fatal):', signalErr?.message || signalErr);
                }
            }

            const result = computeMarketAdjustment({
                baseServiceFare: input.baseServiceFare,
                distanceKm: input.distanceKm,
                durationMinutes: input.durationMinutes,
                platformFeePercent: input.platformFeePercent,
                driverCommissionPercent: effectiveDriverCommissionPercent,
                platformMinimumRevenue: input.platformMinimumRevenue,
                strategy,
                marketReferenceFare,
                lowestCompetitorFare,
                benchmarkCount: fares.length,
                benchmarkUnavailableReason: fares.length >= MINIMUM_BENCHMARKS_REQUIRED ? null : benchmarkResolution.reason,
                featureEnabled: settings.marketPricingEnabled,
                shadowMode: settings.shadowMode,
                driverProtectionEnabled: settings.driverProtectionEnabled,
                platformMarginProtectionEnabled: settings.platformMarginProtectionEnabled,
                internalSignalAdjustmentPercent: internalSignals?.adjustmentPercent ?? 0,
                internalSignalsUsed: settings.useInternalSignals && !!internalSignals,
                calculationVersion: settings.version
            });

            // The "original" (pre-market-pricing) service fare/customer total,
            // computed with the same fee/commission percentages, for audit comparison.
            const originalServiceFare = Number.isFinite(input.baseServiceFare) ? Math.max(0, input.baseServiceFare) : 0;
            const originalCustomerTotal = roundMoney(originalServiceFare * (1 + (Number(input.platformFeePercent) || 0) / 100));

            if (persist) {
                result.marketSnapshotId = await persistSnapshotAndAudit(input, settings, benchmarks, result, originalCustomerTotal, originalServiceFare);
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

            console.log('[MarketPricing] END evaluate', {
                quoteReference: input.quoteReference || null,
                outcome: 'success',
                fallbackReason: result.fallbackReason || null
            });

            return result;
        } catch (err: any) {
            console.warn('[MarketPricingService] evaluate failed entirely, returning unchanged pricing:', err?.message || err);
            console.log('[MarketPricing] END evaluate', {
                quoteReference: input.quoteReference || null,
                outcome: 'threw',
                error: err?.message || err
            });
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
                minimumSustainableFare: 0,
                adjustedServiceFare: roundMoney(safeBase),
                marketAdjustment: 0,
                platformFeeAmount: 0,
                customerTotal: roundMoney(safeBase),
                driverCommissionAmount: 0,
                driverPayout: roundMoney(safeBase),
                strategyId: null,
                marketSnapshotId: null,
                benchmarkUsed: false,
                internalSignalsUsed: false,
                fallbackReason: 'market_service_error',
                calculationVersion: 'market-v1'
            };
        }
    }
}
