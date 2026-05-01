import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { AdminService } from '../../services/admin.service';
import { DriverSubscription, Profile } from '../../../../shared/models/booking.model';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { BadgeComponent } from '../../../../shared/ui/badge';

type DriverSubRow = DriverSubscription & {
  driver?: Profile | null;
  plan?: any;
  plan_code?: string | null;
  status?: string | null;
  current_period_end?: string | null;
  expires_at?: string | null;
};

@Component({
  selector: 'app-driver-subscriptions',
  standalone: true,
  imports: [CommonModule, IonicModule, BadgeComponent],
  template: `
    <div class="bg-white rounded-[2rem] border border-slate-100 shadow-xl shadow-slate-200/40 overflow-hidden">
      <div class="p-8 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h3 class="text-xl font-display font-bold text-slate-900">Driver Subscriptions</h3>
          <p class="text-sm text-slate-500 font-medium mt-1">Monitor and manage driver subscription statuses.</p>
        </div>

        <div class="relative w-full sm:w-72">
          <ion-icon name="search-outline" class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"></ion-icon>
          <input
            type="text"
            placeholder="Search drivers..."
            (input)="onSearch($event)"
            class="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-sm font-medium text-slate-600 focus:outline-none"
          />
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse min-w-[900px]">
          <thead>
            <tr class="bg-slate-50/70">
              <th class="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Driver</th>
              <th class="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Plan</th>
              <th class="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Status</th>
              <th class="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Expires At</th>
              <th class="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>

          <tbody class="divide-y divide-slate-100">
            @for (sub of filteredSubscriptions(); track sub.id) {
              <tr class="hover:bg-slate-50/80 transition-all">
                <td class="px-6 py-5">
                  <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 font-bold text-xs border border-blue-100 shadow-sm">
                      {{ getInitial(sub.driver) }}
                    </div>

                    <div>
                      <h4 class="text-sm font-semibold text-slate-900">{{ getDriverName(sub.driver) }}</h4>
                      <p class="text-xs text-slate-500 font-medium mt-0.5">{{ getDriverContact(sub.driver) }}</p>
                    </div>
                  </div>
                </td>

                <td class="px-6 py-5">
                  <span class="text-sm font-semibold text-slate-900">
                    {{ getPlanName(sub) }}
                  </span>
                </td>

                <td class="px-6 py-5">
                  <app-badge [variant]="getStatusVariant(sub.status || 'inactive')">
                    {{ sub.status || 'inactive' }}
                  </app-badge>
                </td>

                <td class="px-6 py-5 text-sm font-semibold text-slate-900">
                  {{ formatDate(getExpiryDate(sub)) }}
                </td>

                <td class="px-6 py-5 text-right">
                  <button
                    type="button"
                    (click)="toggleStatus(sub)"
                    class="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 hover:bg-blue-600 hover:text-white transition-all flex items-center justify-center ml-auto"
                    [title]="sub.status === 'active' ? 'Pause subscription' : 'Activate subscription'"
                  >
                    <ion-icon [name]="sub.status === 'active' ? 'pause-outline' : 'play-outline'" class="text-lg"></ion-icon>
                  </button>
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="5" class="px-10 py-20 text-center">
                  <div class="w-20 h-20 rounded-[2rem] bg-slate-50 flex items-center justify-center text-slate-300 mx-auto mb-6 border border-slate-100">
                    <ion-icon name="card-outline" class="text-4xl"></ion-icon>
                  </div>
                  <h4 class="text-lg font-bold text-slate-900">No driver subscriptions found</h4>
                  <p class="text-slate-500 font-medium mt-1">Driver subscriptions will appear here.</p>
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
export class DriverSubscriptionsComponent implements OnInit {
  private adminService = inject(AdminService);

  subscriptions = signal<DriverSubRow[]>([]);
  searchTerm = signal('');

  toastMessage = signal('');
  toastColor = signal<'success' | 'danger' | 'warning'>('success');
  showToast = signal(false);

  filteredSubscriptions = computed(() => {
    const term = this.safeLower(this.searchTerm()).trim();

    if (!term) return this.subscriptions();

    return this.subscriptions().filter((sub) => {
      const text = [
        this.getDriverName(sub.driver),
        this.getDriverContact(sub.driver),
        sub?.status,
        this.getPlanName(sub)
      ]
        .map((item) => this.safeLower(item))
        .join(' ');

      return text.includes(term);
    });
  });

  async ngOnInit() {
    await this.loadSubscriptions();
  }

  async loadSubscriptions() {
    try {
      const data = await this.adminService.getDriverSubscriptions();
      this.subscriptions.set(Array.isArray(data) ? (data as DriverSubRow[]) : []);
    } catch (error: unknown) {
      this.triggerToast(error instanceof Error ? error.message : 'Failed to load driver subscriptions.', 'danger');
      this.subscriptions.set([]);
    }
  }

  onSearch(event: Event) {
    this.searchTerm.set((event.target as HTMLInputElement)?.value || '');
  }

  async toggleStatus(sub: DriverSubRow) {
    try {
      const newStatus = sub.status === 'active' ? 'inactive' : 'active';

      await this.adminService.updateSubscription(sub.id, { status: newStatus });

      await this.loadSubscriptions();
      this.triggerToast(`Subscription ${newStatus}.`, 'success');
    } catch (error: unknown) {
      this.triggerToast(error instanceof Error ? error.message : 'Failed to update subscription.', 'danger');
    }
  }

  getDriverName(driver?: Profile | null): string {
    const fullName =
      (driver as any)?.full_name ||
      `${(driver as any)?.first_name || ''} ${(driver as any)?.last_name || ''}`.trim();

    return fullName || (driver as any)?.email || (driver as any)?.phone || 'Driver';
  }

  getInitial(driver?: Profile | null): string {
    return this.getDriverName(driver).charAt(0).toUpperCase();
  }

  getDriverContact(driver?: Profile | null): string {
    return (driver as any)?.email || (driver as any)?.phone || 'No contact';
  }

  getPlanName(sub: DriverSubRow): string {
    return sub?.plan?.display_name || sub?.plan?.name || sub?.plan_code || (sub as any)?.plan_id || 'No plan';
  }

  getExpiryDate(sub: DriverSubRow): string | null {
    return sub?.current_period_end || sub?.expires_at || null;
  }

  formatDate(value: string | null): string {
    if (!value) return 'N/A';

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return date.toLocaleDateString();
  }

  getStatusVariant(status: string): 'success' | 'error' | 'warning' | 'info' | 'primary' | 'secondary' {
    switch (this.safeLower(status)) {
      case 'active':
        return 'success';
      case 'inactive':
        return 'error';
      case 'expired':
        return 'secondary';
      case 'trialing':
        return 'info';
      case 'past_due':
        return 'warning';
      default:
        return 'warning';
    }
  }

  safeLower(value: any): string {
    return String(value || '').toLowerCase();
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
