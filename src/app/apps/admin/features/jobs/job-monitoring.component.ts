import { Component, computed, inject, OnDestroy, OnInit, signal, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, ModalController, AlertController } from '@ionic/angular';
import { JobService } from '@core/services/job/job.service';
import { AdminService } from '../../services/admin.service';
import { LocationService } from '@core/services/logistics/location.service';
import { ProfileService } from '@core/services/profile/profile.service';
import { Job, DriverLocation, ServiceTypeEnum } from '@shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';
import { JobAnomalyService, JobAnomaly } from '@core/services/job/job-anomaly.service';
import { MapComponent } from '@shared/components/map/map.component';
import { SupabaseService } from '@core/services/supabase/supabase.service';

import { BadgeComponent } from '../../../../shared/ui/badge';
import { JobTimelineComponent } from './job-timeline.component';

type JobRisk = {
    label: string;
    variant: 'success' | 'warning' | 'error' | 'secondary';
    message: string;
};

@Component({
    selector: 'app-job-monitoring',
    standalone: true,
    imports: [CommonModule, IonicModule, BadgeComponent, JobTimelineComponent, MapComponent],
    template: `
    <div class="space-y-6">
      <div class="bg-white rounded-[2rem] border border-slate-100 shadow-xl shadow-slate-200/40 overflow-hidden">
        <div class="p-6 border-b border-slate-100 flex items-center justify-between gap-4">
          <div>
            <h3 class="text-xl font-display font-bold text-slate-900">Live Fleet View</h3>
            <p class="text-sm text-slate-500 font-medium mt-1">Real-time driver positions across the tenant.</p>
          </div>

          <button
            type="button"
            (click)="loadJobs()"
            class="h-10 px-4 rounded-xl bg-slate-50 text-slate-600 hover:bg-blue-50 hover:text-blue-600 text-xs font-bold border border-slate-100"
          >
            Refresh
          </button>
        </div>

        <div class="h-[320px] lg:h-[420px] bg-slate-100 relative">
          <app-map #map></app-map>

          <div class="absolute top-4 left-4 z-10 bg-white/90 backdrop-blur-md px-4 py-3 rounded-2xl border border-white shadow-xl shadow-slate-900/5">
            <div class="flex items-center gap-3">
              <div class="w-3 h-3 rounded-full bg-emerald-500 animate-pulse"></div>
              <span class="text-[10px] font-bold text-slate-900 uppercase tracking-widest">Live Tracking</span>
            </div>
          </div>
        </div>
      </div>

      <div class="bg-white rounded-[2rem] border border-slate-100 shadow-xl shadow-slate-200/40 overflow-hidden">
        <div class="p-6 border-b border-slate-100 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div>
            <h3 class="text-xl font-display font-bold text-slate-900">Van Moving Monitoring</h3>
            <p class="text-sm text-slate-500 font-medium mt-1">
              {{ filteredJobs().length }} jobs found · Showing {{ pagedJobs().length }} on this page
            </p>
          </div>

          <div class="flex flex-col sm:flex-row gap-3 w-full xl:w-auto">
            <div class="relative w-full sm:w-72">
              <ion-icon name="search-outline" class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"></ion-icon>
              <input
                type="text"
                placeholder="Search jobs..."
                (input)="onSearch($event)"
                class="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-sm font-medium text-slate-600 focus:outline-none"
              >
            </div>

            <select
              (change)="onStatusFilterChange($event)"
              class="w-full sm:w-48 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-medium text-slate-600 focus:outline-none"
            >
              <option value="all">All statuses</option>
              <option value="requested">Requested</option>
              <option value="pending">Pending</option>
              <option value="accepted">Accepted</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>

            <select
              (change)="onPageSizeChange($event)"
              class="w-full sm:w-36 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-medium text-slate-600 focus:outline-none"
            >
              <option value="10">10 / page</option>
              <option value="20">20 / page</option>
              <option value="50">50 / page</option>
            </select>
          </div>
        </div>

        <div class="overflow-x-auto max-w-full">
          <table class="w-full text-left border-collapse min-w-[1100px]">
            <thead>
              <tr class="bg-slate-50/70">
                <th class="px-4 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Job</th>
                <th class="px-4 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">People</th>
                <th class="px-4 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Route</th>
                <th class="px-4 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Status</th>
                <th class="px-4 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Payment</th>
                <th class="px-4 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Price</th>
                <th class="px-4 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Risk</th>
                <th class="px-4 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Actions</th>
              </tr>
            </thead>

            <tbody class="divide-y divide-slate-100">
              @for (job of pagedJobs(); track job.id) {
                @let risk = getJobRisk(job);

                <tr class="hover:bg-slate-50/80 transition-all align-top">
                  <td class="px-4 py-4">
                    <div class="min-w-[120px]">
                      <span class="text-[11px] font-semibold text-slate-500 bg-slate-100 px-2 py-1 rounded-md">
                        #{{ shortId(job.id) }}
                      </span>
                      <p class="text-[11px] text-slate-400 font-medium mt-2">
                        {{ job.created_at | date:'mediumDate' }}
                      </p>
                    </div>
                  </td>

                  <td class="px-4 py-4">
                    <div class="space-y-3 min-w-[190px]">
                      <div class="flex items-center gap-2">
                        <div class="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600 font-bold text-xs border border-blue-100 shrink-0">
                          {{ getInitial(job.customer) }}
                        </div>
                        <div class="min-w-0">
                          <p class="text-xs font-semibold text-slate-900 truncate">{{ getPersonName(job.customer, 'Customer') }}</p>
                          <p class="text-[11px] text-slate-400 truncate">{{ job.customer?.email || 'No email' }}</p>
                        </div>
                      </div>

                      @if (job.driver) {
                        <div class="flex items-center gap-2">
                          <div class="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-600 font-bold text-xs border border-emerald-100 shrink-0">
                            {{ getInitial(job.driver) }}
                          </div>
                          <div class="min-w-0">
                            <p class="text-xs font-semibold text-slate-900 truncate">{{ getPersonName(job.driver, 'Driver') }}</p>
                            <p class="text-[11px] text-slate-400 truncate">{{ job.driver.phone || 'No phone' }}</p>
                          </div>
                        </div>
                      } @else {
                        <app-badge variant="warning">Unassigned</app-badge>
                      }
                    </div>
                  </td>

                  <td class="px-4 py-4">
                    <div class="text-xs space-y-1.5 font-medium min-w-[260px] max-w-[360px]">
                      <div class="flex items-start gap-2">
                        <span class="text-slate-400 min-w-[36px] font-bold">From:</span>
                        <span class="text-slate-600 line-clamp-1">{{ job.pickup_address || 'Missing pickup' }}</span>
                      </div>
                      <div class="flex items-start gap-2">
                        <span class="text-slate-400 min-w-[36px] font-bold">To:</span>
                        <span class="text-slate-600 line-clamp-1">{{ job.dropoff_address || 'Missing dropoff' }}</span>
                      </div>
                    </div>
                  </td>

                  <td class="px-4 py-4">
                    <app-badge [variant]="getStatusVariant(job.status)">
                      {{ job.status || 'unknown' }}
                    </app-badge>
                  </td>

                  <td class="px-4 py-4">
                    <app-badge [variant]="getPaymentVariant(job)">
                      {{ getPaymentText(job) }}
                    </app-badge>
                  </td>

                  <td class="px-4 py-4">
                    <div class="flex flex-col gap-1 min-w-[100px]">
                      <span class="text-sm font-bold text-slate-900">{{ getCurrency(job) }}{{ toMoney(job.price) }}</span>

                      @if (job.pricing_plan_used) {
                        <span class="text-[11px] text-slate-500 font-medium">
                          {{ job.pricing_plan_used | uppercase }}
                        </span>
                      }

                      @if (job.commission_rate_used) {
                        <span class="text-[11px] text-slate-400 font-medium">
                          {{ job.commission_rate_used }}% fee
                        </span>
                      }
                    </div>
                  </td>

                  <td class="px-4 py-4">
                    <div class="flex flex-col gap-1 min-w-[140px]">
                      <app-badge [variant]="risk.variant">
                        {{ risk.label }}
                      </app-badge>

                      <span
                        class="text-[11px] font-medium leading-snug max-w-[150px]"
                        [class.text-rose-600]="risk.variant === 'error'"
                        [class.text-amber-600]="risk.variant === 'warning'"
                        [class.text-slate-400]="risk.variant === 'success' || risk.variant === 'secondary'"
                      >
                        {{ risk.message }}
                      </span>
                    </div>
                  </td>

                  <td class="px-4 py-4 text-right">
                    <div class="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        (click)="viewTimeline(job.id)"
                        title="View Timeline"
                        class="p-2 rounded-xl bg-slate-50 text-slate-400 hover:bg-blue-50 hover:text-blue-600 transition-all border border-slate-100"
                      >
                        <ion-icon name="time-outline" class="text-lg"></ion-icon>
                      </button>

                      @if (job.errand_details?.receipt_url) {
                        <button
                          type="button"
                          (click)="viewReceipt(job.errand_details!.receipt_url!)"
                          title="View Receipt"
                          class="p-2 rounded-xl bg-emerald-50 text-emerald-600 hover:bg-emerald-100 transition-all border border-emerald-100"
                        >
                          <ion-icon name="receipt-outline" class="text-lg"></ion-icon>
                        </button>
                      }

                      @if (risk.variant === 'error' || risk.variant === 'warning') {
                        <button
                          type="button"
                          (click)="handleRecovery(job)"
                          title="Recovery Actions"
                          class="p-2 rounded-xl bg-amber-50 text-amber-500 hover:bg-amber-100 hover:text-amber-600 transition-all border border-amber-100"
                        >
                          <ion-icon name="flash-outline" class="text-lg"></ion-icon>
                        </button>
                      }
                    </div>
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="8" class="px-10 py-20 text-center">
                    <div class="w-20 h-20 rounded-[2rem] bg-slate-50 flex items-center justify-center text-slate-300 mx-auto mb-6 border border-slate-100">
                      <ion-icon name="briefcase-outline" class="text-4xl"></ion-icon>
                    </div>
                    <h4 class="text-lg font-bold text-slate-900">No jobs found</h4>
                    <p class="text-slate-500 font-medium mt-1">Try changing your filters or search term.</p>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        <div class="p-5 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p class="text-xs text-slate-500 font-semibold">
            Showing {{ pageStart() }}–{{ pageEnd() }} of {{ filteredJobs().length }} jobs
          </p>

          <div class="flex items-center gap-2">
            <button
              type="button"
              (click)="prevPage()"
              [disabled]="currentPage() <= 1"
              class="h-9 px-3 rounded-xl bg-slate-50 text-slate-600 disabled:opacity-40 text-xs font-bold border border-slate-100"
            >
              Previous
            </button>

            <span class="text-xs font-bold text-slate-500 px-2">
              {{ currentPage() }} / {{ totalPages() }}
            </span>

            <button
              type="button"
              (click)="nextPage()"
              [disabled]="currentPage() >= totalPages()"
              class="h-9 px-3 rounded-xl bg-blue-600 text-white disabled:opacity-40 text-xs font-bold"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  `
})
export class JobMonitoringComponent implements OnInit, OnDestroy {
    @ViewChild('map') mapComponent!: MapComponent;

    private jobService = inject(JobService);
    private adminService = inject(AdminService);
    private locationService = inject(LocationService);
    private profileService = inject(ProfileService);
    private modalCtrl = inject(ModalController);
    private anomalyService = inject(JobAnomalyService);
    private alertCtrl = inject(AlertController);
    private supabase = inject(SupabaseService);

    jobs = signal<Job[]>([]);
    anomalies = signal<JobAnomaly[]>([]);
    searchTerm = signal('');
    statusFilter = signal('all');
    currentPage = signal(1);
    pageSize = signal(10);

    private jobChannel?: RealtimeChannel;
    private locationChannel?: RealtimeChannel;

    filteredJobs = computed(() => {
        const term = this.searchTerm().toLowerCase().trim();
        const status = this.statusFilter();

        return this.jobs().filter((job: any) => {
            const searchText = [
                job.id,
                job.status,
                job.payment_status,
                job.pickup_address,
                job.dropoff_address,
                job.customer?.full_name,
                job.customer?.first_name,
                job.customer?.last_name,
                job.customer?.email,
                job.driver?.full_name,
                job.driver?.first_name,
                job.driver?.last_name,
                job.driver?.phone
            ].filter(Boolean).join(' ').toLowerCase();

            const matchesSearch = !term || searchText.includes(term);
            const matchesStatus = status === 'all' || this.normalise(job.status) === status;

            return matchesSearch && matchesStatus;
        });
    });

    totalPages = computed(() => Math.max(1, Math.ceil(this.filteredJobs().length / this.pageSize())));

    pagedJobs = computed(() => {
        const start = (this.currentPage() - 1) * this.pageSize();
        return this.filteredJobs().slice(start, start + this.pageSize());
    });

    pageStart = computed(() => {
        if (this.filteredJobs().length === 0) return 0;
        return (this.currentPage() - 1) * this.pageSize() + 1;
    });

    pageEnd = computed(() => Math.min(this.currentPage() * this.pageSize(), this.filteredJobs().length));

    async ngOnInit() {
        await this.loadJobs();

        this.jobChannel = this.jobService.subscribeToJobs(() => this.loadJobs());
        this.subscribeToAllLocations();
    }

    ngOnDestroy() {
        this.jobChannel?.unsubscribe();
        this.locationChannel?.unsubscribe();
    }

    onSearch(event: Event) {
        this.searchTerm.set((event.target as HTMLInputElement).value || '');
        this.currentPage.set(1);
    }

    onStatusFilterChange(event: Event) {
        this.statusFilter.set((event.target as HTMLSelectElement).value || 'all');
        this.currentPage.set(1);
    }

    onPageSizeChange(event: Event) {
        this.pageSize.set(Number((event.target as HTMLSelectElement).value || 10));
        this.currentPage.set(1);
    }

    nextPage() {
        this.currentPage.update(page => Math.min(page + 1, this.totalPages()));
    }

    prevPage() {
        this.currentPage.update(page => Math.max(page - 1, 1));
    }

    subscribeToAllLocations() {
        const profile = this.profileService.profile();
        if (!profile) return;

        this.locationChannel = this.locationService.subscribeToAllTenantLocations(profile.tenant_id, (location) => {
            this.updateMarker(location);
        });
    }

    updateMarker(location: DriverLocation) {
        if (!this.mapComponent) return;

        this.mapComponent.addOrUpdateMarker({
            id: location.driver_id,
            coordinates: { lat: location.lat, lng: location.lng },
            kind: 'driver',
            serviceType: ServiceTypeEnum.RIDE,
            heading: location.heading,
            label: location.driver?.first_name || 'Driver'
        });
    }

    async loadJobs() {
        const data = await this.adminService.getJobs();
        const safeJobs = Array.isArray(data) ? data as Job[] : [];

        this.jobs.set(safeJobs);
        this.anomalies.set(this.anomalyService.detectAnomalies(safeJobs));

        if (this.currentPage() > this.totalPages()) {
            this.currentPage.set(this.totalPages());
        }
    }

    getAnomaly(jobId: string): JobAnomaly | undefined {
        return this.anomalies().find(a => a.jobId === jobId);
    }

    getJobRisk(job: any): JobRisk {
        const status = this.normalise(job?.status);
        const paymentStatus = this.normalise(job?.payment_status || job?.paymentStatus);
        const hasDriver = !!job?.driver_id || !!job?.driver;
        const ageMinutes = this.getJobAgeMinutes(job);

        if (['cancelled', 'canceled'].includes(status) && this.isPaymentCaptured(paymentStatus)) {
            return { label: 'Refund required', variant: 'error', message: 'Cancelled after payment capture.' };
        }

        if (['requested', 'pending'].includes(status) && !hasDriver && this.isPaymentCaptured(paymentStatus)) {
            return { label: 'Payment risk', variant: 'error', message: 'Paid before driver assignment.' };
        }

        if (['requested', 'pending'].includes(status) && !hasDriver && ageMinutes > 15) {
            return { label: 'Stuck booking', variant: 'warning', message: `${Math.round(ageMinutes)} mins unassigned.` };
        }

        if (status === 'completed' && !this.isPaymentCaptured(paymentStatus)) {
            return { label: 'Payment missing', variant: 'error', message: 'Completed job has no captured payment.' };
        }

        const anomaly = this.getAnomaly(job?.id);

        if (anomaly) {
            return {
                label: anomaly.type || 'Anomaly',
                variant: anomaly.severity === 'high' ? 'error' : 'warning',
                message: anomaly.message || 'Needs review.'
            };
        }

        return { label: 'Healthy', variant: 'success', message: 'No risk detected.' };
    }

    getPaymentText(job: any): string {
        const paymentStatus = this.normalise(job?.payment_status || job?.paymentStatus);

        if (!paymentStatus) return 'Unknown';
        if (['paid', 'captured', 'succeeded'].includes(paymentStatus)) return 'Captured';
        if (['authorized', 'requires_capture'].includes(paymentStatus)) return 'Authorized';
        if (['cancelled', 'canceled'].includes(paymentStatus)) return 'Cancelled';
        if (paymentStatus === 'refunded') return 'Refunded';

        return paymentStatus.replace(/_/g, ' ');
    }

    getPaymentVariant(job: any): 'success' | 'warning' | 'error' | 'secondary' {
        const paymentStatus = this.normalise(job?.payment_status || job?.paymentStatus);
        const status = this.normalise(job?.status);

        if (['cancelled', 'canceled'].includes(status) && this.isPaymentCaptured(paymentStatus)) return 'error';
        if (['paid', 'captured', 'succeeded'].includes(paymentStatus)) return 'success';
        if (['authorized', 'requires_capture'].includes(paymentStatus)) return 'warning';
        if (paymentStatus === 'refunded') return 'secondary';

        return 'secondary';
    }

    private isPaymentCaptured(paymentStatus: string): boolean {
        return ['paid', 'captured', 'succeeded'].includes(paymentStatus);
    }

    private normalise(value: unknown): string {
        return String(value || '').toLowerCase().trim();
    }

    private getJobAgeMinutes(job: any): number {
        const rawDate = job?.created_at || job?.createdAt;
        if (!rawDate) return 0;

        const createdAt = new Date(rawDate).getTime();
        if (Number.isNaN(createdAt)) return 0;

        return (Date.now() - createdAt) / 60000;
    }

    shortId(id: string | undefined | null): string {
        return (id || '').slice(0, 8).toUpperCase() || 'UNKNOWN';
    }

    getPersonName(person: any, fallback: string): string {
        const fullName = person?.full_name || `${person?.first_name || ''} ${person?.last_name || ''}`.trim();
        return fullName || person?.email || person?.phone || fallback;
    }

    getInitial(person: any): string {
        return this.getPersonName(person, 'U').charAt(0).toUpperCase();
    }

    getCurrency(job: any): string {
        return job?.currency_symbol || (job?.currency_code === 'NGN' ? '₦' : '£');
    }

    toMoney(value: unknown): string {
        return Number(value || 0).toFixed(2);
    }

    async handleRecovery(job: Job) {
        const risk = this.getJobRisk(job);

        const buttons: any[] = [
            { text: 'Mark for Review', handler: () => this.markForReview(job) }
        ];

        if (risk.label === 'Stuck booking') {
            buttons.unshift({ text: 'Retry Dispatch', handler: () => this.retryDispatch(job) });
        }

        buttons.push({ text: 'Force Cancel', role: 'destructive', handler: () => this.forceCancel(job) });
        buttons.push({ text: 'Close', role: 'cancel' });

        const alert = await this.alertCtrl.create({
            header: 'Recovery Action',
            subHeader: risk.label,
            message: risk.message,
            buttons
        });

        await alert.present();
    }

    private async retryDispatch(job: Job) {
        try {
            await this.jobService.retryDispatch(job.id, job.tenant_id);
            await this.loadJobs();
        } catch (e: unknown) {
            const errAlert = await this.alertCtrl.create({
                header: 'Error',
                message: e instanceof Error ? e.message : 'Failed to retry dispatch',
                buttons: ['OK']
            });
            await errAlert.present();
        }
    }

    private async markForReview(job: Job) {
        await this.jobService.markForReview(job.id, 'Admin flagged for manual review via dashboard');
        await this.loadJobs();
    }

    private async forceCancel(job: Job) {
        await this.jobService.forceCancel(job.id, 'Admin forced cancellation via dashboard');
        await this.loadJobs();
    }

    getStatusVariant(status: string): 'success' | 'warning' | 'error' | 'info' | 'primary' | 'secondary' {
        switch (this.normalise(status)) {
            case 'requested':
            case 'pending': return 'warning';
            case 'accepted': return 'info';
            case 'in_progress': return 'primary';
            case 'completed': return 'success';
            case 'cancelled':
            case 'canceled': return 'error';
            default: return 'secondary';
        }
    }

    async viewTimeline(jobId: string) {
        const modal = await this.modalCtrl.create({
            component: JobTimelineComponent,
            componentProps: { jobId },
            cssClass: 'timeline-modal',
            breakpoints: [0, 0.65, 0.9],
            initialBreakpoint: 0.65
        });

        await modal.present();
    }

    async viewReceipt(receiptPath: string) {
        const { data } = this.supabase.storage.from('documents').getPublicUrl(receiptPath);

        if (data?.publicUrl) {
            window.open(data.publicUrl, '_blank');
        }
    }
}