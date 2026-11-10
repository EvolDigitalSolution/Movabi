import { MapComponent } from '@shared/components/map/map.component';
import { RoutingService } from '@core/services/maps/routing.service';

export interface MapCoordinates {
  lat: number;
  lng: number;
}

export interface BottomSheetConfig {
  snapPoints: number[]; // [40, 80, 95] percentages
  currentSnap: number;
  mapHeightPercent: number; // Map height as percentage of viewport
}

export interface VehicleMarker {
  id: string;
  coordinates: MapCoordinates;
  bearing?: number; // Direction in degrees
  icon?: string;
}

export interface FitMapOptions {
  maxZoom?: number;
  duration?: number;
  singlePointZoom?: number;
  topPadding?: number;
  sidePadding?: number;
}

/**
 * Shared map UX helpers for Uber/Bolt-style map behavior
 */
export class MapUxHelpers {
  /**
   * Fit the map so every valid point stays visible above the bottom sheet.
   *
   * Returns true only when a camera move was actually issued, so callers can
   * avoid latching camera state onto a failed/deferred fit.
   *
   * A single valid point is framed with an explicit zoom + padding instead of a
   * degenerate (zero-area) bounds box, which MapLibre cannot resolve reliably.
   */
  static fitVisibleMapBounds(
    mapComponent: MapComponent,
    points: MapCoordinates[],
    bottomSheetPercent: number = 40,
    options?: FitMapOptions
  ): boolean {
    const validPoints = this.filterValidCoordinates(points);
    if (!validPoints.length) return false;

    const viewport = this.getViewport(mapComponent);
    const padding = this.buildSheetPadding(bottomSheetPercent, viewport.height, options);

    if (validPoints.length === 1) {
      const point = validPoints[0];

      return mapComponent.easeToCenter(point.lng, point.lat, {
        zoom: options?.singlePointZoom ?? 15,
        duration: options?.duration ?? 700,
        padding
      });
    }

    const lats = validPoints.map(point => point.lat);
    const lngs = validPoints.map(point => point.lng);

    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)]
    ];

    return mapComponent.fitBounds(bounds, {
      padding,
      maxZoom: options?.maxZoom ?? 16,
      duration: options?.duration ?? 800
    });
  }

  /**
   * Build camera padding from the CURRENT bottom-sheet height, using the real
   * map container height where available. Clamped so MapLibre keeps a usable
   * viewport instead of collapsing the visible area.
   */
  static buildSheetPadding(
    bottomSheetPercent: number,
    viewportHeight?: number,
    options?: FitMapOptions
  ): { top: number; bottom: number; left: number; right: number } {
    const parsedHeight = Number(viewportHeight);
    const height = Number.isFinite(parsedHeight) && parsedHeight > 0
      ? parsedHeight
      : window.innerHeight;

    const percent = Math.min(Math.max(Number(bottomSheetPercent) || 0, 0), 90);
    const sheetPixels = (height * percent) / 100;
    const maxBottom = Math.max(96, height - 160);
    const bottom = Math.round(Math.min(Math.max(sheetPixels + 24, 96), maxBottom));

    return {
      top: options?.topPadding ?? 80,
      bottom,
      left: options?.sidePadding ?? 48,
      right: options?.sidePadding ?? 48
    };
  }

  private static getViewport(mapComponent: MapComponent): { width: number; height: number } {
    if (typeof mapComponent.getViewportSize === 'function') {
      const size = mapComponent.getViewportSize();

      if (Number.isFinite(size?.width) && Number.isFinite(size?.height)) {
        return size;
      }
    }

    return { width: window.innerWidth, height: window.innerHeight };
  }

  /**
   * Draw road route between points using RoutingService
   */
  static async drawRoadRoute(
    routingService: RoutingService,
    mapComponent: MapComponent,
    points: MapCoordinates[]
  ): Promise<void> {
    if (points.length < 2) return;

    try {
      // Use RoutingService.getRoute method with from/to coordinates
      const from = points[0];
      const to = points[points.length - 1];
      
      const route = await routingService.getRoute(from, to).toPromise();
      
      if (route && route.geometry) {
        // Valid road route geometry found
        mapComponent.drawRoute(route);
      } else {
        // Fallback to straight line if road route fails
        console.warn('[MapUxHelpers] Road route failed, using straight line fallback');
        // Create a simple route object for straight line
        const straightLineRoute = {
          geometry: points.map(p => [p.lng, p.lat] as [number, number]),
          distanceMeters: this.calculateDistance(from, to),
          durationSeconds: Math.round((this.calculateDistance(from, to) / 1000) / 50 * 3600) // 50km/h average
        };
        mapComponent.drawRoute(straightLineRoute);
      }
    } catch (error) {
      console.error('[MapUxHelpers] Failed to draw route:', error);
      // Fallback to straight line on error
      const from = points[0];
      const to = points[points.length - 1];
      const straightLineRoute = {
        geometry: points.map(p => [p.lng, p.lat] as [number, number]),
        distanceMeters: this.calculateDistance(from, to),
        durationSeconds: Math.round((this.calculateDistance(from, to) / 1000) / 50 * 3600)
      };
      mapComponent.drawRoute(straightLineRoute);
    }
  }

  /**
   * Update vehicle marker position and bearing
   */
  static updateVehicleMarker(
    mapComponent: MapComponent,
    marker: VehicleMarker
  ): void {
    mapComponent.addOrUpdateMarker({
      id: marker.id,
      kind: 'driver',
      serviceType: 'ride',
      coordinates: marker.coordinates,
      label: marker.icon || 'Vehicle'
    });
  }

  /**
   * Calculate distance between two coordinates in meters
   */
  static calculateDistance(point1: MapCoordinates, point2: MapCoordinates): number {
    const R = 6371000; // Earth's radius in meters
    const dLat = (point2.lat - point1.lat) * Math.PI / 180;
    const dLon = (point2.lng - point1.lng) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(point1.lat * Math.PI / 180) * Math.cos(point2.lat * Math.PI / 180) *
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  /**
   * Calculate bearing between two coordinates
   */
  static calculateBearing(from: MapCoordinates, to: MapCoordinates): number {
    const dLon = (to.lng - from.lng) * Math.PI / 180;
    const fromLat = from.lat * Math.PI / 180;
    const toLat = to.lat * Math.PI / 180;
    
    const y = Math.sin(dLon) * Math.cos(toLat);
    const x = Math.cos(fromLat) * Math.sin(toLat) -
              Math.sin(fromLat) * Math.cos(toLat) * Math.cos(dLon);
    
    const bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360;
  }

  /**
   * Check if vehicle moved significantly (for route redraw threshold)
   */
  static shouldUpdateRoute(
    oldPosition: MapCoordinates,
    newPosition: MapCoordinates,
    thresholdMeters: number = 25
  ): boolean {
    const distance = this.calculateDistance(oldPosition, newPosition);
    return distance > thresholdMeters;
  }

  /**
   * Get bottom sheet padding in pixels for map fitting.
   * Kept for backwards compatibility; delegates to buildSheetPadding.
   */
  static getBottomSheetPadding(bottomSheetPercent: number): number {
    return this.buildSheetPadding(bottomSheetPercent, window.innerHeight).bottom;
  }

  /**
   * Create vehicle marker config
   */
  static createVehicleMarker(
    id: string,
    coordinates: MapCoordinates,
    bearing?: number,
    icon?: string
  ): VehicleMarker {
    return {
      id,
      coordinates,
      bearing,
      icon: icon || 'car'
    };
  }

  /**
   * Pause camera follow mode on user gesture
   */
  static pauseFollowOnUserGesture(mapComponent: MapComponent): void {
    // This would integrate with MapComponent's follow mode logic
    // Implementation depends on MapComponent's available methods
    // For now, this is a placeholder for future implementation
    console.log('[MapUxHelpers] Follow mode paused');
  }

  /**
   * Recenter map to follow mode
   */
  static recenter(mapComponent: MapComponent): void {
    // This would restore follow mode
    // For now, this is a placeholder for future implementation
    console.log('[MapUxHelpers] Follow mode resumed');
  }

  /**
   * Filter valid coordinates (remove null/undefined/invalid)
   */
  static filterValidCoordinates(points: (MapCoordinates | null | undefined)[]): MapCoordinates[] {
    return points.filter((point): point is MapCoordinates => 
      point !== null && 
      point !== undefined && 
      typeof point.lat === 'number' && 
      typeof point.lng === 'number' &&
      !isNaN(point.lat) && 
      !isNaN(point.lng)
    );
  }

  /**
   * Get map bounds for given points with padding
   */
  static getBoundsWithPadding(
    points: MapCoordinates[],
    bottomPadding: number,
    sidePadding: number = 48
  ): [[number, number], [number, number]] | null {
    if (!points.length) return null;

    const lats = points.map(point => point.lat);
    const lngs = points.map(point => point.lng);
    
    return [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)]
    ];
  }
}
