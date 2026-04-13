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
}

export interface FarePricingConfig {
  baseFare: number;
  distanceRatePerKm: number;
  timeRatePerMinute: number;
  serviceFee: number;
  minimumFare: number;
  label: string;
}
