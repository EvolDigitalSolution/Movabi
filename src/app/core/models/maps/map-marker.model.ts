export type ServiceTypeSlug = 'ride' | 'errand' | 'delivery' | 'van-moving';
export type MarkerKind = 'pickup' | 'destination' | 'driver';

export interface MarkerCoordinates {
  lat: number;
  lng: number;
}

export interface MarkerOptions {
  id: string;
  kind: MarkerKind;
  serviceType: ServiceTypeSlug;
  coordinates: MarkerCoordinates;
  label?: string;
  heading?: number;
}

export interface DriverLivePosition {
  driverId: string;
  lat: number;
  lng: number;
  heading?: number;
  speedKph?: number;
  updatedAt?: string;
}
