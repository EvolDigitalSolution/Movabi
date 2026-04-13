import { Component, inject, OnInit, ViewChild, signal, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, LoadingController, ToastController } from '@ionic/angular';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { addIcons } from 'ionicons';
import { 
  chevronBackOutline, 
  pin, 
  locate, 
  locateOutline, 
  refreshOutline, 
  informationCircleOutline, 
  location, 
  flag, 
  calendarOutline, 
  businessOutline, 
  flashOutline, 
  lockClosed,
  searchOutline,
  cubeOutline,
  homeOutline,
  storefrontOutline,
  layersOutline,
  shieldCheckmarkOutline,
  giftOutline,
  navigate,
  constructOutline
} from 'ionicons/icons';
import { JobService } from '@core/services/job/job.service';
import { AuthService } from '@core/services/auth/auth.service';
import { ProfileService } from '@core/services/profile/profile.service';
import { LocationService } from '@core/services/logistics/location.service';
import { AppConfigService } from '@core/services/config/app-config.service';
import { AnalyticsService } from '@core/services/analytics/analytics.service';
import { GeocodingService } from '@core/services/maps/geocoding.service';
import { RoutingService } from '@core/services/maps/routing.service';
import { FareCalculationService } from '@core/services/maps/fare-calculation.service';
import { JobEstimate, City, UnifiedLocation, ServiceTypeEnum } from '@shared/models/booking.model';
import { AutocompleteResult } from '@core/models/maps/route-result.model';
import { MapComponent } from '@shared/components/map/map.component';


import { ButtonComponent, CardComponent, PriceDisplayComponent, InputComponent } from '@shared/ui';

@Component({
  selector: 'app-create-job',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 bg-white">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-slate-900">Book a Move</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="flex flex-col h-full">
        <!-- Map Section -->
        <div class="w-full h-[35vh] relative z-10 shadow-lg">
          <app-map #map></app-map>
          
          @if (!pickupLocation.latitude && !pickupLocation.address) {
            <div class="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
              <div class="bg-white/90 backdrop-blur-md px-8 py-4 rounded-3xl shadow-2xl border border-white/50 animate-bounce-slow">
                <p class="text-[10px] font-black text-blue-600 flex items-center uppercase tracking-widest">
                  <ion-icon name="pin" class="mr-2 text-lg"></ion-icon>
                  Select locations below
                </p>
              </div>
            </div>
          }
          
          <!-- Map Controls Overlay -->
          <div class="absolute bottom-6 right-6 flex flex-col gap-2 z-20">
            <button (click)="toggleLocationMode()" 
                    [class.bg-blue-600]="locationService.locationMode() === 'auto'"
                    [class.text-white]="locationService.locationMode() === 'auto'"
                    class="w-10 h-10 rounded-xl bg-white/90 backdrop-blur-md flex items-center justify-center text-slate-600 shadow-xl border border-white hover:bg-white transition-all active:scale-95">
              <ion-icon [name]="locationService.locationMode() === 'auto' ? 'locate' : 'locate-outline'" class="text-lg"></ion-icon>
            </button>
            <button (click)="resetMap()" class="w-10 h-10 rounded-xl bg-white/90 backdrop-blur-md flex items-center justify-center text-slate-600 shadow-xl border border-white hover:bg-white transition-all active:scale-95">
              <ion-icon name="refresh-outline" class="text-lg"></ion-icon>
            </button>
          </div>
        </div>

        <!-- Form Section -->
        <div class="flex-1 bg-white rounded-t-[3rem] -mt-10 relative z-20 shadow-[0_-20px_40px_-15px_rgba(0,0,0,0.1)] p-8 overflow-y-auto">
          <div class="max-w-2xl mx-auto space-y-8 pb-32">
            
            <div class="flex items-center gap-5 p-2">
              <div class="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center text-slate-900 shadow-sm border border-slate-100">
                <ion-icon name="bus-outline" class="text-2xl"></ion-icon>
              </div>
              <div>
                <h2 class="text-2xl font-display font-bold text-slate-900 tracking-tight mb-0.5">Van Moving</h2>
                <p class="text-slate-400 font-medium text-sm">Professional help for your big moves.</p>
              </div>
            </div>

            @if (locationService.locationError()) {
              <div class="p-5 bg-amber-50 border border-amber-100 rounded-3xl flex items-center gap-4 text-amber-800 text-sm font-medium animate-in fade-in slide-in-from-top-2">
                <ion-icon name="information-circle-outline" class="text-2xl text-amber-500 shrink-0"></ion-icon>
                <div class="flex-1">
                  <p>{{ locationService.locationError() }}</p>
                  <button (click)="locationService.setManualMode()" class="text-blue-600 font-bold uppercase tracking-widest text-[10px] mt-2">Enter address manually</button>
                </div>
              </div>
            }

            <div class="space-y-8">
              <div class="space-y-6">
                <div class="relative">
                  <app-input 
                    label="Pickup Location" 
                    [(ngModel)]="pickupLocation.address" 
                    (input)="onAddressInput('pickup', $any($event).target.value)"
                    placeholder="Where should we pick up?"
                    icon="location-outline"
                    (focus)="showPickupResults.set(true)"
                    (blur)="hideResults('pickup')">
                    
                    <div class="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
                      <button (click)="useCurrentLocation('pickup')" 
                              class="p-2 rounded-xl bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors">
                        <ion-icon name="locate-outline"></ion-icon>
                      </button>
                    </div>

                    @if (showPickupResults() && pickupResults().length > 0) {
                      <div dropdown class="absolute z-[9999] left-0 right-0 top-[calc(100%+8px)] bg-white rounded-2xl shadow-2xl border border-slate-100 overflow-y-auto max-h-[280px] animate-in fade-in zoom-in-95 duration-200">
                        @for (result of pickupResults(); track result.label) {
                          <button type="button" 
                                  (mousedown)="selectResult('pickup', result)"
                                  class="w-full px-5 py-4 text-left hover:bg-slate-50 flex items-center gap-3 border-b border-slate-50 last:border-0 transition-colors">
                            <div class="w-9 h-9 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400 shrink-0">
                              <ion-icon name="location-outline" class="text-lg"></ion-icon>
                            </div>
                            <div class="flex-1 min-w-0">
                              <p class="text-sm font-bold text-slate-900 truncate">{{ result.label }}</p>
                              <p class="text-[9px] text-slate-400 truncate uppercase tracking-widest font-bold">Select Location</p>
                            </div>
                          </button>
                        }
                      </div>
                    }
                  </app-input>
                </div>

                <div class="relative">
                  <app-input 
                    label="Dropoff Location" 
                    [(ngModel)]="dropoffLocation.address" 
                    (input)="onAddressInput('dropoff', $any($event).target.value)"
                    placeholder="Where should we deliver?"
                    icon="pin-outline"
                    (focus)="showDropoffResults.set(true)"
                    (blur)="hideResults('dropoff')">

                    @if (showDropoffResults() && dropoffResults().length > 0) {
                      <div dropdown class="absolute z-[9999] left-0 right-0 top-[calc(100%+8px)] bg-white rounded-2xl shadow-2xl border border-slate-100 overflow-y-auto max-h-[280px] animate-in fade-in zoom-in-95 duration-200">
                        @for (result of dropoffResults(); track result.label) {
                          <button type="button" 
                                  (mousedown)="selectResult('dropoff', result)"
                                  class="w-full px-5 py-4 text-left hover:bg-slate-50 flex items-center gap-3 border-b border-slate-50 last:border-0 transition-colors">
                            <div class="w-9 h-9 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400 shrink-0">
                              <ion-icon name="pin-outline" class="text-lg"></ion-icon>
                            </div>
                            <div class="flex-1 min-w-0">
                              <p class="text-sm font-bold text-slate-900 truncate">{{ result.label }}</p>
                              <p class="text-[9px] text-slate-400 truncate uppercase tracking-widest font-bold">Select Destination</p>
                            </div>
                          </button>
                        }
                      </div>
                    }
                  </app-input>
                </div>
              </div>

              <div class="p-6 bg-slate-50 rounded-3xl border border-slate-100 space-y-6">
                <div class="space-y-2">
                  <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Schedule Move</p>
                  <div class="flex items-center gap-4 p-5 bg-white rounded-2xl border border-slate-100 shadow-sm group focus-within:border-blue-200 transition-all">
                    <div class="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center text-blue-600 border border-slate-100">
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

                <div class="space-y-6 pt-4 border-t border-slate-200/50">
                  <div class="flex items-center justify-between pt-6 border-t border-slate-200/50">
                    <div class="flex items-center gap-3">
                      <div class="w-10 h-10 rounded-xl bg-white flex items-center justify-center text-slate-400 border border-slate-100 shadow-sm">
                        <ion-icon name="flash-outline" class="text-xl"></ion-icon>
                      </div>
                      <div>
                        <p class="text-sm font-bold text-slate-900 uppercase tracking-tighter">Auto-Dispatch</p>
                        <p class="text-[9px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">Assign to nearest driver</p>
                      </div>
                    </div>
                    <ion-toggle [(ngModel)]="useAutoDispatch" color="primary"></ion-toggle>
                  </div>
                </div>
              </div>

              <!-- Move Details Section -->
              <div class="space-y-6">
                <div class="flex items-center gap-3 px-2">
                  <div class="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600">
                    <ion-icon name="construct-outline" class="text-lg"></ion-icon>
                  </div>
                  <h3 class="text-lg font-display font-bold text-slate-900">Move Details</h3>
                </div>

                <div class="p-6 bg-slate-50 rounded-3xl border border-slate-100 space-y-8">
                  <!-- Move Size -->
                  <div class="space-y-3">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Move Size</p>
                    <div class="grid grid-cols-2 gap-3">
                      @for (size of moveSizes; track size.id) {
                        <button (click)="moveDetails.size = size.id; calculateRouteAndPrice()"
                                [class.bg-blue-600]="moveDetails.size === size.id"
                                [class.text-white]="moveDetails.size === size.id"
                                [class.bg-white]="moveDetails.size !== size.id"
                                [class.text-slate-600]="moveDetails.size !== size.id"
                                class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-slate-100 shadow-sm transition-all active:scale-95">
                          <ion-icon [name]="size.icon" class="text-xl"></ion-icon>
                          <span class="text-[10px] font-bold uppercase tracking-tight">{{ size.label }}</span>
                        </button>
                      }
                    </div>
                  </div>

                  <!-- Helpers & Floor -->
                  <div class="grid grid-cols-2 gap-4">
                    <app-input 
                      label="Helpers" 
                      type="number" 
                      [(ngModel)]="moveDetails.helperCount"
                      (ngModelChange)="calculateRouteAndPrice()"
                      icon="people-outline">
                    </app-input>
                    <app-input 
                      label="Floor Number" 
                      type="number" 
                      [(ngModel)]="moveDetails.floorNumber"
                      icon="business-outline">
                    </app-input>
                  </div>

                  <!-- Toggles -->
                  <div class="space-y-3">
                    <div class="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-100 shadow-sm">
                      <div class="flex items-center gap-3">
                        <ion-icon name="business-outline" class="text-blue-600"></ion-icon>
                        <span class="text-xs font-bold text-slate-700">Has Elevator?</span>
                      </div>
                      <ion-toggle [(ngModel)]="moveDetails.hasElevator" (ionChange)="calculateRouteAndPrice()" color="primary"></ion-toggle>
                    </div>
                    <div class="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-100 shadow-sm">
                      <div class="flex items-center gap-3">
                        <ion-icon name="layers-outline" class="text-blue-600"></ion-icon>
                        <span class="text-xs font-bold text-slate-700">Stairs Involved?</span>
                      </div>
                      <ion-toggle [(ngModel)]="moveDetails.stairsInvolved" (ionChange)="calculateRouteAndPrice()" color="primary"></ion-toggle>
                    </div>
                    <div class="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-100 shadow-sm">
                      <div class="flex items-center gap-3">
                        <ion-icon name="shield-checkmark-outline" class="text-blue-600"></ion-icon>
                        <span class="text-xs font-bold text-slate-700">Fragile Items?</span>
                      </div>
                      <ion-toggle [(ngModel)]="moveDetails.fragileItems" (ionChange)="calculateRouteAndPrice()" color="primary"></ion-toggle>
                    </div>
                    <div class="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-100 shadow-sm">
                      <div class="flex items-center gap-3">
                        <ion-icon name="gift-outline" class="text-blue-600"></ion-icon>
                        <span class="text-xs font-bold text-slate-700">Packing Help?</span>
                      </div>
                      <ion-toggle [(ngModel)]="moveDetails.packingAssistance" (ionChange)="calculateRouteAndPrice()" color="primary"></ion-toggle>
                    </div>
                  </div>

                  <!-- Summary -->
                  <div class="space-y-2">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Item Summary</p>
                    <textarea 
                      [(ngModel)]="moveDetails.itemSummary" 
                      placeholder="List major items (e.g. Bed, Sofa, Fridge...)"
                      class="w-full px-5 py-4 rounded-2xl bg-white border border-slate-100 text-slate-900 text-sm font-bold focus:outline-none focus:ring-4 focus:ring-blue-600/5 focus:border-blue-500 transition-all min-h-[100px] placeholder:text-slate-300 shadow-sm">
                    </textarea>
                  </div>
                </div>
              </div>

              @if (estimate) {
                <div class="animate-in fade-in slide-in-from-bottom-4 space-y-4">
                  <app-price-display 
                    [total]="estimate.estimated_price"
                    [showBreakdown]="false">
                  </app-price-display>
                  
                  <div class="p-5 bg-blue-50/50 rounded-2xl border border-blue-100/50 flex items-center justify-between">
                    <div class="flex items-center gap-3">
                      <div class="w-8 h-8 rounded-lg bg-white flex items-center justify-center text-blue-600 shadow-sm">
                        <ion-icon name="navigate" class="text-lg"></ion-icon>
                      </div>
                      <span class="text-[10px] font-bold text-blue-600 uppercase tracking-widest">Total Distance</span>
                    </div>
                    <p class="text-lg font-display font-bold text-slate-900">
                      {{ estimate.estimated_distance.toFixed(1) }} <span class="text-xs font-sans text-slate-400 uppercase tracking-widest ml-1">km</span>
                    </p>
                  </div>
                </div>
              } @else if (pickupLocation.address && dropoffLocation.address) {
                <div class="p-5 bg-amber-50 border border-amber-100 rounded-3xl flex items-center gap-4 text-amber-800 text-sm font-medium">
                  <ion-icon name="information-circle-outline" class="text-2xl text-amber-500 shrink-0"></ion-icon>
                  <p>Price will be confirmed by your driver after booking.</p>
                </div>
              }

              <div class="pt-6">
                <app-button 
                  size="lg" 
                  [disabled]="!isFormValid() || submitting()" 
                  (clicked)="createJob()"
                  class="w-full shadow-xl shadow-blue-200"
                >
                  Confirm Booking
                </app-button>
                <p class="text-center text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-8 flex items-center justify-center gap-2">
                  <ion-icon name="lock-closed" class="text-emerald-500 text-sm"></ion-icon>
                  Secure payment via Stripe
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule, ButtonComponent, CardComponent, PriceDisplayComponent, MapComponent, InputComponent]
})
export class CreateJobPage implements OnInit {
  @ViewChild('map') mapComponent!: MapComponent;

  private jobService = inject(JobService);
  private auth = inject(AuthService);
  private profileService = inject(ProfileService);
  public locationService = inject(LocationService);
  private config = inject(AppConfigService);
  private analytics = inject(AnalyticsService);
  private router = inject(Router);
  private loadingCtrl = inject(LoadingController);
  private toastCtrl = inject(ToastController);
  private geocoding = inject(GeocodingService);
  private routing = inject(RoutingService);
  private fareCalculator = inject(FareCalculationService);
  private destroyRef = inject(DestroyRef);

  private pickupSearch$ = new Subject<string>();
  private dropoffSearch$ = new Subject<string>();

  pickupLocation: UnifiedLocation = { source: 'manual', address: '' };
  dropoffLocation: UnifiedLocation = { source: 'manual', address: '' };
  
  scheduledTime = new Date().toISOString();
  estimate: JobEstimate | null = null;
  cities: City[] = [];
  selectedCityId: string | null = null;
  useAutoDispatch = false;
  submitting = signal(false);

  // Move Details
  moveDetails = {
    size: 'small',
    helperCount: 1,
    hasElevator: false,
    stairsInvolved: false,
    floorNumber: 0,
    fragileItems: false,
    packingAssistance: false,
    itemSummary: '',
    notes: ''
  };

  moveSizes = [
    { id: 'small', label: 'Small (Few items)', icon: 'cube-outline' },
    { id: 'medium', label: 'Medium (1-2 rooms)', icon: 'business-outline' },
    { id: 'large', label: 'Large (3-4 rooms)', icon: 'home-outline' },
    { id: 'full-house', label: 'Full House', icon: 'storefront-outline' }
  ];

  pickupResults = signal<AutocompleteResult[]>([]);
  dropoffResults = signal<AutocompleteResult[]>([]);
  showPickupResults = signal(false);
  showDropoffResults = signal(false);

  constructor() {
    addIcons({ 
      chevronBackOutline, 
      pin, 
      locate, 
      locateOutline, 
      refreshOutline, 
      informationCircleOutline, 
      location, 
      flag, 
      calendarOutline, 
      businessOutline, 
      flashOutline, 
      lockClosed,
      searchOutline,
      cubeOutline,
      homeOutline,
      storefrontOutline,
      layersOutline,
      shieldCheckmarkOutline,
      giftOutline,
      navigate,
      constructOutline
    });
  }

  async ngOnInit() {
    this.loadCities();
    this.trySetInitialView();

    this.pickupSearch$.pipe(
      debounceTime(400),
      distinctUntilChanged(),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(query => {
      this.performSearch('pickup', query);
    });

    this.dropoffSearch$.pipe(
      debounceTime(400),
      distinctUntilChanged(),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(query => {
      this.performSearch('dropoff', query);
    });
  }

  async trySetInitialView() {
    const center = await this.getInitialCenter();
    if (this.mapComponent) {
      this.mapComponent.setCenter(center.lng, center.lat, 14);
    }
  }

  private async getInitialCenter(): Promise<{ lat: number, lng: number }> {
    if (this.pickupLocation.latitude && this.pickupLocation.longitude) {
      return { lat: this.pickupLocation.latitude, lng: this.pickupLocation.longitude };
    }

    if (this.locationService.locationMode() === 'auto') {
      const pos = await this.locationService.getCurrentPosition();
      if (pos) {
        return { lat: pos.coords.latitude, lng: pos.coords.longitude };
      }
    }

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
    this.mapComponent.clearRoute();
    this.mapComponent.removeMarker('pickup');
    this.mapComponent.removeMarker('dropoff');
    this.trySetInitialView();
  }

  async loadCities() {
    try {
      this.cities = await this.jobService.getCities();
      if (this.cities.length > 0 && !this.selectedCityId) {
        this.selectedCityId = this.cities[0].id;
      }
    } catch (error) {
      console.error('Error loading cities:', error);
    }
  }

  async useCurrentLocation(type: 'pickup' | 'dropoff') {
    const pos = await this.locationService.getCurrentPosition();
    if (pos) {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      
      this.geocoding.reverseGeocode(lat, lng).subscribe(address => {
        if (type === 'pickup') {
          this.pickupLocation = this.locationService.normalizeLocation('gps', { lat, lng }, address);
          this.updateMarker('pickup');
        } else {
          this.dropoffLocation = this.locationService.normalizeLocation('gps', { lat, lng }, address);
          this.updateMarker('dropoff');
        }
        this.calculateRouteAndPrice();
      });
    }
  }

  onAddressInput(type: 'pickup' | 'dropoff', query: string) {
    if (type === 'pickup') {
      this.pickupSearch$.next(query);
    } else {
      this.dropoffSearch$.next(query);
    }
  }

  private performSearch(type: 'pickup' | 'dropoff', query: string) {
    if (!query || query.length < 3) {
      if (type === 'pickup') {
        this.pickupResults.set([]);
        this.showPickupResults.set(false);
      } else {
        this.dropoffResults.set([]);
        this.showDropoffResults.set(false);
      }
      return;
    }

    this.geocoding.autocomplete(query).subscribe(results => {
      if (type === 'pickup') {
        this.pickupResults.set(results);
        this.showPickupResults.set(true);
      } else {
        this.dropoffResults.set(results);
        this.showDropoffResults.set(true);
      }
    });
  }

  selectResult(type: 'pickup' | 'dropoff', result: AutocompleteResult) {
    if (type === 'pickup') {
      this.pickupLocation = this.locationService.normalizeLocation('map', { lat: result.lat, lng: result.lng }, result.label);
      this.showPickupResults.set(false);
      this.updateMarker('pickup');
    } else {
      this.dropoffLocation = this.locationService.normalizeLocation('map', { lat: result.lat, lng: result.lng }, result.label);
      this.showDropoffResults.set(false);
      this.updateMarker('dropoff');
    }
    this.calculateRouteAndPrice();
  }

  hideResults(type: 'pickup' | 'dropoff') {
    setTimeout(() => {
      if (type === 'pickup') this.showPickupResults.set(false);
      else this.showDropoffResults.set(false);
    }, 250);
  }

  updateMarker(type: 'pickup' | 'dropoff') {
    const loc = type === 'pickup' ? this.pickupLocation : this.dropoffLocation;
    if (loc.latitude && loc.longitude) {
      this.mapComponent.addOrUpdateMarker({
        id: type,
        coordinates: { lat: loc.latitude, lng: loc.longitude },
        kind: type === 'pickup' ? 'pickup' : 'destination',
        serviceType: ServiceTypeEnum.VAN,
        label: type === 'pickup' ? 'PICKUP' : 'DROPOFF'
      });
      this.mapComponent.setCenter(loc.longitude, loc.latitude);
    }
  }

  async calculateRouteAndPrice() {
    // If we have addresses but no coordinates, try to geocode them first
    if (this.pickupLocation.address && (!this.pickupLocation.latitude || isNaN(this.pickupLocation.latitude))) {
      const results = await this.geocoding.autocomplete(this.pickupLocation.address).toPromise();
      if (results && results.length > 0) {
        this.pickupLocation.latitude = results[0].lat;
        this.pickupLocation.longitude = results[0].lng;
        this.updateMarker('pickup');
      }
    }

    if (this.dropoffLocation.address && (!this.dropoffLocation.latitude || isNaN(this.dropoffLocation.latitude))) {
      const results = await this.geocoding.autocomplete(this.dropoffLocation.address).toPromise();
      if (results && results.length > 0) {
        this.dropoffLocation.latitude = results[0].lat;
        this.dropoffLocation.longitude = results[0].lng;
        this.updateMarker('dropoff');
      }
    }

    if (this.pickupLocation.latitude && this.pickupLocation.longitude && 
        this.dropoffLocation.latitude && this.dropoffLocation.longitude) {
      const pickup = { lat: this.pickupLocation.latitude, lng: this.pickupLocation.longitude };
      const dropoff = { lat: this.dropoffLocation.latitude, lng: this.dropoffLocation.longitude };

      // Defensive guard against NaN coordinates
      if (isNaN(pickup.lat) || isNaN(pickup.lng) || isNaN(dropoff.lat) || isNaN(dropoff.lng)) {
        console.warn('[CreateJob] Invalid coordinates for route calculation', { pickup, dropoff });
        return;
      }

      this.routing.getRoute(pickup, dropoff).subscribe({
        next: (route) => {
          if (route) {
            this.mapComponent.drawRoute(route);
            
            // Fit bounds with mobile-safe padding
            this.mapComponent.fitBounds([
              [pickup.lng, pickup.lat],
              [dropoff.lng, dropoff.lat]
            ], { padding: { top: 80, bottom: 320, left: 50, right: 50 } });

            this.calculatePrice(route.distanceMeters / 1000, route.durationSeconds);
          } else {
            this.fallbackEstimate(pickup, dropoff);
          }
        },
        error: () => {
          this.fallbackEstimate(pickup, dropoff);
        }
      });
    }
  }

  private fallbackEstimate(pickup: {lat: number, lng: number}, dropoff: {lat: number, lng: number}) {
    this.toastCtrl.create({ message: 'Could not calculate route. Using direct distance.', duration: 3000 }).then(t => t.present());
    // Fallback to direct distance if routing fails
    const directDist = this.locationService.calculateDistance(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
    this.calculatePrice(directDist, directDist * 2 * 60); // directDist is Km, duration in seconds (rough estimate: 2 mins per km)
  }

  async calculatePrice(distanceKm: number, durationSec: number) {
    try {
      const fare = this.fareCalculator.calculateFare({
        serviceType: 'van-moving',
        distanceMeters: distanceKm * 1000,
        durationSeconds: durationSec,
        moveDetails: {
          size: this.moveDetails.size as 'small' | 'medium' | 'large' | 'full-house',
          helperCount: this.moveDetails.helperCount,
          stairsInvolved: this.moveDetails.stairsInvolved,
          packingAssistance: this.moveDetails.packingAssistance,
          fragileItems: this.moveDetails.fragileItems
        }
      });

      this.estimate = {
        estimated_price: fare.total,
        estimated_distance: distanceKm,
        estimated_duration: durationSec / 60,
        pickup_lat: this.pickupLocation.latitude!,
        pickup_lng: this.pickupLocation.longitude!,
        dropoff_lat: this.dropoffLocation.latitude!,
        dropoff_lng: this.dropoffLocation.longitude!
      };
    } catch (error) {
      console.error('Fare calculation error:', error);
    }
  }

  onManualAddressChange() {
    // This is handled by onAddressInput now
  }

  getValidationError(type: 'pickup' | 'dropoff'): string | null {
    const location = type === 'pickup' ? this.pickupLocation : this.dropoffLocation;
    return this.locationService.getLocationValidationMessage(location, type);
  }

  isFormValid(): boolean {
    return this.locationService.isLocationValidForBooking(this.pickupLocation) && 
           this.locationService.isLocationValidForBooking(this.dropoffLocation);
  }

  async createJob() {
    if (this.submitting()) return;

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

    this.submitting.set(true);
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
        currency_code: profile.currency_code || this.config.currencyCode,
        country_code: profile.country_code || this.config.currentCountry().code,
        status: 'pending',
        city_id: this.selectedCityId || undefined,
        metadata: {
          move_details: this.moveDetails
        }
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
      this.router.navigate(['/customer/van-moving/status', job.id]);
    } catch (error: unknown) {
      await loading.dismiss();
      this.submitting.set(false);
      const message = error instanceof Error ? error.message : 'Failed to create job';
      const toast = await this.toastCtrl.create({ message, duration: 3000, color: 'danger' });
      toast.present();
    }
  }
}
