import { Component, inject, OnInit, signal } from '@angular/core';
import { AdminService } from '../../services/admin.service';
import { Profile } from '../../../../shared/models/booking.model';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { BadgeComponent } from '../../../../shared/ui/badge';
import { ButtonComponent } from '../../../../shared/ui/button';
import { AuthService } from '../../../../core/services/auth/auth.service';

@Component({
    selector: 'app-user-list',
    template: `
    <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-2xl shadow-slate-200/40 overflow-hidden">
      <div class="p-10 border-b border-slate-50 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h3 class="text-2xl font-display font-bold text-slate-900">User Management</h3>
          <p class="text-slate-500 font-medium mt-1">Manage and monitor all customer accounts.</p>
        </div>

        <div class="flex flex-col sm:flex-row items-center gap-4">
          <div class="relative w-full sm:w-72 group">
            <ion-icon name="search-outline" class="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400"></ion-icon>
            <input
              type="text"
              placeholder="Search users..."
              (input)="onSearch($event)"
              class="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-12 pr-5 py-3 text-sm font-medium text-slate-600 focus:outline-none"
            >
          </div>

          <app-button variant="secondary" size="md" [fullWidth]="false" class="px-8 h-12 rounded-2xl">
            <ion-icon name="download-outline" slot="start" class="mr-2"></ion-icon>
            Export CSV
          </app-button>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-slate-50/50">
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">User</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Email</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Joined</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Status</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] text-right">Actions</th>
            </tr>
          </thead>

          <tbody class="divide-y divide-slate-50">
            @for (user of filteredUsers(); track user.id) {
              <tr class="hover:bg-slate-50/80 transition-all group">
                <td class="px-10 py-6">
                  <div class="flex items-center gap-4">
                    <div class="w-12 h-12 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 font-bold text-sm border border-blue-100 shadow-sm">
                      {{ getInitial(user) }}
                    </div>

                    <div>
                      <h4 class="text-sm font-bold text-slate-900">{{ getUserName(user) }}</h4>
                      <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">
                        ID: {{ shortId(user?.id) }}
                      </p>
                    </div>
                  </div>
                </td>

                <td class="px-10 py-6 text-sm font-bold text-slate-900">
                  {{ getUserEmail(user) }}
                </td>

                <td class="px-10 py-6 text-sm font-bold text-slate-900">
                  {{ user?.created_at ? (user.created_at | date:'mediumDate') : 'N/A' }}
                </td>

                <td class="px-10 py-6">
                  <app-badge [variant]="getStatusVariant(user?.account_status || 'active')">
                    {{ (user?.account_status || 'active') | uppercase }}
                  </app-badge>
                </td>

                <td class="px-10 py-6 text-right">
                  <div class="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      (click)="openModerationModal(user)"
                      class="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 hover:bg-blue-600 hover:text-white transition-all flex items-center justify-center"
                      title="Moderate User"
                    >
                      <ion-icon name="shield-outline" class="text-xl"></ion-icon>
                    </button>
                  </div>
                </td>
              </tr>
            }
          </tbody>
        </table>

        @if (filteredUsers().length === 0) {
          <div class="p-10 text-center text-slate-400 font-bold text-sm">
            No users found.
          </div>
        }
      </div>
    </div>

    @if (moderationModal()) {
      <div class="fixed inset-0 z-[10000] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6">
          <h3 class="text-xl font-bold text-slate-900">Moderate User</h3>
          <p class="text-sm font-medium text-slate-700 mt-1">{{ getUserName(moderationModal()?.user) }}</p>

          <div class="space-y-3 mt-5">
            @for (status of ['active', 'suspended', 'banned', 'disabled']; track status) {
              <label class="flex items-center gap-3 rounded-2xl border border-slate-100 p-3 cursor-pointer">
                <input
                  type="radio"
                  name="userStatus"
                  [value]="status"
                  [checked]="moderationModal()?.status === status"
                  (change)="setModerationStatus(status)"
                />
                <span class="font-semibold capitalize">{{ status }}</span>
              </label>
            }
          </div>

          <div class="flex justify-end gap-3 mt-6">
            <button type="button" class="modal-cancel" (click)="moderationModal.set(null)">Cancel</button>
            <button type="button" class="modal-action" (click)="applyModerationStatus()">Apply</button>
          </div>
        </div>
      </div>
    }

    @if (toastMessage()) {
      <div class="fixed bottom-6 right-6 z-[11000] rounded-2xl px-5 py-4 shadow-2xl text-white font-semibold"
           [class.bg-emerald-600]="toastType() === 'success'"
           [class.bg-rose-600]="toastType() === 'danger'"
           [class.bg-amber-600]="toastType() === 'warning'">
        {{ toastMessage() }}
      </div>
    }
  `,
    styles: [`
      .modal-action {
        border-radius: 0.9rem;
        background: rgb(37 99 235);
        color: white;
        font-weight: 800;
        padding: 0.7rem 1rem;
      }

      .modal-cancel {
        border-radius: 0.9rem;
        background: rgb(248 250 252);
        color: rgb(71 85 105);
        font-weight: 800;
        padding: 0.7rem 1rem;
        border: 1px solid rgb(226 232 240);
      }
    `],
    standalone: true,
    imports: [CommonModule, IonicModule, BadgeComponent, ButtonComponent]
})
export class UserListComponent implements OnInit {
    private adminService = inject(AdminService);
    private authService = inject(AuthService);

    users = signal<Profile[]>([]);
    searchTerm = signal('');
    filteredUsers = signal<Profile[]>([]);

    toastMessage = signal<string | null>(null);
    toastType = signal<'success' | 'danger' | 'warning'>('success');

    moderationModal = signal<{
        user: Profile;
        status: string;
    } | null>(null);

    async ngOnInit() {
        await this.loadUsers();
    }

    async loadUsers() {
        const data = await this.adminService.getUsers();
        const safeUsers = Array.isArray(data) ? data : [];

        this.users.set(safeUsers);
        this.applySearchFilter();
    }

    onSearch(event: Event) {
        const input = event.target as HTMLInputElement;
        this.searchTerm.set(input.value || '');
        this.applySearchFilter();
    }

    applySearchFilter() {
        const term = (this.searchTerm() || '').toLowerCase().trim();
        const users = this.users() || [];

        if (!term) {
            this.filteredUsers.set(users);
            return;
        }

        this.filteredUsers.set(
            users.filter((user: any) => {
                const name = this.getUserName(user).toLowerCase();
                const email = this.getUserEmail(user).toLowerCase();
                const phone = (user?.phone || '').toLowerCase();
                const status = (user?.account_status || 'active').toLowerCase();
                const id = (user?.id || '').toLowerCase();

                return (
                    name.includes(term) ||
                    email.includes(term) ||
                    phone.includes(term) ||
                    status.includes(term) ||
                    id.includes(term)
                );
            })
        );
    }

    getUserName(user: any): string {
        const firstName = user?.first_name || '';
        const lastName = user?.last_name || '';
        const fullName = user?.full_name || `${firstName} ${lastName}`.trim();

        return fullName || user?.email || user?.phone || `User ${this.shortId(user?.id)}`;
    }

    getUserEmail(user: any): string {
        return user?.email || 'No email';
    }

    getInitial(user: any): string {
        const name = this.getUserName(user) || 'U';
        return name.charAt(0).toUpperCase();
    }

    shortId(id: string | undefined | null): string {
        return (id || '').slice(0, 8).toUpperCase() || 'UNKNOWN';
    }

    getStatusVariant(status: string): 'success' | 'warning' | 'error' | 'secondary' {
        switch ((status || '').toLowerCase()) {
            case 'active':
                return 'success';
            case 'suspended':
                return 'warning';
            case 'banned':
                return 'error';
            case 'disabled':
                return 'secondary';
            default:
                return 'success';
        }
    }

    openModerationModal(user: Profile) {
        this.moderationModal.set({
            user,
            status: user.account_status || 'active'
        });
    }

    setModerationStatus(status: string) {
        const current = this.moderationModal();

        if (current) {
            this.moderationModal.set({ ...current, status });
        }
    }

    async applyModerationStatus() {
        const current = this.moderationModal();

        if (!current?.user || !current.status) return;

        try {
            await this.adminService.updateAccountStatus(
                current.user.id,
                current.status,
                `Admin changed user status to ${current.status}`,
                this.authService.currentUser()?.id || ''
            );

            await this.showToast(`User status updated to ${current.status}`, 'success');
            this.moderationModal.set(null);

            this.users.update(users =>
                users.map(u =>
                    u.id === current.user.id
                        ? ({ ...u, account_status: current.status } as Profile)
                        : u
                )
            );

            this.applySearchFilter();
            await this.loadUsers();
        } catch (error: unknown) {
            await this.showToast(
                error instanceof Error ? error.message : 'Failed to update user status.',
                'danger'
            );
        }
    }

    private async showToast(message: string, color: 'success' | 'danger' | 'warning' = 'success') {
        this.toastType.set(color);
        this.toastMessage.set(message);

        window.setTimeout(() => {
            this.toastMessage.set(null);
        }, 2500);
    }
}
