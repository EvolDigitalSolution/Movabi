import { Component, inject, OnInit, signal } from '@angular/core';
import { AdminService } from '../../services/admin.service';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { RouterModule } from '@angular/router';
import { SupabaseService } from '../../../../core/services/supabase/supabase.service';
import { CardComponent, ButtonComponent, BadgeComponent, EmptyStateComponent } from '../../../../shared/ui';
import { AppConfigService } from '../../../../core/services/config/app-config.service';

import { Booking, Profile } from '../../../../shared/models/booking.model';

interface DashboardStat {
  label: string;
  value: number;
  prefix?: string;
  icon: string;
  colorClass: string;
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
  template: `
    <div class="space-y-10 container-padding pb-12 bg-slate-50 min-h-screen">
      <!-- Header -->
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-10 pt-8">
        <div>
          <h1 class="text-4xl font-display font-bold text-slate-900 tracking-tight">Operations Dashboard</h1>
          <p class="text-slate-500 font-medium text-lg mt-1">Real-time platform monitoring and insights</p>
        </div>
        <div class="flex items-center gap-4">
          <div class="flex items-center gap-2 bg-emerald-50 px-4 py-2 rounded-full border border-emerald-100 animate-pulse">
            <div class="w-2 h-2 rounded-full bg-emerald-500"></div>
            <span class="text-xs font-bold text-emerald-600 uppercase tracking-widest">System Online</span>
          </div>
          <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Last updated: Just now</span>
        </div>
      </div>

      <!-- Stuck Bookings Alert -->
      @if (stuckBookings().length > 0) {
        <div class="bg-red-50 border border-red-100 rounded-[2rem] p-8 flex flex-col md:flex-row items-center justify-between gap-6 shadow-xl shadow-red-600/5">
          <div class="flex items-center gap-6">
            <div class="w-16 h-16 rounded-3xl bg-red-100 flex items-center justify-center text-red-600 shadow-lg shadow-red-600/10">
              <ion-icon name="alert-circle" class="text-3xl"></ion-icon>
            </div>
            <div>
              <h3 class="text-xl font-bold text-red-900">{{ stuckBookings().length }} Stuck Bookings Detected</h3>
              <p class="text-slate-600 font-medium">These bookings have been searching for a driver for over 5 minutes.</p>
            </div>
          </div>
          <app-button variant="error" size="md" [fullWidth]="false" routerLink="/admin/bookings" class="px-8">
            Take Action
          </app-button>
        </div>
      }

      <!-- Stats Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
        @for (stat of statsList; track stat.label) {
          <app-card [hoverable]="true" class="group">
            <div class="flex items-center justify-between mb-6">
              <div [class]="'w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-transform group-hover:scale-110 ' + stat.colorClass">
                <ion-icon [name]="stat.icon" class="text-2xl"></ion-icon>
              </div>
              <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{{ stat.label }}</span>
            </div>
            <div class="flex items-baseline gap-2">
              <h3 class="text-4xl font-display font-bold text-slate-900 tracking-tight">
                @if (stat.prefix) {
                  <span class="text-sm font-medium text-slate-400 mr-1">{{ stat.prefix }}</span>
                }
                {{ stat.value }}
              </h3>
            </div>
            <div class="mt-6 flex items-center gap-2 text-[10px] font-bold text-emerald-600 uppercase tracking-widest">
              <ion-icon name="trending-up-outline" class="text-sm"></ion-icon>
              <span>Operational Status: Active</span>
            </div>
          </app-card>
        }
      </div>

      <!-- Operational Insights -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div class="bg-slate-900 text-white p-10 rounded-[2.5rem] shadow-2xl relative overflow-hidden group">
          <!-- Background Image -->
          <div class="absolute inset-0">
            <img src="assets/images/movabi-admin-drivers.webp" 
                 alt="Drivers" 
                 class="w-full h-full object-cover opacity-20 group-hover:scale-110 transition-transform duration-1000"
                 referrerpolicy="no-referrer">
          </div>
          <div class="absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-900/80 to-transparent"></div>

          <div class="relative z-10">
            <p class="text-slate-400 text-[10px] font-bold uppercase tracking-widest mb-3">Drivers Online</p>
            <h4 class="text-6xl font-display font-bold tracking-tighter">{{ operationalMetrics()?.online_drivers_count || 0 }}</h4>
            <div class="mt-8 flex items-center gap-3 text-slate-400 text-sm font-medium">
              <div class="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse"></div>
              <span>Live Monitoring Active</span>
            </div>
          </div>
        </div>

        <div class="bg-blue-600 text-white p-10 rounded-[2.5rem] shadow-2xl shadow-blue-600/20 relative overflow-hidden group">
          <!-- Background Image -->
          <div class="absolute inset-0">
            <img src="assets/images/movabi-admin-revenue.webp" 
                 alt="Revenue" 
                 class="w-full h-full object-cover opacity-20 group-hover:scale-110 transition-transform duration-1000"
                 referrerpolicy="no-referrer">
          </div>
          <div class="absolute inset-0 bg-gradient-to-br from-blue-600 via-blue-600/80 to-transparent"></div>

          <div class="relative z-10">
            <p class="text-white/70 text-[10px] font-bold uppercase tracking-widest mb-3">Platform Earnings Today</p>
            <h4 class="text-6xl font-display font-bold tracking-tighter">{{ formatPrice(operationalMetrics()?.platform_earnings_today || 0) }}</h4>
            <div class="mt-8 flex flex-col gap-2">
              <p class="text-white/70 text-xs font-medium flex items-center">
                <ion-icon name="cash-outline" class="mr-2"></ion-icon>
                Total Fare: {{ formatPrice(operationalMetrics()?.revenue_today || 0) }}
              </p>
              <p class="text-white/70 text-xs font-medium flex items-center">
                <ion-icon name="people-outline" class="mr-2"></ion-icon>
                Driver Payouts: {{ formatPrice(operationalMetrics()?.driver_payouts_today || 0) }}
              </p>
            </div>
          </div>
        </div>

        <div class="bg-indigo-600 text-white p-10 rounded-[2.5rem] shadow-2xl shadow-indigo-600/20 relative overflow-hidden group">
          <!-- Background Image -->
          <div class="absolute inset-0">
            <img src="assets/images/movabi-admin-jobs.webp" 
                 alt="Jobs" 
                 class="w-full h-full object-cover opacity-20 group-hover:scale-110 transition-transform duration-1000"
                 referrerpolicy="no-referrer">
          </div>
          <div class="absolute inset-0 bg-gradient-to-br from-indigo-600 via-indigo-600/80 to-transparent"></div>

          <div class="relative z-10">
            <p class="text-white/70 text-[10px] font-bold uppercase tracking-widest mb-3">Job Breakdown</p>
            <h4 class="text-6xl font-display font-bold tracking-tighter">{{ operationalMetrics()?.active_jobs_count || 0 }}</h4>
            <div class="mt-8 flex flex-col gap-2">
              <p class="text-white/70 text-xs font-medium flex items-center">
                <ion-icon name="star-outline" class="mr-2"></ion-icon>
                Pro Plan Jobs: {{ operationalMetrics()?.pro_jobs_count || 0 }}
              </p>
              <p class="text-white/70 text-xs font-medium flex items-center">
                <ion-icon name="flash-outline" class="mr-2"></ion-icon>
                Starter Plan Jobs: {{ operationalMetrics()?.starter_jobs_count || 0 }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Charts & Recent Activity -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-10">
        <!-- Revenue Chart -->
        <app-card class="lg:col-span-2" title="Revenue Overview">
          <div header-action>
            <select class="bg-slate-50 border border-slate-200 rounded-2xl px-5 py-2.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest focus:outline-none focus:ring-4 focus:ring-blue-500/10 transition-all">
              <option>Last 7 Days</option>
              <option>Last 30 Days</option>
              <option>Last 12 Months</option>
            </select>
          </div>
          
          <div class="h-96 w-full flex items-end justify-between gap-6 px-4 pt-12">
            @for (bar of revenueBars; track bar.day) {
              <div class="flex-1 flex flex-col items-center gap-6 group">
                <div class="w-full bg-slate-50 rounded-t-3xl relative overflow-hidden flex items-end" [style.height.%]="bar.height || 0">
                  <div class="absolute inset-0 bg-blue-600 opacity-0 group-hover:opacity-100 transition-all duration-500"></div>
                  <div class="w-full bg-blue-600/10 group-hover:bg-blue-600 transition-all duration-500" [style.height.%]="100"></div>
                </div>
                <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{{ bar.day }}</span>
              </div>
            }
          </div>
        </app-card>

        <!-- Active Bookings -->
        <app-card title="Active Bookings">
          <div class="space-y-5">
            @for (booking of activeBookings(); track booking.id) {
              <div class="flex items-center gap-5 p-5 bg-slate-50 rounded-[1.5rem] border border-slate-100 hover:border-blue-500/20 hover:bg-white hover:shadow-xl hover:shadow-blue-600/5 transition-all group cursor-pointer">
                <div class="w-14 h-14 rounded-2xl bg-white flex items-center justify-center text-blue-600 shadow-sm border border-slate-100 group-hover:scale-110 transition-transform">
                  <ion-icon name="car" class="text-2xl"></ion-icon>
                </div>
                <div class="flex-1 min-w-0">
                  <h4 class="text-sm font-bold text-slate-900 truncate">{{ booking.pickup_address }}</h4>
                  <p class="text-[10px] text-slate-400 truncate uppercase font-bold tracking-widest mt-1">{{ booking.dropoff_address }}</p>
                </div>
                <div class="text-right">
                  <app-badge variant="info">{{ booking.status }}</app-badge>
                  <p class="text-sm font-bold text-slate-900 mt-2">{{ formatPrice(booking.total_price) }}</p>
                </div>
              </div>
            }
            @if (activeBookings().length === 0) {
              <div class="text-center py-20">
                <div class="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-6 border border-slate-100">
                  <ion-icon name="calendar-outline" class="text-3xl text-slate-300"></ion-icon>
                </div>
                <p class="text-slate-500 text-sm font-medium">No active bookings at the moment.</p>
              </div>
            }
          </div>
          <div footer>
            <app-button variant="secondary" size="md" routerLink="/admin/bookings">
              View All Bookings
            </app-button>
          </div>
        </app-card>
      </div>

      <!-- Live Events Log -->
      <app-card title="System Events">
        <div header-action>
          <app-badge variant="info">Live Feed</app-badge>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead>
              <tr class="text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-50">
                <th class="pb-6 px-4">Event</th>
                <th class="pb-6 px-4">User</th>
                <th class="pb-6 px-4">Time</th>
                <th class="pb-6 px-4">Details</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-50">
              @for (event of events(); track event.id) {
                <tr class="text-sm group hover:bg-slate-50/80 transition-colors">
                  <td class="py-5 px-4">
                    <app-badge variant="secondary">{{ event.type.replace('_', ' ') }}</app-badge>
                  </td>
                  <td class="py-5 px-4 font-bold text-slate-900">{{ event.user?.first_name || 'System' }}</td>
                  <td class="py-5 px-4 text-slate-500 font-medium">{{ event.created_at | date:'shortTime' }}</td>
                  <td class="py-5 px-4 text-slate-400 text-xs truncate max-w-xs font-mono">{{ event.payload | json }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </app-card>
    </div>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule, RouterModule, CardComponent, ButtonComponent, BadgeComponent, EmptyStateComponent]
})
export class AdminDashboardComponent implements OnInit {
  private adminService = inject(AdminService);
  private supabase = inject(SupabaseService);
  private config = inject(AppConfigService);
  
  stats = this.adminService.stats;
  activeBookings = signal<Booking[]>([]);
  stuckBookings = signal<Booking[]>([]);
  operationalMetrics = signal<OperationalMetrics | null>(null);
  events = signal<AdminEvent[]>([]);
  revenueBars: RevenueBar[] = [];
  statsList: DashboardStat[] = [];

  async ngOnInit() {
    if (!this.supabase.isConfigured) {
      console.warn('AdminDashboard: Supabase is not configured.');
      return;
    }

    await this.adminService.fetchStats();
    this.updateStatsList();
    
    const [bookings, stuck, metrics, evs] = await Promise.all([
      this.adminService.getLiveBookings(),
      this.adminService.getStuckBookings(),
      this.adminService.getOperationalMetrics(),
      this.adminService.getEvents(10)
    ]);

    this.activeBookings.set(bookings.filter(b => ['accepted', 'arrived', 'in_progress'].includes(b.status)).slice(0, 5));
    this.stuckBookings.set(stuck);
    this.operationalMetrics.set(metrics as OperationalMetrics);
    this.events.set(evs as AdminEvent[]);

    const revenueData = await this.adminService.getRevenueStats();
    const maxValue = Math.max(...revenueData.map(d => d.value), 100);
    this.revenueBars = revenueData.map(d => ({
      ...d,
      height: (d.value / maxValue) * 100
    }));
  }

  private updateStatsList() {
    this.statsList = [
      { label: 'Total Revenue', value: this.stats().totalRevenue, prefix: this.config.currencySymbol, icon: 'cash-outline', colorClass: 'bg-emerald-100 text-emerald-600' },
      { label: 'Total Users', value: this.stats().totalUsers, icon: 'people-outline', colorClass: 'bg-blue-100 text-blue-600' },
      { label: 'Active Drivers', value: this.stats().totalDrivers, icon: 'car-outline', colorClass: 'bg-amber-100 text-amber-600' },
      { label: 'Total Bookings', value: this.stats().totalBookings, icon: 'calendar-outline', colorClass: 'bg-indigo-100 text-indigo-600' },
    ];
  }

  formatPrice(amount: number) {
    return this.config.formatCurrency(amount);
  }
}
