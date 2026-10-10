import { Component, inject, OnInit, computed, signal } from '@angular/core';
import { AdminService } from '../../services/admin.service';
import { Profile } from '../../../../shared/models/booking.model';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { BadgeComponent } from '../../../../shared/ui/badge';
import { ButtonComponent } from '../../../../shared/ui/button';
import { AuthService } from '../../../../core/services/auth/auth.service';
import { downloadCsv, toCsv, csvDateStamp } from '../../../../shared/utils/csv';

@Component({
    selector: 'app-user-list',
    template: `
    <div class="bg-white rounded-2xl border border-slate-100 shadow-2xl shadow-slate-200/40 overflow-hidden">
      <div class="p-4 sm:p-6 border-b border-slate-50 flex flex-col gap-4">
        <div>
          <h3 class="text-lg sm:text-xl leading-tight font-display font-bold text-slate-900">User Management</h3>
          <p class="text-sm text-slate-500 font-medium mt-1">Manage and monitor all customer accounts.</p>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <select
            aria-label="Filter users by account status"
            [value]="statusFilter()"
            (change)="onStatusFilter($event)"
            class="w-full sm:w-44 shrink-0 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm font-bold text-slate-600 focus:outline-none"
          >
            <option value="all">All accounts</option>
            <option value="closure_requested">Closure Requested</option>
            <option value="closed">Closed</option>
            <option value="reinstated">Reinstated</option>
          </select>

          <div class="relative w-full sm:flex-1 sm:min-w-64 group">
            <ion-icon name="search-outline" class="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400"></ion-icon>
            <input
              type="text"
              aria-label="Search users"
              placeholder="Search name, email, phone or ID..."
              (input)="onSearch($event)"
              class="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-12 pr-5 py-3 text-sm font-medium text-slate-600 focus:outline-none"
            >
          </div>

          <app-button variant="secondary" size="md" [fullWidth]="false" (clicked)="exportCsv()" class="shrink-0">
            <ion-icon name="download-outline" slot="start" class="mr-2"></ion-icon>
            Export CSV
          </app-button>
        </div>
      </div>

      <div class="overflow-x-auto max-h-[65vh]" tabindex="0" role="region" aria-label="Customer accounts table">
        <table class="w-full min-w-[850px] table-fixed text-left border-collapse">
          <caption class="sr-only">Customer accounts with contact details, status and management actions</caption>
          <colgroup><col class="w-[26%]"><col class="w-[29%]"><col class="w-[13%]"><col class="w-[14%]"><col class="w-[18%]"></colgroup>
          <thead class="sticky top-0 z-10 bg-slate-50">
            <tr class="bg-slate-50/50">
              <th scope="col" class="px-4 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">User</th>
              <th scope="col" class="px-4 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Email</th>
              <th scope="col" class="px-4 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Joined</th>
              <th scope="col" class="px-4 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Status</th>
              <th scope="col" class="px-4 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider text-right">Actions</th>
            </tr>
          </thead>

          <tbody class="divide-y divide-slate-50">
            @for (user of pagedUsers(); track user.id) {
              <tr class="hover:bg-slate-50/80 transition-all group">
                <td class="px-4 py-3">
                  <div class="flex items-center gap-3">
                    <div class="w-9 h-9 shrink-0 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 font-bold text-sm border border-blue-100 shadow-sm">
                      {{ getInitial(user) }}
                    </div>

                    <div class="min-w-0">
                      <h4 class="truncate text-sm font-bold text-slate-900" [title]="getUserName(user)">{{ getUserName(user) }}</h4>
                      <p class="text-[10px] text-slate-400 font-medium tracking-wide mt-0.5">
                        ID: {{ shortId(user?.id) }}
                      </p>
                    </div>
                  </div>
                </td>

                <td class="px-4 py-3 text-sm font-medium text-slate-700">
                  <span class="block truncate" [title]="getUserEmail(user)">{{ getUserEmail(user) }}</span>
                </td>

                <td class="px-4 py-3 whitespace-nowrap text-xs font-medium text-slate-700">
                  {{ user?.created_at ? (user.created_at | date:'mediumDate') : 'N/A' }}
                </td>

                <td class="px-4 py-3">
                  <app-badge [variant]="getStatusVariant(user?.account_status || 'active')">
                    {{ (user?.account_status || 'active') | uppercase }}
                  </app-badge>
                </td>

                <td class="px-4 py-3 text-right">
                  <div class="flex items-center justify-end gap-2">
                    <button type="button" class="rounded-xl bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700" (click)="openMessageModal(user)">Message</button>
                    <button
                      type="button"
                      (click)="openPurgeModal(user)"
                      class="w-8 h-8 shrink-0 rounded-lg bg-slate-50 text-slate-400 hover:bg-rose-600 hover:text-white transition-all flex items-center justify-center"
                      title="Permanently delete test account"
                      [attr.aria-label]="'Delete test account: ' + getUserName(user)"
                    >
                      <ion-icon name="trash-outline" class="text-xl"></ion-icon>
                    </button>

                    <button
                      type="button"
                      (click)="openModerationModal(user)"
                      class="w-8 h-8 shrink-0 rounded-lg bg-slate-50 text-slate-400 hover:bg-blue-600 hover:text-white transition-all flex items-center justify-center"
                      title="Moderate User"
                      [attr.aria-label]="'Moderate user: ' + getUserName(user)"
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
      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
        <p aria-live="polite">{{ rangeStart() }}–{{ rangeEnd() }} of {{ filteredUsers().length }} users</p>
        <div class="flex flex-wrap items-center gap-3">
          <label class="flex items-center gap-2">Rows
            <select aria-label="Users per page" [value]="pageSize()" (change)="onPageSize($event)" class="rounded-lg border border-slate-200 bg-white px-2 py-1.5">
              <option value="25">25</option><option value="50">50</option><option value="100">100</option>
            </select>
          </label>
          <button type="button" (click)="page.set(page() - 1)" [disabled]="page() <= 1" class="rounded-lg border border-slate-200 px-3 py-1.5 font-semibold disabled:opacity-40">Previous</button>
          <span>Page {{ page() }} of {{ pageCount() }}</span>
          <button type="button" (click)="page.set(page() + 1)" [disabled]="page() >= pageCount()" class="rounded-lg border border-slate-200 px-3 py-1.5 font-semibold disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>

    @if (messageRecipient(); as recipient) {
      <div class="fixed inset-0 z-[10000] bg-slate-900/50 flex items-center justify-center p-4">
        <div class="w-full max-w-md rounded-3xl bg-white p-6">
          <h3 class="text-xl font-bold">Message {{getUserName(recipient)}}</h3>
          <p class="mt-2 text-xs text-slate-500">The customer can read this in Messages from Movabi. No account status changes.</p>
          <textarea class="mt-4 w-full min-h-32 rounded-xl border border-slate-200 p-3" maxlength="2000" [value]="customerMessageDraft()" (input)="customerMessageDraft.set($any($event.target).value)" placeholder="Write your message..."></textarea>
          <div class="mt-4 flex gap-3"><app-button variant="secondary" [disabled]="sendingCustomerMessage()" (clicked)="messageRecipient.set(null)">Cancel</app-button><app-button [disabled]="sendingCustomerMessage() || !customerMessageDraft().trim()" (clicked)="sendCustomerMessage()">{{sendingCustomerMessage()?'Sending...':'Send Message'}}</app-button></div>
        </div>
      </div>
    }

    @if (moderationModal()) {
      <div class="fixed inset-0 z-[10000] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6">
          <h3 class="text-xl font-bold text-slate-900">Moderate User</h3>
          <p class="text-sm font-medium text-slate-700 mt-1">{{ getUserName(moderationModal()?.user) }}</p>

          <div class="space-y-3 mt-5">
            @for (status of ['active', 'closure_requested', 'closed', 'reinstated', 'suspended', 'banned', 'disabled']; track status) {
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

    @if (purgeModal()) {
      <div class="fixed inset-0 z-[10000] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6">
          <h3 class="text-xl font-bold text-rose-600">Permanently delete test account</h3>
          <p class="text-sm font-bold text-slate-800 mt-2">{{ getUserName(purgeModal()) }}</p>
          <p class="text-xs font-semibold text-slate-500 mt-1">
            {{ getUserEmail(purgeModal()) }} · {{ purgeModal()?.role || 'unknown' }}
          </p>
          <p class="text-sm font-semibold text-rose-600 mt-3">This will permanently delete this test account and its associated test activity. This cannot be undone.</p>
          <input
            type="text"
            [value]="purgeConfirmText()"
            (input)="setPurgeConfirmText($event)"
            placeholder="Type DELETE to confirm"
            class="w-full mt-4 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-bold focus:outline-none"
          />
          <div class="flex justify-end gap-3 mt-6">
            <button type="button" class="modal-cancel" (click)="purgeModal.set(null); purgeConfirmText.set('')">Cancel</button>
            <button
              type="button"
              class="shrink-0 whitespace-nowrap px-5 py-3 rounded-2xl bg-rose-600 text-white font-bold disabled:opacity-50"
              [disabled]="purgeConfirmText() !== 'DELETE' || purging()"
              (click)="confirmPurge()"
            >
              {{ purging() ? 'Deleting…' : 'Delete Account' }}
            </button>
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

    messageRecipient = signal<Profile | null>(null);
    customerMessageDraft = signal('');
    sendingCustomerMessage = signal(false);
    users = signal<Profile[]>([]);
    searchTerm = signal('');
    statusFilter = signal('all');
    filteredUsers = signal<Profile[]>([]);
    page = signal(1);
    pageSize = signal(25);
    pageCount = computed(() => Math.max(1, Math.ceil(this.filteredUsers().length / this.pageSize())));
    pagedUsers = computed(() => this.filteredUsers().slice((this.page() - 1) * this.pageSize(), this.page() * this.pageSize()));
    rangeStart = computed(() => this.filteredUsers().length ? (this.page() - 1) * this.pageSize() + 1 : 0);
    rangeEnd = computed(() => Math.min(this.page() * this.pageSize(), this.filteredUsers().length));

    onPageSize(event: Event) {
        const size = Number((event.target as HTMLSelectElement).value);
        if (![25, 50, 100].includes(size)) return;
        this.pageSize.set(size);
        this.page.set(1);
    }

    toastMessage = signal<string | null>(null);
    toastType = signal<'success' | 'danger' | 'warning'>('success');

    moderationModal = signal<{
        user: Profile;
        status: string;
    } | null>(null);

    purgeModal = signal<Profile | null>(null);
    purgeConfirmText = signal('');
    purging = signal(false);

    async ngOnInit() {
        await this.loadUsers();
    }

    openMessageModal(user: Profile) { this.customerMessageDraft.set(''); this.messageRecipient.set(user); }
    async sendCustomerMessage() {
        const recipient=this.messageRecipient();
        if(!recipient?.id || this.sendingCustomerMessage()) return;
        this.sendingCustomerMessage.set(true);
        try {
            await this.adminService.sendCustomerMessage(recipient.id,this.customerMessageDraft().trim());
            this.messageRecipient.set(null);this.customerMessageDraft.set('');
            await this.showToast('Message saved. Push will be attempted for enabled devices.','success');
        }catch(error){await this.showToast(error instanceof Error?error.message:'Could not send message.','danger');}
        finally{this.sendingCustomerMessage.set(false);}
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

    onStatusFilter(event: Event) {
        const select = event.target as HTMLSelectElement;
        this.statusFilter.set(select.value || 'all');
        this.applySearchFilter();
    }

    applySearchFilter() {
        this.page.set(1);
        const term = (this.searchTerm() || '').toLowerCase().trim();
        const statusFilter = this.statusFilter();
        const users = this.users() || [];

        this.filteredUsers.set(
            users.filter((user: any) => {
                const name = this.getUserName(user).toLowerCase();
                const email = this.getUserEmail(user).toLowerCase();
                const phone = (user?.phone || '').toLowerCase();
                const status = (user?.account_status || 'active').toLowerCase();
                const id = (user?.id || '').toLowerCase();

                const matchesStatus = statusFilter === 'all' || status === statusFilter;
                const matchesSearch = !term || (
                    name.includes(term) ||
                    email.includes(term) ||
                    phone.includes(term) ||
                    status.includes(term) ||
                    id.includes(term)
                );

                return matchesStatus && matchesSearch;
            })
        );
    }

    exportCsv() {
        const rows = this.filteredUsers().map((user: any) => [
            this.getUserName(user),
            this.getUserEmail(user),
            user?.phone || '',
            user?.account_status || 'active',
            user?.created_at || '',
            user?.id || ''
        ]);

        const csv = toCsv(['Name', 'Email', 'Phone', 'Status', 'Joined', 'ID'], rows);
        downloadCsv(`users-${csvDateStamp()}.csv`, csv);
        void this.showToast('CSV exported.', 'success');
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
            case 'closure_requested':
            case 'reinstated':
                return 'warning';
            case 'banned':
            case 'closed':
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

    openPurgeModal(user: Profile) {
        this.purgeModal.set(user);
        this.purgeConfirmText.set('');
    }

    setPurgeConfirmText(event: Event) {
        this.purgeConfirmText.set((event.target as HTMLInputElement).value || '');
    }

    async confirmPurge() {
        const user = this.purgeModal();
        if (!user || this.purgeConfirmText() !== 'DELETE' || this.purging()) return;

        this.purging.set(true);
        try {
            await this.adminService.purgeTestAccount(user.id);
            await this.showToast('Test account permanently deleted.', 'success');
            this.purgeModal.set(null);
            this.purgeConfirmText.set('');
            await this.loadUsers();
        } catch (error: unknown) {
            await this.showToast(
                error instanceof Error ? error.message : 'Failed to purge test account.',
                'danger'
            );
        } finally {
            this.purging.set(false);
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
