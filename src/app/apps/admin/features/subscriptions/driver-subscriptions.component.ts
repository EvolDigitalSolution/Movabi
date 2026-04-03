import { Component, inject, OnInit, signal } from '@angular/core';
import { AdminService } from '../../services/admin.service';
import { DriverSubscription, Profile } from '../../../../shared/models/booking.model';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';

@Component({
  selector: 'app-driver-subscriptions',
  template: `
    <div class="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
      <div class="p-8 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 class="text-xl font-bold text-gray-900">Driver Subscriptions</h3>
          <p class="text-sm text-gray-500 mt-1">Monitor and manage active driver subscription statuses.</p>
        </div>
        <div class="flex items-center gap-4">
          <div class="relative">
            <ion-icon name="search-outline" class="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"></ion-icon>
            <input type="text" placeholder="Search drivers..." 
                   class="bg-gray-50 border border-gray-200 rounded-xl pl-11 pr-4 py-2 text-sm font-medium text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 w-64">
          </div>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left">
          <thead>
            <tr class="bg-gray-50/50 border-b border-gray-100">
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Driver</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Plan</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Status</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Expires At</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            @for (sub of subscriptions(); track sub.id) {
              <tr class="hover:bg-gray-50/50 transition-all group">
                <td class="px-8 py-4">
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-xs">
                      {{ sub.driver.first_name[0] || 'D' }}
                    </div>
                    <div>
                      <h4 class="text-sm font-bold text-gray-900">{{ sub.driver.first_name }} {{ sub.driver.last_name }}</h4>
                      <p class="text-xs text-gray-400">{{ sub.driver.email }}</p>
                    </div>
                  </div>
                </td>
                <td class="px-8 py-4">
                  <span class="text-sm font-bold text-gray-900">{{ sub.plan_id }}</span>
                </td>
                <td class="px-8 py-4">
                  <span [class]="'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-widest ' + getStatusClass(sub.status)">
                    {{ sub.status }}
                  </span>
                </td>
                <td class="px-8 py-4 text-sm text-gray-500">
                  {{ sub.expires_at | date:'mediumDate' }}
                </td>
                <td class="px-8 py-4 text-right">
                  <button (click)="toggleStatus(sub)" class="p-2 text-gray-400 hover:text-blue-600 transition-all">
                    <ion-icon [name]="sub.status === 'active' ? 'pause-outline' : 'play-outline'" class="text-xl"></ion-icon>
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
export class DriverSubscriptionsComponent implements OnInit {
  private adminService = inject(AdminService);
  subscriptions = signal<(DriverSubscription & { driver: Profile })[]>([]);

  async ngOnInit() {
    await this.loadSubscriptions();
  }

  async loadSubscriptions() {
    const data = await this.adminService.getDriverSubscriptions();
    this.subscriptions.set(data);
  }

  async toggleStatus(sub: DriverSubscription) {
    const newStatus = sub.status === 'active' ? 'inactive' : 'active';
    await this.adminService.updateSubscription(sub.id, { status: newStatus });
    await this.loadSubscriptions();
  }

  getStatusClass(status: string) {
    switch (status) {
      case 'active': return 'bg-emerald-100 text-emerald-600';
      case 'inactive': return 'bg-red-100 text-red-600';
      case 'expired': return 'bg-gray-100 text-gray-600';
      default: return 'bg-amber-100 text-amber-600';
    }
  }
}
