import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { AdminService } from '../../services/admin.service';
import { Subscription, Profile } from '../../../../shared/models/booking.model';

import { BadgeComponent } from '../../../../shared/ui/badge';

@Component({
  selector: 'app-subscription-list',
  template: `
    <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-2xl shadow-slate-200/40 overflow-hidden">
      <div class="p-10 border-b border-slate-50 flex items-center justify-between">
        <div>
          <h3 class="text-2xl font-display font-bold text-slate-900">Active Subscriptions</h3>
          <p class="text-slate-500 font-medium mt-1">View and manage all driver subscriptions.</p>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-slate-50/50">
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Driver</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Status</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Plan</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Period End</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Auto Renew</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-50">
            @for (sub of subscriptions(); track sub.id) {
              <tr class="hover:bg-slate-50/80 transition-all group">
                <td class="px-10 py-6">
                  <div class="flex items-center gap-4">
                    <div class="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center text-slate-400 overflow-hidden border border-slate-200 shadow-sm">
                      @if (sub.user.avatar_url) {
                        <img [src]="sub.user.avatar_url" class="w-full h-full object-cover" alt="Driver avatar" referrerpolicy="no-referrer">
                      } @else {
                        <ion-icon name="person-outline" class="text-xl"></ion-icon>
                      }
                    </div>
                    <div>
                      <div class="text-sm font-bold text-slate-900">{{ sub.user.first_name }} {{ sub.user.last_name }}</div>
                      <div class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">{{ sub.user.email }}</div>
                    </div>
                  </div>
                </td>
                <td class="px-10 py-6">
                  <app-badge [variant]="getStatusVariant(sub.status)">
                    {{ sub.status }}
                  </app-badge>
                </td>
                <td class="px-10 py-6">
                  <div class="text-sm font-bold text-slate-900">{{ sub.billing_amount_display || sub.stripe_price_id }}</div>
                </td>
                <td class="px-10 py-6">
                  <div class="text-sm font-bold text-slate-900">{{ sub.current_period_end | date:'mediumDate' }}</div>
                </td>
                <td class="px-10 py-6">
                  <div class="flex items-center gap-3">
                    <div [class]="'w-8 h-8 rounded-lg flex items-center justify-center border ' + (sub.cancel_at_period_end ? 'bg-red-50 text-red-500 border-red-100' : 'bg-emerald-50 text-emerald-500 border-emerald-100')">
                      <ion-icon 
                        [name]="sub.cancel_at_period_end ? 'close' : 'checkmark'" 
                        class="text-lg"
                      ></ion-icon>
                    </div>
                    <span class="text-sm font-bold text-slate-900">{{ sub.cancel_at_period_end ? 'No' : 'Yes' }}</span>
                  </div>
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="5" class="px-10 py-20 text-center">
                  <div class="w-20 h-20 rounded-[2rem] bg-slate-50 flex items-center justify-center text-slate-300 mx-auto mb-6 border border-slate-100">
                    <ion-icon name="card-outline" class="text-4xl"></ion-icon>
                  </div>
                  <h4 class="text-lg font-bold text-slate-900">No subscriptions found</h4>
                  <p class="text-slate-500 font-medium mt-1">Active driver subscriptions will appear here.</p>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule, BadgeComponent]
})
export class SubscriptionListComponent implements OnInit {
  private adminService = inject(AdminService);
  subscriptions = signal<(Subscription & { user: Profile })[]>([]);

  async ngOnInit() {
    await this.loadSubscriptions();
  }

  async loadSubscriptions() {
    const data = await this.adminService.getSubscriptions();
    this.subscriptions.set(data as (Subscription & { user: Profile })[]);
  }

  getStatusVariant(status: string): 'success' | 'error' | 'warning' | 'info' | 'primary' | 'secondary' {
    switch (status) {
      case 'active': return 'success';
      case 'canceled': return 'error';
      case 'past_due': return 'warning';
      default: return 'secondary';
    }
  }
}
