import { Injectable, inject } from '@angular/core';
import { MapRendererService } from './map-renderer.service';
import { DriverLivePosition, MarkerOptions } from '../../models/maps/map-marker.model';

@Injectable({
  providedIn: 'root'
})
export class DriverLiveMapService {
  private mapRenderer = inject(MapRendererService);
  private activeDrivers = new Set<string>();

  updateDriverPosition(position: DriverLivePosition) {
    const markerOptions: MarkerOptions = {
      id: `driver-${position.driverId}`,
      kind: 'driver',
      serviceType: 'ride', // Default to ride, could be dynamic
      coordinates: {
        lat: position.lat,
        lng: position.lng
      },
      heading: position.heading
    };

    this.mapRenderer.addOrUpdateMarker(markerOptions);
    this.activeDrivers.add(position.driverId);
  }

  removeDriver(driverId: string) {
    this.mapRenderer.removeMarker(`driver-${driverId}`);
    this.activeDrivers.delete(driverId);
  }

  clearAllDrivers() {
    this.activeDrivers.forEach(id => this.removeDriver(id));
  }
}
