import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { MapProviderService } from './map-provider.service';
import { AppConfigService } from '../config/app-config.service';
import { AutocompleteResult } from '../../models/maps/route-result.model';
import { map, Observable, of } from 'rxjs';

interface ORSFeature {
  properties: {
    label: string;
    name: string;
  };
  geometry: {
    coordinates: [number, number];
  };
}

@Injectable({
  providedIn: 'root'
})
export class GeocodingService {
  private http = inject(HttpClient);
  private provider = inject(MapProviderService);
  private config = inject(AppConfigService);
  private baseUrl = 'https://api.openrouteservice.org/geocode';
  private cache = new Map<string, AutocompleteResult[]>();

  autocomplete(query: string): Observable<AutocompleteResult[]> {
    if (!query || query.length < 3) return of([]);
    
    const countryCode = this.config.currentCountry().code;
    const cacheKey = `autocomplete:${countryCode}:${query}`;
    if (this.cache.has(cacheKey)) return of(this.cache.get(cacheKey)!);

    const apiKey = this.provider.getOpenRouteServiceApiKey();
    if (!apiKey) {
      console.warn('OpenRouteService API key is missing');
      return of([]);
    }

    const params: Record<string, string | number> = {
      api_key: apiKey,
      text: query,
      size: 5
    };

    if (countryCode) {
      params['boundary.country'] = countryCode;
    }

    return this.http.get<{ features: ORSFeature[] }>(`${this.baseUrl}/autocomplete`, {
      params
    }).pipe(
      map(res => {
        const results = this.mapFeaturesToResults(res.features);
        this.cache.set(cacheKey, results);
        return results;
      })
    );
  }

  geocodeAddress(query: string): Observable<AutocompleteResult[]> {
    const apiKey = this.provider.getOpenRouteServiceApiKey();
    if (!apiKey) return of([]);

    const countryCode = this.config.currentCountry().code;
    const params: Record<string, string | number> = {
      api_key: apiKey,
      text: query,
      size: 1
    };

    if (countryCode) {
      params['boundary.country'] = countryCode;
    }

    return this.http.get<{ features: ORSFeature[] }>(`${this.baseUrl}/search`, {
      params
    }).pipe(
      map(res => this.mapFeaturesToResults(res.features))
    );
  }

  reverseGeocode(lat: number, lng: number): Observable<string> {
    const apiKey = this.provider.getOpenRouteServiceApiKey();
    if (!apiKey) return of('');

    return this.http.get<{ features: ORSFeature[] }>(`${this.baseUrl}/reverse`, {
      params: {
        api_key: apiKey,
        'point.lat': lat,
        'point.lon': lng,
        size: 1
      }
    }).pipe(
      map(res => res.features?.[0]?.properties?.label || '')
    );
  }

  private mapFeaturesToResults(features: ORSFeature[]): AutocompleteResult[] {
    if (!features) return [];
    return features.map(f => ({
      label: f.properties.label,
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0]
    }));
  }
}
