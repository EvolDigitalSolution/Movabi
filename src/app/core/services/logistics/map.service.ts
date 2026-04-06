import { Injectable } from '@angular/core';
import { environment } from '@env/environment';

@Injectable({
  providedIn: 'root'
})
export class MapService {
  private isLoaded = false;

  /**
   * Load Google Maps API script
   */
  loadGoogleMaps(): Promise<void> {
    if (this.isLoaded) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${environment.googleMapsApiKey}&libraries=places`;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        this.isLoaded = true;
        resolve();
      };
      script.onerror = (error) => reject(error);
      document.head.appendChild(script);
    });
  }

  /**
   * Create a map instance
   */
  createMap(element: HTMLElement, options: google.maps.MapOptions): google.maps.Map {
    return new google.maps.Map(element, options);
  }

  /**
   * Add a marker to the map
   */
  addMarker(map: google.maps.Map, position: google.maps.LatLngLiteral, icon?: string): google.maps.Marker {
    return new google.maps.Marker({
      position,
      map,
      icon: icon ? {
        url: icon,
        scaledSize: new google.maps.Size(40, 40)
      } : undefined
    });
  }

  /**
   * Draw a route between two points
   */
  drawRoute(map: google.maps.Map, origin: google.maps.LatLngLiteral, destination: google.maps.LatLngLiteral): Promise<google.maps.DirectionsResult> {
    const directionsService = new google.maps.DirectionsService();
    const directionsRenderer = new google.maps.DirectionsRenderer({
      map,
      suppressMarkers: true
    });

    return new Promise((resolve, reject) => {
      directionsService.route(
        {
          origin,
          destination,
          travelMode: google.maps.TravelMode.DRIVING
        },
        (result: google.maps.DirectionsResult | null, status: google.maps.DirectionsStatus) => {
          if (status === google.maps.DirectionsStatus.OK && result) {
            directionsRenderer.setDirections(result);
            resolve(result);
          } else {
            reject(status);
          }
        }
      );
    });
  }
}
