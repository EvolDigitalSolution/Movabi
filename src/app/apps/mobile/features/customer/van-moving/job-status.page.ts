import {
    Component,
    inject,
    OnInit,
    OnDestroy,
    AfterViewInit,
    ViewChild,
    signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, AlertController, ToastController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
    chevronBackOutline,
    call,
    pin,
    closeCircleOutline
} from 'ionicons/icons';
import { ActivatedRoute, Router } from '@angular/router';
import { RealtimeChannel } from '@supabase/supabase-js';

import { JobService } from '@core/services/job/job.service';
import { LocationService } from '@core/services/logistics/location.service';
import { RoutingService } from '@core/services/maps/routing.service';
import { ServiceTypeSlug } from '@core/models/maps/map-marker.model';

import { Job, DriverLocation } from '@shared/models/booking.model';
import { MapComponent } from '@shared/components/map/map.component';
import { CardComponent, BadgeComponent, ButtonComponent } from '../../../../../shared/ui';

@Component({
    selector: 'app-job-status',
    standalone: true,
    imports: [
        IonicModule,
        CommonModule,
        CardComponent,
        BadgeComponent,
        ButtonComponent,
        MapComponent
    ],
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
            <div class="flex justify-between items-start mb-8 gap-4">
              <div class="min-w-0">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-[10px] font-bold text-blue-600 uppercase tracking-widest">Order Details</span>
                  <div class="w-1 h-1 rounded-full bg-slate-300"></div>
                  <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                    #{{ job()?.id?.slice(0, 8) }}
                  </span>
                </div>

                <h2 class="text-3xl font-display font-bold text-slate-900 capitalize leading-tight">
                  {{ getStatusLabel(job()?.status || '') }}
                </h2>
              </div>

              <app-badge [variant]="getStatusVariant(job()?.status || '')">
                {{ getStatusLabel(job()?.status || '') }}
              </app-badge>
            </div>

            <div class="space-y-8">
              <div class="relative pl-8 space-y-8">
                <div class="absolute left-[11px] top-2 bottom-2 w-0.5 bg-slate-100"></div>

                <div class="relative">
                  <div class="absolute -left-[25px] top-1 w-4 h-4 rounded-full bg-white border-4 border-blue-600 shadow-sm z-10"></div>
                  <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Pickup Location</p>
                    <p class="text-slate-900 font-bold leading-snug">{{ job()?.pickup_address || 'Pickup location' }}</p>
                  </div>
                </div>

                <div class="relative">
                  <div class="absolute -left-[25px] top-1 w-4 h-4 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                  <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Dropoff Location</p>
                    <p class="text-slate-900 font-bold leading-snug">{{ job()?.dropoff_address || 'Dropoff location' }}</p>
                  </div>
                </div>
              </div>

              @if (job()?.driver) {
                <div class="pt-8 border-t border-slate-50">
                  <div class="bg-slate-50 rounded-3xl p-5 flex items-center gap-4 border border-slate-100">
                    <div class="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center text-white font-bold text-xl overflow-hidden shadow-lg shadow-blue-600/20 shrink-0">
                      @if (job()?.driver?.avatar_url) {
                        <img [src]="job()?.driver?.avatar_url" class="w-full h-full object-cover" alt="Driver avatar" />
                      } @else {
                        {{ getDriverInitial() }}
                      }
                    </div>

                    <div class="flex-1 min-w-0">
                      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Your Professional Driver</p>
                      <p class="text-lg font-bold text-slate-900 truncate">
                        {{ getDriverName() }}
                      </p>
                    </div>

                    @if (job()?.driver?.phone) {
                      <a
                        [href]="'tel:' + job()?.driver?.phone"
                        class="w-12 h-12 rounded-2xl bg-white flex items-center justify-center text-blue-600 shadow-sm border border-slate-100 active:scale-95 transition-transform shrink-0"
                      >
                        <ion-icon name="call" class="text-xl"></ion-icon>
                      </a>
                    }
                  </div>
                </div>
              } @else if (!isFinishedStatus(job()?.status || '')) {
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

          @if (canCancel()) {
            <div class="mt-6">
              <app-button
                variant="outline"
                color="error"
                class="w-full"
                (click)="cancelJob()"
                (onClick)="cancelJob()"
              >
                <ion-icon name="close-circle-outline" slot="start" class="mr-2"></ion-icon>
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
  `
})
export class JobStatusPage implements OnInit, AfterViewInit, OnDestroy {
    @ViewChild('map') mapComponent?: MapComponent;

    private route = inject(ActivatedRoute);
    private jobService = inject(JobService);
    private locationService = inject(LocationService);
    private routing = inject(RoutingService);
    private router = inject(Router);
    private alertCtrl = inject(AlertController);
    private toastCtrl = inject(ToastController);

    job = signal<Job | null>(null);

    private jobId: string | null = null;
    private jobSubscription?: RealtimeChannel;
    private locationSubscription?: RealtimeChannel;
    private mapReady = false;
    private isCancelling = false;

    constructor() {
        addIcons({
            chevronBackOutline,
            call,
            pin,
            closeCircleOutline
        });
    }

    async ngOnInit(): Promise<void> {
        this.jobId = this.route.snapshot.paramMap.get('id');

        if (!this.jobId) {
            await this.router.navigate(['/customer']);
            return;
        }

        await this.loadJob(this.jobId);
        this.subscribeToUpdates(this.jobId);
    }

    ngAfterViewInit(): void {
        this.mapReady = true;
        setTimeout(() => this.initMap(), 300);
    }

    ngOnDestroy(): void {
        this.jobSubscription?.unsubscribe();
        this.locationSubscription?.unsubscribe();
    }

    async loadJob(id: string): Promise<void> {
        try {
            const data = await this.jobService.getJobById(id);
            this.job.set(data || null);

            if (data?.driver_id) {
                this.subscribeToDriverLocation(data.driver_id);
            }

            if (this.mapReady) {
                setTimeout(() => this.initMap(), 100);
            }
        } catch (error) {
            console.error('Error loading job:', error);
            await this.showToast('Could not load job details.', 'danger');
        }
    }

    initMap(): void {
        const currentJob = this.job();

        if (!currentJob || !this.mapComponent) return;

        const pickup = {
            lat: Number(currentJob.pickup_lat),
            lng: Number(currentJob.pickup_lng)
        };

        const dropoff = {
            lat: Number(currentJob.dropoff_lat),
            lng: Number(currentJob.dropoff_lng)
        };

        if (this.isValidCoord(pickup.lat) && this.isValidCoord(pickup.lng)) {
            this.mapComponent.addOrUpdateMarker({
                id: 'pickup',
                coordinates: pickup,
                kind: 'pickup',
                serviceType: 'van-moving' as ServiceTypeSlug,
                label: 'PICKUP'
            });

            this.mapComponent.setCenter(pickup.lng, pickup.lat, 13);
        }

        if (this.isValidCoord(dropoff.lat) && this.isValidCoord(dropoff.lng)) {
            this.mapComponent.addOrUpdateMarker({
                id: 'dropoff',
                coordinates: dropoff,
                kind: 'destination',
                serviceType: 'van-moving' as ServiceTypeSlug,
                label: 'DROPOFF'
            });
        }

        if (
            this.isValidCoord(pickup.lat) &&
            this.isValidCoord(pickup.lng) &&
            this.isValidCoord(dropoff.lat) &&
            this.isValidCoord(dropoff.lng)
        ) {
            this.routing.getRoute(pickup, dropoff).subscribe({
                next: (route) => {
                    if (!route || !this.mapComponent) return;

                    this.mapComponent.drawRoute(route);
                    this.mapComponent.fitBounds(
                        [
                            [pickup.lng, pickup.lat],
                            [dropoff.lng, dropoff.lat]
                        ],
                        { padding: { top: 70, bottom: 240, left: 45, right: 45 } }
                    );
                },
                error: (error) => {
                    console.warn('Route draw failed:', error);
                }
            });
        }
    }

    subscribeToUpdates(id: string): void {
        this.jobSubscription?.unsubscribe();

        this.jobSubscription = this.jobService.subscribeToJobs((payload) => {
            const updatedJob = payload?.['new'] as Job | undefined;

            if (!updatedJob?.id || updatedJob.id !== id) return;

            const oldDriverId = this.job()?.driver_id;

            void this.loadJob(id).then(() => {
                const newDriverId = this.job()?.driver_id;

                if (newDriverId && newDriverId !== oldDriverId) {
                    this.subscribeToDriverLocation(newDriverId);
                }
            });
        });
    }

    subscribeToDriverLocation(driverId: string): void {
        if (!driverId) return;

        this.locationSubscription?.unsubscribe();

        this.locationSubscription = this.locationService.subscribeToDriverLocation(
            driverId,
            (location) => this.updateDriverMarker(location)
        );
    }

    updateDriverMarker(location: DriverLocation): void {
        if (!this.mapComponent) return;

        const lat = Number(location.lat);
        const lng = Number(location.lng);

        if (!this.isValidCoord(lat) || !this.isValidCoord(lng)) return;

        this.mapComponent.addOrUpdateMarker({
            id: 'driver',
            coordinates: { lat, lng },
            kind: 'driver',
            serviceType: 'van-moving' as ServiceTypeSlug,
            heading: Number(location.heading || 0)
        });
    }

    getStatusVariant(
        status: string
    ): 'success' | 'error' | 'warning' | 'info' | 'primary' | 'secondary' {
        switch ((status || '').toLowerCase()) {
            case 'completed':
            case 'settled':
                return 'success';
            case 'cancelled':
                return 'error';
            case 'pending':
            case 'searching':
                return 'warning';
            case 'accepted':
            case 'assigned':
                return 'info';
            case 'in_progress':
            case 'heading_to_pickup':
            case 'arrived':
                return 'primary';
            default:
                return 'secondary';
        }
    }

    getStatusLabel(status: string): string {
        if (!status) return 'Pending';

        const labels: Record<string, string> = {
            pending: 'Pending',
            searching: 'Searching',
            accepted: 'Accepted',
            assigned: 'Assigned',
            heading_to_pickup: 'Heading to pickup',
            arrived: 'Driver arrived',
            in_progress: 'In progress',
            completed: 'Completed',
            settled: 'Settled',
            cancelled: 'Cancelled'
        };

        return labels[status] || status.replace(/_/g, ' ');
    }

    getDriverInitial(): string {
        return this.job()?.driver?.first_name?.charAt(0)?.toUpperCase() || 'D';
    }

    getDriverName(): string {
        const first = this.job()?.driver?.first_name || '';
        const last = this.job()?.driver?.last_name || '';
        const full = `${first} ${last}`.trim();

        return full || 'Driver assigned';
    }

    canCancel(): boolean {
        const status = this.job()?.status || '';

        return ![
            'cancelled',
            'completed',
            'settled',
            'in_progress'
        ].includes(status);
    }

    isFinishedStatus(status: string): boolean {
        return ['cancelled', 'completed', 'settled'].includes(status);
    }

    async cancelJob(): Promise<void> {
        const currentJob = this.job();

        if (!currentJob || this.isCancelling) return;

        const alert = await this.alertCtrl.create({
            header: 'Cancel Request',
            message: 'Are you sure you want to cancel this van moving request?',
            buttons: [
                {
                    text: 'No',
                    role: 'cancel'
                },
                {
                    text: 'Yes, Cancel',
                    role: 'destructive',
                    handler: async () => {
                        await this.performCancel(currentJob.id);
                    }
                }
            ]
        });

        await alert.present();
    }

    private async performCancel(jobId: string): Promise<void> {
        this.isCancelling = true;

        try {
            await this.jobService.updateJobStatus(jobId, 'cancelled');
            await this.showToast('Request cancelled.', 'success');
            await this.router.navigate(['/customer']);
        } catch (error) {
            console.error('Error cancelling job:', error);
            await this.showToast('Could not cancel request.', 'danger');
        } finally {
            this.isCancelling = false;
        }
    }

    getStatusClass(status: string): string {
        switch (status) {
            case 'pending':
            case 'searching':
                return 'bg-yellow-100 text-yellow-700';
            case 'accepted':
            case 'assigned':
                return 'bg-blue-100 text-blue-700';
            case 'in_progress':
            case 'heading_to_pickup':
            case 'arrived':
                return 'bg-indigo-100 text-indigo-700';
            case 'completed':
            case 'settled':
                return 'bg-green-100 text-green-700';
            case 'cancelled':
                return 'bg-red-100 text-red-700';
            default:
                return 'bg-gray-100 text-gray-700';
        }
    }

    private isValidCoord(value: number): boolean {
        return Number.isFinite(value) && !Number.isNaN(value) && value !== 0;
    }

    private async showToast(
        message: string,
        color: 'success' | 'warning' | 'danger' | 'medium' = 'medium'
    ): Promise<void> {
        const toast = await this.toastCtrl.create({
            message,
            duration: 2500,
            color
        });

        await toast.present();
    }
}