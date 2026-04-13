import { ServiceTypeSlug } from './map-marker.model';

export interface PricingInput {
  serviceType: ServiceTypeSlug;
  distanceMeters: number;
  durationSeconds: number;
  currencyCode?: string;
  countryCode?: string;
  cityId?: string | null;
  basePriceOverride?: number | null;
  moveDetails?: {
    size: 'small' | 'medium' | 'large' | 'full-house';
    helperCount: number;
    stairsInvolved: boolean;
    packingAssistance: boolean;
    fragileItems: boolean;
  } | null;
  errandBudget?: number | null;
  errandDetails?: {
    mode: 'collect_deliver' | 'quick_buy' | 'shop_deliver';
  } | null;
}

export interface FareEstimate {
  serviceType: ServiceTypeSlug;
  currencyCode: string;
  distanceKm: number;
  durationMinutes: number;
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  serviceFee: number;
  subtotal: number;
  minimumFareApplied: boolean;
  total: number;
  breakdownLabel?: string;
}
