import { Component, inject, OnInit, OnDestroy, ViewChild, ElementRef, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController } from '@ionic/angular';
import { ActivatedRoute } from '@angular/router';
import { JobService } from '@core/services/job/job.service';
import { LocationService } from '@core/services/logistics/location.service';
import { MapService } from '@core/services/logistics/map.service';
import { Job, DriverLocation } from '@shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';

@Component({
  selector: 'app-job-status',
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer"></ion-back-button>
        </ion-buttons>
        <ion-title>Job Status</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      @if (job()) {
        <div #mapContainer class="h-80 bg-gray-200 shadow-inner"></div>

        <div class="ion-padding -mt-8 relative z-10">
          <div class="bg-white rounded-3xl p-6 shadow-xl border border-gray-100">
            <div class="flex justify-between items-start mb-6">
              <div>
                <h2 class="text-2xl font-bold text-gray-900 capitalize">{{ job()?.status?.replace('_', ' ') }}</h2>
                <p class="text-gray-500">Job #{{ job()?.id?.slice(0, 8) }}</p>
              </div>
              <div [class]="'px-4 py-2 rounded-full text-xs font-bold uppercase tracking-widest ' + getStatusClass(job()?.status || '')">
                {{ job()?.status }}
              </div>
            </div>

            <div class="space-y-6">
              <div class="flex items-start gap-4">
                <div class="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0">
                  <ion-icon name="pin" class="text-blue-600 text-xl"></ion-icon>
                </div>
                <div>
                  <p class="text-xs text-gray-400 font-bold uppercase tracking-widest">Pickup</p>
                  <p class="text-gray-900">{{ job()?.pickup_address }}</p>
                </div>
              </div>

              <div class="flex items-start gap-4">
                <div class="w-10 h-10 rounded-full bg-green-50 flex items-center justify-center flex-shrink-0">
                  <ion-icon name="flag" class="text-green-600 text-xl"></ion-icon>
                </div>
                <div>
                  <p class="text-xs text-gray-400 font-bold uppercase tracking-widest">Dropoff</p>
                  <p class="text-gray-900">{{ job()?.dropoff_address }}</p>
                </div>
              </div>

              @if (job()?.driver) {
                <div class="pt-6 border-t border-gray-100">
                  <div class="flex items-center gap-4">
                    <div class="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-xl overflow-hidden">
                      @if (job()?.driver?.avatar_url) {
                        <img [src]="job()?.driver?.avatar_url" class="w-full h-full object-cover">
                      } @else {
                        {{ job()?.driver?.first_name?.[0] }}
                      }
                    </div>
                    <div>
                      <p class="text-xs text-gray-400 font-bold uppercase tracking-widest">Your Driver</p>
                      <p class="text-lg font-bold text-gray-900">{{ job()?.driver?.first_name }} {{ job()?.driver?.last_name }}</p>
                    </div>
                    <ion-button fill="clear" class="ml-auto" [href]="'tel:' + job()?.driver?.phone">
                      <ion-icon name="call" slot="icon-only"></ion-icon>
                    </ion-button>
                  </div>
                </div>
              } @else {
                <div class="pt-6 border-t border-gray-100 text-center">
                  <ion-spinner name="crescent" color="primary"></ion-spinner>
                  <p class="text-gray-500 mt-2">Finding a driver...</p>
                </div>
              }
            </div>
          </div>
        </div>
      } @else {
        <div class="flex flex-col items-center justify-center h-full">
          <ion-spinner name="crescent"></ion-spinner>
          <p class="text-gray-500 mt-4">Loading job details...</p>
        </div>
      }
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule]
})
export class JobStatusPage implements OnInit, OnDestroy {
  @ViewChild('mapContainer') mapContainer?: ElementRef;

  private route = inject(ActivatedRoute);
  private jobService = inject(JobService);
  private locationService = inject(LocationService);
  private mapService = inject(MapService);

  job = signal<Job | null>(null);
  private jobSubscription?: RealtimeChannel;
  private locationSubscription?: RealtimeChannel;
  private map: any;
  private driverMarker: any;

  async ngOnInit() {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      await this.loadJob(id);
      this.subscribeToUpdates(id);
      await this.mapService.loadGoogleMaps();
      this.initMap();
    }
  }

  ngOnDestroy() {
    this.jobSubscription?.unsubscribe();
    this.locationSubscription?.unsubscribe();
  }

  async loadJob(id: string) {
    const data = await this.jobService.getJobById(id);
    this.job.set(data);
    
    if (data?.driver_id) {
      this.subscribeToDriverLocation(data.driver_id);
    }
  }

  initMap() {
    const job = this.job();
    if (!job || !this.mapContainer) return;

    const pickup = { lat: job.pickup_lat || 0, lng: job.pickup_lng || 0 };
    const dropoff = { lat: job.dropoff_lat || 0, lng: job.dropoff_lng || 0 };

    this.map = this.mapService.createMap(this.mapContainer.nativeElement, {
      center: pickup,
      zoom: 13,
      disableDefaultUI: true
    });

    this.mapService.addMarker(this.map, pickup, 'https://maps.google.com/mapfiles/ms/icons/blue-dot.png');
    this.mapService.addMarker(this.map, dropoff, 'https://maps.google.com/mapfiles/ms/icons/green-dot.png');
    
    if (job.pickup_lat && job.dropoff_lat) {
      this.mapService.drawRoute(this.map, pickup, dropoff);
    }
  }

  subscribeToUpdates(id: string) {
    this.jobSubscription = this.jobService.subscribeToJobs(payload => {
      if (payload.new.id === id) {
        const oldDriverId = this.job()?.driver_id;
        this.loadJob(id).then(() => {
          if (this.job()?.driver_id && this.job()?.driver_id !== oldDriverId) {
            this.subscribeToDriverLocation(this.job()!.driver_id!);
          }
        });
      }
    });
  }

  subscribeToDriverLocation(driverId: string) {
    this.locationSubscription?.unsubscribe();
    this.locationSubscription = this.locationService.subscribeToDriverLocation(driverId, (location) => {
      this.updateDriverMarker(location);
    });
  }

  updateDriverMarker(location: DriverLocation) {
    if (!this.map) return;

    const pos = { lat: location.lat, lng: location.lng };
    if (this.driverMarker) {
      this.driverMarker.setPosition(pos);
    } else {
      this.driverMarker = this.mapService.addMarker(this.map, pos, 'https://maps.google.com/mapfiles/ms/icons/bus.png');
    }
  }

  getStatusClass(status: string): string {
    switch (status) {
      case 'pending': return 'bg-yellow-100 text-yellow-700';
      case 'accepted': return 'bg-blue-100 text-blue-700';
      case 'in_progress': return 'bg-indigo-100 text-indigo-700';
      case 'completed': return 'bg-green-100 text-green-700';
      case 'cancelled': return 'bg-red-100 text-red-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  }
}
