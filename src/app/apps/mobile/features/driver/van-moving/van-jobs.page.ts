import { Component, inject, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonIcon,
    IonSegment,
    IonSegmentButton,
    IonLabel,
    IonRefresher,
    IonRefresherContent,
    LoadingController,
    ToastController,
    RefresherCustomEvent
} from '@ionic/angular/standalone';
import { Router } from '@angular/router';
import { addIcons } from 'ionicons';
import {
    busOutline,
    chevronBackOutline,
    flagOutline,
    locationOutline,
    navigateOutline,
    refreshOutline,
    searchOutline,
    timeOutline,
    cubeOutline,
    checkmarkCircleOutline,
    alertCircleOutline
} from 'ionicons/icons';
import { RealtimeChannel } from '@supabase/supabase-js';

import { JobService } from '@core/services/job/job.service';
import { AuthService } from '@core/services/auth/auth.service';
import { LocationService } from '@core/services/logistics/location.service';
import { AppConfigService } from '@core/services/config/app-config.service';
import { Job } from '@shared/models/booking.model';
import { ButtonComponent, BadgeComponent, EmptyStateComponent } from '../../../../../shared/ui';

type VanJobSegment = 'available' | 'my-jobs';
type DriverJobStatus = 'pending' | 'searching' | 'accepted' | 'arrived' | 'in_progress' | 'completed' | 'cancelled';

@Component({
    selector: 'app-van-jobs',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        IonHeader,
        IonToolbar,
        IonButtons,
        IonBackButton,
        IonTitle,
        IonContent,
        IonIcon,
        IonSegment,
        IonSegmentButton,
        IonLabel,
        IonRefresher,
        IonRefresherContent,
        ButtonComponent,
        BadgeComponent,
        EmptyStateComponent
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-3 pt-4 bg-slate-50">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>

        <ion-title class="font-display font-black text-slate-950 tracking-tight">
          Moving Requests
        </ion-title>

        <ion-buttons slot="end">
          <button
            type="button"
            (click)="refreshJobs()"
            class="w-10 h-10 rounded-2xl bg-white border border-slate-100 text-slate-500 flex items-center justify-center shadow-sm active:scale-95 transition-all"
            [disabled]="loading()"
          >
            <ion-icon name="refresh-outline" class="text-xl" [class.animate-spin]="loading()"></ion-icon>
          </button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <ion-refresher slot="fixed" (ionRefresh)="refresh($event)">
        <ion-refresher-content></ion-refresher-content>
      </ion-refresher>

      <div class="w-full max-w-xl mx-auto px-3 py-4 space-y-6 pb-20 overflow-x-hidden">
        <div class="relative overflow-hidden rounded-[1.75rem] bg-slate-950 p-5 text-white shadow-xl shadow-slate-900/15">
          <ion-icon name="bus-outline" class="absolute -right-8 -bottom-8 text-[9rem] text-white/10 rotate-12"></ion-icon>

          <div class="relative z-10">
            <div class="flex items-start justify-between gap-4 mb-6">
              <div>
                <p class="text-white/70 text-[10px] font-black mb-2 uppercase tracking-[0.22em]">
                  Van & Moving
                </p>

                <h1 class="text-3xl font-display font-black tracking-tight leading-none">
                  {{ segment() === 'available' ? 'Available Moves' : 'My Moves' }}
                </h1>

                <p class="text-sm text-white/75 font-semibold mt-3 max-w-xs leading-relaxed">
                  {{ segment() === 'available'
                    ? 'Choose requests by payout, timing, and pickup distance.'
                    : 'Follow the next action for each accepted move.' }}
                </p>
              </div>

              <div class="w-12 h-12 rounded-2xl bg-white/10 border border-white/15 flex items-center justify-center shrink-0">
                <ion-icon name="cube-outline" class="text-3xl"></ion-icon>
              </div>
            </div>

            <div class="grid grid-cols-3 gap-2">
              <div class="rounded-2xl bg-white/10 border border-white/10 p-3">
                <p class="text-[9px] text-white/60 font-black uppercase tracking-widest mb-1">Shown</p>
                <p class="text-2xl font-display font-black">{{ filteredJobs().length }}</p>
              </div>

              <div class="rounded-2xl bg-white/10 border border-white/10 p-3">
                <p class="text-[9px] text-white/60 font-black uppercase tracking-widest mb-1">Today</p>
                <p class="text-2xl font-display font-black">{{ todayCount() }}</p>
              </div>

              <div class="rounded-2xl bg-white/10 border border-white/10 p-3">
                <p class="text-[9px] text-white/60 font-black uppercase tracking-widest mb-1">Location</p>
                <p class="text-sm font-black">
                  {{ currentPos() ? 'GPS Ready' : 'Not Set' }}
                </p>
              </div>
            </div>
          </div>
        </div>

        @if (locationService.locationMode() === 'manual') {
          <div class="p-4 bg-amber-50 border border-amber-100 rounded-[1.5rem] flex items-start gap-3 text-amber-700 shadow-sm">
            <ion-icon name="location-outline" class="text-xl shrink-0 mt-0.5"></ion-icon>

            <div class="flex-1 min-w-0">
              <p class="text-sm font-black">Location is in manual mode</p>
              <p class="text-xs font-semibold leading-relaxed mt-1">
                Distance estimates may be unavailable or inaccurate.
              </p>
            </div>

            <button
              type="button"
              (click)="getCurrentLocation()"
              class="text-xs font-black text-blue-600 uppercase tracking-widest shrink-0"
            >
              Retry
            </button>
          </div>
        }

        <div class="bg-white rounded-[1.75rem] p-2 border border-slate-100 shadow-sm">
          <ion-segment
            [value]="segment()"
            (ionChange)="changeSegment($event)"
            class="rounded-[1.5rem]"
          >
            <ion-segment-button value="available">
              <ion-label>Available</ion-label>
            </ion-segment-button>

            <ion-segment-button value="my-jobs">
              <ion-label>My Jobs</ion-label>
            </ion-segment-button>
          </ion-segment>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="bg-white rounded-[1.25rem] border border-slate-100 p-4 shadow-sm">
            <p class="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-1">Potential payout</p>
            <p class="text-xl font-display font-black text-slate-950">{{ formatPrice(totalVisiblePayout()) }}</p>
          </div>

          <div class="bg-white rounded-[1.25rem] border border-slate-100 p-4 shadow-sm">
            <p class="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-1">Nearest pickup</p>
            <p class="text-xl font-display font-black text-slate-950">{{ nearestPickupLabel() }}</p>
          </div>
        </div>

        <div class="relative">
          <ion-icon name="search-outline" class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-lg z-10"></ion-icon>
          <input
            type="search"
            [ngModel]="searchTerm()"
            (ngModelChange)="searchTerm.set($event)"
            placeholder="Search pickup, dropoff, or status"
            class="w-full h-12 rounded-2xl bg-white border border-slate-100 pl-11 pr-4 text-sm font-semibold text-slate-700 shadow-sm outline-none focus:border-blue-200 focus:ring-4 focus:ring-blue-50"
          >
        </div>

        <div class="space-y-4">
          <div class="flex items-center justify-between px-1">
            <div class="flex items-center gap-3">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <div>
                <h3 class="text-xs font-black text-slate-500 uppercase tracking-[0.18em]">
                  {{ segment() === 'available' ? 'Open Moving Requests' : 'Accepted Moving Requests' }}
                </h3>
                <p class="text-[11px] text-slate-400 font-semibold mt-0.5">
                  {{ filteredJobs().length }} of {{ jobs().length }} request{{ jobs().length === 1 ? '' : 's' }}
                </p>
              </div>
            </div>
          </div>

          @if (loading() && jobs().length === 0) {
            <div class="bg-white rounded-[2rem] border border-slate-100 shadow-sm p-6 space-y-4">
              <div class="h-24 bg-slate-100 rounded-2xl animate-pulse"></div>
              <div class="h-24 bg-slate-100 rounded-2xl animate-pulse"></div>
              <div class="h-24 bg-slate-100 rounded-2xl animate-pulse"></div>
            </div>
          } @else if (filteredJobs().length === 0) {
            <div class="bg-white rounded-[2rem] border border-slate-100 shadow-sm overflow-hidden py-10">
              <app-empty-state
                [icon]="segment() === 'available' ? 'search-outline' : 'bus-outline'"
                [title]="searchTerm() ? 'No matching requests' : (segment() === 'available' ? 'No moving requests yet' : 'No accepted moves yet')"
                [description]="searchTerm()
                  ? 'Try a different address, status, or clear the search field.'
                  : (segment() === 'available'
                  ? 'New van and moving requests will appear here when customers create them.'
                  : 'Accepted moving jobs will appear here once you take a request.')"
                [actionLabel]="searchTerm() ? 'Clear Search' : (segment() === 'available' ? 'Refresh' : 'Browse Available')"
                (action)="emptyAction()"
              ></app-empty-state>
            </div>
          } @else {
            <div class="space-y-4">
              @for (job of filteredJobs(); track job.id) {
                <div class="bg-white rounded-[2rem] border border-slate-100 shadow-sm overflow-hidden">
                  <div class="p-5">
                    <div class="flex justify-between items-start gap-4 mb-5">
                      <div class="min-w-0">
                        <div class="flex items-center gap-2 mb-2">
                          <app-badge [variant]="getStatusBadgeVariant(job.status)">
                            {{ formatStatus(job.status) }}
                          </app-badge>

                          @if (isToday(job.scheduled_time)) {
                            <app-badge variant="warning">Today</app-badge>
                          }
                        </div>

                        <h3 class="font-display font-black text-2xl text-slate-950">
                          {{ formatPrice(job.price || job.total_price || 0) }}
                        </h3>

                        <p class="text-[10px] text-slate-400 uppercase tracking-widest font-black mt-1">
                          {{ formatSchedule(job.scheduled_time) }}
                        </p>
                      </div>

                      <button
                        type="button"
                        (click)="viewDetails(job.id)"
                        class="w-12 h-12 rounded-2xl bg-slate-50 border border-slate-100 text-slate-600 flex items-center justify-center active:scale-95 transition-all shrink-0"
                      >
                        <ion-icon name="navigate-outline" class="text-xl"></ion-icon>
                      </button>
                    </div>

                    <div class="relative pl-8 space-y-6 mb-6">
                      <div class="absolute left-[9px] top-2 bottom-2 w-0.5 bg-slate-100"></div>

                      <div class="relative">
                        <div class="absolute -left-[27px] top-1 w-4 h-4 rounded-full bg-white border-4 border-blue-600 shadow-sm z-10"></div>
                        <p class="text-[10px] text-slate-400 uppercase font-black tracking-widest mb-1">Pickup</p>
                        <p class="font-bold text-slate-950 leading-snug text-sm">
                          {{ job.pickup_address || 'Pickup unavailable' }}
                        </p>

                        @if (distanceFromPickup(job) !== null) {
                          <p class="text-xs text-blue-600 font-black mt-1 flex items-center gap-1">
                            <ion-icon name="location-outline"></ion-icon>
                            {{ distanceFromPickup(job) }} km away
                          </p>
                        }
                      </div>

                      <div class="relative">
                        <div class="absolute -left-[27px] top-1 w-4 h-4 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                        <p class="text-[10px] text-slate-400 uppercase font-black tracking-widest mb-1">Dropoff</p>
                        <p class="font-bold text-slate-950 leading-snug text-sm">
                          {{ job.dropoff_address || 'Dropoff unavailable' }}
                        </p>

                        @if (job.estimated_distance) {
                          <p class="text-xs text-slate-500 font-semibold mt-1 flex items-center gap-1">
                            <ion-icon name="flag-outline"></ion-icon>
                            {{ job.estimated_distance }} km trip
                          </p>
                        }
                      </div>
                    </div>

                    <div class="grid grid-cols-3 gap-2 mb-4">
                      <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3">
                        <p class="text-[9px] text-slate-400 font-black uppercase tracking-widest mb-1">When</p>
                        <p class="text-xs font-black text-slate-800">{{ scheduleShort(job.scheduled_time) }}</p>
                      </div>
                      <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3">
                        <p class="text-[9px] text-slate-400 font-black uppercase tracking-widest mb-1">Pickup</p>
                        <p class="text-xs font-black text-slate-800">{{ distanceFromPickup(job) ? distanceFromPickup(job) + ' km' : 'Check' }}</p>
                      </div>
                      <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3">
                        <p class="text-[9px] text-slate-400 font-black uppercase tracking-widest mb-1">Trip</p>
                        <p class="text-xs font-black text-slate-800">{{ job.estimated_distance ? job.estimated_distance + ' km' : 'TBC' }}</p>
                      </div>
                    </div>

                    @if (segment() === 'available') {
                      <app-button
                        variant="primary"
                        size="lg"
                        class="w-full h-14 rounded-2xl shadow-xl shadow-blue-600/20"
                        [loading]="activeJobId() === job.id"
                        [disabled]="submitting() && activeJobId() !== job.id"
                        (clicked)="acceptJob(job.id)"
                      >
                        Accept Move
                      </app-button>
                    } @else {
                      <div class="grid grid-cols-2 gap-3">
                        @if (job.status === 'accepted') {
                          <app-button
                            variant="primary"
                            class="w-full"
                            [loading]="activeJobId() === job.id"
                            [disabled]="submitting() && activeJobId() !== job.id"
                            (clicked)="updateStatus(job.id, 'in_progress')"
                          >
                            Start
                          </app-button>
                        } @else if (job.status === 'in_progress') {
                          <app-button
                            variant="primary"
                            class="w-full"
                            [loading]="activeJobId() === job.id"
                            [disabled]="submitting() && activeJobId() !== job.id"
                            (clicked)="updateStatus(job.id, 'completed')"
                          >
                            Complete
                          </app-button>
                        } @else {
                          <app-button
                            variant="secondary"
                            class="w-full"
                            (clicked)="viewDetails(job.id)"
                          >
                            View
                          </app-button>
                        }

                        <app-button
                          variant="outline"
                          class="w-full"
                          (clicked)="viewDetails(job.id)"
                        >
                          Details
                        </app-button>
                      </div>
                    }
                  </div>
                </div>
              }
            </div>
          }
        </div>
      </div>
    </ion-content>
  `
})
export class VanJobsPage implements OnInit, OnDestroy {
    private jobService = inject(JobService);
    private auth = inject(AuthService);
    public locationService = inject(LocationService);
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);
    private router = inject(Router);
    private config = inject(AppConfigService);

    segment = signal<VanJobSegment>('available');
    jobs = signal<Job[]>([]);
    searchTerm = signal('');
    currentPos = signal<{ lat: number; lng: number } | null>(null);
    loading = signal(false);
    submitting = signal(false);
    activeJobId = signal<string | null>(null);

    private channel?: RealtimeChannel;

    hasLocation = computed(() => !!this.currentPos());
    filteredJobs = computed(() => {
        const term = this.searchTerm().trim().toLowerCase();
        const jobs = this.jobs();

        if (!term) return jobs;

        return jobs.filter(job => [
            job.pickup_address,
            job.dropoff_address,
            job.status,
            job.service_slug,
            this.formatPrice(job.price || job.total_price || 0)
        ].some(value => String(value || '').toLowerCase().includes(term)));
    });
    todayCount = computed(() => this.filteredJobs().filter(job => this.isToday(job.scheduled_time)).length);
    totalVisiblePayout = computed(() => this.filteredJobs().reduce(
        (sum, job) => sum + Number(job.price || job.total_price || 0),
        0
    ));

    constructor() {
        addIcons({
            busOutline,
            chevronBackOutline,
            flagOutline,
            locationOutline,
            navigateOutline,
            refreshOutline,
            searchOutline,
            timeOutline,
            cubeOutline,
            checkmarkCircleOutline,
            alertCircleOutline
        });
    }

    async ngOnInit() {
        await Promise.all([
            this.loadJobs(),
            this.getCurrentLocation()
        ]);

        this.channel = this.jobService.subscribeToJobs(() => {
            void this.loadJobs();
        });
    }

    ngOnDestroy() {
        void this.channel?.unsubscribe();
    }

    async changeSegment(event: CustomEvent) {
        const value = event.detail?.value as VanJobSegment | undefined;
        this.segment.set(value === 'my-jobs' ? 'my-jobs' : 'available');
        await this.loadJobs();
    }

    async refresh(event: RefresherCustomEvent) {
        try {
            await Promise.all([
                this.loadJobs(),
                this.getCurrentLocation()
            ]);
        } finally {
            event.target.complete();
        }
    }

    async refreshJobs() {
        await this.loadJobs();
    }

    async emptyAction() {
        if (this.searchTerm()) {
            this.searchTerm.set('');
            return;
        }

        if (this.segment() === 'available') {
            await this.refreshJobs();
            return;
        }

        this.segment.set('available');
        await this.loadJobs();
    }

    async getCurrentLocation() {
        const pos = await this.locationService.getCurrentPosition();

        if (pos) {
            this.currentPos.set({
                lat: pos.coords.latitude,
                lng: pos.coords.longitude
            });
            return;
        }

        this.currentPos.set(null);
    }

    calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
        return this.locationService.calculateDistance(lat1, lon1, lat2, lon2);
    }

    distanceFromPickup(job: Job): string | null {
        const pos = this.currentPos();

        if (!pos || !job.pickup_lat || !job.pickup_lng) return null;

        return this.calculateDistance(
            pos.lat,
            pos.lng,
            Number(job.pickup_lat),
            Number(job.pickup_lng)
        ).toFixed(1);
    }

    async loadJobs() {
        if (this.loading()) return;

        this.loading.set(true);

        try {
            if (this.segment() === 'available') {
                const available = await this.jobService.getAvailableJobs();
                this.jobs.set(this.sortJobs(available || []));
                return;
            }

            const user = this.auth.currentUser();

            if (!user?.id) {
                this.jobs.set([]);
                return;
            }

            const driverJobs = await this.jobService.getDriverJobs(user.id);
            this.jobs.set(this.sortJobs(driverJobs || []));
        } catch (error) {
            console.error('Failed to load van jobs:', error);
            this.jobs.set([]);
            await this.showToast('Could not load moving requests.', 'danger');
        } finally {
            this.loading.set(false);
        }
    }

    async acceptJob(jobId: string) {
        const user = this.auth.currentUser();

        if (!user?.id) {
            await this.showToast('Please sign in again.', 'warning');
            return;
        }

        if (this.submitting()) return;
        this.submitting.set(true);
        this.activeJobId.set(jobId);

        const loading = await this.loadingCtrl.create({ message: 'Accepting move...' });
        await loading.present();

        try {
            await this.jobService.acceptJob(jobId, user.id);

            this.segment.set('my-jobs');
            await this.loadJobs();

            await this.showToast('Move accepted.', 'success');
            await this.router.navigate(['/driver/job-details', jobId]);
        } catch (error: unknown) {
            console.error('Failed to accept van job:', error);
            const message = error instanceof Error ? error.message : 'Failed to accept move.';
            await this.showToast(message, 'danger');
            await this.loadJobs();
        } finally {
            this.submitting.set(false);
            this.activeJobId.set(null);
            await loading.dismiss();
        }
    }

    async updateStatus(jobId: string, status: DriverJobStatus) {
        if (this.submitting()) return;
        this.submitting.set(true);
        this.activeJobId.set(jobId);

        const loading = await this.loadingCtrl.create({ message: 'Updating move...' });
        await loading.present();

        try {
            await this.jobService.updateJobStatus(jobId, status);
            await this.loadJobs();

            await this.showToast('Move updated.', 'success');

            if (status === 'completed') {
                await this.router.navigate(['/driver']);
            }
        } catch (error: unknown) {
            console.error('Failed to update van job:', error);
            const message = error instanceof Error ? error.message : 'Could not update move.';
            await this.showToast(message, 'danger');
        } finally {
            this.submitting.set(false);
            this.activeJobId.set(null);
            await loading.dismiss();
        }
    }

    viewDetails(jobId: string) {
        this.router.navigate(['/driver/job-details', jobId]);
    }

    formatPrice(amount: number | null | undefined) {
        return this.config.formatCurrency(Number(amount || 0));
    }

    formatStatus(status: string | null | undefined): string {
        if (!status) return 'Pending';

        return String(status)
            .replace(/[_-]/g, ' ')
            .trim()
            .replace(/\s+/g, ' ')
            .replace(/\b\w/g, (char) => char.toUpperCase());
    }

    formatSchedule(value: string | Date | null | undefined): string {
        if (!value) return 'Flexible time';

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) return 'Flexible time';

        return date.toLocaleString([], {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    scheduleShort(value: string | Date | null | undefined): string {
        if (!value) return 'Flexible';

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) return 'Flexible';

        if (this.isToday(value)) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }

        return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
    }

    isToday(value: string | Date | null | undefined): boolean {
        if (!value) return false;

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) return false;

        return date.toDateString() === new Date().toDateString();
    }

    getStatusBadgeVariant(status: string | null | undefined): 'success' | 'warning' | 'error' | 'info' | 'secondary' | 'primary' {
        switch (String(status || '').toLowerCase()) {
            case 'pending':
            case 'searching':
                return 'warning';
            case 'accepted':
            case 'arrived':
                return 'primary';
            case 'in_progress':
                return 'info';
            case 'completed':
                return 'success';
            case 'cancelled':
                return 'error';
            default:
                return 'secondary';
        }
    }

    nearestPickupLabel(): string {
        const distances = this.filteredJobs()
            .map(job => {
                const value = this.distanceFromPickup(job);
                return value === null ? null : Number(value);
            })
            .filter((value): value is number => value !== null && Number.isFinite(value));

        if (!distances.length) return this.currentPos() ? 'TBC' : 'GPS off';

        return `${Math.min(...distances).toFixed(1)} km`;
    }

    private sortJobs(jobs: Job[]): Job[] {
        return [...jobs].sort((a, b) => {
            const aTime = new Date(a.scheduled_time || (a as any).created_at || 0).getTime();
            const bTime = new Date(b.scheduled_time || (b as any).created_at || 0).getTime();

            return bTime - aTime;
        });
    }

    private async showToast(message: string, color: 'success' | 'danger' | 'warning') {
        const toast = await this.toastCtrl.create({
            message,
            duration: 2400,
            color,
            position: 'top'
        });

        await toast.present();
    }
}
