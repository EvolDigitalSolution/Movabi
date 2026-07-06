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

/**
 * Shared map UX helpers for Uber/Bolt-style map behavior
 */
export class MapUxHelpers {
  /**
   * Fit map bounds to ensure all points are visible above bottom sheet
   */
  static fitVisibleMapBounds(
    mapComponent: MapComponent,
    points: MapCoordinates[],
    bottomSheetPercent: number = 40
  ): void {
    if (!points.length) return;

    // Calculate bottom padding based on bottom sheet height
    const viewportHeight = window.innerHeight;
    const bottomPadding = (viewportHeight * bottomSheetPercent) / 100;
    
    // Add extra padding to ensure markers are clearly visible
    const finalBottomPadding = Math.max(bottomPadding + 100, 400);

    const lats = points.map(point => point.lat);
    const lngs = points.map(point => point.lng);
    
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)]
    ];

    // Use MapComponent's fitBounds method
    mapComponent.fitBounds(bounds, {
      padding: { top: 80, left: 48, right: 48, bottom: finalBottomPadding },
      maxZoom: 16,
      duration: 800
    });
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
   * Get bottom sheet padding in pixels for map fitting
   */
  static getBottomSheetPadding(bottomSheetPercent: number): number {
    const viewportHeight = window.innerHeight;
    const basePadding = (viewportHeight * bottomSheetPercent) / 100;
    return Math.max(basePadding + 100, 400);
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
