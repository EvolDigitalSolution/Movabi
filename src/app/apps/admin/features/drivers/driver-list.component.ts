import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { AdminService } from '../../services/admin.service';
import { DriverProfile, Vehicle } from '../../../../shared/models/booking.model';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { BadgeComponent, ButtonComponent, RatingComponent, EmptyStateComponent } from '../../../../shared/ui';

@Component({
  selector: 'app-driver-list',
  template: `
    <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-2xl shadow-slate-200/40 overflow-hidden">
      <div class="p-10 border-b border-slate-50 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h3 class="text-2xl font-display font-bold text-slate-900">Driver Management</h3>
          <p class="text-slate-500 font-medium mt-1">Verify drivers and monitor their performance.</p>
        </div>
        <div class="flex flex-col sm:flex-row items-center gap-4">
          <div class="relative w-full sm:w-48 group">
            <ion-icon name="card-outline" class="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-600 transition-colors"></ion-icon>
            <select (change)="onPlanFilterChange($event)" 
                    class="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-12 pr-5 py-3 text-sm font-medium text-slate-600 focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/50 transition-all appearance-none">
              <option value="all">All Plans</option>
              <option value="starter">Starter</option>
              <option value="pro">Pro</option>
            </select>
          </div>
          <div class="relative w-full sm:w-48 group">
            <ion-icon name="funnel-outline" class="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-600 transition-colors"></ion-icon>
            <select (change)="onStatusFilterChange($event)" 
                    class="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-12 pr-5 py-3 text-sm font-medium text-slate-600 focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/50 transition-all appearance-none">
              <option value="all">All Statuses</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="busy">Busy</option>
              <option value="suspended">Suspended</option>
              <option value="pending">Pending Approval</option>
            </select>
          </div>
          <div class="relative w-full sm:w-64 group">
            <ion-icon name="search-outline" class="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-600 transition-colors"></ion-icon>
            <input type="text" placeholder="Search drivers..." (input)="onSearch($event)"
                   class="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-12 pr-5 py-3 text-sm font-medium text-slate-600 focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/50 transition-all">
          </div>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-slate-50/50">
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Driver</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Plan</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Vehicle</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Metrics</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Verification</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Status</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-50">
            @for (driver of filteredDrivers(); track driver.id) {
              <tr class="hover:bg-slate-50/80 transition-all group">
                <td class="px-10 py-6">
                  <div class="flex items-center gap-4">
                    <div class="w-12 h-12 rounded-2xl bg-amber-50 flex items-center justify-center text-amber-600 font-bold text-sm border border-amber-100 shadow-sm">
                      {{ driver.first_name[0] || 'D' }}
                    </div>
                    <div>
                      <h4 class="text-sm font-bold text-slate-900">{{ driver.first_name }} {{ driver.last_name }}</h4>
                      <div class="mt-1">
                        <app-rating [rating]="driver.rating"></app-rating>
                      </div>
                    </div>
                  </div>
                </td>
                <td class="px-10 py-6">
                  <div class="flex flex-col gap-1">
                    <app-badge [variant]="driver.pricing_plan === 'pro' ? 'primary' : 'secondary'">
                      {{ driver.pricing_plan || 'starter' | uppercase }}
                    </app-badge>
                    <span class="text-[10px] text-slate-400 font-bold uppercase tracking-widest text-center">
                      {{ driver.commission_rate || 15 }}% Fee
                    </span>
                  </div>
                </td>
                <td class="px-10 py-6">
                  @if (driver.vehicles[0]) {
                    <div class="text-sm font-bold text-slate-900">
                      {{ driver.vehicles[0].make }} {{ driver.vehicles[0].model }}
                      <div class="flex gap-2 mt-1">
                        <span class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">{{ driver.vehicles[0].license_plate }}</span>
                        <span class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">•</span>
                        <span class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">{{ driver.vehicles[0].color }}</span>
                      </div>
                    </div>
                  } @else {
                    <span class="text-[10px] text-slate-400 font-bold uppercase tracking-widest italic">No vehicle</span>
                  }
                </td>
                <td class="px-10 py-6">
                  <div class="space-y-2">
                    <div class="flex items-center justify-between gap-4 min-w-[140px]">
                      <span class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Trips</span>
                      <span class="text-xs font-bold text-slate-900">{{ driver.total_trips || 0 }}</span>
                    </div>
                    <div class="flex items-center justify-between gap-4">
                      <span class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Acceptance</span>
                      <app-badge [variant]="getMetricVariant(driver.acceptance_rate || 0)">
                        {{ getMetricLabel(driver.acceptance_rate || 0) }}
                      </app-badge>
                    </div>
                  </div>
                </td>
                <td class="px-10 py-6">
                  <div class="flex items-center gap-3">
                    <ion-toggle [checked]="driver.is_verified" (ionChange)="toggleVerification(driver.id, $event.detail.checked)" class="scale-90"></ion-toggle>
                    <app-badge [variant]="driver.is_verified ? 'success' : 'warning'">
                      {{ driver.is_verified ? 'Verified' : 'Pending' }}
                    </app-badge>
                  </div>
                </td>
                <td class="px-10 py-6">
                  <app-badge [variant]="driver.status === 'online' ? 'success' : driver.status === 'busy' ? 'warning' : 'secondary'">
                    {{ driver.status }}
                  </app-badge>
                </td>
                <td class="px-10 py-6 text-right">
                  <button class="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 hover:bg-blue-600 hover:text-white hover:shadow-lg hover:shadow-blue-600/20 transition-all flex items-center justify-center mx-auto sm:ml-auto">
                    <ion-icon name="eye-outline" class="text-xl"></ion-icon>
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
        
        @if (filteredDrivers().length === 0) {
          <app-empty-state 
            icon="people-outline"
            title="No drivers found"
            description="We couldn't find any drivers matching your current filters or search criteria."
          ></app-empty-state>
        }
      </div>
    </div>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule, BadgeComponent, ButtonComponent, RatingComponent, EmptyStateComponent]
})
export class DriverListComponent implements OnInit {
  private adminService = inject(AdminService);
  drivers = signal<(DriverProfile & { vehicles: Vehicle[] })[]>([]);
  searchTerm = signal('');
  statusFilter = signal('all');
  planFilter = signal('all');

  filteredDrivers = computed(() => {
    const term = this.searchTerm().toLowerCase();
    const status = this.statusFilter();
    const plan = this.planFilter();
    
    return this.drivers().filter(driver => {
      const matchesSearch = 
        driver.first_name.toLowerCase().includes(term) || 
        driver.last_name.toLowerCase().includes(term) ||
        driver.email.toLowerCase().includes(term) ||
        driver.vehicles[0]?.license_plate.toLowerCase().includes(term);
      
      const matchesStatus = status === 'all' || driver.status === status;
      const matchesPlan = plan === 'all' || (driver.pricing_plan || 'starter') === plan;
      
      return matchesSearch && matchesStatus && matchesPlan;
    });
  });

  async ngOnInit() {
    const data = await this.adminService.getDrivers();
    this.drivers.set(data as (DriverProfile & { vehicles: Vehicle[] })[]);
  }

  onSearch(event: Event) {
    const input = event.target as HTMLInputElement;
    this.searchTerm.set(input.value);
  }

  onStatusFilterChange(event: Event) {
    const select = event.target as HTMLSelectElement;
    this.statusFilter.set(select.value);
  }

  onPlanFilterChange(event: Event) {
    const select = event.target as HTMLSelectElement;
    this.planFilter.set(select.value);
  }

  async toggleVerification(driverId: string, isVerified: boolean) {
    await this.adminService.verifyDriver(driverId, isVerified);
    // Update local state
    this.drivers.update(drivers => drivers.map(d => d.id === driverId ? { ...d, is_verified: isVerified } : d));
  }

  getMetricLabel(value: number): string {
    if (value >= 85) return 'Excellent';
    if (value >= 70) return 'Good';
    return 'Needs improvement';
  }

  getMetricVariant(value: number): 'success' | 'warning' | 'error' | 'info' {
    if (value >= 85) return 'success';
    if (value >= 70) return 'info';
    return 'warning';
  }
}
