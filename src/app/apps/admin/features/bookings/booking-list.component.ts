import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { AdminService } from '../../services/admin.service';
import { SupabaseService } from '../../../../core/services/supabase/supabase.service';
import { Job, ServiceTypeEnum, BookingStatus, DriverProfile, Vehicle } from '../../../../shared/models/booking.model';
import { BookingService } from '../../../../core/services/booking/booking.service';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { BadgeComponent } from '../../../../shared/ui/badge';
import { ButtonComponent } from '../../../../shared/ui/button';
import { CardComponent } from '../../../../shared/ui/card';

@Component({
    selector: 'app-booking-list',
    standalone: true,
    imports: [CommonModule, IonicModule, BadgeComponent, ButtonComponent, CardComponent],
    template: `
    <div class="bg-white rounded-[2rem] border border-slate-100 shadow-xl shadow-slate-200/40 overflow-hidden">
      <div class="p-6 border-b border-slate-100 flex flex-col xl:flex-row xl:items-center justify-between gap-5">
        <div>
          <h3 class="text-xl font-display font-bold text-slate-900">Live Bookings</h3>
          <p class="text-sm text-slate-500 font-medium mt-1">
            {{ filteredBookings().length }} bookings found · Showing {{ pagedBookings().length }} on this page
          </p>
        </div>

        <div class="flex flex-col sm:flex-row items-center gap-3 w-full xl:w-auto">
          <div class="relative w-full sm:w-72">
            <ion-icon name="search-outline" class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"></ion-icon>
            <input
              type="text"
              placeholder="Search bookings..."
              (input)="onSearch($event)"
              class="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-2.5 text-xs font-medium text-slate-600 focus:outline-none"
            >
          </div>

          <select
            (change)="onStatusFilterChange($event)"
            class="filter-select"
          >
            <option value="all">All Statuses</option>
            @for (status of allStatuses; track status) {
              <option [value]="status">{{ formatStatus(status) }}</option>
            }
          </select>

          <select
            (change)="onPageSizeChange($event)"
            class="filter-select sm:w-32"
          >
            <option value="10">10 / page</option>
            <option value="20">20 / page</option>
            <option value="50">50 / page</option>
          </select>

          <app-button variant="secondary" size="sm" [fullWidth]="false" class="px-5 h-10 rounded-xl">
            <ion-icon name="download-outline" slot="start" class="mr-2"></ion-icon>
            Export CSV
          </app-button>
        </div>
      </div>

      <div class="overflow-x-auto max-w-full">
        <table class="w-full text-left border-collapse min-w-[980px]">
          <thead>
            <tr class="bg-slate-50/70">
              <th class="th-cell">Booking</th>
              <th class="th-cell">Customer</th>
              <th class="th-cell">Driver</th>
              <th class="th-cell">Route</th>
              <th class="th-cell">Price</th>
              <th class="th-cell">Status</th>
              <th class="th-cell text-right">Actions</th>
            </tr>
          </thead>

          <tbody class="divide-y divide-slate-100">
            @for (booking of pagedBookings(); track booking.id) {
              <tr class="hover:bg-slate-50/80 transition-all align-top">
                <td class="px-4 py-4">
                  <div class="min-w-[115px]">
                    <span class="text-[11px] font-semibold text-slate-500 bg-slate-100 px-2 py-1 rounded-md">
                      #{{ shortId(booking.id) }}
                    </span>
                    <p class="text-[11px] text-slate-400 font-medium mt-2">
                      {{ booking.created_at | date:'short' }}
                    </p>
                  </div>
                </td>

                <td class="px-4 py-4">
                  <div class="flex items-center gap-3 min-w-[180px]">
                    <div class="avatar bg-blue-50 text-blue-600 border-blue-100">
                      {{ getInitial(booking.customer, 'C') }}
                    </div>
                    <div class="min-w-0">
                      <h4 class="text-sm font-semibold text-slate-900 truncate">
                        {{ getPersonName(booking.customer, 'Customer') }}
                      </h4>
                      <p class="text-xs text-slate-500 font-medium truncate">
                        {{ booking.customer?.email || booking.customer?.phone || 'No contact' }}
                      </p>
                    </div>
                  </div>
                </td>

                <td class="px-4 py-4">
                  @if (booking.driver) {
                    <div class="flex items-center gap-3 min-w-[170px]">
                      <div class="avatar bg-amber-50 text-amber-600 border-amber-100">
                        {{ getInitial(booking.driver, 'D') }}
                      </div>
                      <div class="min-w-0">
                        <h4 class="text-sm font-semibold text-slate-900 truncate">
                          {{ getPersonName(booking.driver, 'Driver') }}
                        </h4>
                        <p class="text-xs text-slate-500 font-medium truncate">
                          ID: {{ shortId(booking.driver.id) }}
                        </p>
                      </div>
                    </div>
                  } @else {
                    <app-badge variant="warning">Unassigned</app-badge>
                  }
                </td>

                <td class="px-4 py-4">
                  <div class="text-xs space-y-1.5 font-medium min-w-[250px] max-w-[360px]">
                    <div class="flex items-start gap-2">
                      <span class="text-slate-400 min-w-[36px] font-bold">From:</span>
                      <span class="text-slate-600 line-clamp-1">{{ booking.pickup_address || 'Missing pickup' }}</span>
                    </div>
                    <div class="flex items-start gap-2">
                      <span class="text-slate-400 min-w-[36px] font-bold">To:</span>
                      <span class="text-slate-600 line-clamp-1">{{ booking.dropoff_address || 'Missing dropoff' }}</span>
                    </div>
                  </div>
                </td>

                <td class="px-4 py-4">
                  <span class="text-sm font-bold text-slate-900">
                    {{ getCurrency(booking) }}{{ toMoney(booking.price) }}
                  </span>
                </td>

                <td class="px-4 py-4">
                  <app-badge [variant]="getBadgeVariant(booking.status)">
                    {{ formatStatus(booking.status) }}
                  </app-badge>
                </td>

                <td class="px-4 py-4 text-right">
                  <button
                    type="button"
                    (click)="viewDetails(booking)"
                    class="w-9 h-9 rounded-xl bg-slate-50 text-slate-400 hover:bg-blue-600 hover:text-white transition-all flex items-center justify-center ml-auto"
                    title="View booking details"
                  >
                    <ion-icon name="eye-outline" class="text-lg"></ion-icon>
                  </button>
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="7" class="px-10 py-20 text-center">
                  <div class="w-20 h-20 rounded-[2rem] bg-slate-50 flex items-center justify-center text-slate-300 mx-auto mb-6 border border-slate-100">
                    <ion-icon name="calendar-outline" class="text-4xl"></ion-icon>
                  </div>
                  <h4 class="text-lg font-bold text-slate-900">No bookings found</h4>
                  <p class="text-slate-500 font-medium mt-1">Try changing the search or status filter.</p>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="p-5 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p class="text-xs text-slate-500 font-semibold">
          Showing {{ pageStart() }}–{{ pageEnd() }} of {{ filteredBookings().length }} bookings
        </p>

        <div class="flex items-center gap-2">
          <button
            type="button"
            (click)="prevPage()"
            [disabled]="currentPage() <= 1"
            class="page-btn disabled:opacity-40"
          >
            Previous
          </button>

          <span class="text-xs font-bold text-slate-500 px-2">
            {{ currentPage() }} / {{ totalPages() }}
          </span>

          <button
            type="button"
            (click)="nextPage()"
            [disabled]="currentPage() >= totalPages()"
            class="page-btn bg-blue-600 text-white disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>

    @if (isModalOpen()) {
      <div class="fixed inset-0 z-[9999] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="w-full max-w-5xl max-h-[92vh] rounded-[2rem] overflow-hidden shadow-2xl bg-white">
        <div class="flex flex-col h-full bg-slate-50">
          <div class="p-6 bg-white border-b border-slate-100 flex items-center justify-between">
            <div>
              <h2 class="text-xl font-display font-bold text-slate-900">Booking Details</h2>
              <p class="text-slate-500 font-medium text-sm mt-1">ID: #{{ selectedBooking()?.id }}</p>
            </div>

            <button
              type="button"
              (click)="closeModal()"
              class="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 hover:bg-slate-900 hover:text-white transition flex items-center justify-center"
            >
              <ion-icon name="close-outline" class="text-xl"></ion-icon>
            </button>
          </div>

          <div class="flex-1 overflow-y-auto p-6 space-y-6">
            @if (selectedBooking()) {
              <div class="p-6 rounded-[1.5rem] text-center bg-white border border-slate-100 shadow-sm">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Current Status</p>
                <app-badge [variant]="getBadgeVariant(selectedBooking()!.status)">
                  {{ formatStatus(selectedBooking()!.status) }}
                </app-badge>
              </div>

              <app-card class="p-6">
                <h3 class="modal-section-title">Route Information</h3>
                <div class="relative pl-8 space-y-6">
                  <div class="absolute left-[9px] top-2 bottom-2 w-0.5 bg-slate-100"></div>

                  <div class="relative">
                    <div class="absolute -left-[27px] top-1 w-4 h-4 rounded-full bg-white border-4 border-blue-600 shadow-sm z-10"></div>
                    <p class="modal-label">Pickup</p>
                    <p class="font-semibold text-sm text-slate-900 leading-snug">{{ selectedBooking()!.pickup_address }}</p>
                  </div>

                  <div class="relative">
                    <div class="absolute -left-[27px] top-1 w-4 h-4 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                    <p class="modal-label">Destination</p>
                    <p class="font-semibold text-sm text-slate-900 leading-snug">{{ selectedBooking()!.dropoff_address || 'N/A' }}</p>
                  </div>
                </div>
              </app-card>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
                <app-card class="p-6">
                  <h3 class="modal-section-title">Customer</h3>
                  <div class="flex items-center gap-4">
                    <div class="modal-avatar bg-blue-50 text-blue-600 border-blue-100">
                      {{ getInitial(selectedBooking()!.customer, 'C') }}
                    </div>
                    <div class="min-w-0">
                      <h4 class="text-base font-bold text-slate-900 truncate">{{ getPersonName(selectedBooking()!.customer, 'Customer') }}</h4>
                      <p class="text-sm text-slate-500 font-medium truncate">{{ selectedBooking()!.customer?.email || 'No email' }}</p>
                    </div>
                  </div>
                </app-card>

                <app-card class="p-6">
                  <h3 class="modal-section-title">Driver</h3>

                  @if (selectedBooking()!.driver) {
                    <div class="flex items-center gap-4">
                      <div class="modal-avatar bg-amber-50 text-amber-600 border-amber-100">
                        {{ getInitial(selectedBooking()!.driver, 'D') }}
                      </div>
                      <div class="min-w-0">
                        <h4 class="text-base font-bold text-slate-900 truncate">{{ getPersonName(selectedBooking()!.driver, 'Driver') }}</h4>
                        <p class="text-sm text-slate-500 font-medium truncate">ID: {{ shortId(selectedBooking()!.driver!.id) }}</p>
                      </div>
                    </div>
                  } @else {
                    <div class="flex items-center gap-4 text-slate-400 italic py-2">
                      <ion-icon name="help-circle-outline" class="text-2xl"></ion-icon>
                      <span class="text-sm font-medium">No driver assigned</span>
                    </div>
                  }
                </app-card>
              </div>

              <div class="bg-slate-900 rounded-[2rem] p-6 text-white shadow-xl space-y-8">
                <div>
                  <h3 class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Manual Driver Assignment</h3>
                  <div class="flex flex-col sm:flex-row items-center gap-4">
                    <select
                      #driverSelect
                      class="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 text-sm font-medium text-white focus:outline-none appearance-none"
                    >
                      <option value="" class="bg-slate-900">Select a driver...</option>
                      @for (driver of drivers(); track driver.id) {
                        <option [value]="driver.id" [selected]="driver.id === selectedBooking()!.driver_id" class="bg-slate-900">
                          {{ getPersonName(driver, 'Driver') }} — {{ driver.status || 'unknown' }}
                        </option>
                      }
                    </select>

                    <app-button
                      variant="primary"
                      size="md"
                      [fullWidth]="false"
                      (clicked)="assignDriver(selectedBooking()!.id, driverSelect.value)"
                      [disabled]="!driverSelect.value"
                      class="h-12 px-8 rounded-xl shrink-0"
                    >
                      Assign Driver
                    </app-button>
                  </div>
                </div>

                <div class="pt-8 border-t border-white/10">
                  <h3 class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Status Override</h3>
                  <div class="flex flex-col sm:flex-row items-center gap-4">
                    <select
                      #statusSelect
                      class="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 text-sm font-medium text-white focus:outline-none appearance-none"
                    >
                      @for (status of allStatuses; track status) {
                        <option [value]="status" [selected]="status === selectedBooking()!.status" class="bg-slate-900">
                          {{ formatStatus(status) }}
                        </option>
                      }
                    </select>

                    <app-button
                      variant="error"
                      size="md"
                      [fullWidth]="false"
                      (clicked)="forceUpdateStatus(selectedBooking()!.id, statusSelect.value)"
                      class="h-12 px-8 rounded-xl shrink-0"
                    >
                      Force Update
                    </app-button>
                  </div>

                  <p class="text-[10px] text-slate-500 italic mt-4 flex items-center">
                    <ion-icon name="information-circle-outline" class="mr-2 text-sm"></ion-icon>
                    Use this only to fix stuck bookings. This bypasses standard transition rules.
                  </p>
                </div>
              </div>

              <div class="bg-blue-600 rounded-[2rem] p-6 text-white flex items-center justify-between shadow-xl shadow-blue-600/20">
                <div>
                  <p class="text-blue-100/80 text-[10px] font-bold uppercase tracking-widest mb-1">Total Price</p>
                  <p class="text-3xl font-display font-bold tracking-tight">
                    {{ getCurrency(selectedBooking()) }}{{ toMoney(selectedBooking()!.price) }}
                  </p>
                </div>

                <div class="text-right">
                  <p class="text-blue-100/80 text-[10px] font-bold uppercase tracking-widest mb-1">Service Type</p>
                  <app-badge variant="primary" class="bg-white/20 text-white border-white/30">
                    {{ selectedBooking()!.service_slug || 'booking' }}
                  </app-badge>
                </div>
              </div>

              @if (selectedBooking()!.service_slug === 'errand' && details()) {
                <app-card class="p-6 space-y-6">
                  <h3 class="modal-section-title">Errand Details</h3>

                  <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
                    <div class="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                      <p class="modal-label">Item Budget</p>
                      <p class="text-xl font-display font-bold text-slate-900">£{{ details()?.['estimated_budget'] || 0 }}</p>
                    </div>

                    <div class="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                      <p class="modal-label">Actual Spend</p>
                      <p class="text-xl font-display font-bold text-emerald-600">£{{ details()?.['actual_spending'] || 0 }}</p>
                    </div>
                  </div>

                  @if (details()?.['receipt_url']) {
                    <app-button variant="secondary" size="sm" (clicked)="viewReceipt(details()?.['receipt_url']?.toString())">
                      <ion-icon name="receipt-outline" slot="start" class="mr-2"></ion-icon>
                      View Receipt
                    </app-button>
                  }

                  @if (details()?.['items_list']) {
                    <div>
                      <p class="modal-label mb-2">Items List</p>
                      <div class="flex flex-wrap gap-2">
                        @for (item of asStringArray(details()?.['items_list']); track item) {
                          <app-badge variant="secondary">{{ item }}</app-badge>
                        }
                      </div>
                    </div>
                  }
                </app-card>
              }
            }
          </div>
        </div>
        </div>
      </div>
    }

    @if (confirmModal()) {
      <div class="fixed inset-0 z-[10000] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6">
          <h3 class="text-xl font-bold text-slate-900">{{ confirmModal()?.title }}</h3>
          <p class="text-sm text-slate-600 mt-4">{{ confirmModal()?.message }}</p>

          <div class="flex justify-end gap-3 mt-6">
            <button type="button" class="modal-cancel" (click)="confirmModal.set(null)">
              {{ confirmModal()?.cancelText || 'Cancel' }}
            </button>
            <button type="button" class="modal-action" (click)="runConfirmAction()">
              {{ confirmModal()?.confirmText || 'Confirm' }}
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
    .filter-select {
      width: 100%;
      background: rgb(248 250 252);
      border: 1px solid rgb(226 232 240);
      border-radius: 0.75rem;
      padding: 0.625rem 1rem;
      font-size: 0.75rem;
      font-weight: 600;
      color: rgb(71 85 105);
      outline: none;
    }

    .th-cell {
      padding: 1rem;
      font-size: 10px;
      font-weight: 800;
      color: rgb(148 163 184);
      text-transform: uppercase;
      letter-spacing: 0.14em;
      white-space: nowrap;
    }

    .avatar {
      width: 2.5rem;
      height: 2.5rem;
      border-radius: 0.75rem;
      border-width: 1px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75rem;
      font-weight: 800;
      flex-shrink: 0;
    }

    .modal-avatar {
      width: 3.25rem;
      height: 3.25rem;
      border-radius: 1rem;
      border-width: 1px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      flex-shrink: 0;
    }

    .page-btn {
      height: 2.25rem;
      padding: 0 0.8rem;
      border-radius: 0.75rem;
      background: rgb(248 250 252);
      color: rgb(71 85 105);
      border: 1px solid rgb(226 232 240);
      font-size: 0.75rem;
      font-weight: 800;
    }

    .modal-section-title {
      font-size: 10px;
      font-weight: 800;
      color: rgb(148 163 184);
      text-transform: uppercase;
      letter-spacing: 0.14em;
      margin-bottom: 1.25rem;
    }

    .modal-label {
      font-size: 10px;
      color: rgb(148 163 184);
      text-transform: uppercase;
      font-weight: 800;
      letter-spacing: 0.14em;
      margin-bottom: 0.25rem;
    }

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

  `]
})
export class BookingListComponent implements OnInit {
    private adminService = inject(AdminService);
    private bookingService = inject(BookingService);
    private supabase = inject(SupabaseService);

    ServiceTypeEnum = ServiceTypeEnum;

    bookings = signal<Job[]>([]);
    drivers = signal<(DriverProfile & { vehicles: Vehicle[] })[]>([]);
    selectedBooking = signal<Job | null>(null);
    details = signal<Record<string, string | number | boolean | string[] | null | undefined> | null>(null);
    isModalOpen = signal(false);

    toastMessage = signal<string | null>(null);
    toastType = signal<'success' | 'danger' | 'warning'>('success');

    confirmModal = signal<{
        title: string;
        message: string;
        confirmText?: string;
        cancelText?: string;
        action?: () => Promise<void>;
    } | null>(null);

    searchTerm = signal('');
    statusFilter = signal('all');
    currentPage = signal(1);
    pageSize = signal(10);

    allStatuses: string[] = [
        'requested',
        'searching',
        'assigned',
        'accepted',
        'arrived',
        'heading_to_pickup',
        'arrived_at_store',
        'shopping_in_progress',
        'collected',
        'en_route_to_customer',
        'delivered',
        'in_progress',
        'completed',
        'cancelled',
        'settled'
    ];

    filteredBookings = computed(() => {
        const term = this.searchTerm().toLowerCase().trim();
        const status = this.statusFilter();

        return this.bookings().filter((booking: any) => {
            const searchText = [
                booking.id,
                booking.status,
                booking.service_slug,
                booking.pickup_address,
                booking.dropoff_address,
                booking.customer?.full_name,
                booking.customer?.first_name,
                booking.customer?.last_name,
                booking.customer?.email,
                booking.customer?.phone,
                booking.driver?.full_name,
                booking.driver?.first_name,
                booking.driver?.last_name,
                booking.driver?.email,
                booking.driver?.phone
            ].filter(Boolean).join(' ').toLowerCase();

            const matchesSearch = !term || searchText.includes(term);
            const matchesStatus = status === 'all' || String(booking.status || '').toLowerCase() === status;

            return matchesSearch && matchesStatus;
        });
    });

    totalPages = computed(() => Math.max(1, Math.ceil(this.filteredBookings().length / this.pageSize())));

    pagedBookings = computed(() => {
        const start = (this.currentPage() - 1) * this.pageSize();
        return this.filteredBookings().slice(start, start + this.pageSize());
    });

    pageStart = computed(() => this.filteredBookings().length ? ((this.currentPage() - 1) * this.pageSize()) + 1 : 0);
    pageEnd = computed(() => Math.min(this.currentPage() * this.pageSize(), this.filteredBookings().length));

    async ngOnInit() {
        await Promise.all([
            this.loadBookings(),
            this.loadDrivers()
        ]);
    }

    async loadBookings() {
        try {
            const data = await this.adminService.getJobs();
            this.bookings.set(Array.isArray(data) ? data as Job[] : []);

            if (this.currentPage() > this.totalPages()) {
                this.currentPage.set(this.totalPages());
            }
        } catch (error: unknown) {
            await this.showToast(error instanceof Error ? error.message : 'Failed to load bookings.', 'danger');
            this.bookings.set([]);
        }
    }

    async loadDrivers() {
        try {
            const data = await this.adminService.getDrivers();
            this.drivers.set(Array.isArray(data) ? data as (DriverProfile & { vehicles: Vehicle[] })[] : []);
        } catch (error: unknown) {
            await this.showToast(error instanceof Error ? error.message : 'Failed to load drivers.', 'danger');
            this.drivers.set([]);
        }
    }

    onSearch(event: Event) {
        this.searchTerm.set((event.target as HTMLInputElement).value || '');
        this.currentPage.set(1);
    }

    onStatusFilterChange(event: Event) {
        this.statusFilter.set((event.target as HTMLSelectElement).value || 'all');
        this.currentPage.set(1);
    }

    onPageSizeChange(event: Event) {
        this.pageSize.set(Number((event.target as HTMLSelectElement).value || 10));
        this.currentPage.set(1);
    }

    nextPage() {
        this.currentPage.update(page => Math.min(page + 1, this.totalPages()));
    }

    prevPage() {
        this.currentPage.update(page => Math.max(page - 1, 1));
    }

    async viewDetails(booking: Job) {
        this.selectedBooking.set(booking);
        this.isModalOpen.set(true);
        this.details.set(null);

        try {
            const bookingDetails = await this.bookingService.getBookingDetails(
                booking.id,
                booking.service_slug as ServiceTypeEnum
            );

            this.details.set(bookingDetails as Record<string, string | number | boolean | string[] | null | undefined>);
        } catch (e) {
            console.error('Failed to load details', e);
            this.details.set(null);
        }
    }


    async forceUpdateStatus(bookingId: string, status: string) {
        this.confirmModal.set({
            title: 'Confirm Update',
            message: `Force update this booking to ${this.formatStatus(status)}?`,
            confirmText: 'Update',
            cancelText: 'Cancel',
            action: async () => {
                await this.adminService.updateBookingStatus(
                    bookingId,
                    status as BookingStatus,
                    'Admin force update'
                );

                await this.loadBookings();

                const updated = this.bookings().find(b => b.id === bookingId);
                if (updated) this.selectedBooking.set(updated);

                await this.showToast('Status updated successfully.', 'success');
            }
        });
    }

    async assignDriver(bookingId: string, driverId: string) {
        if (!driverId) {
            await this.showToast('Please select a driver.', 'warning');
            return;
        }

        this.confirmModal.set({
            title: 'Confirm Assignment',
            message: 'Manually assign this driver to the booking?',
            confirmText: 'Assign',
            cancelText: 'Cancel',
            action: async () => {
                await this.adminService.manualAssignDriver(bookingId, driverId);
                await this.loadBookings();

                const updated = await this.bookingService.getBooking(bookingId);
                this.selectedBooking.set(updated as Job);

                await this.showToast('Driver assigned successfully.', 'success');
            }
        });
    }

    async runConfirmAction() {
        const current = this.confirmModal();

        if (!current?.action) {
            this.confirmModal.set(null);
            return;
        }

        try {
            await current.action();
            this.confirmModal.set(null);
        } catch (e: unknown) {
            await this.showToast(
                e instanceof Error ? e.message : 'Action failed.',
                'danger'
            );
        }
    }

    closeModal() {
        this.isModalOpen.set(false);
        this.selectedBooking.set(null);
        this.details.set(null);
    }

    getBadgeVariant(status: string): 'success' | 'warning' | 'error' | 'primary' | 'secondary' | 'info' {
        switch ((status || '').toLowerCase()) {
            case 'completed':
            case 'settled':
            case 'delivered':
                return 'success';
            case 'cancelled':
            case 'canceled':
                return 'error';
            case 'searching':
            case 'requested':
                return 'warning';
            case 'accepted':
            case 'assigned':
            case 'arrived':
            case 'heading_to_pickup':
                return 'primary';
            case 'in_progress':
            case 'shopping_in_progress':
            case 'arrived_at_store':
            case 'collected':
            case 'en_route_to_customer':
                return 'info';
            default:
                return 'secondary';
        }
    }

    formatStatus(status: string | null | undefined): string {
        return String(status || 'unknown').replace(/_/g, ' ');
    }

    shortId(id: string | null | undefined): string {
        return (id || '').slice(0, 8).toUpperCase() || 'UNKNOWN';
    }

    getPersonName(person: any, fallback: string): string {
        const fullName = person?.full_name || `${person?.first_name || ''} ${person?.last_name || ''}`.trim();
        return fullName || person?.email || person?.phone || fallback;
    }

    getInitial(person: any, fallback: string): string {
        return this.getPersonName(person, fallback).charAt(0).toUpperCase();
    }

    getCurrency(booking: any): string {
        if (booking?.currency_symbol) return booking.currency_symbol;

        switch (String(booking?.currency_code || 'GBP').toUpperCase()) {
            case 'NGN': return '₦';
            case 'USD': return '$';
            case 'EUR': return '€';
            case 'CAD': return '$';
            case 'AUD': return '$';
            case 'AED': return 'د.إ';
            case 'GBP':
            default:
                return '£';
        }
    }

    toMoney(value: unknown): string {
        return Number(value || 0).toFixed(2);
    }

    asStringArray(value: unknown): string[] {
        if (Array.isArray(value)) return value.map(v => String(v));
        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed)) return parsed.map(v => String(v));
            } catch {
                return value.split('\n').map(v => v.trim()).filter(Boolean);
            }
        }

        return [];
    }

    viewReceipt(path: string | null | undefined) {
        if (!path) return;

        const { data } = this.supabase.storage.from('documents').getPublicUrl(path);

        if (data?.publicUrl) {
            window.open(data.publicUrl, '_blank');
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