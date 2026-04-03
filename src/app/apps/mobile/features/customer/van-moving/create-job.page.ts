import { Component, inject, OnInit, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController, LoadingController, ToastController } from '@ionic/angular';
import { FormsModule } from '@angular/forms';
import { JobService } from '@core/services/job/job.service';
import { AuthService } from '@core/services/auth/auth.service';
import { ProfileService } from '@core/services/profile/profile.service';
import { MapService } from '@core/services/logistics/map.service';

@Component({
  selector: 'app-create-job',
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer"></ion-back-button>
        </ion-buttons>
        <ion-title>Book a Move</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <div class="max-w-lg mx-auto">
        <div #mapContainer class="h-64 bg-gray-200 rounded-3xl mb-6 overflow-hidden shadow-inner border border-gray-100"></div>

        <div class="space-y-6">
          <div class="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            <h3 class="text-lg font-bold mb-4">Route</h3>
            <div class="space-y-4">
              <div class="p-4 bg-gray-50 rounded-xl border border-gray-100">
                <p class="text-xs text-gray-400 uppercase font-bold tracking-widest mb-1">Pickup</p>
                <p class="text-sm">{{ pickupAddress || 'Click map to set pickup' }}</p>
              </div>
              <div class="p-4 bg-gray-50 rounded-xl border border-gray-100">
                <p class="text-xs text-gray-400 uppercase font-bold tracking-widest mb-1">Dropoff</p>
                <p class="text-sm">{{ dropoffAddress || 'Click map to set dropoff' }}</p>
              </div>
            </div>

            <h3 class="text-lg font-bold mt-6 mb-4">Schedule</h3>
            <ion-item lines="none" class="bg-gray-50 rounded-xl mb-4">
              <ion-icon name="calendar" slot="start" color="warning"></ion-icon>
              <ion-datetime-button datetime="datetime"></ion-datetime-button>
              <ion-modal [keepContentsMounted]="true">
                <ng-template>
                  <ion-datetime id="datetime" presentation="date-time" [(ngModel)]="scheduledTime"></ion-datetime>
                </ng-template>
              </ion-modal>
            </ion-item>

            @if (estimate) {
              <h3 class="text-lg font-bold mt-6 mb-4">Estimated Price</h3>
              <div class="bg-blue-50 p-6 rounded-2xl border border-blue-100 flex justify-between items-center">
                <div>
                  <p class="text-xs text-blue-600 uppercase font-bold tracking-widest">Total Estimate</p>
                  <p class="text-2xl font-bold text-blue-900">£{{ estimate.estimated_price }}</p>
                </div>
                <div class="text-right">
                  <p class="text-xs text-blue-600 uppercase font-bold tracking-widest">Distance</p>
                  <p class="text-lg font-bold text-blue-900">{{ estimate.estimated_distance.toFixed(1) }} km</p>
                </div>
              </div>

              <h3 class="text-lg font-bold mt-6 mb-4">Service Options</h3>
              <div class="bg-gray-50 p-6 rounded-2xl border border-gray-100 space-y-4">
                <ion-item lines="none" class="bg-transparent">
                  <ion-label>Select City</ion-label>
                  <ion-select [(ngModel)]="selectedCityId" placeholder="Choose City">
                    @for (city of cities; track city.id) {
                      <ion-select-option [value]="city.id">{{ city.name }}</ion-select-option>
                    }
                  </ion-select>
                </ion-item>
                
                <ion-item lines="none" class="bg-transparent">
                  <ion-label>
                    <h2 class="font-bold">Auto-Dispatch</h2>
                    <p class="text-xs text-gray-400">Assign to nearest driver automatically</p>
                  </ion-label>
                  <ion-toggle [(ngModel)]="useAutoDispatch" slot="end" color="primary"></ion-toggle>
                </ion-item>
              </div>
            }
          </div>

          <ion-button expand="block" size="large" class="rounded-2xl font-bold" [disabled]="!estimate" (click)="createJob()">
            Confirm Booking
          </ion-button>
        </div>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule]
})
export class CreateJobPage implements OnInit {
  @ViewChild('mapContainer', { static: true }) mapContainer!: ElementRef;

  private jobService = inject(JobService);
  private auth = inject(AuthService);
  private profileService = inject(ProfileService);
  private mapService = inject(MapService);
  private nav = inject(NavController);
  private loadingCtrl = inject(LoadingController);
  private toastCtrl = inject(ToastController);

  pickupAddress = '';
  dropoffAddress = '';
  pickupCoords: { lat: number, lng: number } | null = null;
  dropoffCoords: { lat: number, lng: number } | null = null;
  scheduledTime = new Date().toISOString();
  estimate: any = null;
  map: any;
  cities: any[] = [];
  selectedCityId: string | null = null;
  useAutoDispatch = false;

  async ngOnInit() {
    await this.mapService.loadGoogleMaps();
    this.initMap();
    this.loadCities();
  }

  async loadCities() {
    try {
      this.cities = await this.jobService.getCities();
    } catch (error) {
      console.error('Error loading cities:', error);
    }
  }

  initMap() {
    this.map = this.mapService.createMap(this.mapContainer.nativeElement, {
      center: { lat: 51.5074, lng: -0.1278 }, // London
      zoom: 12,
      disableDefaultUI: true
    });

    this.map.addListener('click', (event: any) => {
      const coords = { lat: event.latLng.lat(), lng: event.latLng.lng() };
      this.handleMapClick(coords);
    });
  }

  async handleMapClick(coords: { lat: number, lng: number }) {
    if (!this.pickupCoords) {
      this.pickupCoords = coords;
      this.pickupAddress = `Location (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`;
      this.mapService.addMarker(this.map, coords, 'https://maps.google.com/mapfiles/ms/icons/blue-dot.png');
    } else if (!this.dropoffCoords) {
      this.dropoffCoords = coords;
      this.dropoffAddress = `Location (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`;
      this.mapService.addMarker(this.map, coords, 'https://maps.google.com/mapfiles/ms/icons/green-dot.png');
      
      await this.mapService.drawRoute(this.map, this.pickupCoords, this.dropoffCoords);
      await this.calculatePrice();
    } else {
      // Reset
      this.pickupCoords = coords;
      this.dropoffCoords = null;
      this.estimate = null;
      this.pickupAddress = `Location (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`;
      this.dropoffAddress = '';
      this.initMap(); // Simple reset
      this.mapService.addMarker(this.map, coords, 'https://maps.google.com/mapfiles/ms/icons/blue-dot.png');
    }
  }

  async calculatePrice() {
    if (this.pickupCoords && this.dropoffCoords) {
      try {
        this.estimate = await this.jobService.calculatePrice(this.pickupCoords, this.dropoffCoords);
      } catch (error) {
        const toast = await this.toastCtrl.create({ message: 'Failed to calculate price', duration: 2000, color: 'danger' });
        toast.present();
      }
    }
  }

  async createJob() {
    if (!this.pickupCoords || !this.dropoffCoords || !this.estimate) return;

    const loading = await this.loadingCtrl.create({ message: 'Creating job...' });
    await loading.present();

    try {
      const user = this.auth.currentUser();
      const profile = this.profileService.profile();
      if (!user || !profile) throw new Error('User not found');

      const job = await this.jobService.createJob({
        tenant_id: profile.tenant_id,
        customer_id: user.id,
        pickup_address: this.pickupAddress,
        pickup_lat: this.pickupCoords.lat,
        pickup_lng: this.pickupCoords.lng,
        dropoff_address: this.dropoffAddress,
        dropoff_lat: this.dropoffCoords.lat,
        dropoff_lng: this.dropoffCoords.lng,
        scheduled_time: this.scheduledTime,
        price: this.estimate.estimated_price,
        estimated_distance: this.estimate.estimated_distance,
        estimated_price: this.estimate.estimated_price,
        status: 'pending',
        city_id: this.selectedCityId || undefined
      });

      if (this.useAutoDispatch) {
        await this.jobService.enqueueJob(job.id, profile.tenant_id, this.selectedCityId || undefined);
      }

      await loading.dismiss();
      this.nav.navigateForward(['/customer/van-moving/status', job.id]);
    } catch (error) {
      await loading.dismiss();
      const toast = await this.toastCtrl.create({ message: 'Failed to create job', duration: 2000, color: 'danger' });
      toast.present();
    }
  }
}
