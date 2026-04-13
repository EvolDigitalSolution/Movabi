import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { mapOutline, alertCircleOutline, swapHorizontalOutline, closeCircleOutline } from 'ionicons/icons';
import { MapRendererService } from '../../../core/services/maps/map-renderer.service';
import { AppConfigService } from '../../../core/services/config/app-config.service';
import { MarkerOptions } from '../../../core/models/maps/map-marker.model';
import { RouteSummary } from '../../../core/models/maps/route-result.model';

@Component({
  selector: 'app-map',
  standalone: true,
  imports: [CommonModule, IonicModule],
  template: `
    <div class="w-full h-full relative">
      <div #mapContainer class="map-container w-full h-full min-h-[300px] relative overflow-hidden" [class.opacity-0]="!mapReady()"></div>
      
      @if (!mapReady() && !initializing()) {
        <div class="absolute inset-0 flex flex-col items-center justify-center bg-slate-50 text-slate-400 p-6 text-center animate-in fade-in duration-500">
          <ion-icon name="map-outline" class="text-6xl mb-4 opacity-20"></ion-icon>
          <h3 class="text-slate-900 font-display font-bold text-lg mb-2">Map unavailable right now</h3>
          <p class="text-sm max-w-[240px]">We're having trouble loading the interactive map. You can still continue with your booking.</p>
        </div>
      }

      @if (initializing()) {
        <div class="absolute inset-0 flex items-center justify-center bg-slate-50/50 backdrop-blur-sm z-50">
          <ion-spinner name="crescent" color="primary"></ion-spinner>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }
    .map-container { background: #f8fafc; }
    
    ::ng-deep .movabi-marker {
      cursor: pointer;
      z-index: 10;
    }
    
    ::ng-deep .movabi-marker__wrapper {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    
    ::ng-deep .movabi-marker__pin {
      width: 38px;
      height: 38px;
      border-radius: 50% 50% 50% 0;
      background: var(--marker-color, #2563eb);
      position: relative;
      transform: rotate(-45deg);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 8px 16px -4px rgb(0 0 0 / 0.2);
      border: 2.5px solid white;
      transition: transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    
    ::ng-deep .movabi-marker:hover .movabi-marker__pin {
      transform: rotate(-45deg) scale(1.1);
    }
    
    ::ng-deep .movabi-marker__icon {
      transform: rotate(45deg);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    ::ng-deep .movabi-marker__label {
      background: white;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 10px;
      font-weight: 700;
      color: #0f172a;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-top: 6px;
      box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
      border: 1px solid #f1f5f9;
      white-space: nowrap;
    }
    
    ::ng-deep .movabi-marker--ride { --marker-color: #2563eb; }
    ::ng-deep .movabi-marker--errand { --marker-color: #10b981; }
    ::ng-deep .movabi-marker--van-moving { --marker-color: #f59e0b; }
    
    ::ng-deep .movabi-marker--driver .movabi-marker__pin {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      transform: none;
    }
    
    ::ng-deep .movabi-marker--driver .movabi-marker__icon {
      transform: none;
    }
    
    ::ng-deep .movabi-marker__pulse {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 40px;
      height: 40px;
      background: var(--marker-color, #2563eb);
      border-radius: 50%;
      opacity: 0.2;
      animation: movabi-pulse 2s infinite;
    }
    
    @keyframes movabi-pulse {
      0% { transform: translate(-50%, -50%) scale(0.8); opacity: 0.4; }
      100% { transform: translate(-50%, -50%) scale(2.5); opacity: 0; }
    }
  `]
})
export class MapComponent implements OnInit, OnDestroy {
  @ViewChild('mapContainer', { static: true }) mapContainer!: ElementRef;
  
  private mapRenderer = inject(MapRendererService);
  private config = inject(AppConfigService);

  mapReady = signal(false);
  initializing = signal(true);

  constructor() {
    addIcons({ 
      mapOutline, 
      alertCircleOutline, 
      swapHorizontalOutline, 
      closeCircleOutline 
    });
  }

  ngOnInit() {
    setTimeout(() => {
      const map = this.mapRenderer.initMap(this.mapContainer.nativeElement);
      this.initializing.set(false);
      if (map) {
        this.mapReady.set(true);
      }
    }, 0);
  }

  ngOnDestroy() {
    this.mapRenderer.destroyMap();
  }

  addOrUpdateMarker(options: MarkerOptions) {
    this.mapRenderer.addOrUpdateMarker(options);
  }

  removeMarker(id: string) {
    this.mapRenderer.removeMarker(id);
  }

  drawRoute(route: RouteSummary) {
    this.mapRenderer.drawRoute(route);
  }

  clearRoute() {
    this.mapRenderer.clearRoute();
  }

  setCenter(lng: number, lat: number, zoom?: number) {
    this.mapRenderer.setCenter(lng, lat, zoom);
  }

  fitBounds(bounds: [[number, number], [number, number]], options?: unknown) {
    this.mapRenderer.fitBounds(bounds, options);
  }

  resize() {
    this.mapRenderer.resize();
  }
}
