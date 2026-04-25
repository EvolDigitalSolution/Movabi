import { Component, inject, OnInit, OnDestroy, signal, ViewChild } from '@angular/core';
import { AdminService, FailedBooking, WalletTransaction } from '../../services/admin.service';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { RouterModule } from '@angular/router';
import { SupabaseService } from '../../../../core/services/supabase/supabase.service';
import { CardComponent, ButtonComponent, BadgeComponent } from '../../../../shared/ui';
import { AppConfigService } from '../../../../core/services/config/app-config.service';
import { RealtimeChannel } from '@supabase/supabase-js';
import { Job, Profile } from '../../../../shared/models/booking.model';
import { JobAnomalyService, JobAnomaly } from '@core/services/job/job-anomaly.service';
import { MapComponent } from '../../../../shared/components/map/map.component';

interface DashboardStat {
    label: string;
    value: number | string;
    prefix?: string;
    icon: string;
    bgClass: string;
    iconClass: string;
    note: string;
}

interface RevenueBar {
    day: string;
    value: number;
    height?: number;
}

interface OperationalMetrics {
    online_drivers_count: number;
    revenue_today: number;
    active_jobs_count: number;
    platform_earnings_today: number;
    driver_payouts_today: number;
    pro_jobs_count: number;
    starter_jobs_count: number;
    total_pro_drivers: number;
}

interface AdminEvent {
    id: string;
    type: string;
    user?: Profile;
    created_at: string;
    payload: Record<string, unknown>;
}

@Component({
    selector: 'app-admin-dashboard',
    standalone: true,
    imports: [CommonModule, IonicModule, RouterModule, CardComponent, ButtonComponent, BadgeComponent, MapComponent],
    template: `
    <div class="space-y-6 container-padding pb-12 bg-slate-50 min-h-screen">
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-5 pt-6">
        <div>
          <h1 class="text-2xl md:text-3xl font-display font-bold text-slate-950 tracking-tight">Operations Dashboard</h1>
          <p class="text-sm text-slate-500 font-medium mt-1">Real-time platform monitoring and insights.</p>
        </div>

        <div class="flex flex-col sm:flex-row sm:items-center gap-3">
          <div class="inline-flex items-center gap-2 bg-emerald-50 px-4 py-2 rounded-full border border-emerald-100">
            <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
            <span class="text-[11px] font-bold text-emerald-700 uppercase tracking-widest">System Online</span>
          </div>

          <button
            type="button"
            (click)="refreshData()"
            class="h-10 px-4 rounded-xl bg-white border border-slate-200 text-slate-700 hover:bg-blue-50 hover:text-blue-700 text-xs font-bold transition"
          >
            Refresh
          </button>
        </div>
      </div>

      @if ((stuckJobs() || []).length > 0) {
        <div class="bg-rose-50 border border-rose-100 rounded-[1.5rem] p-5 flex flex-col md:flex-row md:items-center justify-between gap-5 shadow-sm">
          <div class="flex items-center gap-4">
            <div class="w-12 h-12 rounded-2xl bg-rose-100 flex items-center justify-center text-rose-600 shrink-0">
              <ion-icon name="alert-circle-outline" class="text-2xl"></ion-icon>
            </div>

            <div>
              <h3 class="text-base font-bold text-rose-900">{{ (stuckJobs() || []).length }} Job Issues Detected</h3>
              <p class="text-sm text-rose-700 font-medium">Review bookings that may be stuck, paid too early, or need manual action.</p>
            </div>
          </div>

          <a routerLink="/van-jobs" class="inline-flex items-center justify-center h-10 px-5 rounded-xl bg-rose-600 text-white text-xs font-bold hover:bg-rose-700 transition">
            Monitor Jobs
          </a>
        </div>
      }

      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
        @for (stat of statsList; track stat.label) {
          <div class="rounded-[1.5rem] bg-white border border-slate-100 shadow-sm p-5 hover:shadow-lg hover:shadow-slate-200/60 transition">
            <div class="flex items-start justify-between gap-4 mb-5">
              <div [class]="'w-12 h-12 rounded-2xl flex items-center justify-center ' + stat.bgClass">
                <ion-icon [name]="stat.icon" [class]="'text-2xl ' + stat.iconClass"></ion-icon>
              </div>

              <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">{{ stat.label }}</span>
            </div>

            <div class="flex items-baseline gap-1">
              @if (stat.prefix) {
                <span class="text-base font-bold text-slate-500">{{ stat.prefix }}</span>
              }
              <h3 class="text-3xl font-display font-black text-slate-950 tracking-tight">{{ stat.value }}</h3>
            </div>

            <div class="mt-4 flex items-center gap-2 text-[11px] font-semibold text-slate-500">
              <ion-icon name="pulse-outline" class="text-sm text-emerald-600"></ion-icon>
              <span>{{ stat.note }}</span>
            </div>
          </div>
        }
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div class="metric-panel bg-slate-950">
          <p class="metric-label text-slate-300">Drivers Online</p>
          <h4 class="metric-value text-white">{{ operationalMetrics()?.online_drivers_count || 0 }}</h4>
          <p class="metric-note text-slate-300">
            <span class="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse mr-2"></span>
            Live monitoring active
          </p>
        </div>

        <div class="metric-panel bg-blue-700">
          <p class="metric-label text-blue-100">Platform Earnings Today</p>
          <h4 class="metric-value text-white">{{ formatPrice(operationalMetrics()?.platform_earnings_today || 0) }}</h4>
          <div class="mt-5 space-y-1 text-xs font-medium text-blue-100">
            <p>Total fare: {{ formatPrice(operationalMetrics()?.revenue_today || 0) }}</p>
            <p>Driver payouts: {{ formatPrice(operationalMetrics()?.driver_payouts_today || 0) }}</p>
          </div>
        </div>

        <div class="metric-panel bg-indigo-700">
          <p class="metric-label text-indigo-100">Active Jobs</p>
          <h4 class="metric-value text-white">{{ operationalMetrics()?.active_jobs_count || 0 }}</h4>
          <div class="mt-5 space-y-1 text-xs font-medium text-indigo-100">
            <p>Pro jobs: {{ operationalMetrics()?.pro_jobs_count || 0 }}</p>
            <p>Starter jobs: {{ operationalMetrics()?.starter_jobs_count || 0 }}</p>
          </div>
        </div>
      </div>

      <div class="rounded-[1.5rem] bg-white border border-slate-100 shadow-sm overflow-hidden">
        <div class="p-5 border-b border-slate-100 flex items-center justify-between gap-4">
          <div>
            <h3 class="text-lg font-bold text-slate-950">Demand Heatmap</h3>
            <p class="text-sm text-slate-500 font-medium">Live demand zones and driver activity.</p>
          </div>

          <div class="hidden sm:flex items-center gap-4">
            <div class="legend-dot bg-rose-500">High Demand</div>
            <div class="legend-dot bg-emerald-500">Balanced</div>
          </div>
        </div>

        <div class="h-[320px] md:h-[400px] w-full relative bg-slate-100">
          <app-map #adminMap></app-map>
        </div>
      </div>

      <div class="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div class="xl:col-span-2 rounded-[1.5rem] bg-white border border-slate-100 shadow-sm p-5">
          <div class="flex items-center justify-between gap-4 mb-8">
            <div>
              <h3 class="text-lg font-bold text-slate-950">Revenue Overview</h3>
              <p class="text-sm text-slate-500 font-medium">Recent completed-job revenue.</p>
            </div>
            <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Last 7 Days</span>
          </div>

          <div class="h-80 w-full flex items-end justify-between gap-4 px-2 pt-8">
            @for (bar of (revenueBars || []); track bar.day) {
              <div class="flex-1 flex flex-col items-center gap-4 group h-full justify-end">
                <div class="w-full bg-slate-100 rounded-t-2xl relative overflow-hidden flex items-end min-h-[10px]" [style.height.%]="bar.height || 4">
                  <div class="w-full h-full bg-blue-600/80 group-hover:bg-blue-700 transition-all"></div>
                </div>
                <div class="text-center">
                  <p class="text-[11px] font-bold text-slate-700">{{ formatPrice(bar.value || 0) }}</p>
                  <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{{ bar.day }}</span>
                </div>
              </div>
            }

            @if ((revenueBars || []).length === 0) {
              <div class="w-full h-full flex items-center justify-center text-sm text-slate-400 font-medium">
                No revenue data available.
              </div>
            }
          </div>
        </div>

        <div class="rounded-[1.5rem] bg-white border border-slate-100 shadow-sm p-5">
          <div class="flex items-center justify-between gap-4 mb-5">
            <div>
              <h3 class="text-lg font-bold text-slate-950">Active Jobs</h3>
              <p class="text-sm text-slate-500 font-medium">Current dispatch activity.</p>
            </div>
            <a routerLink="/van-jobs" class="text-xs font-bold text-blue-700 hover:text-blue-900">View all</a>
          </div>

          <div class="space-y-3">
            @for (job of (activeJobs() || []); track job.id) {
              <a routerLink="/van-jobs" class="flex items-center gap-3 p-4 bg-slate-50 rounded-2xl border border-slate-100 hover:bg-white hover:shadow-md transition">
                <div class="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-700 border border-blue-100 shrink-0">
                  <ion-icon name="car-outline" class="text-xl"></ion-icon>
                </div>

                <div class="flex-1 min-w-0">
                  <h4 class="text-sm font-bold text-slate-900 truncate">{{ job.pickup_address || 'Pickup unavailable' }}</h4>
                  <p class="text-xs text-slate-500 truncate mt-0.5">{{ job.dropoff_address || 'Dropoff unavailable' }}</p>
                </div>

                <div class="text-right shrink-0">
                  <app-badge variant="info">{{ job.status || 'unknown' }}</app-badge>
                  <p class="text-xs font-bold text-slate-900 mt-2">{{ formatPrice(job.price || 0) }}</p>
                </div>
              </a>
            }

            @if ((activeJobs() || []).length === 0) {
              <div class="text-center py-14">
                <div class="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-slate-100">
                  <ion-icon name="calendar-outline" class="text-2xl text-slate-300"></ion-icon>
                </div>
                <p class="text-slate-500 text-sm font-medium">No active jobs right now.</p>
              </div>
            }
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <div class="rounded-[1.5rem] bg-white border border-slate-100 shadow-sm p-5">
          <h3 class="text-lg font-bold text-slate-950 mb-5">Failed Bookings</h3>

          <div class="space-y-3">
            @for (failure of (failedBookings() || []); track failure.id) {
              <div class="flex items-center justify-between gap-4 p-4 bg-rose-50 rounded-2xl border border-rose-100">
                <div class="min-w-0">
                  <h5 class="text-sm font-bold text-slate-900 truncate">
                    {{ failure.customer?.first_name || 'Unknown' }} {{ failure.customer?.last_name || '' }}
                  </h5>
                  <p class="text-xs text-rose-700 mt-1 truncate">
                    {{ failure.status || 'unknown' }} · {{ failure.cancellation_reason || 'No reason' }}
                  </p>
                </div>
                <span class="text-[11px] font-bold text-slate-500 whitespace-nowrap">
                  {{ failure.created_at | date:'shortTime' }}
                </span>
              </div>
            }

            @if ((failedBookings() || []).length === 0) {
              <p class="text-center py-10 text-slate-400 text-sm">No recent failures.</p>
            }
          </div>
        </div>

        <div class="rounded-[1.5rem] bg-white border border-slate-100 shadow-sm p-5">
          <h3 class="text-lg font-bold text-slate-950 mb-5">Recent Wallet Activity</h3>

          <div class="space-y-3">
            @for (payment of (recentPayments() || []); track payment.id) {
              <div class="flex items-center justify-between gap-4 p-4 bg-emerald-50 rounded-2xl border border-emerald-100">
                <div class="flex items-center gap-3 min-w-0">
                  <div class="w-10 h-10 rounded-xl bg-white flex items-center justify-center text-emerald-700 shadow-sm border border-emerald-100 shrink-0">
                    <ion-icon [name]="payment.type === 'credit' ? 'arrow-down-outline' : 'arrow-up-outline'"></ion-icon>
                  </div>
                  <div class="min-w-0">
                    <h5 class="text-sm font-bold text-slate-900 truncate">{{ payment.user?.first_name || 'Unknown' }}</h5>
                    <p class="text-xs text-slate-600 mt-1 truncate">{{ payment.description || 'Wallet transaction' }}</p>
                  </div>
                </div>

                <p [class]="'text-sm font-bold whitespace-nowrap ' + (payment.type === 'credit' ? 'text-emerald-700' : 'text-rose-700')">
                  {{ payment.type === 'credit' ? '+' : '-' }}{{ formatPrice(payment.amount || 0) }}
                </p>
              </div>
            }

            @if ((recentPayments() || []).length === 0) {
              <p class="text-center py-10 text-slate-400 text-sm">No recent transactions.</p>
            }
          </div>
        </div>
      </div>

      <div class="rounded-[1.5rem] bg-white border border-slate-100 shadow-sm overflow-hidden">
        <div class="p-5 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 class="text-lg font-bold text-slate-950">System Events</h3>
            <p class="text-sm text-slate-500 font-medium">Latest internal activity feed.</p>
          </div>
          <app-badge variant="info">Live Feed</app-badge>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left min-w-[720px]">
            <thead>
              <tr class="text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100 bg-slate-50/70">
                <th class="py-4 px-5">Event</th>
                <th class="py-4 px-5">User</th>
                <th class="py-4 px-5">Time</th>
                <th class="py-4 px-5">Details</th>
              </tr>
            </thead>

            <tbody class="divide-y divide-slate-100">
              @for (event of (events() || []); track event.id) {
                <tr class="text-sm hover:bg-slate-50/80 transition-colors">
                  <td class="py-4 px-5">
                    <app-badge variant="secondary">{{ (event.type || 'system').replace('_', ' ') }}</app-badge>
                  </td>
                  <td class="py-4 px-5 font-bold text-slate-900">{{ event.user?.first_name || 'System' }}</td>
                  <td class="py-4 px-5 text-slate-500 font-medium">{{ event.created_at | date:'shortTime' }}</td>
                  <td class="py-4 px-5 text-slate-500 text-xs truncate max-w-xs font-mono">
                    {{ event.payload || {} | json }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        @if ((events() || []).length === 0) {
          <p class="text-center py-10 text-slate-400 text-sm">No system events yet.</p>
        }
      </div>
    </div>
  `,
    styles: [`
    .metric-panel {
      border-radius: 1.5rem;
      padding: 1.5rem;
      box-shadow: 0 18px 45px rgb(15 23 42 / 0.10);
      position: relative;
      overflow: hidden;
    }

    .metric-label {
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      margin-bottom: 0.75rem;
    }

    .metric-value {
      font-size: clamp(2rem, 5vw, 3.5rem);
      font-weight: 900;
      line-height: 1;
      letter-spacing: -0.04em;
    }

    .metric-note {
      margin-top: 1.25rem;
      font-size: 0.8rem;
      font-weight: 600;
    }

    .legend-dot {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 10px;
      font-weight: 800;
      color: rgb(100 116 139);
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }

    .legend-dot::before {
      content: "";
      width: 0.7rem;
      height: 0.7rem;
      border-radius: 9999px;
      background: currentColor;
    }
  `]
})
export class AdminDashboardComponent implements OnInit, OnDestroy {
    @ViewChild('adminMap') adminMap!: MapComponent;

    private adminService = inject(AdminService);
    private supabase = inject(SupabaseService);
    private config = inject(AppConfigService);
    private anomalyService = inject(JobAnomalyService);

    stats = this.adminService.stats;
    activeJobs = signal<Job[]>([]);
    stuckJobs = signal<JobAnomaly[]>([]);
    operationalMetrics = signal<OperationalMetrics | null>(null);
    failedBookings = signal<FailedBooking[]>([]);
    recentPayments = signal<WalletTransaction[]>([]);
    events = signal<AdminEvent[]>([]);
    revenueBars: RevenueBar[] = [];
    statsList: DashboardStat[] = [];

    private channels: RealtimeChannel[] = [];

    async ngOnInit() {
        if (!this.supabase.isConfigured) {
            console.warn('AdminDashboard: Supabase is not configured.');
            return;
        }

        await this.refreshData();

        // Keep disabled until Kong realtime websocket config is stable.
        // this.setupRealtime();
    }

    ngOnDestroy() {
        this.channels.forEach(channel => channel.unsubscribe());
    }

    async refreshData() {
        try {
            await this.adminService.fetchStats();
            this.updateStatsList();

            const [jobs, metrics, evs, failures, payments] = await Promise.all([
                this.adminService.getJobs(),
                this.adminService.getOperationalMetrics(),
                this.adminService.getEvents(10),
                this.adminService.getFailedBookings(),
                this.adminService.getRecentPayments()
            ]);

            const allJobs = Array.isArray(jobs) ? jobs as Job[] : [];
            const safeEvents = Array.isArray(evs) ? evs as AdminEvent[] : [];
            const safeFailures = Array.isArray(failures) ? failures : [];
            const safePayments = Array.isArray(payments) ? payments : [];

            this.activeJobs.set(
                allJobs
                    .filter(job => ['accepted', 'arrived', 'assigned', 'in_progress', 'heading_to_pickup'].includes(job.status))
                    .slice(0, 5)
            );

            this.stuckJobs.set(this.anomalyService.detectAnomalies(allJobs));
            this.operationalMetrics.set((metrics || null) as OperationalMetrics | null);
            this.events.set(safeEvents);
            this.failedBookings.set(safeFailures);
            this.recentPayments.set(safePayments);

            const revenueData = await this.adminService.getRevenueStats();
            const safeRevenueData = Array.isArray(revenueData) ? revenueData : [];
            const maxValue = Math.max(...safeRevenueData.map(item => item.value || 0), 100);

            this.revenueBars = safeRevenueData.map(item => ({
                ...item,
                height: Math.max(4, ((item.value || 0) / maxValue) * 100)
            }));

            try {
                const heatmap = await this.adminService.getHeatmapData();

                if (heatmap?.zones && Array.isArray(heatmap.zones) && this.adminMap) {
                    this.adminMap.drawHeatmap(heatmap.zones);

                    if (heatmap.zones.length > 0) {
                        this.adminMap.setCenter(heatmap.zones[0].lng, heatmap.zones[0].lat, 12);
                    }
                }
            } catch (error) {
                console.error('Failed to load heatmap', error);
            }
        } catch (error) {
            console.error('AdminDashboard refreshData failed:', error);
        }
    }

    private setupRealtime() {
        const jobsChannel = this.supabase.client
            .channel('admin-dashboard-jobs')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, () => {
                this.refreshData();
            })
            .subscribe();

        const profilesChannel = this.supabase.client
            .channel('admin-dashboard-profiles')
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, () => {
                this.refreshData();
            })
            .subscribe();

        this.channels = [jobsChannel, profilesChannel];
    }

    private updateStatsList() {
        this.statsList = [
            {
                label: 'Total Revenue',
                value: this.formatNumber(this.stats().totalRevenue || 0),
                prefix: this.config.currencySymbol,
                icon: 'cash-outline',
                bgClass: 'bg-emerald-100',
                iconClass: 'text-emerald-700',
                note: 'Revenue tracked'
            },
            {
                label: 'Total Users',
                value: this.formatNumber(this.stats().totalUsers || 0),
                icon: 'people-outline',
                bgClass: 'bg-blue-100',
                iconClass: 'text-blue-700',
                note: 'Registered users'
            },
            {
                label: 'Active Drivers',
                value: this.formatNumber(this.stats().totalDrivers || 0),
                icon: 'car-outline',
                bgClass: 'bg-amber-100',
                iconClass: 'text-amber-700',
                note: 'Driver accounts'
            },
            {
                label: 'Total Jobs',
                value: this.formatNumber(this.stats().totalJobs || 0),
                icon: 'calendar-outline',
                bgClass: 'bg-indigo-100',
                iconClass: 'text-indigo-700',
                note: 'Jobs created'
            }
        ];
    }

    formatPrice(amount: number) {
        return this.config.formatCurrency(amount || 0);
    }

    formatNumber(value: number) {
        return Number(value || 0).toLocaleString();
    }
}