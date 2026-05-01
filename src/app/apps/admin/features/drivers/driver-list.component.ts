import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { AdminService } from '../../services/admin.service';
import { DriverProfile, Vehicle } from '../../../../shared/models/booking.model';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { BadgeComponent, ButtonComponent, RatingComponent, EmptyStateComponent } from '../../../../shared/ui';
import { AuthService } from '../../../../core/services/auth/auth.service';

type AdminDriver = DriverProfile & {
    vehicles?: Vehicle[];
    vehicle?: Vehicle | null;
    full_name?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    council_license_number?: string | null;
    council_name?: string | null;
    taxi_badge_number?: string | null;
    taxi_license_expiry?: string | null;
    stripe_connect_status?: string | null;
    stripe_account_id?: string | null;
    driver_license_url?: string | null;
    insurance_url?: string | null;
    verification_blockers?: string[] | string | null;
    testing_approval_override?: boolean | null;
    manual_verification_notes?: string | null;
    vehicle_check_status?: string | null;
    mot_check_status?: string | null;
    insurance_check_status?: string | null;
    council_check_status?: string | null;
};

@Component({
    selector: 'app-driver-list',
    standalone: true,
    imports: [
        CommonModule,
        IonicModule,
        BadgeComponent,
        ButtonComponent,
        RatingComponent,
        EmptyStateComponent
    ],
    template: `
    <div class="bg-white rounded-[2rem] border border-slate-100 shadow-xl shadow-slate-200/40 overflow-hidden">
      <div class="p-6 border-b border-slate-100 flex flex-col xl:flex-row xl:items-center justify-between gap-5">
        <div>
          <h3 class="text-xl font-display font-bold text-slate-900">Driver Management</h3>
          <p class="text-sm text-slate-500 font-medium mt-1">
            Review drivers, documents, council licence, manual approval and payout readiness.
          </p>
        </div>

        <div class="flex flex-col sm:flex-row items-center gap-3 w-full xl:w-auto">
          <select (change)="onPlanFilterChange($event)" class="filter-select">
            <option value="all">All Plans</option>
            <option value="starter">Starter</option>
            <option value="pro">Pro</option>
          </select>

          <select (change)="onStatusFilterChange($event)" class="filter-select">
            <option value="all">All Statuses</option>
            <option value="approved">Approved</option>
            <option value="under_review">Under Review</option>
            <option value="action_required">Action Required</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="banned">Banned</option>
          </select>

          <div class="relative w-full sm:w-64">
            <ion-icon name="search-outline" class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"></ion-icon>
            <input
              type="text"
              placeholder="Search drivers..."
              (input)="onSearch($event)"
              class="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-2.5 text-xs font-medium text-slate-600 focus:outline-none"
            />
          </div>

          <select (change)="onPageSizeChange($event)" class="filter-select sm:w-32">
            <option value="10">10 / page</option>
            <option value="20">20 / page</option>
            <option value="50">50 / page</option>
          </select>
        </div>
      </div>

      <div class="overflow-x-auto max-w-full">
        <table class="w-full text-left border-collapse min-w-[1080px]">
          <thead>
            <tr class="bg-slate-50/70">
              <th class="th-cell">Driver</th>
              <th class="th-cell">Council</th>
              <th class="th-cell">Vehicle</th>
              <th class="th-cell">Docs</th>
              <th class="th-cell">Stripe</th>
              <th class="th-cell">Verification</th>
              <th class="th-cell text-right">Actions</th>
            </tr>
          </thead>

          <tbody class="divide-y divide-slate-100">
            @for (driver of pagedDrivers(); track driver.id) {
              <tr class="hover:bg-slate-50/80 transition-all align-top">
                <td class="px-4 py-4">
                  <div class="flex items-center gap-3 min-w-[210px]">
                    <div class="avatar bg-amber-50 text-amber-600 border-amber-100">
                      {{ getInitial(driver) }}
                    </div>

                    <div class="min-w-0">
                      <h4 class="text-sm font-semibold text-slate-900 leading-tight truncate">
                        {{ getDriverName(driver) }}
                      </h4>

                      <p class="text-xs text-slate-500 font-medium mt-1 truncate">
                        {{ getDriverContact(driver) }}
                      </p>

                      @if (driver.testing_approval_override) {
                        <span class="inline-flex mt-2 px-2 py-1 rounded-full bg-blue-50 text-blue-700 text-[10px] font-semibold">
                          Manually Approved
                        </span>
                      }
                    </div>
                  </div>
                </td>

                <td class="px-4 py-4">
                  <div class="space-y-1 min-w-[165px]">
                    <p class="text-xs font-semibold leading-tight"
                      [class.text-slate-800]="driver.council_name"
                      [class.text-rose-600]="!driver.council_name">
                      {{ driver.council_name || 'Council missing' }}
                    </p>

                    <p class="mini-line">Licence: {{ driver.council_license_number || 'Missing' }}</p>
                    <p class="mini-line">Badge: {{ driver.taxi_badge_number || 'Missing' }}</p>
                    <p class="mini-line">
                      Expiry: {{ formatDate(driver.taxi_license_expiry) }}
                    </p>
                  </div>
                </td>

                <td class="px-4 py-4">
                  @if (getVehicle(driver)) {
                    <div class="text-sm font-semibold text-slate-900 leading-tight min-w-[145px]">
                      {{ getVehicleMakeModel(driver) }}

                      <div class="flex gap-2 mt-1">
                        <span class="mini-line">{{ getVehiclePlate(driver) }}</span>
                        <span class="mini-line">•</span>
                        <span class="mini-line">{{ getVehicleColor(driver) }}</span>
                      </div>
                    </div>
                  } @else {
                    <span class="text-xs text-rose-500 font-semibold italic">No vehicle</span>
                  }
                </td>

                <td class="px-4 py-4">
                  <div class="flex flex-col gap-2 min-w-[125px]">
                    <button
                      type="button"
                      (click)="openDocument(driver.driver_license_url, 'Driver licence')"
                      class="doc-pill"
                      [class.doc-ok]="driver.driver_license_url"
                      [class.doc-missing]="!driver.driver_license_url">
                      {{ driver.driver_license_url ? 'Licence' : 'No licence' }}
                    </button>

                    <button
                      type="button"
                      (click)="openDocument(driver.insurance_url, 'Insurance')"
                      class="doc-pill"
                      [class.doc-ok]="driver.insurance_url"
                      [class.doc-missing]="!driver.insurance_url">
                      {{ driver.insurance_url ? 'Insurance' : 'No insurance' }}
                    </button>
                  </div>
                </td>

                <td class="px-4 py-4">
                  <app-badge [variant]="getStripeVariant(driver)">
                    {{ getStripeText(driver) }}
                  </app-badge>
                </td>

                <td class="px-4 py-4">
                  <div class="flex flex-col gap-2 min-w-[135px]">
                    <app-badge [variant]="getVerificationVariant(driver)">
                      {{ getVerificationText(driver) }}
                    </app-badge>

                    <span class="text-[11px] text-slate-500 font-medium">
                      {{ getManualReviewSummary(driver) }}
                    </span>
                  </div>
                </td>

                <td class="px-4 py-4 text-right">
                  <div class="flex items-center justify-end gap-2">
                    <button type="button" (click)="viewDriver(driver)" class="action-btn hover:bg-blue-600 hover:text-white" title="View Details">
                      <ion-icon name="eye-outline" class="text-lg"></ion-icon>
                    </button>

                    <button type="button" (click)="preVerifyDriver(driver)" class="action-btn hover:bg-amber-600 hover:text-white" title="Check Missing Items">
                      <ion-icon name="checkmark-circle-outline" class="text-lg"></ion-icon>
                    </button>

                    <button type="button" (click)="manualApproveDriver(driver)" class="action-btn hover:bg-green-600 hover:text-white" title="Manual Approval">
                      <ion-icon name="checkmark-done-outline" class="text-lg"></ion-icon>
                    </button>

                    <button type="button" (click)="moderateDriver(driver)" class="action-btn hover:bg-slate-800 hover:text-white" title="Moderate Driver">
                      <ion-icon name="shield-outline" class="text-lg"></ion-icon>
                    </button>
                  </div>
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="7" class="px-10 py-16">
                  <app-empty-state
                    icon="people-outline"
                    title="No drivers found"
                    description="No drivers match your current filters.">
                  </app-empty-state>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="p-5 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p class="text-xs text-slate-500 font-semibold">
          Showing {{ pageStart() }}–{{ pageEnd() }} of {{ filteredDrivers().length }} drivers
        </p>

        <div class="flex items-center gap-2">
          <button type="button" (click)="prevPage()" [disabled]="currentPage() <= 1" class="page-btn disabled:opacity-40">
            Previous
          </button>

          <span class="text-xs font-bold text-slate-500 px-2">
            {{ currentPage() }} / {{ totalPages() }}
          </span>

          <button type="button" (click)="nextPage()" [disabled]="currentPage() >= totalPages()" class="page-btn bg-blue-600 text-white disabled:opacity-40">
            Next
          </button>
        </div>
      </div>
    </div>

    @if (selectedDriver()) {
      <div class="fixed inset-0 z-[9999] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-white rounded-[2rem] shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden">
          <div class="p-6 border-b border-slate-100 flex items-start justify-between gap-4">
            <div>
              <h2 class="text-xl font-display font-bold text-slate-900">
                {{ getDriverName(selectedDriver()) }}
              </h2>
              <p class="text-sm text-slate-500 font-medium mt-1">
                Full driver verification details
              </p>
            </div>

            <button type="button" (click)="closeDriverModal()" class="w-10 h-10 rounded-xl bg-slate-50 text-slate-500 hover:bg-slate-900 hover:text-white transition">
              <ion-icon name="close-outline" class="text-xl"></ion-icon>
            </button>
          </div>

          <div class="p-6 overflow-y-auto max-h-[70vh] space-y-5">
            <div class="grid md:grid-cols-3 gap-4">
              <div class="detail-card">
                <p class="detail-label">Verification</p>
                <app-badge [variant]="getVerificationVariant(selectedDriver())">
                  {{ getVerificationText(selectedDriver()) }}
                </app-badge>
              </div>

              <div class="detail-card">
                <p class="detail-label">Account</p>
                <app-badge [variant]="getAccountStatusVariant(selectedDriver()?.account_status || 'active')">
                  {{ selectedDriver()?.account_status || 'active' | uppercase }}
                </app-badge>
              </div>

              <div class="detail-card">
                <p class="detail-label">Manual Approval</p>
                <app-badge [variant]="selectedDriver()?.testing_approval_override ? 'success' : 'secondary'">
                  {{ selectedDriver()?.testing_approval_override ? 'USED' : 'NOT USED' }}
                </app-badge>
              </div>
            </div>

            <div class="grid md:grid-cols-2 gap-4">
              <div class="detail-card">
                <p class="detail-label">Contact</p>
                <p class="detail-value">{{ selectedDriver()?.email || 'No email' }}</p>
                <p class="detail-muted">{{ selectedDriver()?.phone || 'No phone' }}</p>
              </div>

              <div class="detail-card">
                <p class="detail-label">Stripe</p>
                <app-badge [variant]="getStripeVariant(selectedDriver())">
                  {{ getStripeText(selectedDriver()) }}
                </app-badge>
              </div>
            </div>

            <div class="detail-card">
              <p class="detail-label">Council / Taxi Licence</p>

              <div class="grid sm:grid-cols-2 gap-3 mt-3">
                <div>
                  <span class="detail-muted">Council:</span>
                  <span class="detail-value">{{ selectedDriver()?.council_name || 'Missing' }}</span>
                </div>

                <div>
                  <span class="detail-muted">Licence No:</span>
                  <span class="detail-value">{{ selectedDriver()?.council_license_number || 'Missing' }}</span>
                </div>

                <div>
                  <span class="detail-muted">Badge No:</span>
                  <span class="detail-value">{{ selectedDriver()?.taxi_badge_number || 'Missing' }}</span>
                </div>

                <div>
                  <span class="detail-muted">Expiry:</span>
                  <span class="detail-value">{{ formatDate(selectedDriver()?.taxi_license_expiry) }}</span>
                </div>
              </div>
            </div>

            <div class="detail-card">
              <p class="detail-label">Vehicle</p>

              @if (getVehicle(selectedDriver())) {
                <div class="grid sm:grid-cols-2 gap-3 mt-3">
                  <div>
                    <span class="detail-muted">Make/Model:</span>
                    <span class="detail-value">{{ getVehicleMakeModel(selectedDriver()) }}</span>
                  </div>

                  <div>
                    <span class="detail-muted">Plate:</span>
                    <span class="detail-value">{{ getVehiclePlate(selectedDriver()) }}</span>
                  </div>

                  <div>
                    <span class="detail-muted">Colour:</span>
                    <span class="detail-value">{{ getVehicleColor(selectedDriver()) }}</span>
                  </div>

                  <div>
                    <span class="detail-muted">Year:</span>
                    <span class="detail-value">{{ getVehicle(selectedDriver())?.year || 'Missing' }}</span>
                  </div>
                </div>
              } @else {
                <p class="text-sm text-rose-500 font-semibold mt-2">No vehicle details found.</p>
              }
            </div>

            <div class="detail-card">
              <p class="detail-label">Documents</p>

              <div class="flex flex-col sm:flex-row gap-3 mt-4">
                <button
                  type="button"
                  (click)="openDocument(selectedDriver()?.driver_license_url, 'Driver licence')"
                  class="modal-doc-btn">
                  <ion-icon name="document-text-outline"></ion-icon>
                  {{ selectedDriver()?.driver_license_url ? 'Open Driver Licence' : 'Driver Licence Missing' }}
                </button>

                <button
                  type="button"
                  (click)="openDocument(selectedDriver()?.insurance_url, 'Insurance')"
                  class="modal-doc-btn">
                  <ion-icon name="shield-checkmark-outline"></ion-icon>
                  {{ selectedDriver()?.insurance_url ? 'Open Insurance' : 'Insurance Missing' }}
                </button>
              </div>
            </div>

            @if (getBlockers(selectedDriver()).length) {
              <div class="rounded-2xl border border-amber-100 bg-amber-50 p-5">
                <p class="text-xs font-bold text-amber-900 uppercase tracking-widest mb-3">
                  Review Notes / Blockers
                </p>

                <ul class="space-y-2">
                  @for (blocker of getBlockers(selectedDriver()); track blocker) {
                    <li class="text-sm text-amber-800 font-medium">• {{ blocker }}</li>
                  }
                </ul>
              </div>
            }

            @if (selectedDriver()?.manual_verification_notes) {
              <div class="detail-card">
                <p class="detail-label">Manual Approval Notes</p>
                <p class="text-sm text-slate-700 font-medium mt-2">
                  {{ selectedDriver()?.manual_verification_notes }}
                </p>
              </div>
            }

            <div class="flex flex-col sm:flex-row gap-3 pt-2">
              <app-button variant="secondary" class="flex-1" (clicked)="preVerifyDriver(selectedDriver())">
                Check Missing Items
              </app-button>

              <app-button class="flex-1" (clicked)="manualApproveDriver(selectedDriver())">
                Manual Approval
              </app-button>
            </div>
          </div>
        </div>
      </div>
    }

    @if (reviewModal()) {
      <div class="fixed inset-0 z-[10000] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl shadow-2xl w-full max-w-lg p-6">
          <h3 class="text-xl font-bold text-slate-900">{{ reviewModal()?.title }}</h3>
          <p class="text-sm text-slate-600 whitespace-pre-line mt-4">{{ reviewModal()?.message }}</p>

          <div class="flex justify-end mt-6">
            <button type="button" class="modal-action" (click)="reviewModal.set(null)">OK</button>
          </div>
        </div>
      </div>
    }

    @if (confirmModal()) {
      <div class="fixed inset-0 z-[10000] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl shadow-2xl w-full max-w-xl p-6">
          <h3 class="text-xl font-bold text-slate-900">{{ confirmModal()?.title }}</h3>
          <p class="text-sm font-medium text-slate-700 mt-1">{{ confirmModal()?.subtitle }}</p>
          <p class="text-sm text-slate-600 mt-4">{{ confirmModal()?.message }}</p>

          <textarea
            class="w-full mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm outline-none"
            rows="4"
            [value]="confirmModal()?.notes || ''"
            (input)="updateConfirmNotes($event)"
          ></textarea>

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

    @if (moderationModal()) {
      <div class="fixed inset-0 z-[10000] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6">
          <h3 class="text-xl font-bold text-slate-900">Moderate Driver</h3>
          <p class="text-sm font-medium text-slate-700 mt-1">{{ getDriverName(moderationModal()?.driver) }}</p>

          <div class="space-y-3 mt-5">
            @for (status of ['active', 'suspended', 'banned', 'disabled']; track status) {
              <label class="flex items-center gap-3 rounded-2xl border border-slate-100 p-3 cursor-pointer">
                <input
                  type="radio"
                  name="driverStatus"
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

    .mini-line {
      font-size: 11px;
      font-weight: 500;
      color: rgb(100 116 139);
    }

    .doc-pill {
      font-size: 0.75rem;
      font-weight: 700;
      border-radius: 0.6rem;
      padding: 0.45rem 0.75rem;
      border-width: 1px;
      text-align: left;
      transition: all 150ms ease;
    }

    .doc-ok {
      background: rgb(236 253 245);
      color: rgb(4 120 87);
      border-color: rgb(209 250 229);
    }

    .doc-missing {
      background: rgb(255 241 242);
      color: rgb(244 63 94);
      border-color: rgb(255 228 230);
    }

    .action-btn {
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 0.75rem;
      background: rgb(248 250 252);
      color: rgb(148 163 184);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 150ms ease;
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

    .detail-card {
      border: 1px solid rgb(241 245 249);
      background: rgb(248 250 252 / 0.6);
      border-radius: 1.1rem;
      padding: 1rem;
    }

    .detail-label {
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: rgb(148 163 184);
      margin-bottom: 0.45rem;
    }

    .detail-value {
      font-size: 0.82rem;
      font-weight: 700;
      color: rgb(15 23 42);
    }

    .detail-muted {
      font-size: 0.75rem;
      font-weight: 600;
      color: rgb(100 116 139);
    }

    .modal-doc-btn {
      flex: 1;
      border-radius: 0.9rem;
      border: 1px solid rgb(209 250 229);
      background: rgb(236 253 245);
      color: rgb(4 120 87);
      font-weight: 700;
      font-size: 0.78rem;
      padding: 0.8rem 1rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      transition: all 150ms ease;
    }

    .modal-doc-btn:hover {
      background: rgb(16 185 129);
      color: white;
    }

    .modal-action {
      border-radius: 0.9rem;
      background: rgb(22 163 74);
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
export class DriverListComponent implements OnInit {
    private adminService = inject(AdminService);
    private authService = inject(AuthService);

    drivers = signal<AdminDriver[]>([]);
    selectedDriver = signal<AdminDriver | null>(null);

    toastMessage = signal<string | null>(null);
    toastType = signal<'success' | 'danger' | 'warning'>('success');

    confirmModal = signal<{
        title: string;
        subtitle?: string;
        message: string;
        confirmText?: string;
        cancelText?: string;
        notes?: string;
        action?: (notes?: string) => Promise<void>;
    } | null>(null);

    reviewModal = signal<{
        title: string;
        message: string;
    } | null>(null);

    moderationModal = signal<{
        driver: AdminDriver;
        status: string;
    } | null>(null);

    searchTerm = signal('');
    statusFilter = signal('all');
    planFilter = signal('all');
    currentPage = signal(1);
    pageSize = signal(10);

    filteredDrivers = computed(() => {
        const term = this.safeLower(this.searchTerm()).trim();
        const statusFilter = this.safeLower(this.statusFilter());
        const planFilter = this.safeLower(this.planFilter());

        return this.drivers().filter((driver) => {
            const vehicle = this.getVehicle(driver);

            const searchText = [
                this.getDriverName(driver),
                driver?.phone,
                driver?.email,
                driver?.verification_status,
                driver?.account_status,
                driver?.council_name,
                driver?.council_license_number,
                driver?.taxi_badge_number,
                this.getVehiclePlate(driver),
                vehicle?.make,
                vehicle?.model,
                vehicle?.color
            ]
                .map((item) => this.safeLower(item))
                .join(' ');

            const plan = this.safeLower((driver as any)?.pricing_plan || 'starter');
            const verification = this.safeLower((driver as any)?.verification_status);
            const accountStatus = this.safeLower((driver as any)?.account_status);
            const legacyStatus = this.safeLower((driver as any)?.status);

            const matchesSearch = !term || searchText.includes(term);

            const matchesStatus =
                statusFilter === 'all' ||
                verification === statusFilter ||
                accountStatus === statusFilter ||
                legacyStatus === statusFilter;

            const matchesPlan = planFilter === 'all' || plan === planFilter;

            return matchesSearch && matchesStatus && matchesPlan;
        });
    });

    totalPages = computed(() =>
        Math.max(1, Math.ceil(this.filteredDrivers().length / this.pageSize()))
    );

    pagedDrivers = computed(() => {
        const safePage = Math.min(this.currentPage(), this.totalPages());
        const start = (safePage - 1) * this.pageSize();
        return this.filteredDrivers().slice(start, start + this.pageSize());
    });

    pageStart = computed(() =>
        this.filteredDrivers().length ? ((this.currentPage() - 1) * this.pageSize()) + 1 : 0
    );

    pageEnd = computed(() =>
        Math.min(this.currentPage() * this.pageSize(), this.filteredDrivers().length)
    );

    async ngOnInit() {
        await this.loadDrivers();
    }

    async loadDrivers() {
        try {
            const data = await this.adminService.getDrivers();
            this.drivers.set((Array.isArray(data) ? data : []) as AdminDriver[]);

            if (this.currentPage() > this.totalPages()) {
                this.currentPage.set(this.totalPages());
            }
        } catch (error: unknown) {
            await this.showToast(error instanceof Error ? error.message : 'Failed to load drivers.', 'danger');
            this.drivers.set([]);
        }
    }

    onSearch(event: Event) {
        this.searchTerm.set((event.target as HTMLInputElement)?.value || '');
        this.currentPage.set(1);
    }

    onStatusFilterChange(event: Event) {
        this.statusFilter.set((event.target as HTMLSelectElement)?.value || 'all');
        this.currentPage.set(1);
    }

    onPlanFilterChange(event: Event) {
        this.planFilter.set((event.target as HTMLSelectElement)?.value || 'all');
        this.currentPage.set(1);
    }

    onPageSizeChange(event: Event) {
        const value = Number((event.target as HTMLSelectElement)?.value || 10);
        this.pageSize.set(Number.isFinite(value) && value > 0 ? value : 10);
        this.currentPage.set(1);
    }

    nextPage() {
        this.currentPage.update((page) => Math.min(page + 1, this.totalPages()));
    }

    prevPage() {
        this.currentPage.update((page) => Math.max(page - 1, 1));
    }

    getVehicle(driver: any): any | null {
        if (driver?.vehicle) return driver.vehicle;

        if (Array.isArray(driver?.vehicles) && driver.vehicles.length > 0) {
            return driver.vehicles[0] || null;
        }

        return null;
    }

    getDriverName(driver: any): string {
        const fullName =
            driver?.full_name ||
            `${driver?.first_name || ''} ${driver?.last_name || ''}`.trim();

        return fullName || driver?.email || driver?.phone || 'Driver';
    }

    getInitial(driver: any): string {
        const name = this.getDriverName(driver);
        return name.charAt(0).toUpperCase();
    }

    getDriverContact(driver: any): string {
        return driver?.email || driver?.phone || 'No contact';
    }

    getVehicleMakeModel(driver: any): string {
        const vehicle = this.getVehicle(driver);

        if (!vehicle) return 'No vehicle';

        const make = vehicle?.make || 'Unknown';
        const model = vehicle?.model || '';

        return `${make} ${model}`.trim();
    }

    getVehiclePlate(driver: any): string {
        const vehicle = this.getVehicle(driver);

        return (
            vehicle?.license_plate ||
            vehicle?.registration_number ||
            vehicle?.plate_number ||
            'No plate'
        );
    }

    getVehicleColor(driver: any): string {
        const vehicle = this.getVehicle(driver);
        return vehicle?.color || 'No colour';
    }

    formatDate(value: string | null | undefined): string {
        if (!value) return 'Missing';

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            return value;
        }

        return date.toLocaleDateString();
    }

    safeLower(value: any): string {
        return String(value || '').toLowerCase();
    }

    isApproved(driver: any): boolean {
        return driver?.is_verified === true || driver?.verification_status === 'approved';
    }

    getVerificationText(driver: any): string {
        if (driver?.verification_status === 'approved' || driver?.is_verified) {
            return driver?.testing_approval_override ? 'Approved Manually' : 'Approved';
        }

        if (driver?.verification_status === 'ready_for_admin_review') return 'Ready For Review';
        if (driver?.verification_status === 'action_required') return 'Action Required';
        if (driver?.verification_status === 'under_review') return 'Under Review';
        if (driver?.verification_status === 'rejected') return 'Rejected';

        return 'Pending';
    }

    getVerificationVariant(driver: any): 'success' | 'warning' | 'error' | 'secondary' {
        if (driver?.verification_status === 'approved' || driver?.is_verified) return 'success';
        if (driver?.verification_status === 'action_required' || driver?.verification_status === 'rejected') return 'error';
        if (driver?.verification_status === 'under_review' || driver?.verification_status === 'ready_for_admin_review') return 'warning';
        return 'secondary';
    }

    getStripeText(driver: any): string {
        const status = this.safeLower(driver?.stripe_connect_status);

        if (status === 'enabled' || status === 'connected' || driver?.stripe_account_id) {
            return 'Enabled';
        }

        if (status === 'pending') return 'Pending';

        return 'Not Started';
    }

    getStripeVariant(driver: any): 'success' | 'warning' | 'secondary' {
        const status = this.safeLower(driver?.stripe_connect_status);

        if (status === 'enabled' || status === 'connected' || driver?.stripe_account_id) {
            return 'success';
        }

        if (status === 'pending') return 'warning';

        return 'secondary';
    }

    getAccountStatusVariant(status: string): 'success' | 'warning' | 'error' | 'secondary' {
        switch (this.safeLower(status)) {
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

    getManualReviewSummary(driver: any): string {
        if (driver?.testing_approval_override) return 'Manually approved';
        if (this.isApproved(driver)) return 'Approved';
        return 'Manual review';
    }

    getBlockers(driver: any): string[] {
        const raw = driver?.verification_blockers;

        if (Array.isArray(raw)) {
            return raw.map((item) => String(item)).filter(Boolean);
        }

        if (typeof raw === 'string') {
            try {
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed)
                    ? parsed.map((item) => String(item)).filter(Boolean)
                    : raw
                        ? [raw]
                        : [];
            } catch {
                return raw ? [raw] : [];
            }
        }

        return [];
    }

    viewDriver(driver: AdminDriver) {
        this.selectedDriver.set(driver);
    }

    closeDriverModal() {
        this.selectedDriver.set(null);
    }

    async openDocument(path: string | null | undefined, label: string) {
        if (!path) {
            await this.showToast(`${label} not uploaded.`, 'warning');
            return;
        }

        try {
            let url = path;

            if (!path.startsWith('http')) {
                url = await this.adminService.getDriverDocumentSignedUrl(path);
            }

            if (!url) {
                await this.showToast(`Could not create secure link for ${label}.`, 'danger');
                return;
            }

            window.open(url, '_blank', 'noopener,noreferrer');
        } catch (error: unknown) {
            await this.showToast(
                error instanceof Error ? error.message : `Could not open ${label}.`,
                'danger'
            );
        }
    }


    async preVerifyDriver(driver: any) {
        if (!driver?.id) return;

        try {
            const result = await this.adminService.preVerifyDriver(driver.id);
            const blockers = Array.isArray(result?.blockers) ? result.blockers : [];

            this.reviewModal.set({
                title: result?.canApprove ? 'Ready for manual approval' : 'Manual review needed',
                message: blockers.length
                    ? blockers.join('\\n')
                    : 'No blockers found. Driver can be approved manually.'
            });

            await this.loadDrivers();

            const updated = this.drivers().find((d) => d.id === driver.id);

            if (updated && this.selectedDriver()) {
                this.selectedDriver.set(updated);
            }
        } catch (error: unknown) {
            await this.showToast(
                error instanceof Error ? error.message : 'Pre-verification failed',
                'danger'
            );
        }
    }

    async manualApproveDriver(driver: any) {
        if (!driver?.id) return;

        this.confirmModal.set({
            title: 'Manual Approval',
            subtitle: this.getDriverName(driver),
            message: 'This approves the driver manually while external verification APIs are disabled.',
            notes: 'Approved manually. External verification APIs are not enabled yet.',
            confirmText: 'Approve',
            cancelText: 'Cancel',
            action: async (notes?: string) => {
                await this.adminService.manualApproveDriver(driver.id, notes || '');
                await this.showToast('Driver approved manually.', 'success');
                await this.loadDrivers();

                const updated = this.drivers().find((d) => d.id === driver.id);

                if (updated && this.selectedDriver()) {
                    this.selectedDriver.set(updated);
                }
            }
        });
    }

    async toggleVerification(driverId: string, isVerified: boolean) {
        try {
            await this.adminService.verifyDriver(driverId, isVerified);
            await this.loadDrivers();
        } catch (error: unknown) {
            await this.showToast(
                error instanceof Error ? error.message : 'Failed to update verification.',
                'danger'
            );
        }
    }

    async moderateDriver(driver: AdminDriver) {
        this.moderationModal.set({
            driver,
            status: driver.account_status || 'active'
        });
    }

    updateConfirmNotes(event: Event) {
        const value = (event.target as HTMLTextAreaElement)?.value || '';
        const current = this.confirmModal();

        if (current) {
            this.confirmModal.set({ ...current, notes: value });
        }
    }

    async runConfirmAction() {
        const current = this.confirmModal();

        if (!current?.action) {
            this.confirmModal.set(null);
            return;
        }

        try {
            await current.action(current.notes);
            this.confirmModal.set(null);
        } catch (error: unknown) {
            await this.showToast(
                error instanceof Error ? error.message : 'Action failed',
                'danger'
            );
        }
    }

    setModerationStatus(status: string) {
        const current = this.moderationModal();

        if (current) {
            this.moderationModal.set({ ...current, status });
        }
    }

    async applyModerationStatus() {
        const current = this.moderationModal();

        if (!current?.driver || !current.status) return;

        try {
            await this.adminService.updateAccountStatus(
                current.driver.id,
                current.status,
                `Admin changed driver status to ${current.status}`,
                this.authService.currentUser()?.id || ''
            );

            await this.showToast(`Driver status updated to ${current.status}`, 'success');
            this.moderationModal.set(null);

            this.drivers.update((drivers) =>
                drivers.map((d) =>
                    d.id === current.driver.id
                        ? ({ ...d, account_status: current.status } as AdminDriver)
                        : d
                )
            );

            await this.loadDrivers();

            const updated = this.drivers().find((d) => d.id === current.driver.id);

            if (updated && this.selectedDriver()) {
                this.selectedDriver.set(updated);
            }
        } catch (error: unknown) {
            await this.showToast(
                error instanceof Error ? error.message : 'Failed to update driver status.',
                'danger'
            );
        }
    }

    private async showToast(
        message: string,
        color: 'success' | 'danger' | 'warning' = 'success'
    ) {
        this.toastType.set(color);
        this.toastMessage.set(message);

        window.setTimeout(() => {
            this.toastMessage.set(null);
        }, 2500);
    }

}