export type MarketPricingStrategyType =
  | 'manual'
  | 'match_market'
  | 'beat_market'
  | 'premium'
  | 'lowest_sustainable';

export interface MarketPricingStrategy {
  id: string;
  countryCode: string;
  marketCity?: string | null;
  zoneId?: string | null;
  serviceType: string;
  vehicleClass?: string | null;
  strategy: MarketPricingStrategyType;
  targetDifferencePercent: number;
  /** Market/country/service-scoped minimum launch target; null disables it. */
  minimumLaunchTargetFare?: number | null;
  minimumDriverHourlyRate?: number | null;
  minimumDriverPerKm?: number | null;
  minimumDriverPayout?: number | null;
  minimumPlatformMarginPercent: number;
  minimumPlatformRevenue: number;
  commissionPercent?: number | null;
  normalDemandMultiplier?: number | null;
  busyMultiplier?: number | null;
  maximumSurgeMultiplier?: number | null;
  maximumCustomerDiscountPercent: number;
  maximumMarketAdjustmentPercent: number;
  currency: string;
  enabled: boolean;
  validFrom?: string | null;
  validUntil?: string | null;
}

export type CompetitorSourceType = 'manual' | 'partner' | 'research' | 'api';

export interface CompetitorProfile {
  id: string;
  countryCode: string;
  marketCity?: string | null;
  competitorName: string;
  competitorSlug: string;
  serviceType: string;
  vehicleClass?: string | null;
  enabled: boolean;
  displayOrder: number;
  sourceType: CompetitorSourceType;
  notes?: string | null;
}

export type CompetitorFareType =
  | 'minimum'
  | 'typical'
  | 'peak'
  | 'off_peak'
  | 'airport'
  | 'manual_index';

export interface CompetitorFareBenchmark {
  id: string;
  competitorProfileId: string;
  distanceKm?: number | null;
  durationMinutes?: number | null;
  routeOriginLabel?: string | null;
  routeDestinationLabel?: string | null;
  observedFare: number;
  currency: string;
  fareType: CompetitorFareType;
  observedAt: string;
  expiresAt?: string | null;
  confidenceScore: number;
  sourceReference?: string | null;
  notes?: string | null;
}

export interface CompetitorBenchmarkSummary {
  competitorCount: number;
  lowestFare?: number | null;
  averageFare?: number | null;
  medianFare?: number | null;
  highestFare?: number | null;
  currency: string;
  benchmarkIds: string[];
}

export interface MarketPricingInput {
  countryCode: string;
  marketCity?: string | null;
  zoneId?: string | null;
  serviceType: string;
  vehicleClass?: string | null;
  currency: string;
  distanceKm: number;
  durationMinutes: number;
  baseServiceFare: number;
  platformFeePercent: number;
  driverCommissionPercent: number;
  platformMinimumRevenue?: number;
  serviceSurcharges?: Record<string, number>;
  jobId?: string | null;
  bookingId?: string | null;
  quoteReference?: string | null;
}

export interface MarketPricingResult {
  enabled: boolean;
  shadowMode: boolean;
  adjustmentApplied: boolean;

  baseServiceFare: number;
  marketReferenceFare?: number | null;
  targetFare?: number | null;

  driverProtectionFloor: number;
  platformMarginFloor: number;
  /** max(driverProtectionFloor, platformMarginFloor) - the lowest sustainable SERVICE fare. */
  minimumSustainableFare: number;

  adjustedServiceFare: number;
  marketAdjustment: number;

  platformFeeAmount: number;
  customerTotal: number;

  driverCommissionAmount: number;
  driverPayout: number;

  strategyId?: string | null;
  marketSnapshotId?: string | null;

  /** true when a real competitor-derived market reference fare was used. */
  benchmarkUsed: boolean;
  /** true when the (currently no-op) internal market signal provider was consulted. */
  internalSignalsUsed: boolean;

  fallbackReason?: string | null;
  calculationVersion: string;
}

export interface MarketPricingSettings {
  marketPricingEnabled: boolean;
  competitorBenchmarksEnabled: boolean;
  driverProtectionEnabled: boolean;
  platformMarginProtectionEnabled: boolean;
  shadowMode: boolean;
  auditEnabled: boolean;
  defaultTargetPercent: number;
  maxDiscountPercent: number;
  benchmarkMaxAgeHours: number;
  /** master toggle for the (currently no-op) internal market signal provider. */
  useInternalSignals: boolean;
  version: string;
}

/**
 * Internal Movabi signals (driver acceptance, cancellation, supply/demand,
 * time of day, traffic, weather, etc). This is a forward-looking extension
 * point only - Phase "sustainability redesign" intentionally ships this as a
 * structural placeholder so a future signal provider (rule-based or ML-based)
 * can be dropped in without reshaping MarketPricingService again. It must
 * never throw and must default to "no adjustment" when signals are
 * unavailable or disabled.
 */
export interface InternalMarketSignalsInput {
  countryCode: string;
  marketCity?: string | null;
  serviceType: string;
  vehicleClass?: string | null;
  requestedAt?: string | null;
}

export interface InternalMarketSignalsResult {
  /** Percentage adjustment to apply to the pre-floor target fare. 0 = no-op (current behaviour). */
  adjustmentPercent: number;
  /** 0-100 confidence in the signal; 0 means "no signal available". */
  confidence: number;
  /** Raw signal snapshot for audit/debugging, null while unimplemented. */
  signals: {
    driverAcceptanceRate?: number | null;
    customerCancellationRate?: number | null;
    completedFareAverage?: number | null;
    availableDriverSupply?: number | null;
    demand?: number | null;
    timeOfDay?: string | null;
    trafficIndex?: number | null;
    weatherIndex?: number | null;
  } | null;
  source: string;
}
