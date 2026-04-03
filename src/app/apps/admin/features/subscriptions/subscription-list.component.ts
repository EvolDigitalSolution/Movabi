import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { AdminService } from '../../services/admin.service';

@Component({
  selector: 'app-subscription-list',
  template: `
    <div class="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
      <div class="p-8 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 class="text-xl font-bold text-gray-900">Active Subscriptions</h3>
          <p class="text-sm text-gray-500 mt-1">View and manage all driver subscriptions.</p>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-gray-50/50">
              <th class="p-4 text-xs font-bold text-gray-400 uppercase tracking-widest border-b border-gray-100">Driver</th>
              <th class="p-4 text-xs font-bold text-gray-400 uppercase tracking-widest border-b border-gray-100">Status</th>
              <th class="p-4 text-xs font-bold text-gray-400 uppercase tracking-widest border-b border-gray-100">Plan</th>
              <th class="p-4 text-xs font-bold text-gray-400 uppercase tracking-widest border-b border-gray-100">Period End</th>
              <th class="p-4 text-xs font-bold text-gray-400 uppercase tracking-widest border-b border-gray-100">Auto Renew</th>
            </tr>
          </thead>
          <tbody>
            @for (sub of subscriptions(); track sub.id) {
              <tr class="hover:bg-gray-50/50 transition-colors group">
                <td class="p-4 border-b border-gray-50">
                  <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400 overflow-hidden">
                      @if (sub.user?.avatar_url) {
                        <img [src]="sub.user.avatar_url" class="w-full h-full object-cover">
                      } @else {
                        <ion-icon name="person-outline" class="text-xl"></ion-icon>
                      }
                    </div>
                    <div>
                      <div class="font-bold text-gray-900">{{ sub.user?.first_name }} {{ sub.user?.last_name }}</div>
                      <div class="text-xs text-gray-400">{{ sub.user?.email }}</div>
                    </div>
                  </div>
                </td>
                <td class="p-4 border-b border-gray-50">
                  <span [class]="'px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-widest ' + getStatusClass(sub.status)">
                    {{ sub.status }}
                  </span>
                </td>
                <td class="p-4 border-b border-gray-50">
                  <div class="font-medium text-gray-700">{{ sub.stripe_price_id }}</div>
                </td>
                <td class="p-4 border-b border-gray-50">
                  <div class="text-sm text-gray-600">{{ sub.current_period_end | date:'mediumDate' }}</div>
                </td>
                <td class="p-4 border-b border-gray-50">
                  <div class="flex items-center gap-2">
                    <ion-icon 
                      [name]="sub.cancel_at_period_end ? 'close-circle' : 'checkmark-circle'" 
                      [class]="sub.cancel_at_period_end ? 'text-red-500' : 'text-emerald-500'"
                      class="text-lg"
                    ></ion-icon>
                    <span class="text-sm text-gray-600">{{ sub.cancel_at_period_end ? 'No' : 'Yes' }}</span>
                  </div>
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="5" class="p-12 text-center text-gray-400">
                  <ion-icon name="card-outline" class="text-4xl mb-2"></ion-icon>
                  <p>No subscriptions found.</p>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule]
})
export class SubscriptionListComponent implements OnInit {
  private adminService = inject(AdminService);
  subscriptions = signal<any[]>([]);

  async ngOnInit() {
    await this.loadSubscriptions();
  }

  async loadSubscriptions() {
    const data = await this.adminService.getSubscriptions();
    this.subscriptions.set(data);
  }

  getStatusClass(status: string): string {
    switch (status) {
      case 'active': return 'bg-emerald-100 text-emerald-600';
      case 'canceled': return 'bg-red-100 text-red-600';
      case 'past_due': return 'bg-amber-100 text-amber-600';
      default: return 'bg-gray-100 text-gray-600';
    }
  }
}
