import { Component, inject, OnInit, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController, LoadingController, ToastController } from '@ionic/angular';
import { FormsModule } from '@angular/forms';
import { JobService } from '@core/services/job/job.service';
import { AuthService } from '@core/services/auth/auth.service';
import { ProfileService } from '@core/services/profile/profile.service';
import { MapService } from '@core/services/logistics/map.service';
import { LocationService } from '@core/services/logistics/location.service';
import { AppConfigService } from '@core/services/config/app-config.service';
import { AnalyticsService } from '@core/services/analytics/analytics.service';
import { JobEstimate, City, UnifiedLocation } from '@shared/models/booking.model';

import { ButtonComponent, CardComponent, PriceDisplayComponent } from '@shared/ui';

@Component({
  selector: 'app-create-job',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-4 bg-white">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer" text="" icon="chevron-back-outline" class="text-slate-900"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-xl text-slate-900">Book a Move</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="max-w-xl mx-auto p-6 space-y-8 pb-12">
        <!-- Map Section -->
        <div class="relative group">
          <div #mapContainer class="h-80 bg-slate-200 rounded-[2.5rem] overflow-hidden shadow-2xl shadow-slate-200/60 border-4 border-white transition-all group-hover:shadow-blue-600/10 group-hover:border-blue-50"></div>
          
          @if (!pickupLocation.latitude && !pickupLocation.address) {
            <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div class="bg-white/90 backdrop-blur-md px-8 py-4 rounded-3xl shadow-2xl border border-white/50 animate-bounce-slow">
                <p class="text-xs font-black text-blue-600 flex items-center uppercase tracking-widest">
                  <ion-icon name="pin" class="mr-2 text-lg"></ion-icon>
                  Tap map to set pickup
                </p>
              </div>
            </div>
          }
          
          <!-- Map Controls Overlay -->
          <div class="absolute bottom-6 right-6 flex flex-col gap-2">
            <button (click)="toggleLocationMode()" 
                    [class.bg-blue-600]="locationService.locationMode() === 'auto'"
                    [class.text-white]="locationService.locationMode() === 'auto'"
                    class="w-12 h-12 rounded-2xl bg-white/90 backdrop-blur-md flex items-center justify-center text-slate-600 shadow-xl border border-white hover:bg-white transition-all active:scale-95">
              <ion-icon [name]="locationService.locationMode() === 'auto' ? 'locate' : 'locate-outline'" class="text-xl"></ion-icon>
            </button>
            <button (click)="resetMap()" class="w-12 h-12 rounded-2xl bg-white/90 backdrop-blur-md flex items-center justify-center text-slate-600 shadow-xl border border-white hover:bg-white transition-all active:scale-95">
              <ion-icon name="refresh-outline" class="text-xl"></ion-icon>
            </button>
          </div>
        </div>

        @if (locationService.locationError()) {
          <div class="p-4 bg-amber-50 border border-amber-100 rounded-2xl flex items-center gap-3 text-amber-700 text-xs font-medium animate-in fade-in slide-in-from-top-2">
            <ion-icon name="information-circle-outline" class="text-lg shrink-0"></ion-icon>
            <div class="flex-1">
              <p>{{ locationService.locationError() }}</p>
              <button (click)="locationService.setManualMode()" class="text-blue-600 font-bold uppercase tracking-widest mt-1">Enter address manually</button>
            </div>
          </div>
        }

        <div class="space-y-8">
          <app-card>
            <div class="flex items-center gap-3 mb-8 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h2 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Route Details</h2>
            </div>

            <div class="space-y-6 relative">
              <!-- Vertical Line -->
              <div class="absolute left-6 top-10 bottom-10 w-0.5 bg-slate-100 dashed border-l-2 border-slate-200 border-dashed"></div>
              
              <div class="flex gap-5 items-start relative">
                <div class="w-12 h-12 rounded-2xl bg-blue-50 flex items-center justify-center shrink-0 border border-blue-100 shadow-sm">
                  <ion-icon name="location" class="text-blue-600 text-xl"></ion-icon>
                </div>
                <div class="flex-1 pt-1">
                  <p class="text-[10px] text-slate-400 uppercase font-bold tracking-[0.2em] mb-1.5">Pickup Location</p>
                  <input type="text" 
                         [(ngModel)]="pickupLocation.address" 
                         (blur)="onManualAddressChange('pickup')"
                         placeholder="Tap on map or type address"
                         class="w-full bg-transparent border-none p-0 text-sm font-bold text-slate-900 focus:ring-0 placeholder:text-slate-300" />
                  @if (getValidationError('pickup')) {
                    <p class="text-[10px] text-rose-500 font-bold mt-1 uppercase tracking-wider">{{ getValidationError('pickup') }}</p>
                  }
                </div>
              </div>

              <div class="flex gap-5 items-start relative">
                <div class="w-12 h-12 rounded-2xl bg-emerald-50 flex items-center justify-center shrink-0 border border-emerald-100 shadow-sm">
                  <ion-icon name="flag" class="text-emerald-600 text-xl"></ion-icon>
                </div>
                <div class="flex-1 pt-1">
                  <p class="text-[10px] text-slate-400 uppercase font-bold tracking-[0.2em] mb-1.5">Dropoff Location</p>
                  <input type="text" 
                         [(ngModel)]="dropoffLocation.address" 
                         (blur)="onManualAddressChange('dropoff')"
                         placeholder="Tap on map or type address"
                         class="w-full bg-transparent border-none p-0 text-sm font-bold text-slate-900 focus:ring-0 placeholder:text-slate-300" />
                  @if (getValidationError('dropoff')) {
                    <p class="text-[10px] text-rose-500 font-bold mt-1 uppercase tracking-wider">{{ getValidationError('dropoff') }}</p>
                  }
                </div>
              </div>
            </div>

            <div class="mt-10 pt-8 border-t border-slate-50">
              <h3 class="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-4 ml-1">Schedule Move</h3>
              <div class="flex items-center gap-4 p-5 bg-slate-50 rounded-[1.5rem] border border-slate-100 group focus-within:border-blue-200 transition-all">
                <div class="w-10 h-10 rounded-xl bg-white flex items-center justify-center text-blue-600 shadow-sm">
                  <ion-icon name="calendar-outline" class="text-xl"></ion-icon>
                </div>
                <ion-datetime-button datetime="datetime" class="font-bold text-slate-900"></ion-datetime-button>
                <ion-modal [keepContentsMounted]="true">
                  <ng-template>
                    <ion-datetime id="datetime" presentation="date-time" [(ngModel)]="scheduledTime"></ion-datetime>
                  </ng-template>
                </ion-modal>
              </div>
            </div>
          </app-card>

          @if (estimate) {
            <app-card>
              <div class="flex items-center gap-3 mb-8 ml-1">
                <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
                <h2 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Price Estimate</h2>
              </div>

              <div class="grid grid-cols-2 gap-4 mb-8">
                <div class="bg-blue-50/50 p-6 rounded-[2rem] border border-blue-100/50">
                  <p class="text-[10px] text-blue-600 uppercase font-bold tracking-widest mb-2">Estimated Price</p>
                  <app-price-display [total]="estimate.estimated_price"></app-price-display>
                </div>
                <div class="bg-slate-50 p-6 rounded-[2rem] border border-slate-100">
                  <p class="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-2">Total Distance</p>
                  <p class="text-2xl font-display font-bold text-slate-900">{{ estimate.estimated_distance.toFixed(1) }} <span class="text-xs font-sans text-slate-400 uppercase tracking-widest ml-1">km</span></p>
                </div>
              </div>

              <div class="space-y-6">
                <div class="p-6 bg-slate-50 rounded-[2rem] border border-slate-100">
                  <p class="text-[10px] text-slate-400 uppercase font-bold tracking-[0.2em] mb-6">Service Options</p>
                  
                  <div class="space-y-6">
                    <div class="flex items-center justify-between">
                      <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded-lg bg-white flex items-center justify-center text-slate-400 shadow-sm">
                          <ion-icon name="business-outline"></ion-icon>
                        </div>
                        <span class="text-sm font-bold text-slate-700">Select City</span>
                      </div>
                      <ion-select [(ngModel)]="selectedCityId" placeholder="Choose City" class="text-sm font-black text-blue-600 uppercase tracking-widest">
                        @for (city of cities; track city.id) {
                          <ion-select-option [value]="city.id">{{ city.name }}</ion-select-option>
                        }
                      </ion-select>
                    </div>
                    
                    <div class="flex items-center justify-between pt-6 border-t border-slate-200/50">
                      <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded-lg bg-white flex items-center justify-center text-slate-400 shadow-sm">
                          <ion-icon name="flash-outline"></ion-icon>
                        </div>
                        <div>
                          <p class="text-sm font-bold text-slate-900">Auto-Dispatch</p>
                          <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">Assign to nearest driver</p>
                        </div>
                      </div>
                      <ion-toggle [(ngModel)]="useAutoDispatch" color="primary"></ion-toggle>
                    </div>
                  </div>
                </div>
              </div>
            </app-card>
          }

          <div class="pt-6">
            <app-button 
              size="lg" 
              [disabled]="!estimate" 
              (clicked)="createJob()"
              class="w-full shadow-2xl shadow-blue-600/20"
            >
              Confirm Booking
            </app-button>
            <div class="flex items-center justify-center gap-2 mt-6">
              <ion-icon name="lock-closed" class="text-slate-300"></ion-icon>
              <p class="text-[10px] text-slate-400 font-bold uppercase tracking-[0.2em]">
                Secure Payment via Stripe
              </p>
            </div>
          </div>
        </div>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule, ButtonComponent, CardComponent, PriceDisplayComponent]
})
export class CreateJobPage implements OnInit {
  @ViewChild('mapContainer', { static: true }) mapContainer!: ElementRef;

  private jobService = inject(JobService);
  private auth = inject(AuthService);
  private profileService = inject(ProfileService);
  private mapService = inject(MapService);
  public locationService = inject(LocationService);
  private config = inject(AppConfigService);
  private analytics = inject(AnalyticsService);
  private nav = inject(NavController);
  private loadingCtrl = inject(LoadingController);
  private toastCtrl = inject(ToastController);

  pickupLocation: UnifiedLocation = { source: 'manual', address: '' };
  dropoffLocation: UnifiedLocation = { source: 'manual', address: '' };
  
  scheduledTime = new Date().toISOString();
  estimate: JobEstimate | null = null;
  map: google.maps.Map | null = null;
  cities: City[] = [];
  selectedCityId: string | null = null;
  useAutoDispatch = false;

  async ngOnInit() {
    await this.mapService.loadGoogleMaps();
    this.initMap();
    this.loadCities();
    this.trySetInitialView();
  }

  async trySetInitialView() {
    const center = await this.getInitialCenter();
    if (this.map) {
      this.map.setCenter(center);
      this.map.setZoom(14);
    }
  }

  private async getInitialCenter(): Promise<google.maps.LatLngLiteral> {
    // 1. Confirmed user-selected/manual/map location
    if (this.pickupLocation.latitude && this.pickupLocation.longitude) {
      return { lat: this.pickupLocation.latitude, lng: this.pickupLocation.longitude };
    }

    // 2. Current GPS location if available and allowed
    if (this.locationService.locationMode() === 'auto') {
      const pos = await this.locationService.getCurrentPosition();
      if (pos) {
        return { lat: pos.coords.latitude, lng: pos.coords.longitude };
      }
    }

    // 3. Selected country defaultCenter from AppConfigService
    // 4. UK default center as final fallback (already in AppConfigService as default)
    return this.config.currentCountry().defaultCenter;
  }

  toggleLocationMode() {
    if (this.locationService.locationMode() === 'auto') {
      this.locationService.setManualMode();
    } else {
      this.locationService.setAutoMode();
      this.trySetInitialView();
    }
  }

  resetMap() {
    this.pickupLocation = { source: 'manual', address: '' };
    this.dropoffLocation = { source: 'manual', address: '' };
    this.estimate = null;
    this.initMap();
    this.trySetInitialView();
  }

  async loadCities() {
    try {
      this.cities = await this.jobService.getCities();
    } catch (error) {
      console.error('Error loading cities:', error);
    }
  }

  initMap() {
    const defaultCenter = this.config.currentCountry().defaultCenter;
    this.map = this.mapService.createMap(this.mapContainer.nativeElement, {
      center: defaultCenter,
      zoom: 12,
      disableDefaultUI: true
    });

    this.map.addListener('click', (event: google.maps.MapMouseEvent) => {
      if (event.latLng) {
        const coords = { lat: event.latLng.lat(), lng: event.latLng.lng() };
        this.handleMapClick(coords);
      }
    });
  }

  async handleMapClick(coords: { lat: number, lng: number }) {
    if (!this.pickupLocation.latitude) {
      this.pickupLocation = this.locationService.normalizeLocation('map', coords, `Map Location (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`);
      this.mapService.addMarker(this.map!, coords, 'https://maps.google.com/mapfiles/ms/icons/blue-dot.png');
    } else if (!this.dropoffLocation.latitude) {
      this.dropoffLocation = this.locationService.normalizeLocation('map', coords, `Map Location (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`);
      this.mapService.addMarker(this.map!, coords, 'https://maps.google.com/mapfiles/ms/icons/green-dot.png');
      
      await this.mapService.drawRoute(this.map!, 
        { lat: this.pickupLocation.latitude!, lng: this.pickupLocation.longitude! }, 
        { lat: this.dropoffLocation.latitude!, lng: this.dropoffLocation.longitude! }
      );
      await this.calculatePrice();
    } else {
      // Reset and start new pickup
      this.resetMap();
      this.pickupLocation = this.locationService.normalizeLocation('map', coords, `Map Location (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`);
      this.mapService.addMarker(this.map!, coords, 'https://maps.google.com/mapfiles/ms/icons/blue-dot.png');
    }
  }

  onManualAddressChange(type: 'pickup' | 'dropoff') {
    if (type === 'pickup') {
      this.pickupLocation.source = 'manual';
      // Clear coords if address changed manually to ensure consistency
      // In a real app, we might trigger geocoding here
      this.pickupLocation.latitude = undefined;
      this.pickupLocation.longitude = undefined;
    } else {
      this.dropoffLocation.source = 'manual';
      this.dropoffLocation.latitude = undefined;
      this.dropoffLocation.longitude = undefined;
    }
    this.estimate = null;
  }

  async calculatePrice() {
    if (this.pickupLocation.latitude && this.dropoffLocation.latitude) {
      try {
        this.estimate = await this.jobService.calculatePrice(
          { lat: this.pickupLocation.latitude, lng: this.pickupLocation.longitude! },
          { lat: this.dropoffLocation.latitude, lng: this.dropoffLocation.longitude! }
        );
      } catch {
        const toast = await this.toastCtrl.create({ message: 'Failed to calculate price', duration: 2000, color: 'danger' });
        toast.present();
      }
    }
  }

  getValidationError(type: 'pickup' | 'dropoff'): string | null {
    const location = type === 'pickup' ? this.pickupLocation : this.dropoffLocation;
    return this.locationService.getLocationValidationMessage(location, type);
  }

  async createJob() {
    if (!this.locationService.isLocationValidForBooking(this.pickupLocation) || 
        !this.locationService.isLocationValidForBooking(this.dropoffLocation)) {
      const toast = await this.toastCtrl.create({ 
        message: 'Please provide valid pickup and dropoff locations.', 
        duration: 2000, 
        color: 'warning' 
      });
      toast.present();
      return;
    }

    const loading = await this.loadingCtrl.create({ message: 'Creating job...' });
    await loading.present();

    try {
      const user = this.auth.currentUser();
      const profile = this.profileService.profile();
      if (!user || !profile) throw new Error('User not found');

      const job = await this.jobService.createJob({
        tenant_id: profile.tenant_id,
        customer_id: user.id,
        pickup_address: this.pickupLocation.address || 'Pickup Location',
        pickup_lat: this.pickupLocation.latitude,
        pickup_lng: this.pickupLocation.longitude,
        dropoff_address: this.dropoffLocation.address || 'Dropoff Location',
        dropoff_lat: this.dropoffLocation.latitude,
        dropoff_lng: this.dropoffLocation.longitude,
        scheduled_time: this.scheduledTime,
        price: this.estimate?.estimated_price || null,
        estimated_distance: this.estimate?.estimated_distance,
        estimated_price: this.estimate?.estimated_price,
        status: 'pending',
        city_id: this.selectedCityId || undefined
      });

      // Track booking creation with source info
      const eventName = this.pickupLocation.source === 'gps' ? 'booking_created_with_gps' :
                        this.pickupLocation.source === 'map' ? 'booking_created_with_map_selection' :
                        'booking_created_with_manual_address';
      
      this.analytics.track(eventName, { 
        job_id: job.id, 
        pickup_source: this.pickupLocation.source,
        dropoff_source: this.dropoffLocation.source
      });

      if (this.useAutoDispatch) {
        await this.jobService.enqueueJob(job.id, profile.tenant_id, this.selectedCityId || undefined);
      }

      await loading.dismiss();
      this.nav.navigateForward(['/customer/van-moving/status', job.id]);
    } catch {
      await loading.dismiss();
      const toast = await this.toastCtrl.create({ message: 'Failed to create job', duration: 2000, color: 'danger' });
      toast.present();
    }
  }
}
