import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, ToastController } from '@ionic/angular';
import { AdminService } from '../../services/admin.service';
import { Subscription, Profile } from '../../../../shared/models/booking.model';
import { BadgeComponent } from '../../../../shared/ui/badge';

type SubscriptionRow = Subscription & {
    user?: Profile | null;
    plan?: any;
    billing_amount_display?: string | null;
    stripe_price_id?: string | null;
    current_period_end?: string | null;
    cancel_at_period_end?: boolean | null;
};

@Component({
    selector: 'app-subscription-list',
    standalone: true,
    imports: [CommonModule, IonicModule, BadgeComponent],
    template: `
    <div class="bg-white rounded-[2rem] border border-slate-100 shadow-xl shadow-slate-200/40 overflow-hidden">
      <div class="p-8 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h3 class="text-xl font-display font-bold text-slate-900">Active Subscriptions</h3>
          <p class="text-sm text-slate-500 font-medium mt-1">View and manage all driver subscriptions.</p>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse min-w-[900px]">
          <thead>
            <tr class="bg-slate-50/70">
              <th class="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Driver</th>
              <th class="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Status</th>
              <th class="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Plan</th>
              <th class="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Period End</th>
              <th class="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Auto Renew</th>
            </tr>
          </thead>

          <tbody class="divide-y divide-slate-100">
            @for (sub of subscriptions(); track sub.id) {
              <tr class="hover:bg-slate-50/80 transition-all">
                <td class="px-6 py-5">
                  <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-slate-400 overflow-hidden border border-slate-200 shadow-sm">
                      @if (sub.user?.avatar_url) {
                        <img [src]="sub.user?.avatar_url" class="w-full h-full object-cover" alt="Driver avatar" referrerpolicy="no-referrer">
                      } @else {
                        <span class="text-xs font-bold text-slate-500">{{ getInitial(sub.user) }}</span>
                      }
                    </div>

                    <div>
                      <div class="text-sm font-semibold text-slate-900">{{ getUserName(sub.user) }}</div>
                      <div class="text-xs text-slate-500 font-medium mt-0.5">{{ sub.user?.email || sub.user?.phone || 'No contact' }}</div>
                    </div>
                  </div>
                </td>

                <td class="px-6 py-5">
                  <app-badge [variant]="getStatusVariant(sub.status)">
                    {{ sub.status || 'unknown' }}
                  </app-badge>
                </td>

                <td class="px-6 py-5">
                  <div class="text-sm font-semibold text-slate-900">{{ getPlanDisplay(sub) }}</div>
                </td>

                <td class="px-6 py-5">
                  <div class="text-sm font-semibold text-slate-900">
                    {{ sub.current_period_end ? (sub.current_period_end | date:'mediumDate') : 'N/A' }}
                  </div>
                </td>

                <td class="px-6 py-5">
                  <div class="flex items-center gap-3">
                    <div
                      class="w-8 h-8 rounded-lg flex items-center justify-center border"
                      [class.bg-red-50]="sub.cancel_at_period_end"
                      [class.text-red-500]="sub.cancel_at_period_end"
                      [class.border-red-100]="sub.cancel_at_period_end"
                      [class.bg-emerald-50]="!sub.cancel_at_period_end"
                      [class.text-emerald-500]="!sub.cancel_at_period_end"
                      [class.border-emerald-100]="!sub.cancel_at_period_end"
                    >
                      <ion-icon [name]="sub.cancel_at_period_end ? 'close' : 'checkmark'" class="text-lg"></ion-icon>
                    </div>

                    <span class="text-sm font-semibold text-slate-900">
                      {{ sub.cancel_at_period_end ? 'No' : 'Yes' }}
                    </span>
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
  `
})
export class SubscriptionListComponent implements OnInit {
    private adminService = inject(AdminService);
    private toastCtrl = inject(ToastController);

    subscriptions = signal<SubscriptionRow[]>([]);

    async ngOnInit() {
        await this.loadSubscriptions();
    }

    async loadSubscriptions() {
        try {
            const data = await this.adminService.getSubscriptions();
            this.subscriptions.set(Array.isArray(data) ? data as SubscriptionRow[] : []);
        } catch (error: unknown) {
            await this.showToast(error instanceof Error ? error.message : 'Failed to load subscriptions.', 'danger');
            this.subscriptions.set([]);
        }
    }

    getUserName(user?: Profile | null): string {
        const fullName = (user as any)?.full_name || `${(user as any)?.first_name || ''} ${(user as any)?.last_name || ''}`.trim();
        return fullName || (user as any)?.email || (user as any)?.phone || 'Driver';
    }

    getInitial(user?: Profile | null): string {
        return this.getUserName(user).charAt(0).toUpperCase();
    }

    getPlanDisplay(sub: SubscriptionRow): string {
        return sub.plan?.display_name ||
            sub.plan?.name ||
            sub.billing_amount_display ||
            sub.stripe_price_id ||
            'No plan';
    }

    getStatusVariant(status: string): 'success' | 'error' | 'warning' | 'info' | 'primary' | 'secondary' {
        switch ((status || '').toLowerCase()) {
            case 'active': return 'success';
            case 'canceled':
            case 'cancelled': return 'error';
            case 'past_due': return 'warning';
            case 'trialing': return 'info';
            default: return 'secondary';
        }
    }

    private async showToast(message: string, color: 'success' | 'danger' | 'warning' = 'success') {
        const toast = await this.toastCtrl.create({ message, duration: 2500, color });
        await toast.present();
    }
}