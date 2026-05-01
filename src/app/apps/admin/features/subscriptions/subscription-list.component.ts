import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
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
                      @if (getAvatarUrl(sub.user)) {
                        <img [src]="getAvatarUrl(sub.user)" class="w-full h-full object-cover" alt="Driver avatar" referrerpolicy="no-referrer">
                      } @else {
                        <span class="text-xs font-bold text-slate-500">{{ getInitial(sub.user) }}</span>
                      }
                    </div>

                    <div>
                      <div class="text-sm font-semibold text-slate-900">{{ getUserName(sub.user) }}</div>
                      <div class="text-xs text-slate-500 font-medium mt-0.5">{{ getUserContact(sub.user) }}</div>
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
                    {{ formatDate(sub.current_period_end) }}
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

    @if(showToast()) {
      <div class="fixed top-5 right-5 z-[11000]">
        <div
          class="px-5 py-3 rounded-2xl shadow-xl text-white text-sm font-semibold"
          [class.bg-emerald-600]="toastColor()==='success'"
          [class.bg-rose-600]="toastColor()==='danger'"
          [class.bg-amber-500]="toastColor()==='warning'"
        >
          {{ toastMessage() }}
        </div>
      </div>
    }
  `
})
export class SubscriptionListComponent implements OnInit {
  private adminService = inject(AdminService);

  subscriptions = signal<SubscriptionRow[]>([]);

  toastMessage = signal('');
  toastColor = signal<'success' | 'danger' | 'warning'>('success');
  showToast = signal(false);

  async ngOnInit() {
    await this.loadSubscriptions();
  }

  async loadSubscriptions() {
    try {
      const data = await this.adminService.getSubscriptions();
      this.subscriptions.set(Array.isArray(data) ? (data as SubscriptionRow[]) : []);
    } catch (error: unknown) {
      this.triggerToast(error instanceof Error ? error.message : 'Failed to load subscriptions.', 'danger');
      this.subscriptions.set([]);
    }
  }

  getUserName(user?: Profile | null): string {
    const fullName =
      (user as any)?.full_name ||
      `${(user as any)?.first_name || ''} ${(user as any)?.last_name || ''}`.trim();

    return fullName || (user as any)?.email || (user as any)?.phone || 'Driver';
  }

  getInitial(user?: Profile | null): string {
    return this.getUserName(user).charAt(0).toUpperCase();
  }

  getUserContact(user?: Profile | null): string {
    return (user as any)?.email || (user as any)?.phone || 'No contact';
  }

  getAvatarUrl(user?: Profile | null): string | null {
    return (user as any)?.avatar_url || null;
  }

  getPlanDisplay(sub: SubscriptionRow): string {
    return (
      sub?.plan?.display_name ||
      sub?.plan?.name ||
      sub?.billing_amount_display ||
      sub?.stripe_price_id ||
      'No plan'
    );
  }

  formatDate(value?: string | null): string {
    if (!value) return 'N/A';

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return date.toLocaleDateString();
  }

  getStatusVariant(status: string | null | undefined): 'success' | 'error' | 'warning' | 'info' | 'primary' | 'secondary' {
    switch (String(status || '').toLowerCase()) {
      case 'active':
        return 'success';
      case 'canceled':
      case 'cancelled':
        return 'error';
      case 'past_due':
        return 'warning';
      case 'trialing':
        return 'info';
      default:
        return 'secondary';
    }
  }

  triggerToast(message: string, color: 'success' | 'danger' | 'warning' = 'success') {
    this.toastMessage.set(message);
    this.toastColor.set(color);
    this.showToast.set(true);

    setTimeout(() => {
      this.showToast.set(false);
    }, 2500);
  }
}
