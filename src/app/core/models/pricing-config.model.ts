import { ServiceTypeSlug } from './maps/map-marker.model';

export interface PricingConfig {
  id?: string;
  service_type: ServiceTypeSlug;
  base_fare: number;
  per_km: number;
  per_min: number;
  service_fee: number;
  minimum_fare: number;
  currency_code: string;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;

  // Shop / errand specific
  free_included_items?: number;
  extra_item_fee?: number;
  large_shopping_surcharge?: number;
  large_shopping_threshold?: number;
  peak_multiplier?: number;
  weather_multiplier?: number;
}

export interface FarePricingConfig {
  baseFare: number;
  distanceRatePerKm: number;
  timeRatePerMinute: number;
  serviceFee: number;
  minimumFare: number;
  label: string;

  // Shop / errand specific
  freeIncludedItems: number;
  extraItemFee: number;
  largeShoppingSurcharge: number;
  largeShoppingThreshold: number;
  peakMultiplier: number;
  weatherMultiplier: number;
}
