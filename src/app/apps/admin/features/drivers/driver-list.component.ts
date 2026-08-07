import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { AdminService } from '../../services/admin.service';
import { DriverProfile, Vehicle } from '../../../../shared/models/booking.model';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { BadgeComponent, ButtonComponent, EmptyStateComponent } from '../../../../shared/ui';
import { AuthService } from '../../../../core/services/auth/auth.service';
import { OnboardingTourService } from '../../../../core/services/onboarding-tour/onboarding-tour.service';
import { ComplianceService } from '../../../../core/services/compliance/compliance.service';
import {
    getBlockingRequirements,
    getVehiclePlateValue,
    isRideSelected as engineRideSelected,
    normaliseSelectedServices,
    normaliseVehicleClass,
    vehicleRequiresRegistration
} from '../../../../shared/verification/driver-requirements.engine';

type AdminDriver = DriverProfile & {
    vehicles?: Vehicle[];
    vehicle?: Vehicle | null;
    full_name?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    auth_email?: string | null;
    date_of_birth?: string | null;
    dob_correction_request?:{id:string;status:'pending'|'approved'|'rejected';public_message:string;private_admin_note:string|null;permission_consumed_at:string|null}|null;
    phone?: string | null;
    council_license_number?: string | null;
    council_name?: string | null;
    taxi_badge_number?: string | null;
    taxi_license_expiry?: string | null;
    private_hire_vehicle_license_url?: string | null;
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
    driver_review_status?: 'pending' | 'action_required' | 'under_review' | 'approved' | 'rejected' | null;
    driver_review_notes?: string | null;
    driver_review_blockers?: string[] | string | null;
    driver_review_sent_at?: string | null;
    driver_review_sent_by?: string | null;
};

@Component({
    selector: 'app-driver-list',
    standalone: true,
    imports: [
        CommonModule,
        IonicModule,
        BadgeComponent,
        ButtonComponent,
        EmptyStateComponent
    ],
    template: `
    <div class="bg-white rounded-[2rem] border border-slate-100 shadow-xl shadow-slate-200/40 overflow-hidden">
      <div class="p-6 border-b border-slate-100 flex flex-col xl:flex-row xl:items-center justify-between gap-5">
        <div>
          <h3 class="text-xl font-display font-bold text-slate-900">Driver Management</h3>
          <p class="text-sm text-slate-500 font-medium mt-1">
            Scan driver contact, vehicle, documents, payout and review status.
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
            <option value="closure_requested">Closure Requested</option>
            <option value="closed">Closed</option>
            <option value="reinstated">Reinstated</option>
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

                      <div class="mt-1 space-y-0.5">
                        <p class="text-[11px] text-slate-600 font-semibold leading-tight truncate">
                          {{ getDriverEmail(driver) }}
                        </p>
                        <p class="text-[11px] text-slate-400 font-medium leading-tight truncate">
                          {{ getDriverPhone(driver) }}
                        </p>
                      </div>

                      @if (driver.testing_approval_override) {
                        <span class="inline-flex mt-2 px-2 py-1 rounded-full bg-blue-50 text-blue-700 text-[10px] font-semibold">
                          Manually Approved
                        </span>
                      }
                    </div>
                  </div>
                </td>

                <td class="px-4 py-4">
                  <div class="space-y-1 min-w-[155px]">
                    @if (isRideSelected(driver)) {
                      <p class="text-xs font-bold leading-tight"
                        [class.text-slate-800]="driver.council_name"
                        [class.text-rose-600]="!driver.council_name">
                        {{ getCouncilSummary(driver) }}
                      </p>

                      <p class="mini-line">Licence: {{ driver.council_license_number || 'Missing' }}</p>
                      <p class="mini-line">Badge: {{ driver.taxi_badge_number || 'Missing' }}</p>
                      <p class="mini-line">Expiry: {{ formatDate(driver.taxi_license_expiry) }}</p>
                    } @else {
                      <span class="inline-flex rounded-full bg-slate-100 text-slate-500 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.08em]">
                        Not required
                      </span>
                      <p class="mini-line mt-1">Ride not selected</p>
                    }
                  </div>
                </td>

                <td class="px-4 py-4">
                  @if (getVehicle(driver)) {
                    <div class="text-sm font-semibold text-slate-900 leading-tight min-w-[145px]">
                      {{ getVehicleMakeModel(driver) }}

                      <div class="flex gap-2 mt-1">
                        <span class="mini-line">{{ getVehiclePlate(driver) }}</span>
                        <span class="mini-line">-</span>
                        <span class="mini-line">{{ getVehicleColor(driver) }}</span>
                      </div>

                      <div class="flex flex-wrap gap-1.5 mt-2">
                        <span class="vehicle-chip">{{ getVehicleClassLabel(driver) }}</span>
                        <span class="vehicle-chip">{{ getSelectedServiceLabels(driver) }}</span>
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

                    <button type="button" (click)="manualApproveDriver(driver)" class="action-btn hover:bg-green-600 hover:text-white" title="Review and Approve">
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
        <div class="bg-white rounded-[2rem] shadow-2xl w-full max-w-5xl max-h-[92vh] overflow-hidden">
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

          <div class="p-6 overflow-y-auto max-h-[74vh] space-y-5">
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
                <p class="detail-label">Review outcome</p>
                <app-badge [variant]="selectedDriver()?.testing_approval_override ? 'success' : 'secondary'">
                  {{ selectedDriver()?.testing_approval_override ? 'USED' : 'NOT USED' }}
                </app-badge>
              </div>
            </div>

            <div class="grid md:grid-cols-2 gap-4">
              <div class="detail-card">
                <p class="detail-label">Contact</p>
                <div class="space-y-2 mt-2">
                  <div>
                    <span class="detail-muted">Registered Email:</span>
                    <span class="detail-value">{{ getDriverEmail(selectedDriver()) }}</span>
                  </div>
                  <div>
                    <span class="detail-muted">Phone:</span>
                    <span class="detail-value">{{ getDriverPhone(selectedDriver()) }}</span>
                  </div>
                  <div>
                    <span class="detail-muted">Date of Birth:</span>
                    <span class="detail-value">{{ formatDate(selectedDriver()?.date_of_birth) }}</span>
                  </div>
                  @if(selectedDriver()?.dob_correction_request;as correction){<div class="rounded-xl border border-amber-200 bg-amber-50 p-3"><p class="text-xs font-black text-amber-900">DOB correction: {{correction.status}}</p><p class="mt-1 text-xs text-amber-800">{{correction.public_message}}</p>@if(correction.status==='pending'){<div class="mt-2 flex gap-2"><button type="button" class="text-xs font-bold text-green-700" (click)="resolveDobCorrection(selectedDriver(),true)">Allow correction</button><button type="button" class="text-xs font-bold text-rose-700" (click)="resolveDobCorrection(selectedDriver(),false)">Reject</button></div>}</div>}
                  <div>
                    <span class="detail-muted">Driver ID:</span>
                    <span class="detail-value break-all">{{ selectedDriver()?.id }}</span>
                  </div>
                </div>
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

              @if (isRideSelected(selectedDriver())) {
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
              } @else {
                <p class="detail-muted mt-3">Not required for the selected services.</p>
              }
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

                  <div>
                    <span class="detail-muted">Class:</span>
                    <span class="detail-value">{{ getVehicleClassLabel(selectedDriver()) }}</span>
                  </div>

                  <div>
                    <span class="detail-muted">Capacity:</span>
                    <span class="detail-value">{{ getVehicleCapacityLabel(selectedDriver()) }}</span>
                  </div>

                  <div class="sm:col-span-2">
                    <span class="detail-muted">Selected services:</span>
                    <span class="detail-value">{{ getSelectedServiceLabels(selectedDriver()) }}</span>
                  </div>

                  <div class="sm:col-span-2">
                    <span class="detail-muted">Can Handle:</span>
                    <span class="detail-value">{{ getVehicleCapabilitySummary(selectedDriver()) }}</span>
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

            <div class="detail-card border-amber-100 bg-amber-50/50">
              <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div>
                  <p class="detail-label">Send Missing Information Request</p>
                  <p class="detail-muted mt-1">
                    Pick the items the driver must fix. They will see this in the app before resubmitting.
                  </p>
                </div>

                @if (selectedDriver()?.driver_review_sent_at) {
                  <span class="text-xs font-semibold text-amber-700">
                    Last sent {{ formatDate(selectedDriver()?.driver_review_sent_at) }}
                  </span>
                }
              </div>

              <div class="mt-4 space-y-2">
                @for (blocker of getReviewFeedbackOptions(selectedDriver()); track blocker) {
                  <label class="flex items-start gap-3 rounded-xl bg-white border border-amber-100 px-3 py-2 text-sm text-slate-700 font-semibold">
                    <input
                      type="checkbox"
                      class="mt-1 accent-amber-500"
                      [checked]="isReviewBlockerSelected(blocker)"
                      (change)="toggleReviewBlocker(blocker, $any($event.target).checked)"
                    />
                    <span>{{ blocker }}</span>
                  </label>
                }
              </div>

              <textarea
                class="mt-4 w-full min-h-28 rounded-2xl border border-amber-100 bg-white p-3 text-sm text-slate-700 font-medium focus:outline-none focus:ring-2 focus:ring-amber-300"
                [value]="reviewFeedbackNotes()"
                (input)="reviewFeedbackNotes.set($any($event.target).value)"
                placeholder="Write a clear message for the driver..."
              ></textarea>

              <app-button class="mt-4 w-full" variant="primary" (clicked)="sendMissingInfoRequest(selectedDriver())">
                Send to Driver
              </app-button>
            </div>

            @if (selectedDriver()?.manual_verification_notes) {
              <div class="detail-card">
                <p class="detail-label">Review notes</p>
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
                Review and Approve
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
            @for (status of ['active', 'closure_requested', 'closed', 'reinstated', 'suspended', 'banned', 'disabled']; track status) {
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
      font-size: 9px;
      font-weight: 800;
      color: rgb(148 163 184);
      text-transform: uppercase;
      letter-spacing: 0.1em;
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

    .vehicle-chip {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      background: rgb(239 246 255);
      color: rgb(37 99 235);
      border: 1px solid rgb(219 234 254);
      padding: 0.2rem 0.5rem;
      font-size: 10px;
      font-weight: 800;
      line-height: 1;
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
    private tour = inject(OnboardingTourService);
    private complianceService = inject(ComplianceService);

    drivers = signal<AdminDriver[]>([]);
    selectedDriver = signal<AdminDriver | null>(null);
    reviewFeedbackNotes = signal('');
    selectedReviewBlockers = signal<string[]>([]);

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
                vehicle?.color,
                vehicle?.type,
                vehicle?.capacity,
                this.getVehicleClassLabel(driver),
                this.getVehicleCapacityLabel(driver)
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
        this.tour.startIfNeeded('admin');
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

    getDriverEmail(driver: any): string {
        return String(driver?.email || driver?.auth_email || '').trim() || 'No email';
    }

    getDriverPhone(driver: any): string {
        return String(driver?.phone || '').trim() || 'No phone';
    }

    getDriverContact(driver: any): string {
        const email = this.getDriverEmail(driver);
        const phone = this.getDriverPhone(driver);

        if (email !== 'No email' && phone !== 'No phone') return `${email} • ${phone}`;
        if (email !== 'No email') return email;
        if (phone !== 'No phone') return phone;

        return 'No email or phone';
    }

    isRideSelected(driver: any): boolean {
        return engineRideSelected(driver, this.getVehicle(driver));
    }

    getCouncilSummary(driver: any): string {
        if (!this.isRideSelected(driver)) return 'Not required';
        return String(driver?.council_name || '').trim() || 'Council missing';
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

        const plate = getVehiclePlateValue(vehicle);
        return plate || 'No plate';
    }

    getVehicleColor(driver: any): string {
        const vehicle = this.getVehicle(driver);
        return vehicle?.color || 'No colour';
    }

    getVehicleClassLabel(driver: any): string {
        const vehicle = this.getVehicle(driver);
        const vehicleClass = normaliseVehicleClass(vehicle);

        if (!vehicle) return 'No class';
        if (vehicleClass === 'bike') return 'Bike';
        if (vehicleClass === 'large_van') return 'Large van';
        if (vehicleClass === 'small_van') return 'Small van';
        if (vehicleClass === 'xl_7_seater') return 'XL / 7 seater';
        return 'Car';
    }

    getVehicleCapacityLabel(driver: any): string {
        const vehicle = this.getVehicle(driver);
        const raw = String(vehicle?.capacity || '').trim();

        if (!vehicle) return 'Capacity missing';
        if (!raw) return this.getVehicleClassLabel(driver) === 'XL / 7 seater' ? 'Up to 7 seats' : 'Up to 4 seats';

        return raw
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (char) => char.toUpperCase());
    }

    private getSelectedServices(driver: any): string[] {
        return normaliseSelectedServices(driver, this.getVehicle(driver));
    }

    private parseVerificationItems(value: unknown): Record<string, unknown> {
        if (!value) return {};

        if (Array.isArray(value)) {
            return value.reduce<Record<string, unknown>>((items, entry) => {
                if (!entry || typeof entry !== 'object') return items;
                const record = entry as Record<string, unknown>;
                const key = String(record['key'] || record['name'] || record['field'] || '').trim();
                if (key) items[key] = record['value'] ?? record['label'] ?? '';
                return items;
            }, {});
        }

        if (typeof value === 'object') return value as Record<string, unknown>;

        if (typeof value === 'string') {
            try {
                return this.parseVerificationItems(JSON.parse(value));
            } catch {
                return {};
            }
        }

        return {};
    }

    getSelectedServiceLabels(driver: any): string {
        const services = this.getSelectedServices(driver);
        if (!services.length) return 'Legacy defaults';

        const labels: Record<string, string> = {
            ride: 'Ride',
            errand: 'Errands',
            delivery: 'Package delivery',
            van: 'Van / Moving'
        };

        return services.map(service => labels[service] || service).join(', ');
    }

    getVehicleCapabilitySummary(driver: any): string {
        const label = this.getVehicleClassLabel(driver);

        switch (label) {
            case 'Bike':
                return 'Small delivery requests';
            case 'Small van':
                return 'Car, delivery, errand and small van moves';
            case 'Large van':
                return 'Car, XL, delivery, errand and all van moves';
            case 'XL / 7 seater':
                return 'Car, XL and 7 seater ride requests';
            case 'Car':
                return 'Standard ride, errand and car delivery';
            default:
                return 'Vehicle capabilities need review';
        }
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
            case 'reinstated':
                return 'success';
            case 'suspended':
            case 'closure_requested':
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

    getManualReviewSummary(driver: any): string {
        if (driver?.testing_approval_override) return 'Manually approved';
        if (this.isApproved(driver)) return 'Approved';
        return 'Manual review';
    }

    getBlockers(driver: any): string[] {
        const raw = driver?.verification_blockers ?? driver?.driver_review_blockers;
        const engineBlockers = this.getEngineBlockers(driver);
        return this.filterReviewBlockers(driver, [
            ...this.parseStringList(raw),
            ...engineBlockers
        ]);
    }

    getReviewFeedbackOptions(driver: any): string[] {
        const existing = this.filterReviewBlockers(driver, [
            ...this.parseStringList(driver?.driver_review_blockers),
            ...this.parseStringList(driver?.verification_blockers)
        ]);

        return this.filterReviewBlockers(driver, Array.from(new Set([
            ...existing,
            ...this.getEngineBlockers(driver)
        ].filter(Boolean) as string[])));
    }

    private getEngineBlockers(driver: any): string[] {
        const vehicle = this.getVehicle(driver);
        const selectedServices = this.getSelectedServices(driver);
        
        // Use ComplianceService as source of truth for all service types
        const allRequirements = selectedServices.map(serviceType => 
            this.complianceService.getDriverMissingRequirements(
                driver,
                vehicle,
                { ...driver, ...vehicle },
                serviceType as any
            )
        ).flat();
        
        // Also check base requirements
        const baseRequirements = this.complianceService.getDriverMissingRequirements(
            driver,
            vehicle,
            { ...driver, ...vehicle },
            'base'
        );
        
        // Combine and filter for blockers only
        const allBlockers = [...allRequirements, ...baseRequirements]
            .filter(req => req.severity === 'blocker')
            .map(req => req.message);
        
        // Remove duplicates
        return Array.from(new Set(allBlockers));
    }

    private filterReviewBlockers(driver: any, blockers: string[]): string[] {
        const vehicle = this.getVehicle(driver);
        const selectedServices = this.getSelectedServices(driver);
        const plate = getVehiclePlateValue(vehicle);
        const needsRideReview = this.isRideSelected(driver);
        const needsRegistration = vehicleRequiresRegistration(
            normaliseVehicleClass(vehicle),
            selectedServices,
            driver?.country_code || driver?.country
        );

        return blockers.filter((blocker) => {
            const text = String(blocker || '').toLowerCase();

            if ((!needsRegistration || plate) && (
                text.includes('vehicle registration number is missing') ||
                text.includes('registration plate is missing') ||
                text.includes('vehicle registration is missing')
            )) {
                return false;
            }

            if (!needsRideReview && (
                text.includes('council') ||
                text.includes('taxi') ||
                text.includes('private hire') ||
                text.includes('badge number') ||
                text.includes('phv')
            )) {
                return false;
            }

            if (driver?.council_name && (text.includes('council/private hire authority') || text.includes('council name') || text.includes('licensing authority'))) return false;
            if (driver?.council_license_number && text.includes('council licence number')) return false;
            if (driver?.taxi_badge_number && text.includes('taxi badge number')) return false;
            if (driver?.taxi_license_expiry && text.includes('taxi licence expiry')) return false;
            if (driver?.private_hire_vehicle_license_url && text.includes('private hire vehicle licence')) return false;

            if ((driver?.insurance_url || driver?.courier_insurance_url || driver?.hire_reward_insurance_url) && (
                text.includes('insurance document is missing') ||
                text.includes('courier insurance') ||
                text.includes('hire and reward')
            )) {
                return false;
            }

            return true;
        });
    }

    isReviewBlockerSelected(blocker: string): boolean {
        return this.selectedReviewBlockers().includes(blocker);
    }

    toggleReviewBlocker(blocker: string, checked: boolean) {
        const current = new Set(this.selectedReviewBlockers());

        if (checked) {
            current.add(blocker);
        } else {
            current.delete(blocker);
        }

        this.selectedReviewBlockers.set(Array.from(current));
    }

    private parseStringList(raw: unknown): string[] {

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

    private getVehiclePlateValue(vehicle: any): string {
        return String(
            vehicle?.license_plate ??
            vehicle?.registration_plate ??
            vehicle?.registration_number ??
            vehicle?.plate_number ??
            vehicle?.vehicle_registration ??
            ''
        ).trim();
    }

    viewDriver(driver: AdminDriver) {
        this.reviewFeedbackNotes.set(
            driver.driver_review_notes ||
            driver.verification_notes ||
            'Your verification needs more information. Please update the selected items and resubmit for review.'
        );
        this.selectedReviewBlockers.set(this.getReviewFeedbackOptions(driver));
        this.selectedDriver.set(driver);
    }

    closeDriverModal() {
        this.selectedDriver.set(null);
        this.reviewFeedbackNotes.set('');
        this.selectedReviewBlockers.set([]);
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

        const blockers = this.getReviewFeedbackOptions(driver);
        const blockerMessage = blockers.length
            ? `Some blockers are still present. Approve anyway?\n\n${blockers.map((item) => `• ${item}`).join('\n')}`
            : 'This approves the driver manually while external verification APIs are disabled.';

        this.confirmModal.set({
            title: 'Review and Approve',
            subtitle: this.getDriverName(driver),
            message: blockerMessage,
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

    async resolveDobCorrection(driver:AdminDriver|null,approved:boolean){const request=driver?.dob_correction_request;if(!driver?.id||!request)return;const publicMessage=window.prompt('Public message for the driver',approved?'Correction approved. You may update your date of birth once.':'Correction request was not approved.')||'';const privateNote=window.prompt('Private Admin note (not shown to the driver)','')||'';try{await this.adminService.resolveDobCorrection(driver.id,request.id,approved,publicMessage,privateNote);await this.loadDrivers();}catch(error){console.error('[Admin] DOB correction resolution failed',error);}}

    async sendMissingInfoRequest(driver: any) {
        if (!driver?.id) return;

        const blockers = this.selectedReviewBlockers().length
            ? this.selectedReviewBlockers()
            : this.getReviewFeedbackOptions(driver);

        const notes =
            this.reviewFeedbackNotes().trim() ||
            'Your verification needs more information. Please update the selected items and resubmit for review.';

        if (!blockers.length) {
            await this.showToast('No missing items selected.', 'warning');
            return;
        }

        try {
            console.log('[admin-driver-review] sending', {
                driverId: driver.id,
                notes,
                blockers
            });

            const result = await this.adminService.sendDriverMissingInfoRequest(
                driver.id,
                notes,
                blockers
            );

            console.log('[admin-driver-review] saved', result);

            await this.showToast('Missing information request sent to driver.', 'success');
            await this.loadDrivers();

            const updated = this.drivers().find((d) => d.id === driver.id);

            if (updated) {
                this.selectedDriver.set(updated);
                this.reviewFeedbackNotes.set(
                    updated.driver_review_notes ||
                    'Your verification needs more information. Please update the selected items and resubmit for review.'
                );
                this.selectedReviewBlockers.set(this.getReviewFeedbackOptions(updated));
            }
        } catch (error: unknown) {
            console.error('[admin-driver-review] failed', error);

            await this.showToast(
                error instanceof Error
                    ? error.message
                    : 'Could not send missing information request.',
                'danger'
            );
        }
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
