import { Component, inject, OnInit, signal } from '@angular/core';
import { AdminService } from '../../services/admin.service';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { RouterModule } from '@angular/router';
import { SupabaseService } from '../../../../core/services/supabase/supabase.service';
import { CardComponent, ButtonComponent, BadgeComponent } from '../../../../shared/ui';

import { Booking } from '../../../../shared/models/booking.model';

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

@Component({
  selector: 'app-admin-dashboard',
  template: `
    <div class="space-y-8 container-padding">
      <!-- Header -->
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 class="text-3xl font-display font-bold text-text-primary">Operations Dashboard</h1>
          <p class="text-text-secondary">Real-time platform monitoring and insights</p>
        </div>
        <div class="flex items-center gap-3">
          <app-badge variant="success" class="animate-pulse">System Online</app-badge>
          <span class="text-xs font-bold text-text-secondary uppercase tracking-widest">Last updated: Just now</span>
        </div>
      </div>

      <!-- Stuck Bookings Alert -->
      @if (stuckBookings().length > 0) {
        <div class="bg-error/5 border border-error/10 rounded-3xl p-6 flex flex-col md:flex-row items-center justify-between gap-4 animate-pulse">
          <div class="flex items-center gap-4">
            <div class="w-12 h-12 rounded-2xl bg-error/10 flex items-center justify-center text-error">
              <ion-icon name="alert-circle-outline" class="text-2xl"></ion-icon>
            </div>
            <div>
              <h3 class="text-lg font-bold text-error">{{ stuckBookings().length }} Stuck Bookings Detected</h3>
              <p class="text-sm text-error/80">These bookings have been searching for a driver for over 5 minutes.</p>
            </div>
          </div>
          <app-button variant="danger" size="sm" [fullWidth]="false" routerLink="/admin/bookings">
            Take Action
          </app-button>
        </div>
      }

      <!-- Stats Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        @for (stat of statsList; track stat.label) {
          <app-card [hoverable]="true">
            <div class="flex items-center justify-between mb-4">
              <div [class]="'w-12 h-12 rounded-2xl flex items-center justify-center ' + stat.colorClass">
                <ion-icon [name]="stat.icon" class="text-2xl"></ion-icon>
              </div>
              <span class="text-[10px] font-bold text-text-secondary uppercase tracking-widest">{{ stat.label }}</span>
            </div>
            <div class="flex items-baseline gap-2">
              <h3 class="text-3xl font-display font-bold text-text-primary tracking-tight">
                @if (stat.prefix) {
                  <span class="text-sm font-medium text-text-secondary mr-1">{{ stat.prefix }}</span>
                }
                {{ stat.value }}
              </h3>
            </div>
            <div class="mt-4 flex items-center gap-2 text-[10px] font-bold text-success uppercase tracking-tighter">
              <ion-icon name="trending-up-outline"></ion-icon>
              <span>Operational Status: Active</span>
            </div>
          </app-card>
        }
      </div>

      <!-- Operational Insights -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div class="bg-secondary text-white p-8 rounded-3xl shadow-xl relative overflow-hidden group">
          <div class="relative z-10">
            <p class="text-gray-400 text-[10px] font-bold uppercase tracking-widest mb-2">Drivers Online</p>
            <h4 class="text-5xl font-display font-bold">{{ operationalMetrics()?.online_drivers_count || 0 }}</h4>
            <div class="mt-6 flex items-center gap-2 text-gray-400 text-sm font-medium">
              <div class="w-2 h-2 rounded-full bg-primary animate-pulse"></div>
              <span>Live Monitoring Active</span>
            </div>
          </div>
          <ion-icon name="car" class="absolute -right-6 -bottom-6 text-9xl text-white/5 rotate-12 group-hover:scale-110 transition-transform duration-500"></ion-icon>
        </div>

        <div class="bg-primary text-white p-8 rounded-3xl shadow-xl relative overflow-hidden group">
          <div class="relative z-10">
            <p class="text-white/70 text-[10px] font-bold uppercase tracking-widest mb-2">Revenue Today</p>
            <h4 class="text-5xl font-display font-bold">{{ operationalMetrics()?.revenue_today || 0 | currency:'GBP' }}</h4>
            <p class="mt-6 text-white/70 text-sm font-medium">Platform Fee: 15%</p>
          </div>
          <ion-icon name="cash" class="absolute -right-6 -bottom-6 text-9xl text-white/10 rotate-12 group-hover:scale-110 transition-transform duration-500"></ion-icon>
        </div>

        <div class="bg-blue-600 text-white p-8 rounded-3xl shadow-xl relative overflow-hidden group">
          <div class="relative z-10">
            <p class="text-white/70 text-[10px] font-bold uppercase tracking-widest mb-2">Active Jobs</p>
            <h4 class="text-5xl font-display font-bold">{{ operationalMetrics()?.active_jobs_count || 0 }}</h4>
            <p class="mt-6 text-white/70 text-sm font-medium">Real-time Dispatching</p>
          </div>
          <ion-icon name="map" class="absolute -right-6 -bottom-6 text-9xl text-white/10 rotate-12 group-hover:scale-110 transition-transform duration-500"></ion-icon>
        </div>
      </div>

      <!-- Charts & Recent Activity -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <!-- Revenue Chart -->
        <app-card class="lg:col-span-2" title="Revenue Overview">
          <div header-action>
            <select class="bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 text-xs font-bold text-text-secondary uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-primary/20">
              <option>Last 7 Days</option>
              <option>Last 30 Days</option>
              <option>Last 12 Months</option>
            </select>
          </div>
          
          <div class="h-80 w-full flex items-end justify-between gap-4 px-4 pt-8">
            @for (bar of revenueBars; track bar.day) {
              <div class="flex-1 flex flex-col items-center gap-4 group">
                <div class="w-full bg-gray-50 rounded-t-2xl relative overflow-hidden flex items-end" [style.height.%]="bar.height || 0">
                  <div class="absolute inset-0 bg-primary opacity-0 group-hover:opacity-100 transition-all duration-300"></div>
                  <div class="w-full bg-primary/20 group-hover:bg-primary transition-all duration-300" [style.height.%]="100"></div>
                </div>
                <span class="text-[10px] font-bold text-text-secondary uppercase tracking-widest">{{ bar.day }}</span>
              </div>
            }
          </div>
        </app-card>

        <!-- Active Bookings -->
        <app-card title="Active Bookings">
          <div class="space-y-4">
            @for (booking of activeBookings(); track booking.id) {
              <div class="flex items-center gap-4 p-4 bg-gray-50 rounded-2xl border border-gray-100 hover:border-primary/20 transition-all group cursor-pointer">
                <div class="w-12 h-12 rounded-xl bg-white flex items-center justify-center text-primary shadow-sm group-hover:scale-110 transition-transform">
                  <ion-icon name="car-outline" class="text-2xl"></ion-icon>
                </div>
                <div class="flex-1 min-w-0">
                  <h4 class="text-sm font-bold text-text-primary truncate">{{ booking.pickup_address }}</h4>
                  <p class="text-[10px] text-text-secondary truncate uppercase font-bold tracking-tighter">{{ booking.dropoff_address }}</p>
                </div>
                <div class="text-right">
                  <app-badge variant="info" class="text-[8px]">{{ booking.status }}</app-badge>
                  <p class="text-sm font-bold text-text-primary mt-1">£{{ booking.total_price }}</p>
                </div>
              </div>
            }
            @if (activeBookings().length === 0) {
              <div class="text-center py-12">
                <ion-icon name="calendar-outline" class="text-4xl text-gray-200 mb-2"></ion-icon>
                <p class="text-text-secondary text-sm font-medium">No active bookings at the moment.</p>
              </div>
            }
          </div>
          <div footer>
            <app-button variant="secondary" size="sm" routerLink="/admin/bookings">
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
              <tr class="text-[10px] font-bold text-text-secondary uppercase tracking-widest border-b border-gray-50">
                <th class="pb-4">Event</th>
                <th class="pb-4">User</th>
                <th class="pb-4">Time</th>
                <th class="pb-4">Details</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
              @for (event of events(); track event.id) {
                <tr class="text-sm group hover:bg-gray-50/50 transition-colors">
                  <td class="py-4">
                    <app-badge variant="secondary" class="text-[8px]">{{ event.type.replace('_', ' ') }}</app-badge>
                  </td>
                  <td class="py-4 font-bold text-text-primary">{{ event.user?.first_name || 'System' }}</td>
                  <td class="py-4 text-text-secondary font-medium">{{ event.created_at | date:'shortTime' }}</td>
                  <td class="py-4 text-text-secondary text-xs truncate max-w-xs font-mono">{{ event.payload | json }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </app-card>
    </div>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule, RouterModule, CardComponent, ButtonComponent, BadgeComponent]
})
export class AdminDashboardComponent implements OnInit {
  private adminService = inject(AdminService);
  private supabase = inject(SupabaseService);
  
  stats = this.adminService.stats;
  activeBookings = signal<Booking[]>([]);
  stuckBookings = signal<Booking[]>([]);
  operationalMetrics = signal<any>(null);
  events = signal<any[]>([]);
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
    this.operationalMetrics.set(metrics);
    this.events.set(evs);

    const revenueData = await this.adminService.getRevenueStats();
    const maxValue = Math.max(...revenueData.map(d => d.value), 100);
    this.revenueBars = revenueData.map(d => ({
      ...d,
      height: (d.value / maxValue) * 100
    }));
  }

  private updateStatsList() {
    this.statsList = [
      { label: 'Total Revenue', value: this.stats().totalRevenue, prefix: 'USD', icon: 'cash-outline', colorClass: 'bg-emerald-100 text-emerald-600' },
      { label: 'Total Users', value: this.stats().totalUsers, icon: 'people-outline', colorClass: 'bg-blue-100 text-blue-600' },
      { label: 'Active Drivers', value: this.stats().totalDrivers, icon: 'car-outline', colorClass: 'bg-amber-100 text-amber-600' },
      { label: 'Total Bookings', value: this.stats().totalBookings, icon: 'calendar-outline', colorClass: 'bg-indigo-100 text-indigo-600' },
    ];
  }
}
