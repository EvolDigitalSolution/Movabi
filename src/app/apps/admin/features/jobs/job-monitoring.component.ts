import { Component, inject, OnInit, OnDestroy, ViewChild, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
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
import { ModalController, AlertController } from '@ionic/angular';

@Component({
  selector: 'app-job-monitoring',
  template: `
    <div class="space-y-10">
      <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-2xl shadow-slate-200/40 overflow-hidden">
        <div class="p-10 border-b border-slate-50">
          <h3 class="text-2xl font-display font-bold text-slate-900">Live Fleet View</h3>
          <p class="text-slate-500 font-medium mt-1">Real-time driver positions across the tenant.</p>
        </div>
        <div class="h-[500px] bg-slate-100 relative">
          <app-map #map></app-map>
          <!-- Map Overlay for Premium Feel -->
          <div class="absolute top-6 left-6 z-10 bg-white/90 backdrop-blur-md p-4 rounded-2xl border border-white shadow-xl shadow-slate-900/5">
            <div class="flex items-center gap-3">
              <div class="w-3 h-3 rounded-full bg-emerald-500 animate-pulse"></div>
              <span class="text-xs font-bold text-slate-900 uppercase tracking-widest">Live Tracking Active</span>
            </div>
          </div>
        </div>
      </div>

      <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-2xl shadow-slate-200/40 overflow-hidden">
        <div class="p-10 border-b border-slate-50 flex items-center justify-between">
          <div>
            <h3 class="text-2xl font-display font-bold text-slate-900">Van Moving Monitoring</h3>
            <p class="text-slate-500 font-medium mt-1">Real-time overview of all moving jobs.</p>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="bg-slate-50/50">
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Job ID</th>
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Customer</th>
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Driver</th>
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Route</th>
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Status</th>
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Plan</th>
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Financials</th>
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Anomalies</th>
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-50">
              @for (job of jobs(); track job.id) {
                <tr class="hover:bg-slate-50/80 transition-all group">
                  <td class="px-10 py-6">
                    <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest bg-slate-100 px-2 py-1 rounded-md">#{{ job.id.slice(0,8) }}</span>
                  </td>
                  <td class="px-10 py-6">
                    <div class="flex items-center gap-4">
                      <div class="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 font-bold text-xs border border-blue-100">
                        {{ job.customer?.first_name?.[0] }}
                      </div>
                      <div>
                        <p class="text-sm font-bold text-slate-900">{{ job.customer?.first_name }} {{ job.customer?.last_name }}</p>
                        <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">{{ job.customer?.email }}</p>
                      </div>
                    </div>
                  </td>
                  <td class="px-10 py-6">
                    @if (job.driver) {
                      <div class="flex items-center gap-4">
                        <div class="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-600 font-bold text-xs border border-emerald-100">
                          {{ job.driver.first_name[0] }}
                        </div>
                        <div>
                          <p class="text-sm font-bold text-slate-900">{{ job.driver.first_name }} {{ job.driver.last_name }}</p>
                          <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">{{ job.driver.phone }}</p>
                        </div>
                      </div>
                    } @else {
                      <app-badge variant="warning">Unassigned</app-badge>
                    }
                  </td>
                  <td class="px-10 py-6">
                    <div class="text-[10px] space-y-2 font-bold uppercase tracking-widest">
                      <div class="flex items-center gap-2">
                        <span class="text-slate-400 min-w-[32px]">From:</span>
                        <span class="text-slate-600 line-clamp-1">{{ job.pickup_address }}</span>
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="text-slate-400 min-w-[32px]">To:</span>
                        <span class="text-slate-600 line-clamp-1">{{ job.dropoff_address }}</span>
                      </div>
                    </div>
                  </td>
                  <td class="px-10 py-6">
                    <app-badge [variant]="getStatusVariant(job.status)">
                      {{ job.status }}
                    </app-badge>
                  </td>
                  <td class="px-10 py-6">
                    <div class="flex flex-col gap-1">
                      <app-badge [variant]="job.pricing_plan_used === 'pro' ? 'primary' : 'secondary'">
                        {{ job.pricing_plan_used || 'starter' | uppercase }}
                      </app-badge>
                      @if (job.commission_rate_used) {
                        <span class="text-[10px] text-slate-400 font-bold uppercase tracking-widest text-center">
                          {{ job.commission_rate_used }}% Fee
                        </span>
                      }
                    </div>
                  </td>
                  <td class="px-10 py-6">
                    <div class="flex flex-col gap-1">
                      <span class="text-sm font-black text-slate-900">£{{ job.price }}</span>
                      @if (job.service_slug === 'errand' && job.errand_details) {
                        <div class="flex flex-col text-[10px] font-bold uppercase tracking-widest">
                          <span class="text-slate-400">Budget: £{{ job.errand_details.estimated_budget }}</span>
                          @if (job.errand_details.actual_spending) {
                            <span [class]="job.errand_details.actual_spending > (job.errand_details.estimated_budget || 0) ? 'text-rose-600' : 'text-emerald-600'">
                              Spent: £{{ job.errand_details.actual_spending }}
                            </span>
                          }
                          @if (job.errand_funding?.over_budget_status === 'requested') {
                            <span class="text-amber-600 animate-pulse">Over-budget Req: £{{ job.errand_funding?.over_budget_amount }}</span>
                          }
                        </div>
                      }
                      @if (job.status === 'completed' && job.driver_payout) {
                        <div class="flex flex-col text-[10px] font-bold uppercase tracking-widest text-slate-400">
                          <span class="text-emerald-600">Payout: £{{ job.driver_payout }}</span>
                          <span class="text-blue-600">Platform: £{{ job.platform_fee }}</span>
                        </div>
                      }
                    </div>
                  </td>
                  <td class="px-10 py-6">
                    @let anomaly = getAnomaly(job.id);
                    @if (anomaly) {
                      <div class="flex flex-col gap-1">
                        <app-badge [variant]="anomaly.severity === 'high' ? 'error' : 'warning'">
                          {{ anomaly.type | uppercase }}
                        </app-badge>
                        <span class="text-[8px] text-slate-400 font-bold uppercase leading-tight max-w-[120px]">
                          {{ anomaly.message }}
                        </span>
                      </div>
                    } @else {
                      <span class="text-[10px] text-slate-300 font-bold uppercase tracking-widest">Healthy</span>
                    }
                  </td>
                  <td class="px-10 py-6">
                    <div class="flex items-center gap-2">
                      <button (click)="viewTimeline(job.id)" 
                              title="View Timeline"
                              class="p-2 rounded-xl bg-slate-50 text-slate-400 hover:bg-blue-50 hover:text-blue-600 transition-all border border-slate-100">
                        <ion-icon name="time-outline" class="text-lg"></ion-icon>
                      </button>

                      @if (job.errand_details?.receipt_url) {
                        <button (click)="viewReceipt(job.errand_details!.receipt_url!)" 
                                title="View Receipt"
                                class="p-2 rounded-xl bg-emerald-50 text-emerald-600 hover:bg-emerald-100 transition-all border border-emerald-100">
                          <ion-icon name="receipt-outline" class="text-lg"></ion-icon>
                        </button>
                      }
                      
                      @if (getAnomaly(job.id)) {
                        <button (click)="handleRecovery(job)" 
                                title="Recovery Actions"
                                class="p-2 rounded-xl bg-amber-50 text-amber-500 hover:bg-amber-100 hover:text-amber-600 transition-all border border-amber-100">
                          <ion-icon name="flash-outline" class="text-lg"></ion-icon>
                        </button>
                      }
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule, BadgeComponent, JobTimelineComponent, MapComponent]
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
  private jobChannel?: RealtimeChannel;
  private locationChannel?: RealtimeChannel;

  async ngOnInit() {
    await this.loadJobs();
    this.jobChannel = this.jobService.subscribeToJobs(() => this.loadJobs());
    this.subscribeToAllLocations();
  }

  ngOnDestroy() {
    this.jobChannel?.unsubscribe();
    this.locationChannel?.unsubscribe();
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
    const pos = { lat: location.lat, lng: location.lng };
    
    this.mapComponent.addOrUpdateMarker({
      id: location.driver_id,
      coordinates: pos,
      kind: 'driver',
      serviceType: ServiceTypeEnum.RIDE, // Default for monitoring
      heading: location.heading,
      label: location.driver?.first_name || 'Driver'
    });
  }

  async loadJobs() {
    const data = await this.adminService.getJobs() as Job[];
    this.jobs.set(data);
    this.anomalies.set(this.anomalyService.detectAnomalies(data));
  }

  getAnomaly(jobId: string): JobAnomaly | undefined {
    return this.anomalies().find(a => a.jobId === jobId);
  }

  async handleRecovery(job: Job) {
    const anomaly = this.getAnomaly(job.id);
    if (!anomaly) return;

    const alert = await this.alertCtrl.create({
      header: 'Recovery Action',
      subHeader: anomaly.message,
      message: 'Select a safe recovery action for this job.',
      buttons: [
        {
          text: 'Retry Dispatch',
          handler: () => this.retryDispatch(job)
        },
        {
          text: 'Mark for Review',
          handler: () => this.markForReview(job)
        },
        {
          text: 'Force Cancel',
          role: 'destructive',
          handler: () => this.forceCancel(job)
        },
        {
          text: 'Close',
          role: 'cancel'
        }
      ]
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

  getStatusVariant(status: string) {
    switch (status) {
      case 'pending': return 'warning';
      case 'accepted': return 'info';
      case 'in_progress': return 'primary';
      case 'completed': return 'success';
      case 'cancelled': return 'error';
      default: return 'secondary';
    }
  }

  async viewTimeline(jobId: string) {
    const modal = await this.modalCtrl.create({
      component: JobTimelineComponent,
      componentProps: { jobId },
      cssClass: 'timeline-modal',
      breakpoints: [0, 0.5, 0.8],
      initialBreakpoint: 0.5
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
