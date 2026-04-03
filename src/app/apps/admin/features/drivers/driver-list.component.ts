import { Component, inject, OnInit, signal } from '@angular/core';
import { AdminService } from '../../services/admin.service';
import { DriverProfile, Vehicle } from '../../../../shared/models/booking.model';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';

@Component({
  selector: 'app-driver-list',
  template: `
    <div class="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
      <div class="p-8 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 class="text-xl font-bold text-gray-900">Driver Management</h3>
          <p class="text-sm text-gray-500 mt-1">Verify drivers and monitor their performance.</p>
        </div>
        <div class="flex items-center gap-4">
          <div class="relative">
            <ion-icon name="search-outline" class="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"></ion-icon>
            <input type="text" placeholder="Search drivers..." 
                   class="bg-gray-50 border border-gray-200 rounded-xl pl-11 pr-4 py-2 text-sm font-medium text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 w-64">
          </div>
          <button class="bg-blue-600 text-white px-6 py-2 rounded-xl font-bold text-sm hover:bg-blue-700 transition-all shadow-lg shadow-blue-600/20">
            Export CSV
          </button>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left">
          <thead>
            <tr class="bg-gray-50/50 border-b border-gray-100">
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Driver</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Vehicle</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Verification</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Status</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            @for (driver of drivers(); track driver.id) {
              <tr class="hover:bg-gray-50/50 transition-all group">
                <td class="px-8 py-4">
                  <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center text-amber-600 font-bold text-xs">
                      {{ driver.first_name[0] || 'D' }}
                    </div>
                    <div>
                      <h4 class="text-sm font-bold text-gray-900">{{ driver.first_name }} {{ driver.last_name }}</h4>
                      <p class="text-xs text-gray-400">Rating: {{ driver.rating }} ★</p>
                    </div>
                  </div>
                </td>
                <td class="px-8 py-4">
                  @if (driver.vehicles[0]) {
                    <div class="text-sm font-medium text-gray-600">
                      {{ driver.vehicles[0].make }} {{ driver.vehicles[0].model }}
                      <p class="text-xs text-gray-400">{{ driver.vehicles[0].license_plate }}</p>
                    </div>
                  } @else {
                    <span class="text-xs text-gray-400 italic">No vehicle</span>
                  }
                </td>
                <td class="px-8 py-4">
                  <div class="flex items-center gap-2">
                    <ion-toggle [checked]="driver.is_verified" (ionChange)="toggleVerification(driver.id, $event.detail.checked)"></ion-toggle>
                    <span [class]="'text-xs font-bold uppercase tracking-widest ' + (driver.is_verified ? 'text-emerald-600' : 'text-amber-600')">
                      {{ driver.is_verified ? 'Verified' : 'Pending' }}
                    </span>
                  </div>
                </td>
                <td class="px-8 py-4">
                  <span [class]="'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-widest ' + (driver.status === 'online' ? 'bg-emerald-100 text-emerald-600' : 'bg-gray-100 text-gray-600')">
                    {{ driver.status }}
                  </span>
                </td>
                <td class="px-8 py-4 text-right">
                  <button class="p-2 text-gray-400 hover:text-blue-600 transition-all">
                    <ion-icon name="eye-outline" class="text-xl"></ion-icon>
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  imports: [CommonModule, IonicModule]
})
export class DriverListComponent implements OnInit {
  private adminService = inject(AdminService);
  drivers = signal<(DriverProfile & { vehicles: Vehicle[] })[]>([]);

  async ngOnInit() {
    const data = await this.adminService.getDrivers();
    this.drivers.set(data);
  }

  async toggleVerification(driverId: string, isVerified: boolean) {
    await this.adminService.verifyDriver(driverId, isVerified);
    // Update local state
    this.drivers.update(drivers => drivers.map(d => d.id === driverId ? { ...d, is_verified: isVerified } : d));
  }
}
