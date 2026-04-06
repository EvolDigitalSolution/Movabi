import { Component, inject, OnInit, OnDestroy, ViewChild, ElementRef, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController } from '@ionic/angular';
import { ActivatedRoute } from '@angular/router';
import { JobService } from '@core/services/job/job.service';
import { LocationService } from '@core/services/logistics/location.service';
import { MapService } from '@core/services/logistics/map.service';
import { Job, DriverLocation } from '@shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';

import { CardComponent, BadgeComponent, ButtonComponent } from '../../../../../shared/ui';

@Component({
  selector: 'app-job-status',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-slate-900">Job Status</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      @if (job()) {
        <div class="relative h-[40vh] w-full">
          <div #mapContainer class="h-full w-full bg-slate-200"></div>
          <div class="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-slate-50 to-transparent pointer-events-none"></div>
        </div>

        <div class="ion-padding -mt-12 relative z-10 max-w-xl mx-auto pb-12">
          <app-card>
            <div class="flex justify-between items-start mb-8">
              <div>
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-[10px] font-bold text-blue-600 uppercase tracking-widest">Order Details</span>
                  <div class="w-1 h-1 rounded-full bg-slate-300"></div>
                  <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">#{{ job()?.id?.slice(0, 8) }}</span>
                </div>
                <h2 class="text-3xl font-display font-bold text-slate-900 capitalize leading-tight">
                  {{ job()?.status?.replace('_', ' ') }}
                </h2>
              </div>
              <app-badge [variant]="getStatusVariant(job()?.status || '')">{{ job()?.status }}</app-badge>
            </div>

            <div class="space-y-8">
              <div class="relative pl-8 space-y-8">
                <!-- Vertical Line -->
                <div class="absolute left-[11px] top-2 bottom-2 w-0.5 bg-slate-100"></div>

                <!-- Pickup -->
                <div class="relative">
                  <div class="absolute -left-[25px] top-1 w-4 h-4 rounded-full bg-white border-4 border-blue-600 shadow-sm z-10"></div>
                  <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Pickup Location</p>
                    <p class="text-slate-900 font-bold leading-snug">{{ job()?.pickup_address }}</p>
                  </div>
                </div>

                <!-- Dropoff -->
                <div class="relative">
                  <div class="absolute -left-[25px] top-1 w-4 h-4 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                  <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Dropoff Location</p>
                    <p class="text-slate-900 font-bold leading-snug">{{ job()?.dropoff_address }}</p>
                  </div>
                </div>
              </div>

              @if (job()?.driver) {
                <div class="pt-8 border-t border-slate-50">
                  <div class="bg-slate-50 rounded-3xl p-5 flex items-center gap-4 border border-slate-100">
                    <div class="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center text-white font-bold text-xl overflow-hidden shadow-lg shadow-blue-600/20">
                      @if (job()?.driver?.avatar_url) {
                        <img [src]="job()?.driver?.avatar_url" class="w-full h-full object-cover" alt="Driver avatar">
                      } @else {
                        {{ job()?.driver?.first_name?.[0] }}
                      }
                    </div>
                    <div class="flex-1 min-w-0">
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Your Professional Driver</p>
                      <p class="text-lg font-bold text-slate-900 truncate">{{ job()?.driver?.first_name }} {{ job()?.driver?.last_name }}</p>
                    </div>
                    <a [href]="'tel:' + job()?.driver?.phone" 
                       class="w-12 h-12 rounded-2xl bg-white flex items-center justify-center text-blue-600 shadow-sm border border-slate-100 active:scale-95 transition-transform">
                      <ion-icon name="call" class="text-xl"></ion-icon>
                    </a>
                  </div>
                </div>
              } @else {
                <div class="pt-8 border-t border-slate-50 text-center py-6">
                  <div class="relative w-16 h-16 mx-auto mb-4">
                    <div class="absolute inset-0 bg-blue-100 rounded-full animate-ping opacity-20"></div>
                    <div class="relative w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center border border-blue-100">
                      <ion-spinner name="crescent" color="primary"></ion-spinner>
                    </div>
                  </div>
                  <h4 class="text-lg font-bold text-slate-900 mb-1 tracking-tight">Finding your driver</h4>
                  <p class="text-sm text-slate-500 font-medium">We're matching you with the best professional available.</p>
                </div>
              }
            </div>
          </app-card>

          @if (job()?.status === 'pending') {
            <div class="mt-6">
              <app-button variant="outline" color="error" class="w-full" (click)="cancelJob()">
                Cancel Request
              </app-button>
            </div>
          }
        </div>
      } @else {
        <div class="flex flex-col items-center justify-center h-full ion-padding text-center">
          <div class="w-16 h-16 bg-white rounded-2xl flex items-center justify-center shadow-xl shadow-slate-200/50 border border-slate-100 mb-6">
            <ion-spinner name="crescent" color="primary"></ion-spinner>
          </div>
          <h3 class="text-xl font-bold text-slate-900 mb-2">Loading details</h3>
          <p class="text-slate-500 font-medium">Retrieving your journey information...</p>
        </div>
      }
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, CardComponent, BadgeComponent, ButtonComponent]
})
export class JobStatusPage implements OnInit, OnDestroy {
  @ViewChild('mapContainer') mapContainer?: ElementRef;

  private route = inject(ActivatedRoute);
  private jobService = inject(JobService);
  private locationService = inject(LocationService);
  private mapService = inject(MapService);
  private navCtrl = inject(NavController);

  job = signal<Job | null>(null);
  private jobSubscription?: RealtimeChannel;
  private locationSubscription?: RealtimeChannel;
  private map: google.maps.Map | null = null;
  private driverMarker: google.maps.Marker | null = null;

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
      disableDefaultUI: true,
      styles: [
        {
          "featureType": "all",
          "elementType": "geometry.fill",
          "stylers": [{ "weight": "2.00" }]
        },
        {
          "featureType": "all",
          "elementType": "geometry.stroke",
          "stylers": [{ "color": "#9c9c9c" }]
        },
        {
          "featureType": "all",
          "elementType": "labels.text",
          "stylers": [{ "visibility": "on" }]
        },
        {
          "featureType": "landscape",
          "elementType": "all",
          "stylers": [{ "color": "#f2f2f2" }]
        },
        {
          "featureType": "landscape",
          "elementType": "geometry.fill",
          "stylers": [{ "color": "#ffffff" }]
        },
        {
          "featureType": "landscape.man_made",
          "elementType": "geometry.fill",
          "stylers": [{ "color": "#ffffff" }]
        },
        {
          "featureType": "poi",
          "elementType": "all",
          "stylers": [{ "visibility": "off" }]
        },
        {
          "featureType": "road",
          "elementType": "all",
          "stylers": [{ "saturation": -100 }, { "lightness": 45 }]
        },
        {
          "featureType": "road",
          "elementType": "geometry.fill",
          "stylers": [{ "color": "#eeeeee" }]
        },
        {
          "featureType": "road",
          "elementType": "labels.text.fill",
          "stylers": [{ "color": "#7b7b7b" }]
        },
        {
          "featureType": "road",
          "elementType": "labels.text.stroke",
          "stylers": [{ "color": "#ffffff" }]
        },
        {
          "featureType": "road.highway",
          "elementType": "all",
          "stylers": [{ "visibility": "simplified" }]
        },
        {
          "featureType": "road.arterial",
          "elementType": "labels.icon",
          "stylers": [{ "visibility": "off" }]
        },
        {
          "featureType": "transit",
          "elementType": "all",
          "stylers": [{ "visibility": "off" }]
        },
        {
          "featureType": "water",
          "elementType": "all",
          "stylers": [{ "color": "#46bcec" }, { "visibility": "on" }]
        },
        {
          "featureType": "water",
          "elementType": "geometry.fill",
          "stylers": [{ "color": "#c8d7d4" }]
        },
        {
          "featureType": "water",
          "elementType": "labels.text.fill",
          "stylers": [{ "color": "#070707" }]
        },
        {
          "featureType": "water",
          "elementType": "labels.text.stroke",
          "stylers": [{ "color": "#ffffff" }]
        }
      ]
    });

    this.mapService.addMarker(this.map!, pickup, 'https://maps.google.com/mapfiles/ms/icons/blue-dot.png');
    this.mapService.addMarker(this.map!, dropoff, 'https://maps.google.com/mapfiles/ms/icons/green-dot.png');
    
    if (job.pickup_lat && job.dropoff_lat) {
      this.mapService.drawRoute(this.map!, pickup, dropoff);
    }
  }

  subscribeToUpdates(id: string) {
    this.jobSubscription = this.jobService.subscribeToJobs(payload => {
      const newJob = payload['new'] as Job;
      if (newJob && newJob.id === id) {
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
      this.driverMarker = this.mapService.addMarker(this.map!, pos, 'https://maps.google.com/mapfiles/ms/icons/bus.png');
    }
  }

  getStatusVariant(status: string): 'success' | 'error' | 'warning' | 'info' | 'primary' {
    switch (status?.toLowerCase()) {
      case 'completed': return 'success';
      case 'cancelled': return 'error';
      case 'pending': return 'warning';
      case 'accepted': return 'info';
      case 'in_progress': return 'primary';
      default: return 'primary';
    }
  }

  async cancelJob() {
    const job = this.job();
    if (!job) return;
    
    try {
      await this.jobService.updateJobStatus(job.id, 'cancelled');
      this.navCtrl.back();
    } catch (error) {
      console.error('Error cancelling job:', error);
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
