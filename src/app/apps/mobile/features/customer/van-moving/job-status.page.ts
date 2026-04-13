import { Component, inject, OnInit, OnDestroy, ViewChild, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { chevronBackOutline, call, pin } from 'ionicons/icons';
import { ActivatedRoute, Router } from '@angular/router';
import { JobService } from '@core/services/job/job.service';
import { LocationService } from '@core/services/logistics/location.service';
import { Job, DriverLocation } from '@shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';
import { MapComponent } from '@shared/components/map/map.component';
import { RoutingService } from '@core/services/maps/routing.service';
import { ServiceTypeSlug } from '@core/models/maps/map-marker.model';

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
          <app-map #map></app-map>
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
  imports: [IonicModule, CommonModule, CardComponent, BadgeComponent, ButtonComponent, MapComponent]
})
export class JobStatusPage implements OnInit, OnDestroy {
  @ViewChild('map') mapComponent!: MapComponent;

  private route = inject(ActivatedRoute);
  private jobService = inject(JobService);
  private locationService = inject(LocationService);
  private routing = inject(RoutingService);
  private router = inject(Router);

  job = signal<Job | null>(null);
  private jobSubscription?: RealtimeChannel;
  private locationSubscription?: RealtimeChannel;

  constructor() {
    addIcons({ chevronBackOutline, call, pin });
  }

  async ngOnInit() {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      await this.loadJob(id);
      this.subscribeToUpdates(id);
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
    if (!job) return;

    const pickup = { lat: job.pickup_lat || 0, lng: job.pickup_lng || 0 };
    const dropoff = { lat: job.dropoff_lat || 0, lng: job.dropoff_lng || 0 };

    setTimeout(() => {
      this.mapComponent.addOrUpdateMarker({
        id: 'pickup',
        coordinates: pickup,
        kind: 'pickup',
        serviceType: 'van-moving' as ServiceTypeSlug,
        label: 'PICKUP'
      });

      this.mapComponent.addOrUpdateMarker({
        id: 'dropoff',
        coordinates: dropoff,
        kind: 'destination',
        serviceType: 'van-moving' as ServiceTypeSlug,
        label: 'DROPOFF'
      });

      if (job.pickup_lat && job.dropoff_lat) {
        this.routing.getRoute(pickup, dropoff).subscribe(route => {
          if (route) {
            this.mapComponent.drawRoute(route);
          }
        });
      }

      this.mapComponent.setCenter(pickup.lng, pickup.lat, 13);
    }, 500);
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
    if (!this.mapComponent) return;

    const pos = { lat: location.lat, lng: location.lng };
    this.mapComponent.addOrUpdateMarker({
      id: 'driver',
      coordinates: pos,
      kind: 'driver',
      serviceType: 'van-moving' as ServiceTypeSlug,
      heading: location.heading
    });
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
      this.router.navigate(['/customer']);
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
