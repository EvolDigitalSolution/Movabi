import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { MapProviderService } from './map-provider.service';
import { RouteSummary } from '../../models/maps/route-result.model';
import { map, Observable, of } from 'rxjs';

interface ORSRoute {
  summary: {
    distance: number;
    duration: number;
  };
  geometry: string | object;
  bbox: [number, number, number, number];
}

@Injectable({
  providedIn: 'root'
})
export class RoutingService {
  private http = inject(HttpClient);
  private provider = inject(MapProviderService);
  private baseUrl = 'https://api.openrouteservice.org/v2/directions/driving-car';
  private cache = new Map<string, RouteSummary | null>();

  getRoute(start: { lat: number, lng: number }, end: { lat: number, lng: number }): Observable<RouteSummary | null> {
    const cacheKey = `route:${start.lat},${start.lng}:${end.lat},${end.lng}`;
    if (this.cache.has(cacheKey)) return of(this.cache.get(cacheKey)!);

    const apiKey = this.provider.getOpenRouteServiceApiKey();
    if (!apiKey) return of(null);

    return this.http.post<{ routes: ORSRoute[] }>(this.baseUrl, {
      coordinates: [[start.lng, start.lat], [end.lng, end.lat]],
      instructions: true
    }, {
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json'
      }
    }).pipe(
      map(res => {
        const route = res.routes?.[0];
        if (!route) {
          this.cache.set(cacheKey, null);
          return null;
        }

        const summary = route.summary;
        const geometry = route.geometry;
        const bbox = route.bbox; // [minLon, minLat, maxLon, maxLat]

        const result = {
          distanceMeters: summary.distance,
          durationSeconds: summary.duration,
          geometry: geometry,
          bounds: [
            [bbox[0], bbox[1]], // sw
            [bbox[2], bbox[3]]  // ne
          ]
        } as RouteSummary;

        this.cache.set(cacheKey, result);
        return result;
      })
    );
  }
}
