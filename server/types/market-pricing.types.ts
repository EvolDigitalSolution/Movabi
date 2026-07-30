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
  minimumDriverHourlyRate?: number | null;
  minimumDriverPerKm?: number | null;
  minimumDriverPayout?: number | null;
  minimumPlatformMarginPercent: number;
  minimumPlatformRevenue: number;
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

  adjustedServiceFare: number;
  marketAdjustment: number;

  platformFeeAmount: number;
  customerTotal: number;

  driverCommissionAmount: number;
  driverPayout: number;

  strategyId?: string | null;
  marketSnapshotId?: string | null;

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
  version: string;
}
