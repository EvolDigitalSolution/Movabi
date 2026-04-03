import { Injectable } from '@angular/core';

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
      // @ts-ignore
      script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places`;
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
  createMap(element: HTMLElement, options: any): any {
    // @ts-ignore
    return new google.maps.Map(element, options);
  }

  /**
   * Add a marker to the map
   */
  addMarker(map: any, position: { lat: number, lng: number }, icon?: string): any {
    // @ts-ignore
    return new google.maps.Marker({
      position,
      map,
      icon: icon ? {
        url: icon,
        // @ts-ignore
        scaledSize: new google.maps.Size(40, 40)
      } : undefined
    });
  }

  /**
   * Draw a route between two points
   */
  drawRoute(map: any, origin: { lat: number, lng: number }, destination: { lat: number, lng: number }): Promise<any> {
    // @ts-ignore
    const directionsService = new google.maps.DirectionsService();
    // @ts-ignore
    const directionsRenderer = new google.maps.DirectionsRenderer({
      map,
      suppressMarkers: true
    });

    return new Promise((resolve, reject) => {
      directionsService.route(
        {
          origin,
          destination,
          // @ts-ignore
          travelMode: google.maps.TravelMode.DRIVING
        },
        (result: any, status: any) => {
          // @ts-ignore
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
