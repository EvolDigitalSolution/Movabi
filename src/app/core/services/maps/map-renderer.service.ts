import { Injectable, inject } from '@angular/core';
import { Map, NavigationControl, Marker, AttributionControl, LngLatBounds } from 'maplibre-gl';
import { MapProviderService } from './map-provider.service';
import { MarkerFactoryService } from './marker-factory.service';
import { MarkerOptions } from '../../models/maps/map-marker.model';
import { RouteSummary } from '../../models/maps/route-result.model';

@Injectable({
  providedIn: 'root'
})
export class MapRendererService {
  private provider = inject(MapProviderService);
  private markerFactory = inject(MarkerFactoryService);
  
  private map: Map | null = null;
  private markers = new globalThis.Map<string, Marker>();
  private markerAnimationFrames = new globalThis.Map<string, number>();
  private routeLayerId = 'movabi-route-layer';
  private routeSourceId = 'movabi-route-source';

  initMap(container: HTMLElement): Map | null {
    if (!this.provider.hasMapConfig()) {
      console.error('Map configuration is incomplete. Map cannot be initialized.');
      return null;
    }

    try {
      const config = this.provider.getMapConfig();
      const styleUrl = this.provider.getStyleUrl();

      if (!styleUrl) {
        throw new Error('Resolved style URL is empty.');
      }
      
      this.map = new Map({
        container: container,
        style: styleUrl,
        center: config.defaultCenter,
        zoom: config.defaultZoom,
        attributionControl: false
      });

      this.map.addControl(new AttributionControl({ compact: true }));
      this.map.addControl(new NavigationControl(), 'top-right');
      
      return this.map;
    } catch (error) {
      console.error('Failed to initialize MapLibre map:', error);
      return null;
    }
  }

  destroyMap() {
    this.cancelAllMarkerAnimations();
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    this.markers.clear();
  }

  setCenter(lng: number, lat: number, zoom?: number) {
    if (!this.map || isNaN(lng) || isNaN(lat)) return;
    
    this.map.flyTo({
      center: [lng, lat],
      zoom: zoom || this.map.getZoom(),
      essential: true
    });
  }

  addOrUpdateMarker(options: MarkerOptions) {
    if (!this.map) return;
    
    // Defensive guard against invalid coordinates
    if (!options.coordinates || isNaN(options.coordinates.lat) || isNaN(options.coordinates.lng)) {
      console.warn(`[MapRenderer] Invalid coordinates for marker ${options.id}:`, options.coordinates);
      return;
    }

    try {
      let marker = this.markers.get(options.id);
      
      if (marker) {
        if (options.kind === 'driver') {
          this.animateMarkerMovement(
            options.id,
            marker,
            options.coordinates.lng,
            options.coordinates.lat,
            options.heading
          );
        } else {
          marker.setLngLat([options.coordinates.lng, options.coordinates.lat]);
        }
      } else {
        const el = this.markerFactory.createMarkerElement(options.kind, options.serviceType, options.label);
        if (options.onClick) {
          el.addEventListener('click', () => options.onClick?.(options.id));
        }
        marker = new Marker({ element: el })
          .setLngLat([options.coordinates.lng, options.coordinates.lat])
          .addTo(this.map);
        
        if (options.heading !== undefined) {
          this.rotateMarker(marker, options.heading);
        }
        
        this.markers.set(options.id, marker);
      }
    } catch (error) {
      console.error(`[MapRenderer] Failed to add/update marker ${options.id}:`, error);
    }
  }

  removeMarker(id: string) {
    this.cancelMarkerAnimation(id);
    const marker = this.markers.get(id);
    if (marker) {
      marker.remove();
      this.markers.delete(id);
    }
  }

  private rotateMarker(marker: Marker, heading: number) {
    const el = marker.getElement();
    const pin = el.querySelector('.movabi-marker__pin') as HTMLElement;
    if (pin) {
      // For drivers, we might want to rotate the whole pin or just an arrow inside
      // The spec says "directional styling if heading available"
      pin.style.transform = `rotate(${heading}deg)`;
    }
  }

  private animateMarkerMovement(
    markerId: string,
    marker: Marker,
    targetLng: number,
    targetLat: number,
    heading?: number
  ) {
    this.cancelMarkerAnimation(markerId);

    const start = marker.getLngLat();
    const end = { lng: targetLng, lat: targetLat };
    const distanceKm = this.distanceKm(start.lat, start.lng, end.lat, end.lng);

    // Do not animate stale GPS jumps across a city. Normal location updates glide
    // for long enough to look continuous without lagging behind the driver.
    if (distanceKm > 5) {
      marker.setLngLat([targetLng, targetLat]);
      if (heading !== undefined) this.rotateMarker(marker, heading);
      return;
    }

    const duration = Math.min(3200, Math.max(900, 900 + distanceKm * 18000));
    const resolvedHeading = heading ?? this.bearingDegrees(start.lat, start.lng, end.lat, end.lng);
    const startTime = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = 1 - Math.pow(1 - progress, 3);

      const lng = start.lng + (end.lng - start.lng) * easedProgress;
      const lat = start.lat + (end.lat - start.lat) * easedProgress;

      marker.setLngLat([lng, lat]);

      if (progress < 1) {
        this.markerAnimationFrames.set(markerId, requestAnimationFrame(animate));
      } else {
        this.markerAnimationFrames.delete(markerId);
      }
    };

    this.markerAnimationFrames.set(markerId, requestAnimationFrame(animate));
    
    this.rotateMarker(marker, resolvedHeading);
  }

  private cancelMarkerAnimation(markerId: string): void {
    const frame = this.markerAnimationFrames.get(markerId);
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      this.markerAnimationFrames.delete(markerId);
    }
  }

  private cancelAllMarkerAnimations(): void {
    this.markerAnimationFrames.forEach((frame) => cancelAnimationFrame(frame));
    this.markerAnimationFrames.clear();
  }

  private distanceKm(startLat: number, startLng: number, endLat: number, endLng: number): number {
    const toRadians = (value: number) => value * Math.PI / 180;
    const latDelta = toRadians(endLat - startLat);
    const lngDelta = toRadians(endLng - startLng);
    const a = Math.sin(latDelta / 2) ** 2
      + Math.cos(toRadians(startLat)) * Math.cos(toRadians(endLat))
      * Math.sin(lngDelta / 2) ** 2;

    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private bearingDegrees(startLat: number, startLng: number, endLat: number, endLng: number): number {
    const toRadians = (value: number) => value * Math.PI / 180;
    const startLatitude = toRadians(startLat);
    const endLatitude = toRadians(endLat);
    const longitudeDelta = toRadians(endLng - startLng);
    const y = Math.sin(longitudeDelta) * Math.cos(endLatitude);
    const x = Math.cos(startLatitude) * Math.sin(endLatitude)
      - Math.sin(startLatitude) * Math.cos(endLatitude) * Math.cos(longitudeDelta);

    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  drawRoute(route: RouteSummary) {
    if (!this.map || !route.geometry) return;

    this.clearRoute();

    this.map.addSource(this.routeSourceId, {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: {},
        geometry: route.geometry
      }
    });

    this.map.addLayer({
      id: this.routeLayerId,
      type: 'line',
      source: this.routeSourceId,
      layout: {
        'line-join': 'round',
        'line-cap': 'round'
      },
      paint: {
        'line-color': '#2563eb',
        'line-width': 5,
        'line-opacity': 0.75
      }
    });

    if (route.bounds) {
      const container = this.map.getContainer();
      const width = container.clientWidth;
      const height = container.clientHeight;
      const bottomPadding = height > 520 ? Math.floor(height * 0.18) : Math.max(56, Math.floor(height * 0.18));
      const horizontalPadding = width > 420 ? 56 : 28;

      if (width > 120 && height > 120) {
        try {
          this.map.fitBounds(route.bounds, {
            padding: { top: 80, bottom: bottomPadding, left: horizontalPadding, right: horizontalPadding },
            maxZoom: 15,
            duration: 1000
          });
        } catch (error) {
          console.warn('[MapRenderer] Route bounds could not fit current map viewport.', error);
        }
      }
    }
  }

  clearRoute() {
    if (!this.map) return;
    if (this.map.getLayer(this.routeLayerId)) this.map.removeLayer(this.routeLayerId);
    if (this.map.getSource(this.routeSourceId)) this.map.removeSource(this.routeSourceId);
  }

  drawHeatmap(zones: { lat: number; lng: number; demand: number; drivers: number }[]) {
    if (!this.map) return;

    const sourceId = 'heatmap-source';
    const layerId = 'heatmap-layer';

    if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);

    const features = zones.map(zone => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [zone.lng, zone.lat]
      },
      properties: {
        demand: zone.demand,
        drivers: zone.drivers,
        // Color logic: red if demand > drivers, green if drivers >= demand
        color: zone.demand > zone.drivers ? '#ef4444' : '#10b981',
        radius: Math.min(20 + (zone.demand * 5), 50)
      }
    }));

    this.map.addSource(sourceId, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: features as any[]
      }
    });

    this.map.addLayer({
      id: layerId,
      type: 'circle',
      source: sourceId,
      paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.4,
        'circle-stroke-width': 2,
        'circle-stroke-color': ['get', 'color']
      }
    });
  }

  fitBounds(bounds: [[number, number], [number, number]], options?: unknown) {
    if (!this.map || !bounds) return;
    
    try {
      // Validate bounds to prevent "Invalid base URL" or other MapLibre errors
      const isValid = bounds.every(coord => 
        Array.isArray(coord) && 
        coord.length === 2 && 
        !isNaN(coord[0]) && 
        !isNaN(coord[1])
      );

      if (!isValid) {
        console.warn('[MapRenderer] Invalid bounds for fitBounds:', bounds);
        return;
      }

      const container = this.map.getContainer();
      const width = container.clientWidth;
      const height = container.clientHeight;

      if (width <= 120 || height <= 120) {
        return;
      }

      const nextOptions = { ...((options as Record<string, any>) || {}) };
      const padding = nextOptions['padding'];

      if (typeof padding === 'object' && padding !== null) {
        nextOptions['padding'] = {
          top: Math.min(Number(padding['top'] || 0), Math.max(24, Math.floor(height * 0.6))),
          bottom: Math.min(Number(padding['bottom'] || 0), Math.max(24, Math.floor(height * 0.85))),
          left: Math.min(Number(padding['left'] || 0), Math.max(24, Math.floor(width * 0.45))),
          right: Math.min(Number(padding['right'] || 0), Math.max(24, Math.floor(width * 0.45)))
        };
      }

      this.map.fitBounds(bounds, nextOptions);
    } catch (e) {
      console.warn('[MapRenderer] fitBounds failed', e);
    }
  }

  resize() {
    if (this.map) {
      this.map.resize();
    }
  }

  drawTrackingPolyline(id: string, coords: Array<{lat:number; lng:number}>): void {
    const map = this.map;
    if (!map || coords.length < 2) return;

    const sourceId = `${id}-source`;
    const layerId = `${id}-layer`;

    const lineCoords = coords.map(p => [p.lng, p.lat]);

    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);

    map.addSource(sourceId, {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: lineCoords
        },
        properties: {}
      }
    });

    map.addLayer({
      id: layerId,
      type: 'line',
      source: sourceId,
      layout: {
        'line-join': 'round',
        'line-cap': 'round'
      },
      paint: {
        'line-width': 5,
        'line-opacity': 0.9,
        'line-color': '#2563eb'
      }
    });
  }

  drawLineString(
    id: string,
    points: Array<{ lat: number; lng: number }>
  ): void {
    const map = this.map;
    if (!map || points.length < 2) return;

    const sourceId = `${id}-source`;
    const layerId = `${id}-layer`;

    const coordinates = points
      .filter(p =>
        Number.isFinite(Number(p.lat)) &&
        Number.isFinite(Number(p.lng)) &&
        Math.abs(Number(p.lat)) > 0 &&
        Math.abs(Number(p.lng)) > 0
      )
      .map(p => [Number(p.lng), Number(p.lat)]);

    if (coordinates.length < 2) return;

    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }

    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
    }

    map.addSource(sourceId, {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates
        },
        properties: {}
      }
    });

    map.addLayer({
      id: layerId,
      type: 'line',
      source: sourceId,
      layout: {
        'line-join': 'round',
        'line-cap': 'round'
      },
      paint: {
        'line-color': '#2563eb',
        'line-width': 6,
        'line-opacity': 0.95
      }
    });
  }

  fitTrackingBounds(points: Array<{ lat: number; lng: number }>): void {
    const map = this.map;
    if (!map || points.length < 2) return;

    const valid = points.filter(p =>
      Number.isFinite(Number(p.lat)) &&
      Number.isFinite(Number(p.lng)) &&
      Math.abs(Number(p.lat)) > 0 &&
      Math.abs(Number(p.lng)) > 0
    );

    if (valid.length < 2) return;

    // Use imported LngLatBounds
    
    const bounds = valid.reduce((b, p) => {
      return b.extend([Number(p.lng), Number(p.lat)]);
    }, new LngLatBounds(
      [Number(valid[0].lng), Number(valid[0].lat)],
      [Number(valid[0].lng), Number(valid[0].lat)]
    ));

    map.fitBounds(bounds, {
      padding: {
        top: 80,
        left: 48,
        right: 48,
        bottom: 420
      },
      duration: 600,
      maxZoom: 16
    });
  }

  upsertMarker(id: string, coords: { lat: number; lng: number }, options: { type: string }): void {
    if (!this.map || !coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) {
      return;
    }

    // Remove existing marker if it exists
    if (this.markers.has(id)) {
      const marker = this.markers.get(id);
      if (marker) {
        marker.remove();
      }
      this.markers.delete(id);
    }

    // Create marker element based on type
    let kind: 'driver' | 'pickup' | 'destination' = 'destination';
    if (options.type === 'driver') kind = 'driver';
    else if (options.type === 'pickup') kind = 'pickup';

    const el = this.markerFactory.createMarkerElement(kind, 'ride' as any, '');
    
    const marker = new Marker({ element: el })
      .setLngLat([coords.lng, coords.lat])
      .addTo(this.map);

    this.markers.set(id, marker);
  }

  updateMarkerPosition(id: string, coords: { lat: number; lng: number }): void {
    if (!this.map || !coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) {
      return;
    }

    const marker = this.markers?.get(id);
    if (!marker) {
      // Marker doesn't exist, create it with default options
      this.upsertMarker(id, coords, { type: 'destination' });
      return;
    }

    marker.setLngLat([coords.lng, coords.lat]);
  }

  drawRouteGeometry(id: string, coordinates: number[][]): void {
    const map = this.map;
    if (!map || !coordinates?.length || coordinates.length < 2) return;

    const sourceId = `${id}-source`;
    const layerId = `${id}-layer`;

    const validCoords = coordinates
      .filter(c =>
        Array.isArray(c) &&
        c.length >= 2 &&
        Number.isFinite(Number(c[0])) &&
        Number.isFinite(Number(c[1]))
      )
      .map(c => [Number(c[0]), Number(c[1])]);

    if (validCoords.length < 2) return;

    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }

    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
    }

    map.addSource(sourceId, {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: validCoords
        },
        properties: {}
      }
    });

    map.addLayer({
      id: layerId,
      type: 'line',
      source: sourceId,
      layout: {
        'line-join': 'round',
        'line-cap': 'round'
      },
      paint: {
        'line-color': '#2563eb',
        'line-width': 6,
        'line-opacity': 0.95
      }
    });
  }
}
