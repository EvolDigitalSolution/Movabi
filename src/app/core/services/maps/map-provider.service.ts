import { Injectable, inject } from '@angular/core';
import { environment } from '@env/environment';
import { MapConfig } from '../../models/maps/map-config.model';
import { AppConfigService } from '../config/app-config.service';

@Injectable({
  providedIn: 'root'
})
export class MapProviderService {
  private appConfig = inject(AppConfigService);
  
  private config: MapConfig = {
    provider: environment.mapProvider || 'maptiler',
    styleUrl: environment.mapStyleUrl || 'https://api.maptiler.com/maps/streets-v2/style.json?key={key}',
    apiKey: environment.mapApiKey,
    defaultCenter: [environment.defaultMapCenterLng, environment.defaultMapCenterLat],
    defaultZoom: environment.defaultMapZoom || 12
  };

  getMapConfig(): MapConfig {
    const country = this.appConfig.currentCountry();
    return { 
      ...this.config,
      defaultCenter: [country.defaultCenter.lng, country.defaultCenter.lat]
    };
  }

  getStyleUrl(): string {
    const styleUrl = this.config.styleUrl || '';
    const apiKey = this.config.apiKey || '';
    
    if (!styleUrl) {
      console.warn('Map style URL is missing.');
      return '';
    }

    // Ensure we don't pass a template string with {key} to MapLibre
    return styleUrl.replace('{key}', apiKey);
  }

  hasMapConfig(): boolean {
    return !!this.config.apiKey && !!this.config.styleUrl;
  }

  hasRoutingConfig(): boolean {
    return !!this.getOpenRouteServiceApiKey();
  }

  getOpenRouteServiceApiKey(): string {
    return environment.openRouteServiceApiKey || '';
  }

  getDriverLiveUpdateIntervalMs(): number {
    return (environment as Record<string, unknown>)['driverLiveUpdateIntervalMs'] as number || 4000;
  }

  getRouteRecalcDebounceMs(): number {
    return (environment as Record<string, unknown>)['routeRecalcDebounceMs'] as number || 350;
  }
}
