export interface RouteSummary {
  distanceMeters: number;
  durationSeconds: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  geometry?: any; // GeoJSON geometry
  bounds?: [[number, number], [number, number]]; // [sw, ne]
  legs?: {
    distanceMeters: number;
    durationSeconds: number;
    instruction?: string;
    name?: string;
  }[];
}

export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
  countryCode?: string;
  region?: string;
  city?: string;
  postalCode?: string;
}

export interface AutocompleteResult {
  label: string;
  lat: number;
  lng: number;
}
