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
  /** Latest route requested while the style was still loading (one slot; latest wins). */
  private pendingRoute: RouteSummary | null = null;
  private routeStyleListenerRegistered = false;

  // Camera-follow support. Genuine user gestures are identified by MapLibre's
  // originalEvent metadata; programmatic easeTo events do not carry it.
  private userGestureListeners: Array<{ event: string; handler: (e: any) => void }> = [];
  private userGestureCallback: (() => void) | null = null;

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
    this.detachUserGestureListeners();
    this.pendingRoute = null;
    this.routeStyleListenerRegistered = false;
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    this.markers.clear();
    this.markerHeadings.clear();
  }

  /**
   * Register a callback fired only for genuine user map gestures
   * (drag / zoom / rotate / pitch). Programmatic camera moves are ignored.
   */
  onUserMapGesture(callback: (() => void) | null): void {
    this.detachUserGestureListeners();
    this.userGestureCallback = callback;

    if (!this.map || !callback) return;

    const events = ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart'];
    const handler = (event: any) => {
      // MapLibre sets originalEvent only for genuine user input. Programmatic
      // easeTo/flyTo/fitBounds events do not carry it, so they cannot disable
      // auto-follow and cannot create a feedback loop.
      const original = event?.originalEvent;
      if (!original) return;
      this.userGestureCallback?.();
    };

    events.forEach((name) => {
      this.map!.on(name as any, handler);
      this.userGestureListeners.push({ event: name, handler });
    });
  }

  private detachUserGestureListeners(): void {
    if (this.map) {
      this.userGestureListeners.forEach(({ event, handler }) => {
        try {
          this.map!.off(event as any, handler);
        } catch {
          // ignore
        }
      });
    }
    this.userGestureListeners = [];
  }

  /**
   * Smoothly move the camera to a real coordinate without resetting zoom.
   * Used by live tracking follow. Never offsets coordinates.
   */
  easeToCenter(lng: number, lat: number, options?: { zoom?: number; duration?: number; padding?: any }): boolean {
    if (!this.map || isNaN(lng) || isNaN(lat)) return false;

    const next: Record<string, any> = {
      center: [lng, lat],
      duration: options?.duration ?? 900,
      essential: true
    };

    if (typeof options?.zoom === 'number' && Number.isFinite(options.zoom)) {
      next['zoom'] = options.zoom;
    }

    if (options?.padding) {
      next['padding'] = options.padding;
    }

    try {
      this.map.easeTo(next as any);
      return true;
    } catch (error) {
      console.warn('[MapRenderer] easeToCenter failed', error);
      return false;
    }
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
      let marker: Marker | undefined | null = this.markers.get(options.id);
      const serviceType = String(options.serviceType ?? '');
      const kind = String(options.kind ?? '');

      if (marker) {
        const prevServiceType = String((marker as any)._movabiServiceType ?? '');
        const prevKind = String((marker as any)._movabiKind ?? '');
        const changed = serviceType !== prevServiceType || kind !== prevKind;

        if (changed) {
          // Service/kind changed: rebuild the DOM element so a stale service icon
          // (e.g. an errand cart pin) cannot survive into a new service request.
          this.cancelMarkerAnimation(options.id);
          marker.remove();
          this.markers.delete(options.id);
          marker = null;
        } else if (options.kind === 'driver') {
          this.animateMarkerMovement(
            options.id,
            marker,
            options.coordinates.lng,
            options.coordinates.lat,
            options.heading
          );
          return;
        } else {
          marker.setLngLat([options.coordinates.lng, options.coordinates.lat]);
          return;
        }
      }

      const el = this.markerFactory.createMarkerElement(options.kind, options.serviceType, options.label);
      if (options.onClick) {
        el.addEventListener('click', () => options.onClick?.(options.id));
      }
      marker = new Marker({ element: el })
        .setLngLat([options.coordinates.lng, options.coordinates.lat])
        .addTo(this.map);

      (marker as any)._movabiId = options.id;
      (marker as any)._movabiServiceType = serviceType;
      (marker as any)._movabiKind = kind;

      if (options.heading !== undefined) {
        this.rotateMarker(marker, options.heading);
      }

      this.markers.set(options.id, marker);
    } catch (error) {
      console.error(`[MapRenderer] Failed to add/update marker ${options.id}:`, error);
    }
  }

  removeMarker(id: string) {
    this.cancelMarkerAnimation(id);
    this.markerHeadings.delete(id);
    const marker = this.markers.get(id);
    if (marker) {
      marker.remove();
      this.markers.delete(id);
    }
  }

  private markerHeadings = new globalThis.Map<string, number>();

  private rotateMarker(marker: Marker, heading: number) {
    const el = marker.getElement();
    const pin = el.querySelector('.movabi-marker__pin') as HTMLElement;
    if (!pin) return;

    const markerId = (marker as any)?._movabiId as string | undefined;
    const previous = markerId ? this.markerHeadings.get(markerId) : undefined;

    let next = ((heading % 360) + 360) % 360;

    if (previous !== undefined) {
      // Shortest angular direction: 359 -> 1 must not rotate 358 backwards.
      const delta = ((next - previous + 540) % 360) - 180;
      next = previous + delta;
    }

    if (markerId) {
      this.markerHeadings.set(markerId, ((next % 360) + 360) % 360);
    }

    pin.style.transform = `rotate(${next}deg)`;
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

    this.pendingRoute = route;

    if (!this.map.isStyleLoaded()) {
      // Style not ready: defer EXACTLY once via MapLibre's own style.load event.
      // A repeated pre-ready draw overwrites pendingRoute, so the latest route
      // wins without accumulating duplicate listeners or source/layer work.
      this.ensureRouteStyleListener();
      return;
    }

    this.renderRoute(route);
  }

  private ensureRouteStyleListener(): void {
    if (!this.map || this.routeStyleListenerRegistered) return;
    this.routeStyleListenerRegistered = true;

    this.map.once('style.load', () => {
      this.routeStyleListenerRegistered = false;
      const route = this.pendingRoute;
      this.pendingRoute = null;

      // The map may have been destroyed before readiness — do nothing then.
      if (route && this.map && this.map.isStyleLoaded()) {
        this.renderRoute(route);
      }
    });
  }

  private renderRoute(route: RouteSummary) {
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
    if (!this.map || !this.map.isStyleLoaded()) return;
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

  fitBounds(bounds: [[number, number], [number, number]], options?: unknown): boolean {
    if (!this.map || !bounds) return false;
    
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
        return false;
      }

      const container = this.map.getContainer();
      const width = container.clientWidth;
      const height = container.clientHeight;

      if (width <= 120 || height <= 120) {
        return false;
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
      return true;
    } catch (e) {
      console.warn('[MapRenderer] fitBounds failed', e);
      return false;
    }
  }

  resize() {
    if (this.map) {
      this.map.resize();
    }
  }

  /**
   * Live map container size, used to derive camera padding from real layout
   * instead of window dimensions. Returns zeros when no map is mounted.
   */
  getContainerSize(): { width: number; height: number } {
    if (!this.map) return { width: 0, height: 0 };

    const container = this.map.getContainer();

    return {
      width: container?.clientWidth ?? 0,
      height: container?.clientHeight ?? 0
    };
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
      this.cancelMarkerAnimation(id);
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

  clearRouteGeometry(id: string): void {
    const map = this.map;
    if (!map) return;

    const sourceId = `${id}-source`;
    const layerId = `${id}-layer`;

    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }

    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
    }
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
