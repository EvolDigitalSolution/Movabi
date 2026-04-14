import { Injectable, inject } from '@angular/core';
import { Map, NavigationControl, Marker, AttributionControl } from 'maplibre-gl';
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
          this.animateMarkerMovement(marker, options.coordinates.lng, options.coordinates.lat, options.heading);
        } else {
          marker.setLngLat([options.coordinates.lng, options.coordinates.lat]);
        }
      } else {
        const el = this.markerFactory.createMarkerElement(options.kind, options.serviceType, options.label);
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

  private animateMarkerMovement(marker: Marker, targetLng: number, targetLat: number, heading?: number) {
    const start = marker.getLngLat();
    const end = { lng: targetLng, lat: targetLat };
    const duration = 1000;
    const startTime = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);

      const lng = start.lng + (end.lng - start.lng) * progress;
      const lat = start.lat + (end.lat - start.lat) * progress;

      marker.setLngLat([lng, lat]);

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
    
    if (heading !== undefined) {
      this.rotateMarker(marker, heading);
    }
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
      this.map.fitBounds(route.bounds, {
        padding: { top: 80, bottom: 320, left: 60, right: 60 },
        maxZoom: 15,
        duration: 1000
      });
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.map.fitBounds(bounds, options as Record<string, any>);
    } catch (e) {
      console.warn('[MapRenderer] fitBounds failed', e);
    }
  }

  resize() {
    if (this.map) {
      this.map.resize();
    }
  }
}
