import { Component, inject, computed, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonContent,
    IonIcon,
    IonToggle,
    LoadingController,
    ToastController
} from '@ionic/angular/standalone';
import { ActivatedRoute, Router } from '@angular/router';
import { addIcons } from 'ionicons';
import {
    shieldCheckmark,
    walletOutline,
    logOutOutline,
    locationOutline,
    checkmarkDoneOutline,
    starOutline,
    moonOutline,
    searchOutline,
    star,
    statsChart,
    card,
    timeOutline,
    alertCircleOutline,
    flashOutline,
    radioOutline,
    cashOutline,
    checkmarkCircleOutline,
    personAddOutline,
    listOutline,
    navigate,
    chevronDownOutline,
    settingsOutline
} from 'ionicons/icons';
import { RealtimeChannel } from '@supabase/supabase-js';
import { Haptics, NotificationType } from '@capacitor/haptics';

import { DriverService } from '../../../../../core/services/driver/driver.service';
import { AuthService } from '../../../../../core/services/auth/auth.service';
import { LocationService } from '../../../../../core/services/logistics/location.service';
import { ProfileService } from '../../../../../core/services/profile/profile.service';
import { ConnectService } from '../../../../../core/services/stripe/connect.service';
import { SupabaseService } from '../../../../../core/services/supabase/supabase.service';
import { VehicleCompatibilityService } from '../../../../../core/services/driver/vehicle-compatibility.service';
import { OneSignalService } from '../../../../../core/services/notification/onesignal.service';
import { OnboardingTourService } from '../../../../../core/services/onboarding-tour/onboarding-tour.service';
import {
    CardComponent,
    ButtonComponent,
    BadgeComponent,
    RatingComponent,
    EmptyStateComponent,
    PerformanceBadgeComponent,
    MovabiCarouselComponent,
    MovabiCarouselSlide
} from '../../../../../shared/ui';
import { Booking, DriverProfile, ServiceTypeEnum } from '../../../../../shared/models/booking.model';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';

type ToastColor = 'success' | 'danger' | 'warning';

type StripeUiState = {
    accountId: string | null;
    status: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
};

type MetricState = {
    value: number | null;
    label: string;
    display: string;
    isNew: boolean;
};

type DriverDashboardStats = {
    todayJobs: number;
    acceptedJobs: number;
    completedJobs: number;
};

type PassedJob = {
    id: string;
    passedAt: number;
};

@Component({
    selector: 'app-driver-dashboard',
    standalone: true,
    imports: [
        CommonModule,
        IonHeader,
        IonToolbar,
        IonTitle,
        IonButtons,
        IonContent,
        IonIcon,
        IonToggle,
        CardComponent,
        ButtonComponent,
        BadgeComponent,
        RatingComponent,
        EmptyStateComponent,
        PerformanceBadgeComponent,
        MovabiCarouselComponent
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-3 pt-4 bg-slate-50">
        <ion-title class="font-display font-black text-[1.65rem] tracking-tighter text-slate-950">
          Driver Hub
        </ion-title>

        <ion-buttons slot="end">
          @if (auth.userRole() === 'admin') {
            <button
              type="button"
              (click)="router.navigate(['/dashboard'])"
              class="w-11 h-11 rounded-2xl bg-indigo-50 text-indigo-700 flex items-center justify-center border border-indigo-100 shadow-sm active:scale-95 transition-all"
            >
              <ion-icon name="shield-checkmark" class="text-xl"></ion-icon>
            </button>
          }

          <button
            type="button"
            (click)="router.navigate(['/driver/earnings'])"
            class="w-11 h-11 rounded-2xl bg-white text-slate-700 flex items-center justify-center border border-slate-200 shadow-sm ml-2 active:scale-95 transition-all"
          >
            <ion-icon name="wallet-outline" class="text-xl"></ion-icon>
          </button>

          <button
            type="button"
            (click)="router.navigate(['/driver/settings'])"
            class="w-11 h-11 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center border border-amber-100 shadow-sm ml-2 active:scale-95 transition-all"
          >
            <ion-icon name="settings-outline" class="text-xl"></ion-icon>
          </button>

          <button
            type="button"
            (click)="auth.signOut()"
            class="w-11 h-11 rounded-2xl bg-red-50 text-red-600 flex items-center justify-center border border-red-100 shadow-sm ml-2 active:scale-95 transition-all"
          >
            <ion-icon name="log-out-outline" class="text-xl"></ion-icon>
          </button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="movabi-page">
      <div class="w-full max-w-xl mx-auto px-3 py-3 space-y-5 pb-20 overflow-x-hidden">
        @if (toastVisible()) {
          <div
            class="fixed top-5 left-4 right-4 z-[9999] max-w-xl mx-auto rounded-2xl px-5 py-4 shadow-2xl border text-sm font-bold"
            [class.bg-emerald-50]="toastColor() === 'success'"
            [class.text-emerald-800]="toastColor() === 'success'"
            [class.border-emerald-100]="toastColor() === 'success'"
            [class.bg-amber-50]="toastColor() === 'warning'"
            [class.text-amber-800]="toastColor() === 'warning'"
            [class.border-amber-100]="toastColor() === 'warning'"
            [class.bg-rose-50]="toastColor() === 'danger'"
            [class.text-rose-800]="toastColor() === 'danger'"
            [class.border-rose-100]="toastColor() === 'danger'"
          >
            {{ toastMessage() }}
          </div>
        }

        @if (isUnderReview()) {
          <div class="bg-white rounded-[2rem] p-6 border border-slate-100 shadow-xl shadow-slate-200/50 space-y-6">
            <div class="text-center space-y-4">
              <div class="w-14 h-14 bg-amber-50 rounded-[1.75rem] flex items-center justify-center mx-auto border border-amber-100">
                <ion-icon name="time-outline" class="text-4xl text-amber-600"></ion-icon>
              </div>

              <h2 class="text-lg font-display font-bold text-slate-950">
                Manual Review in Progress
              </h2>

              <p class="text-slate-600 font-medium leading-relaxed">
                We are reviewing your profile and documents. This usually takes 24 to 48 hours.
              </p>
            </div>

            <app-button variant="outline" (clicked)="router.navigate(['/driver/onboarding'])">
              Review Documents
            </app-button>
          </div>
        } @else if (isActionRequired()) {
          <div class="bg-white rounded-[2rem] p-6 border border-rose-100 shadow-xl shadow-rose-100/30 space-y-6">
            <div class="text-center space-y-4">
              <div class="w-14 h-14 bg-rose-50 rounded-[1.75rem] flex items-center justify-center mx-auto border border-rose-100">
                <ion-icon name="alert-circle-outline" class="text-4xl text-rose-600"></ion-icon>
              </div>

              <h2 class="text-lg font-display font-bold text-slate-950">
                Changes Needed
              </h2>

              <p class="text-slate-600 font-medium leading-relaxed">
                Please review your submitted details and resubmit.
              </p>
            </div>

            @if (verificationNotes()) {
              <div class="rounded-2xl bg-rose-50 border border-rose-100 p-4 text-sm text-slate-700">
                {{ verificationNotes() }}
              </div>
            }

            @if (reviewBlockers().length) {
              <ul class="rounded-2xl bg-rose-50 border border-rose-100 p-4 space-y-2 text-left">
                @for (blocker of reviewBlockers(); track blocker) {
                  <li class="text-sm text-rose-900 font-semibold leading-relaxed">• {{ blocker }}</li>
                }
              </ul>
            }

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <app-button variant="secondary" size="sm" class="w-full" (clicked)="router.navigate(['/driver/onboarding'])">
                Update Details
              </app-button>
              <app-button variant="secondary" size="sm" class="w-full" (clicked)="router.navigate(['/driver/onboarding'])">
                Upload Documents
              </app-button>
              <app-button variant="primary" color="error" size="sm" class="w-full" [disabled]="resubmittingReview()" (clicked)="resubmitDriverReview()">
                {{ resubmittingReview() ? 'Sending...' : 'Resubmit' }}
              </app-button>
            </div>
          </div>
        } @else if (!isVerified()) {
          <div class="bg-white rounded-[2rem] p-7 border border-slate-100 shadow-xl shadow-slate-200/50 text-center space-y-6">
            <div class="w-14 h-14 bg-blue-50 rounded-[2rem] flex items-center justify-center mx-auto border border-blue-100">
              <ion-icon name="person-add-outline" class="text-4xl text-blue-600"></ion-icon>
            </div>

            <div class="space-y-2">
              <h2 class="text-lg font-display font-bold text-slate-950">Complete Onboarding</h2>
              <p class="text-slate-500 font-medium leading-relaxed">
                Add your vehicle, upload documents, and connect payouts to start receiving ride, errand, and moving requests.
              </p>
            </div>

            <app-button variant="primary" (clicked)="router.navigate(['/driver/onboarding'])">
              Continue Setup
            </app-button>
          </div>
        } @else {
          @if (!isStripeReady()) {
            <div class="relative overflow-hidden rounded-[1.75rem] border border-amber-100 bg-gradient-to-br from-amber-50 via-white to-rose-50 p-5 shadow-lg shadow-amber-100/40">
              <div class="relative flex items-start gap-4">
                <div class="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-amber-600 shadow-sm border border-amber-100 shrink-0">
                  <ion-icon name="cash-outline" class="text-xl"></ion-icon>
                </div>

                <div class="flex-1 min-w-0">
                  <span class="text-[10px] font-bold uppercase tracking-[0.2em] text-amber-600">
                    Payouts setup
                  </span>

                  <h3 class="font-display font-bold text-slate-950 text-lg mt-2 mb-1">
                    Stripe Connect {{ isStripePending() ? 'needs attention' : 'not completed' }}
                  </h3>

                  <p class="text-sm text-slate-600 font-medium leading-relaxed">
                    {{ getStripeDescription() }}
                  </p>

                  <div class="mt-4">
                    <app-button variant="primary" color="warning" size="sm" class="w-full" (clicked)="setupPayouts()">
                      {{ isStripePending() ? 'Continue Stripe Setup' : 'Start Stripe Setup' }}
                    </app-button>
                  </div>
                </div>
              </div>
            </div>
          }

          @if (locationError() && status() === 'online') {
            <div class="bg-amber-50 border border-amber-100 rounded-2xl p-4 flex items-center gap-3 text-amber-700 text-sm shadow-sm">
              <ion-icon name="location-outline" class="text-xl shrink-0"></ion-icon>
              <p class="font-medium">{{ locationError() }}</p>
            </div>
          }

          @if (activeJob()) {
          <button
  type="button"
  (click)="resumeActiveJob()"
  class="w-full text-left relative overflow-hidden
         rounded-[1.75rem]
         bg-white
         border border-slate-200
         shadow-lg shadow-slate-200/40
         px-4 py-4
         active:scale-[0.99]
         transition-all"
>
  <div class="absolute top-0 left-0 right-0 h-1.5 bg-amber-500"></div>

  <div class="flex gap-4 items-start">

    <div class="w-10 h-10 rounded-2xl
                bg-amber-50
                border border-amber-100
                flex items-center justify-center
                shrink-0">
      <ion-icon
        name="navigate"
        class="text-xl text-amber-600">
      </ion-icon>
    </div>

    <div class="flex-1 min-w-0 space-y-2">

      <div>
        <p class="text-[10px] uppercase tracking-[0.1em] font-black text-slate-500">
          Continue Active Request
        </p>

        <div class="mt-2">
          <span class="inline-flex
                       px-3 py-1
                       rounded-full
                       border
                       border-slate-200
                       bg-slate-50
                       text-[10px]
                       font-bold
                       uppercase
                        tracking-wide">
            {{ activeJobStatusLabel() }}
          </span>
        </div>
      </div>

      <h3 class="text-lg font-display font-bold text-slate-900 leading-tight">
        {{ activeJobTitle() }}
      </h3>

      <p class="text-sm text-slate-600 leading-5 whitespace-normal">
        {{ activeJobRouteLabel() }}
      </p>

      <div class="pt-1">
        <span class="text-sm font-bold text-amber-700">
          Resume →
        </span>
      </div>

    </div>

  </div>
</button>
          }

          @if (hasDriverReviewActionRequired()) {
            <button
              type="button"
              class="w-full rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-left shadow-sm shadow-amber-100/40 active:scale-[0.99] transition-all"
              (click)="router.navigate(['/driver/settings'])"
            >
              <div class="flex items-start gap-3">
                <div class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
                  <ion-icon name="alert-circle-outline" class="text-xl"></ion-icon>
                </div>

                <div class="min-w-0">
                  <p class="text-[10px] font-black uppercase tracking-[0.12em] text-amber-800">
                    Action Required
                  </p>
                  <p class="mt-1 text-sm font-bold leading-snug text-slate-950">
                    Your driver verification needs attention.
                  </p>
                  <p class="mt-0.5 text-xs font-semibold leading-snug text-amber-800">
                    Tap here to update your information.
                  </p>
                </div>
              </div>
            </button>
          }

          <div class="movabi-hero" data-tour="driver-status">
            <div class="absolute inset-x-0 top-0 h-1.5 bg-blue-600"></div>

            <div class="relative z-10">
              <div class="flex flex-col gap-5">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="movabi-badge-sm mb-4 bg-white/80">
                      <ion-icon name="radio-outline" class="text-sm"></ion-icon>
                      Live status
                    </div>

                    <h2 class="movabi-hero-title">
                      {{ status() === 'online' ? (isAvailable() ? 'Active' : 'Busy') : 'Offline' }}
                    </h2>

                    <p class="movabi-hero-subtitle mt-3 max-w-[14rem]">
                      @if (status() === 'offline') {
                        Go online to receive nearby ride, errand, delivery, and moving requests.
                      } @else if (!isAvailable()) {
                        You're online, but temporarily marked as busy.
                      } @else if (!canDriverAcceptTrips()) {
                        Complete Stripe Connect before going online.
                      } @else {
                        You're live and ready for new requests.
                      }
                    </p>
                  </div>

                  <div class="rounded-[1.25rem] border border-slate-200 bg-white/75 p-3 shadow-sm shrink-0">
                    <div class="grid grid-cols-2 gap-3">
                      <div class="flex flex-col items-center">
                        <span class="text-[9px] uppercase text-slate-600 font-black mb-2 tracking-[0.08em]">Online</span>
                        <ion-toggle
                          [checked]="status() === 'online'"
                          (ionChange)="toggleStatus($event)"
                          color="success"
                          [disabled]="!canDriverAcceptTrips()"
                        ></ion-toggle>
                      </div>

                      <div class="flex flex-col items-center">
                        <span class="text-[9px] uppercase text-slate-600 font-black mb-2 tracking-[0.08em]">Free</span>
                        <ion-toggle
                          [checked]="isAvailable()"
                          (ionChange)="toggleAvailability($event)"
                          color="primary"
                          [disabled]="!canDriverAcceptTrips()"
                        ></ion-toggle>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="flex flex-wrap gap-2">
                  @if (isProDriver()) {
                    <app-performance-badge type="pro-driver"></app-performance-badge>
                  }

                  @if (!ratingMetric().isNew && (ratingMetric().value || 0) >= 4.8) {
                    <app-performance-badge type="top-rated"></app-performance-badge>
                  }

                  @if (hasAcceptanceRate() && (acceptanceMetric().value || 0) >= 95) {
                    <app-performance-badge type="reliable"></app-performance-badge>
                  }

                  @if (!isProDriver()) {
                    <app-badge variant="secondary">Starter Driver</app-badge>
                  }
                </div>
              </div>
            </div>
          </div>

          <app-movabi-carousel [slides]="driverCarouselSlides()"></app-movabi-carousel>

          <div class="space-y-3" data-section="available-requests">
            <div class="movabi-section-header">
              <div class="flex items-center gap-2 min-w-0 flex-1">
                <h3 class="movabi-section-title flex flex-wrap items-center gap-2 min-w-0 whitespace-normal">
                  <span>Available Requests</span>
                  <span class="movabi-badge-sm bg-amber-500 text-slate-950 border-amber-500 shrink-0">
                    {{ jobs().length }}
                  </span>
                </h3>
              </div>

              <button
                type="button"
                (click)="refreshAvailableJobs()"
                class="px-3 py-2 rounded-xl bg-white border border-slate-200 text-slate-600 text-[10px] font-black uppercase tracking-[0.12em] shadow-sm active:scale-95 transition-all shrink-0"
              >
                Refresh
              </button>
            </div>

            @if (status() === 'offline') {
              <div class="bg-white rounded-[2rem] border border-slate-100 shadow-sm overflow-hidden py-10">
                <app-empty-state
                  icon="moon-outline"
                  title="You are offline"
                  description="Go online to see nearby ride, errand, delivery, and moving requests."
                  actionLabel="Go Online"
                  (action)="goOnline()"
                ></app-empty-state>
              </div>
            } @else if (!isAvailable()) {
              <div class="bg-white rounded-[2rem] border border-slate-100 shadow-sm overflow-hidden py-10">
                <app-empty-state
                  icon="time-outline"
                  title="You are marked busy"
                  description="Turn Free on to receive new available requests."
                  actionLabel="Set Free"
                  (action)="setAvailableNow()"
                ></app-empty-state>
              </div>
            } @else if (jobs().length === 0) {
              <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 flex items-center justify-center shrink-0">
                  <ion-icon name="search-outline" class="text-xl"></ion-icon>
                </div>
                <div class="min-w-0">
                  <p class="text-sm font-black text-slate-900">No requests right now</p>
                  <p class="text-xs font-semibold text-slate-500 leading-snug whitespace-normal">New nearby requests will expand this section automatically.</p>
                </div>
              </div>
            } @else {
              <div class="space-y-5">
                @for (job of jobs(); track job.id) {
                  <app-card [hoverable]="true" class="group overflow-hidden border-slate-100">
                    <div class="flex justify-between items-start gap-4 mb-3">
                      <div class="space-y-2 min-w-0">
                        <app-badge variant="primary">{{ getServiceName(job) }}</app-badge>
                        <div class="flex items-center gap-2 text-slate-500 text-[10px] font-bold uppercase tracking-widest">
                          <ion-icon name="flash-outline"></ion-icon>
                          New nearby request
                        </div>
                      </div>

                      <div class="text-right shrink-0">
                        <span class="text-xl font-display font-bold text-slate-950">
                          {{ formatPrice(getRequestFare(job)) }}
                        </span>
                        <p class="text-[10px] font-black text-blue-600 uppercase tracking-widest mt-1">
                          Request Fare
                        </p>
                      </div>
                    </div>

                    <div class="space-y-4 mb-3">
                      <div class="rounded-2xl bg-amber-50 border border-amber-100 p-4">
                        <div class="flex items-start gap-3">
                          <div class="w-10 h-10 rounded-xl bg-white border border-amber-100 text-amber-600 flex items-center justify-center shrink-0">
                            <ion-icon [name]="requestServiceIcon(job)" class="text-xl"></ion-icon>
                          </div>
                          <div class="min-w-0">
                            <p class="text-sm font-black text-slate-950">{{ requestServiceHeadline(job) }}</p>
                            <p class="text-xs font-semibold text-slate-600 leading-relaxed mt-1">{{ requestServiceHelper(job) }}</p>
                          </div>
                        </div>
                      </div>

                      <div class="rounded-2xl bg-slate-50 border border-slate-100 p-4 space-y-4">
                        <div>
                          <p class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">{{ requestOriginLabel(job) }}</p>
                          <p class="text-sm font-bold text-slate-900 leading-snug">
                            {{ job.pickup_address || requestOriginUnavailableLabel(job) }}
                          </p>
                        </div>

                        <div class="h-px bg-slate-200/70"></div>

                        <div>
                          <p class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">{{ requestDestinationLabel(job) }}</p>
                          <p class="text-sm font-bold text-slate-900 leading-snug">
                            {{ job.dropoff_address || requestDestinationUnavailableLabel(job) }}
                          </p>
                        </div>
                      </div>

                      <div class="grid grid-cols-3 gap-2">
                        <div class="rounded-2xl bg-blue-50 border border-blue-100 p-3">
                          <p class="text-[8px] font-black text-blue-500 uppercase tracking-widest">Service</p>
                          <p class="text-xs font-bold text-slate-900 mt-1 whitespace-normal leading-snug">
                            {{ getServiceName(job) }}
                          </p>
                        </div>

                        <div class="rounded-2xl bg-emerald-50 border border-emerald-100 p-3">
                          <p class="text-[8px] font-black text-emerald-600 uppercase tracking-widest">Distance</p>
                          <p class="text-xs font-bold text-slate-900 mt-1">
                            {{ formatJobDistance(job) }}
                          </p>
                        </div>

                        <div class="rounded-2xl bg-amber-50 border border-amber-100 p-3">
                          <p class="text-[8px] font-black text-amber-600 uppercase tracking-widest">Time</p>
                          <p class="text-xs font-bold text-slate-900 mt-1">
                            {{ formatJobDuration(job) }}
                          </p>
                        </div>
                      </div>

                      <div class="grid grid-cols-2 gap-2">
                        <div class="rounded-2xl bg-white border border-slate-100 p-3">
                          <p class="text-[8px] font-black text-slate-400 uppercase tracking-widest">{{ requestThirdMetricLabel(job) }}</p>
                          <p class="text-xs font-bold text-slate-900 mt-1">
                            {{ requestThirdMetricValue(job) }}
                          </p>
                        </div>

                        <div class="rounded-2xl bg-white border border-slate-100 p-3">
                          <p class="text-[8px] font-black text-slate-400 uppercase tracking-widest">Payment</p>
                          <p class="text-xs font-bold text-slate-900 mt-1">
                            {{ getPaymentLabel(job) }}
                          </p>
                        </div>
                      </div>

                      @if (getJobNotes(job)) {
                        <div class="rounded-2xl bg-indigo-50 border border-indigo-100 p-4">
                          <p class="text-[9px] font-black text-indigo-500 uppercase tracking-widest mb-1">Notes</p>
                          <p class="text-sm font-semibold text-slate-800 leading-snug">
                            {{ getJobNotes(job) }}
                          </p>
                        </div>
                      }
                    </div>

                    <div class="grid grid-cols-2 gap-3">
                      <app-button variant="outline" class="w-full" [disabled]="submitting()" (clicked)="reject(job.id)">
                        Pass
                      </app-button>

                      <app-button variant="primary" class="w-full" [disabled]="submitting()" (clicked)="accept(job.id)">
                        {{ submitting() ? 'Accepting...' : 'Accept' }}
                      </app-button>
                    </div>
                  </app-card>
                }
              </div>
            }
          </div>

          <div class="space-y-4">
            <button
              type="button"
              class="w-full flex items-center justify-between px-1 gap-3 text-left"
              [attr.aria-expanded]="isPayoutPanelOpen()"
              (click)="togglePayoutPanel()"
            >
              <div class="flex items-center gap-3 min-w-0">
                <div
                  class="w-1.5 h-6 rounded-full shadow-lg shrink-0"
                  [class.bg-emerald-500]="isStripeReady()"
                  [class.bg-rose-500]="getStripeBadgeText() === 'Action Required'"
                  [class.bg-amber-500]="!isStripeReady() && getStripeBadgeText() !== 'Action Required'"
                ></div>

                <div class="min-w-0">
                  <h3 class="text-xs font-black text-slate-500 uppercase tracking-[0.12em] leading-snug">
                    Payouts
                  </h3>
                  <p class="text-[11px] text-slate-400 font-semibold mt-0.5 whitespace-normal leading-snug">
                    {{ isPayoutPanelOpen() ? 'Stripe Connect' : getStripeCompactSummary() }}
                  </p>
                </div>
              </div>

              <div class="flex items-center gap-2 shrink-0">
                <app-badge [variant]="getStripeBadgeVariant()">
                  {{ getStripeBadgeText() }}
                </app-badge>

                <ion-icon
                  name="chevron-down-outline"
                  class="text-xl text-slate-400 transition-transform duration-200"
                  [class.rotate-180]="isPayoutPanelOpen()"
                ></ion-icon>
              </div>
            </button>

            @if (isPayoutPanelOpen()) {
            <div class="relative overflow-hidden rounded-[1.85rem] border p-5 shadow-lg bg-white">
              <div class="relative flex items-start gap-4">
                <div class="w-14 h-14 rounded-[1.25rem] flex items-center justify-center border shadow-sm shrink-0 bg-emerald-50 text-emerald-700 border-emerald-100">
                  <ion-icon
                    [name]="isStripeReady() ? 'checkmark-circle-outline' : 'cash-outline'"
                    class="text-3xl"
                  ></ion-icon>
                </div>

                <div class="flex-1 min-w-0">
                  <h3 class="font-display font-black text-slate-950 text-xl tracking-tight">
                    Stripe Connect
                  </h3>

                  <p class="text-sm text-slate-500 font-semibold leading-relaxed mt-1">
                    Required for receiving payouts. You can still accept test/live requests while setup is pending.
                  </p>

                  <div class="mt-5">
                    @if (isStripeReady()) {
                      <app-button variant="secondary" class="w-full" (clicked)="openStripeDashboard()">
                        Open Stripe Dashboard
                      </app-button>
                    } @else {
                      <app-button variant="primary" class="w-full" (clicked)="setupPayouts()">
                        {{ isStripePending() ? 'Continue Stripe Setup' : 'Start Stripe Setup' }}
                      </app-button>
                    }
                  </div>
                </div>
              </div>
            </div>
            }
          </div>

          <div class="space-y-4">
            <div class="flex items-center gap-2 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h3 class="text-xs font-bold text-slate-500 uppercase tracking-[0.12em] leading-snug">Performance Metrics</h3>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div class="bg-white p-5 rounded-[1.75rem] border border-slate-100 shadow-sm">
                <div class="flex items-center justify-between gap-3 mb-4">
                  <div class="flex items-center gap-3 min-w-0">
                    <div class="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 shadow-sm shrink-0">
                      <ion-icon name="checkmark-done-outline"></ion-icon>
                    </div>
                    <span class="text-[10px] font-bold text-slate-500 uppercase tracking-[0.12em] whitespace-normal leading-snug">Acceptance</span>
                  </div>

                  <app-badge [variant]="acceptanceBadgeVariant()">
                    {{ acceptanceBadgeLabel() }}
                  </app-badge>
                </div>

                <p class="text-xl font-display font-bold text-slate-950">{{ acceptanceMetric().display }}</p>
                <p class="text-sm text-slate-500 font-medium mt-1">{{ acceptanceMetric().label }}</p>
              </div>

              <div class="bg-white p-5 rounded-[1.75rem] border border-slate-100 shadow-sm">
                <div class="flex items-center justify-between gap-3 mb-4">
                  <div class="flex items-center gap-3 min-w-0">
                    <div class="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-600 shadow-sm shrink-0">
                      <ion-icon name="star-outline"></ion-icon>
                    </div>
                    <span class="text-[10px] font-bold text-slate-500 uppercase tracking-[0.12em] whitespace-normal leading-snug">Rating</span>
                  </div>

                  <app-badge [variant]="ratingMetric().isNew ? 'secondary' : 'success'">
                    {{ ratingMetric().isNew ? 'New' : 'Live' }}
                  </app-badge>
                </div>

                @if (ratingMetric().isNew) {
                  <p class="text-xl font-display font-bold text-slate-950">New</p>
                  <p class="text-sm text-slate-500 font-medium mt-1">
                    Rating will appear after your first customer review.
                  </p>
                } @else {
                  <p class="text-xl font-display font-bold text-slate-950">{{ ratingMetric().display }}</p>
                  <app-rating [rating]="ratingMetric().value || 0"></app-rating>
                }
              </div>
            </div>
          </div>

          <div class="space-y-4">
            <div class="flex items-center gap-2 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h3 class="text-xs font-bold text-slate-500 uppercase tracking-[0.12em] leading-snug">Quick Actions</h3>
            </div>

            <div class="grid grid-cols-1 min-[430px]:grid-cols-2 gap-3">
              <button type="button" (click)="router.navigate(['/driver/earnings'])" class="relative min-h-[9.5rem] overflow-hidden flex flex-col items-center justify-center p-5 bg-white rounded-[1.5rem] border border-slate-100 shadow-sm active:scale-[0.98] transition-all text-center">
                <div class="w-14 h-14 bg-blue-50 rounded-[1.75rem] flex items-center justify-center text-blue-600 mb-3 border border-blue-100 shadow-lg shadow-blue-600/10">
                  <ion-icon name="stats-chart" class="text-2xl"></ion-icon>
                </div>
                <h4 class="font-display font-black text-slate-950 text-lg leading-tight mb-2">Earnings</h4>
                <p class="text-xs text-slate-500 font-bold uppercase tracking-[0.14em] leading-snug">View income</p>
              </button>

              <button type="button" (click)="router.navigate(['/driver/subscription'])" class="relative min-h-[9.5rem] overflow-hidden flex flex-col items-center justify-center p-5 bg-white rounded-[1.5rem] border border-slate-100 shadow-sm active:scale-[0.98] transition-all text-center">
                <div class="w-14 h-14 bg-amber-50 rounded-[1.75rem] flex items-center justify-center text-amber-600 mb-3 border border-amber-100 shadow-lg shadow-amber-500/10">
                  <ion-icon name="star" class="text-2xl"></ion-icon>
                </div>
                <h4 class="font-display font-black text-slate-950 text-lg leading-tight mb-2">Subscription</h4>
                <p class="text-xs text-slate-500 font-bold uppercase tracking-[0.14em] leading-snug">
                  {{ isProDriver() ? 'Pro plan active' : 'Starter plan' }}
                </p>
              </button>

              <button type="button" (click)="browseRequests()" class="relative min-h-[9.5rem] overflow-hidden flex flex-col items-center justify-center p-5 bg-white rounded-[1.5rem] border border-slate-100 shadow-sm active:scale-[0.98] transition-all text-center">
                <div class="w-14 h-14 bg-indigo-50 rounded-[1.75rem] flex items-center justify-center text-indigo-600 mb-3 border border-indigo-100 shadow-lg shadow-indigo-600/10">
                  <ion-icon name="list-outline" class="text-2xl"></ion-icon>
                </div>
                <h4 class="font-display font-black text-slate-950 text-lg leading-tight mb-2">Requests</h4>
                <p class="text-xs text-slate-500 font-bold uppercase tracking-[0.14em] leading-snug">Ride, errand & moving</p>
              </button>

              <button type="button" (click)="setupPayouts()" class="relative min-h-[9.5rem] overflow-hidden flex flex-col items-center justify-center p-5 bg-white rounded-[1.5rem] border border-slate-100 shadow-sm active:scale-[0.98] transition-all text-center">
                <div class="w-14 h-14 bg-emerald-50 rounded-[1.75rem] flex items-center justify-center text-emerald-600 mb-3 border border-emerald-100 shadow-lg shadow-emerald-600/10">
                  <ion-icon name="card" class="text-2xl"></ion-icon>
                </div>
                <h4 class="font-display font-black text-slate-950 text-lg leading-tight mb-2">Payouts</h4>
                <p class="text-xs text-slate-500 font-bold uppercase tracking-[0.14em] leading-snug">Stripe Connect</p>
              </button>
            </div>
          </div>
        }
      </div>
    </ion-content>
  `
})
export class DriverDashboardPage implements OnInit, OnDestroy {
    public router = inject(Router);
    private route = inject(ActivatedRoute);
    public auth = inject(AuthService);
    private driverService = inject(DriverService);
    private locationService = inject(LocationService);
    public profileService = inject(ProfileService);
    private connectService = inject(ConnectService);
    private supabase = inject(SupabaseService);
    private vehicleCompatibility = inject(VehicleCompatibilityService);
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);
    private config = inject(AppConfigService);
    private oneSignal = inject(OneSignalService);
    private tour = inject(OnboardingTourService);

    status = this.driverService.onlineStatus;
    isAvailable = this.driverService.isAvailable;
    activeJob = this.driverService.activeJob;
    private readonly passedJobsStorageKey = 'movabi_driver_passed_jobs';
    passedJobIds = signal<Set<string>>(new Set());
    jobs = computed(() => {
        const passed = this.passedJobIds();
        return this.driverService.availableJobs().filter(job => !passed.has(job.id));
    });
    locationError = this.locationService.locationError;

    submitting = signal(false);
    toastVisible = signal(false);
    toastMessage = signal('');
    toastColor = signal<ToastColor>('success');
    dashboardStats = signal<DriverDashboardStats>({
        todayJobs: 0,
        acceptedJobs: 0,
        completedJobs: 0
    });

    stripeUiState = signal<StripeUiState>({
        accountId: null,
        status: 'not_started',
        chargesEnabled: false,
        payoutsEnabled: false
    });
    payoutPanelOpen = signal(false);

    private jobsChannel?: RealtimeChannel;
    private jobsRefreshInterval?: ReturnType<typeof setInterval>;
    private knownAvailableJobIds = new Set<string>();
    resubmittingReview = signal(false);

    verificationStatus = computed<'draft' | 'under_review' | 'action_required' | 'approved'>(() => {
        const profile = this.profileService.profile() as DriverProfile | null;

        if (!profile) return 'draft';
        if (profile.is_verified === true || profile.verification_status === 'approved') return 'approved';
        if (profile.driver_review_status === 'action_required') return 'action_required';
        if (profile.verification_status === 'action_required') return 'action_required';
        if (profile.driver_review_status === 'under_review') return 'under_review';
        if (profile.verification_status === 'under_review') return 'under_review';
        if (profile.onboarding_completed) return 'under_review';

        return 'draft';
    });

    verificationNotes = computed(() => {
        const profile = this.profileService.profile() as DriverProfile | null;
        return profile?.driver_review_notes ?? profile?.verification_notes ?? null;
    });

    reviewBlockers = computed(() => {
        const profile = this.profileService.profile() as DriverProfile | null;
        return this.parseStringList(profile?.driver_review_blockers ?? profile?.verification_blockers);
    });

    isVerified = computed(() => this.verificationStatus() === 'approved');
    isUnderReview = computed(() => this.verificationStatus() === 'under_review');
    isActionRequired = computed(() => this.verificationStatus() === 'action_required');
    hasDriverReviewActionRequired = computed(() => {
        const profile = this.profileService.profile() as DriverProfile | null;
        return profile?.driver_review_status === 'action_required';
    });

    todayMetric = computed<MetricState>(() => {
        const count = this.dashboardStats().todayJobs;

        return {
            value: count,
            label: count === 1 ? 'Job today' : 'Jobs today',
            display: String(count),
            isNew: count === 0
        };
    });

    acceptanceMetric = computed<MetricState>(() => {
        const profile = this.profileService.profile() as any;
        const value = this.toNullableNumber(profile?.acceptance_rate ?? null);

        if (value === null || value <= 0) {
            const acceptedJobs = this.dashboardStats().acceptedJobs;

            return {
                value: acceptedJobs,
                label: acceptedJobs === 1 ? 'Accepted request' : 'Accepted requests',
                display: String(acceptedJobs),
                isNew: acceptedJobs === 0
            };
        }

        const percentage = Math.max(0, Math.min(100, Math.round(value)));

        return {
            value: percentage,
            label: 'Live performance',
            display: `${percentage}%`,
            isNew: false
        };
    });

    ratingMetric = computed<MetricState>(() => {
        const profile = this.profileService.profile() as any;
        const value = this.toNullableNumber(profile?.rating ?? profile?.driver_rating ?? null);

        if (value === null || value <= 0) {
            return {
                value: 0,
                label: 'No reviews yet',
                display: '0.0',
                isNew: true
            };
        }

        const rating = Math.max(0, Math.min(5, value));

        return {
            value: rating,
            label: 'Driver score',
            display: rating.toFixed(1),
            isNew: false
        };
    });

    driverCarouselSlides = computed<MovabiCarouselSlide[]>(() => {
        const slides: MovabiCarouselSlide[] = [
            {
                eyebrow: 'Today',
                title: `${this.todayMetric().display} ${this.todayMetric().label}`,
                subtitle: this.status() === 'online' ? 'Stay available for nearby requests.' : 'Go online when you are ready.',
                value: `${this.dashboardStats().completedJobs || 0} done`,
                icon: 'location-outline',
                cta: this.status() === 'online' ? 'Live now' : 'Go online',
                tone: 'slate'
            },
            {
                eyebrow: 'Performance',
                title: `Rating ${this.ratingMetric().display}`,
                subtitle: this.ratingMetric().isNew ? 'Your first customer review will appear here.' : 'Keep responses quick and service friendly.',
                icon: 'star-outline',
                cta: 'Build trust',
                tone: 'amber',
                accentColor: '#c2410c'
            },
            {
                eyebrow: 'Requests',
                title: `${this.jobs().length} available now`,
                subtitle: this.jobs().length > 0 ? 'Review the best nearby request and accept when ready.' : "We'll show nearby jobs here automatically.",
                icon: 'location-outline',
                cta: 'Nearby work',
                tone: 'emerald',
                accentColor: '#047857'
            },
            {
                eyebrow: 'Payouts',
                title: this.isStripeReady() ? 'Payouts ready' : 'Payout setup pending',
                subtitle: this.isStripeReady() ? 'Completed jobs can be processed safely.' : 'Complete Stripe Connect to avoid payout delays.',
                icon: 'wallet-outline',
                cta: this.isStripeReady() ? 'Earnings safe' : 'Finish setup',
                tone: this.isStripeReady() ? 'blue' : 'rose'
            }
        ];

        if (!this.isVerified()) {
            slides.push({
                eyebrow: 'Compliance',
                title: 'Documents under review',
                subtitle: 'Some request types unlock after approval.',
                icon: 'document-text-outline',
                cta: 'Review status',
                tone: 'rose'
            });
        }

        return slides;
    });

    isStripeReady = computed(() => {
        const state = this.stripeUiState();
        if (!state.accountId) return false;
        return state.chargesEnabled === true && state.payoutsEnabled === true;
    });

    canDriverAcceptTrips = computed(() => {
        return this.isStripeReady();
    });

    isPayoutPanelOpen = computed(() => this.payoutPanelOpen() || !this.isStripeReady());

    isStripePending = computed(() => {
        if (this.isStripeReady()) return false;
        return !!this.stripeUiState().accountId;
    });

    constructor() {
        addIcons({
            shieldCheckmark,
            walletOutline,
            logOutOutline,
            locationOutline,
            checkmarkDoneOutline,
            starOutline,
            moonOutline,
            searchOutline,
            star,
            statsChart,
            card,
            timeOutline,
            alertCircleOutline,
            flashOutline,
            radioOutline,
            cashOutline,
            checkmarkCircleOutline,
            personAddOutline,
            listOutline,
            navigate,
            chevronDownOutline,
            settingsOutline
        });
    }

    async ngOnInit() {
        if (!this.supabase.isConfigured) return;

        this.loadPassedJobs();
        await this.refreshStripeUiStateFromDb();
        await this.ensureMovabiPayVirtualCard();
        await this.loadAvailability();
        await this.handleStripeReturn();

        await this.loadDashboardStats();
        await this.refreshActiveJob();
        await this.driverService.fetchAvailableJobs();
        this.knownAvailableJobIds = new Set(this.jobs().map(job => job.id));

        this.subscribeToAvailableJobsRealtime();
        this.startJobsAutoRefresh();

        if (this.isVerified()) {
            this.checkTracking();
            await this.loadAvailability();
        }

        this.tour.startIfNeeded('driver');
    }

    ngOnDestroy() {
        this.locationService.stopTracking();

        if (this.jobsRefreshInterval) {
            clearInterval(this.jobsRefreshInterval);
            this.jobsRefreshInterval = undefined;
        }

        if (this.jobsChannel) {
            this.supabase.client.removeChannel(this.jobsChannel);
            this.jobsChannel = undefined;
        }
    }

    formatPrice(amount: number | null | undefined) {
        return this.config.formatCurrency(Number(amount || 0));
    }

    async refreshActiveJob(): Promise<void> {
        try {
            await this.driverService.fetchActiveJob();
        } catch (error) {
            console.warn('[driver-dashboard] Failed to refresh active job', error);
        }
    }

    private async ensureMovabiPayVirtualCard(): Promise<void> {
        try {
            await this.driverService.ensureMovabiPayVirtualCard();
        } catch (error) {
            console.warn('[driver-dashboard] Movabi Pay virtual card setup deferred', error);
        }
    }

    async loadDashboardStats(): Promise<void> {
        const user = this.auth.currentUser();

        if (!user?.id) {
            this.dashboardStats.set({ todayJobs: 0, acceptedJobs: 0, completedJobs: 0 });
            return;
        }

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const activeAndDoneStatuses = [
            'assigned',
            'accepted',
            'heading_to_pickup',
            'arrived',
            'arrived_at_store',
            'shopping_in_progress',
            'collected',
            'en_route_to_customer',
            'in_progress',
            'delivered',
            'completed',
            'settled',
            'over_budget_requested'
        ];

        try {
            const [todayResult, acceptedResult, completedResult] = await Promise.all([
                this.supabase.client
                    .from('jobs')
                    .select('id')
                    .eq('driver_id', user.id)
                    .in('status', activeAndDoneStatuses)
                    .gte('updated_at', startOfToday.toISOString())
                    .limit(1000),
                this.supabase.client
                    .from('jobs')
                    .select('id')
                    .eq('driver_id', user.id)
                    .in('status', activeAndDoneStatuses)
                    .limit(1000),
                this.supabase.client
                    .from('jobs')
                    .select('id')
                    .eq('driver_id', user.id)
                    .in('status', ['completed', 'settled'])
                    .limit(1000)
            ]);

            if (todayResult.error || acceptedResult.error || completedResult.error) {
                throw todayResult.error || acceptedResult.error || completedResult.error;
            }

            this.dashboardStats.set({
                todayJobs: todayResult.data?.length ?? 0,
                acceptedJobs: acceptedResult.data?.length ?? 0,
                completedJobs: completedResult.data?.length ?? 0
            });
        } catch (error) {
            console.warn('[driver-dashboard] Failed to load dashboard stats', error);

            const profile = this.profileService.profile() as DriverProfile | null;
            this.dashboardStats.set({
                todayJobs: this.activeJob() ? 1 : 0,
                acceptedJobs: Number(profile?.completed_jobs || profile?.total_trips || 0),
                completedJobs: Number(profile?.completed_jobs || profile?.total_trips || 0)
            });
        }
    }

    async resumeActiveJob(): Promise<void> {
        const active = this.activeJob();

        if (!active?.id) {
            await this.refreshActiveJob();
        }

        const jobId = this.activeJob()?.id;

        if (!jobId) {
            this.showToast('No active request to resume.', 'warning');
            return;
        }

        await this.router.navigate(['/driver/job-details', jobId]);
    }

    activeJobTitle(): string {
        const job = this.activeJob();
        if (!job) return 'Active request';

        return this.getServiceName(job);
    }

    activeJobStatusLabel(): string {
        const status = this.activeJob()?.status;
        if (!status) return 'Active';

        return String(status)
            .replace(/_/g, ' ')
            .replace(/\b\w/g, char => char.toUpperCase());
    }

    activeJobRouteLabel(): string {
        const job = this.activeJob();
        if (!job) return 'Tap to continue the request.';

        const origin = this.shortenAddress(job.pickup_address || this.requestOriginUnavailableLabel(job));
        const destination = this.shortenAddress(job.dropoff_address || this.requestDestinationUnavailableLabel(job));

        return `${origin} → ${destination}`;
    }

    activeJobShortRouteLabel(): string {
        const job = this.activeJob();
        if (!job) return 'Tap to continue the request.';

        const origin = this.compactAddress(job.pickup_address || this.requestOriginUnavailableLabel(job));
        const destination = this.compactAddress(job.dropoff_address || this.requestDestinationUnavailableLabel(job));

        return `${this.requestOriginLabel(job)}: ${origin} → ${this.requestDestinationLabel(job)}: ${destination}`;
    }

    private compactAddress(address: string | null | undefined): string {
        const value = String(address || '').trim();

        if (!value) return 'Location unavailable';

        const parts = value
            .split(',')
            .map(part => part.trim())
            .filter(Boolean);

        if (parts.length >= 2) {
            return `${parts[0]}, ${parts[1]}`;
        }

        return value.length > 46 ? `${value.slice(0, 43)}...` : value;
    }

    private shortenAddress(address: string): string {
        const value = String(address || '').trim();
        if (!value) return 'Location unavailable';

        const parts = value
            .split(',')
            .map(part => part.trim())
            .filter(Boolean);

        return parts.length >= 2 ? `${parts[0]}, ${parts[1]}` : value;
    }

    getRequestFare(job: Booking): number {
        const raw = job as any;

        const total = Number(raw.total_price);
        if (Number.isFinite(total) && total > 0) return total;

        const price = Number(raw.price);
        if (Number.isFinite(price) && price > 0) return price;

        const estimated = Number(raw.estimated_price);
        if (Number.isFinite(estimated) && estimated > 0) return estimated;

        const frontendTotal = Number(raw.metadata?.frontend_total_price);
        if (Number.isFinite(frontendTotal) && frontendTotal > 0) return frontendTotal;

        return 0;
    }

    getDriverPayout(job: Booking): number {
        const raw = job as any;
        const payout = Number(raw.driver_payout);

        if (Number.isFinite(payout) && payout > 0) {
            return payout;
        }

        return this.getRequestFare(job);
    }

    formatJobTime(value: unknown): string {
        if (!value) return 'ASAP';

        const date = new Date(String(value));

        if (Number.isNaN(date.getTime())) {
            return 'ASAP';
        }

        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    formatSearchTimeLeft(job: Booking): string {
        const raw = job as any;

        if (!raw.driver_search_expires_at) {
            return 'Open now';
        }

        const expiresAt = new Date(raw.driver_search_expires_at).getTime();

        if (!Number.isFinite(expiresAt)) {
            return 'Open now';
        }

        const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));

        if (seconds === 0) {
            return 'Expiring';
        }

        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;

        return `${mins}m ${secs.toString().padStart(2, '0')}s`;
    }

    getServiceName(job: Booking): string {
        const raw = String(
            (job as any)?.service_type?.name ||
            (job as any)?.service_type_name ||
            (job as any)?.service_slug ||
            (job as any)?.service_type ||
            (job as any)?.type ||
            'Request'
        );

        return raw
            .trim()
            .replace(/_/g, ' ')
            .replace(/-/g, ' ')
            .replace(/\b\w/g, char => char.toUpperCase());
    }

    requestServiceIcon(job: Booking): string {
        switch ((job as any)?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'storefront-outline';
            case ServiceTypeEnum.DELIVERY:
                return 'cube-outline';
            case ServiceTypeEnum.VAN:
                return 'home-outline';
            default:
                return 'car-sport-outline';
        }
    }

    requestServiceHeadline(job: Booking): string {
        const customer = this.requestCustomerFirstName(job);

        switch ((job as any)?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return `Shop and deliver for ${customer}`;
            case ServiceTypeEnum.DELIVERY:
                return `Collect and deliver a package`;
            case ServiceTypeEnum.VAN:
                return `Help with a move`;
            default:
                return `Pickup ride for ${customer}`;
        }
    }

    requestServiceHelper(job: Booking): string {
        const vehicle = this.vehicleCompatibility.getRequiredLabel(job);

        switch ((job as any)?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return `Includes item budget handling, receipt upload, and delivery. Vehicle needed: ${vehicle}.`;
            case ServiceTypeEnum.DELIVERY:
                return `Confirm collection before travelling to the recipient. Vehicle needed: ${vehicle}.`;
            case ServiceTypeEnum.VAN:
                return `Accept only if your vehicle can handle the load and you can complete the move. Vehicle needed: ${vehicle}.`;
            default:
                return `Accept when you can reach pickup and complete the trip. Vehicle needed: ${vehicle}.`;
        }
    }

    requestThirdMetricLabel(job: Booking): string {
        switch ((job as any)?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Item Budget';
            case ServiceTypeEnum.VAN:
                return 'Vehicle';
            default:
                return 'Search Window';
        }
    }

    requestThirdMetricValue(job: Booking): string {
        if ((job as any)?.service_slug === ServiceTypeEnum.ERRAND) {
            const budget = this.firstPositiveNumber(
                (job as any)?.metadata?.errand_details?.budget,
                (job as any)?.metadata?.errand_details?.estimated_budget,
                (job as any)?.metadata?.payment_split?.item_budget,
                (job as any)?.item_budget
            );

            return budget !== null ? this.formatPrice(budget) : 'Protected';
        }

        if ((job as any)?.service_slug === ServiceTypeEnum.VAN) {
            return this.vehicleCompatibility.getRequiredLabel(job);
        }

        return this.formatSearchTimeLeft(job);
    }

    private requestCustomerFirstName(job: Booking): string {
        const customer = (job as any)?.customer || {};
        const first = String(customer.first_name || customer.full_name || '').trim().split(/\s+/)[0];

        return first || 'customer';
    }

    requestOriginLabel(job: Booking): string {
        switch ((job as any)?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Store';
            case ServiceTypeEnum.DELIVERY:
                return 'Collect from';
            case ServiceTypeEnum.VAN:
                return 'Moving from';
            default:
                return 'Pickup';
        }
    }

    requestDestinationLabel(job: Booking): string {
        switch ((job as any)?.service_slug) {
            case ServiceTypeEnum.ERRAND:
                return 'Deliver to';
            case ServiceTypeEnum.DELIVERY:
                return 'Recipient';
            case ServiceTypeEnum.VAN:
                return 'Moving to';
            default:
                return 'Dropoff';
        }
    }

    requestOriginUnavailableLabel(job: Booking): string {
        return `${this.requestOriginLabel(job)} unavailable`;
    }

    requestDestinationUnavailableLabel(job: Booking): string {
        return `${this.requestDestinationLabel(job)} unavailable`;
    }

    hasAcceptanceRate(): boolean {
        const profile = this.profileService.profile() as any;
        const value = this.toNullableNumber(profile?.acceptance_rate ?? null);
        return value !== null && value > 0;
    }

    acceptanceBadgeLabel(): string {
        const metric = this.acceptanceMetric();

        if (this.hasAcceptanceRate()) {
            return this.getMetricLabel(metric.value || 0);
        }

        return metric.isNew ? 'New' : 'Accepted';
    }

    acceptanceBadgeVariant(): 'success' | 'warning' | 'error' | 'info' | 'secondary' {
        const metric = this.acceptanceMetric();

        if (this.hasAcceptanceRate()) {
            return this.getMetricVariant(metric.value || 0);
        }

        return metric.isNew ? 'secondary' : 'info';
    }

    formatJobDistance(job: Booking): string {
        const raw = job as any;
        const metadata = raw.metadata || {};
        const km = this.firstPositiveNumber(
            raw.estimated_distance_km,
            raw.distance_km,
            raw.estimated_distance,
            metadata.distance_km,
            metadata.estimated_distance_km
        );

        if (km !== null) {
            return this.formatDistance(km);
        }

        const meters = this.firstPositiveNumber(raw.distance_meters, metadata.distance_meters);
        if (meters !== null) {
            return this.formatDistance(meters / 1000);
        }

        return 'Not set';
    }

    formatJobDuration(job: Booking): string {
        const raw = job as any;
        const metadata = raw.metadata || {};
        const seconds = this.firstPositiveNumber(
            raw.duration_seconds,
            raw.estimated_duration_seconds,
            metadata.duration_seconds
        );

        if (seconds !== null) {
            const mins = Math.max(1, Math.round(seconds / 60));
            return `${mins} min`;
        }

        const minutes = this.firstPositiveNumber(
            raw.duration_minutes,
            raw.estimated_duration_minutes,
            metadata.duration_minutes
        );

        if (minutes !== null) {
            return `${Math.max(1, Math.round(minutes))} min`;
        }

        return 'ASAP';
    }

    getPaymentLabel(job: Booking): string {
        const status = String((job as any).payment_status || '').replace(/_/g, ' ');

        if (!status) {
            return 'Pending';
        }

        return status.replace(/\b\w/g, char => char.toUpperCase());
    }

    formatDistance(distance: unknown): string {
        const value = Number(distance || 0);

        if (!Number.isFinite(value) || value <= 0) {
            return 'Not set';
        }

        return `${value.toFixed(1)} km`;
    }

    private firstPositiveNumber(...values: unknown[]): number | null {
        for (const value of values) {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed > 0) {
                return parsed;
            }
        }

        return null;
    }


    getJobNotes(job: Booking): string | null {
        const raw = job as any;
        const metadata = raw.metadata || {};

        return (
            raw.notes ||
            raw.instructions ||
            raw.customer_notes ||
            metadata.notes ||
            metadata.instructions ||
            null
        );
    }

    isProDriver(): boolean {
        const profile = this.profileService.profile() as any;
        return profile?.pricing_plan === 'pro' && profile?.subscription_status === 'active';
    }

    private toNullableNumber(value: unknown): number | null {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    private parseStringList(raw: unknown): string[] {
        if (Array.isArray(raw)) {
            return raw.map((item) => String(item || '').trim()).filter(Boolean);
        }

        if (typeof raw === 'string') {
            try {
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed)
                    ? parsed.map((item) => String(item || '').trim()).filter(Boolean)
                    : raw.trim()
                        ? [raw.trim()]
                        : [];
            } catch {
                return raw.trim() ? [raw.trim()] : [];
            }
        }

        return [];
    }

    async refreshAvailableJobs() {
        await this.driverService.fetchAvailableJobs();
        this.showToast('Requests refreshed.', 'success');
    }

    async browseRequests() {
        if (this.status() !== 'online') {
            await this.goOnline();
        } else {
            await this.driverService.fetchAvailableJobs();
        }

        const section = document.querySelector('[data-section="available-requests"]');
        section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async setAvailableNow() {
        this.driverService.isAvailable.set(true);

        const profile = this.profileService.profile();

        if (profile) {
            await this.safeUpdateProfile(profile.id, {
                is_available: true,
                last_active_at: new Date().toISOString()
            });
        }

        await this.driverService.fetchAvailableJobs();
    }

    private subscribeToAvailableJobsRealtime(): void {
        if (this.jobsChannel) return;

        this.jobsChannel = this.supabase.client
            .channel('driver-dashboard-jobs')
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'jobs'
                },
                async (payload) => {
                    const newStatus = String((payload.new as any)?.status || '');
                    const oldStatus = String((payload.old as any)?.status || '');
                    const changedJobId = String((payload.new as any)?.id || (payload.old as any)?.id || '');
                    const shouldAlert =
                        newStatus === 'searching' &&
                        !!changedJobId &&
                        !this.knownAvailableJobIds.has(changedJobId) &&
                        this.status() === 'online' &&
                        this.isAvailable();
                    const activeStatuses = [
                        'assigned',
                        'accepted',
                        'heading_to_pickup',
                        'arrived',
                        'arrived_at_store',
                        'shopping_in_progress',
                        'collected',
                        'en_route_to_customer',
                        'in_progress',
                        'delivered',
                        'over_budget_requested'
                    ];

                    if (
                        newStatus === 'searching' ||
                        oldStatus === 'searching' ||
                        activeStatuses.includes(newStatus) ||
                        activeStatuses.includes(oldStatus) ||
                        newStatus === 'completed' ||
                        newStatus === 'cancelled' ||
                        newStatus === 'no_driver_found'
                    ) {
                        await this.refreshActiveJob();
                        await this.driverService.fetchAvailableJobs();

                        const visibleJobs = this.jobs();
                        const newVisibleJob = visibleJobs.find(job => job.id === changedJobId);

                        if (shouldAlert && newVisibleJob) {
                            await this.alertNewJob(newVisibleJob);
                        }

                        this.knownAvailableJobIds = new Set(visibleJobs.map(job => job.id));
                    }
                }
            )
            .subscribe((status) => {
                console.log('[driver-dashboard] jobs realtime:', status);
            });
    }

    private async alertNewJob(job: Booking): Promise<void> {
        const serviceName = this.getServiceName(job);
        this.showToast(`New ${serviceName.toLowerCase()} request nearby`, 'warning');

        try {
            await Haptics.notification({ type: NotificationType.Warning });
        } catch {
            navigator.vibrate?.([160, 80, 160]);
        }

        await this.oneSignal.notifyNewJob(serviceName, this.formatPrice(this.getRequestFare(job)), job.id)
            .catch(() => undefined);

        this.playNewJobTone();
    }

    private playNewJobTone(): void {
        try {
            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
            if (!AudioContextClass) return;

            const context: AudioContext = new AudioContextClass();
            const start = context.currentTime;

            [
                { offset: 0, frequency: 880, duration: 0.12, gain: 0.2 },
                { offset: 0.18, frequency: 660, duration: 0.1, gain: 0.12 }
            ].forEach((tone) => {
                const oscillator = context.createOscillator();
                const gain = context.createGain();
                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(tone.frequency, start + tone.offset);
                gain.gain.setValueAtTime(0.0001, start + tone.offset);
                gain.gain.exponentialRampToValueAtTime(tone.gain, start + tone.offset + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.offset + tone.duration);
                oscillator.connect(gain);
                gain.connect(context.destination);
                oscillator.start(start + tone.offset);
                oscillator.stop(start + tone.offset + tone.duration + 0.02);
            });

            window.setTimeout(() => void context.close(), 600);
        } catch (error) {
            console.warn('[driver-dashboard] New request tone was blocked by the device:', error);
        }
    }

    private startJobsAutoRefresh(): void {
        if (this.jobsRefreshInterval) return;

        this.jobsRefreshInterval = setInterval(async () => {
            await this.loadDashboardStats();
            await this.refreshActiveJob();

            if (this.status() === 'online' && this.isAvailable()) {
                await this.driverService.fetchAvailableJobs();
            }
        }, 5000);
    }

    private async refreshStripeUiStateFromDb() {
        const user = this.auth.currentUser();

        if (!user?.id) {
            this.resetStripeUiState();
            return;
        }

        try {
            const settings = await this.connectService.getPayoutSettings();

            if (!settings.stripeAccountId) {
                this.resetStripeUiState();
                return;
            }

            this.stripeUiState.set({
                accountId: settings.stripeAccountId,
                status: settings.connectStatus || 'pending',
                chargesEnabled: settings.chargesEnabled === true,
                payoutsEnabled: settings.payoutsEnabled === true
            });

            this.mergeLocalProfile({
                stripe_account_id: settings.stripeAccountId,
                stripe_connect_status: settings.connectStatus || 'pending'
            });

            return;
        } catch (error) {
            console.warn('[DriverDashboard] payout settings lookup failed; falling back to profile Stripe fields', error);
        }

        const { data: profile, error } = await this.supabase.client
            .from('profiles')
            .select('id, tenant_id, stripe_account_id, stripe_connect_status')
            .eq('id', user.id)
            .maybeSingle();

        if (error) return;

        this.mergeLocalProfile((profile || {}) as Record<string, unknown>);

        const accountId = (profile as any)?.stripe_account_id || null;
        const dbStatus = String((profile as any)?.stripe_connect_status || 'not_started');

        if (!accountId) {
            this.resetStripeUiState();
            return;
        }

        try {
            const status = await this.connectService.refreshAccountStatus(accountId, user.id);

            this.stripeUiState.set({
                accountId: status.stripe_account_id || accountId,
                status: status.status || dbStatus,
                chargesEnabled: status.charges_enabled === true,
                payoutsEnabled: status.payouts_enabled === true
            });
        } catch (error) {
            console.warn('[DriverDashboard] Stripe status refresh failed', error);
            this.stripeUiState.set({
                accountId,
                status: dbStatus,
                chargesEnabled: false,
                payoutsEnabled: false
            });
        }
    }

    private resetStripeUiState() {
        this.stripeUiState.set({
            accountId: null,
            status: 'not_started',
            chargesEnabled: false,
            payoutsEnabled: false
        });

        this.driverService.stripeAccount.set(null);

        this.mergeLocalProfile({
            stripe_account_id: null,
            stripe_connect_status: 'not_started'
        });
    }

    async handleStripeReturn() {
        const stripe = this.route.snapshot.queryParamMap.get('stripe');
        if (!stripe) return;

        try {
            await this.refreshStripeUiStateFromDb();

            if (stripe === 'success') {
                this.showToast(
                    this.isStripeReady()
                        ? 'Stripe payouts are connected.'
                        : 'Stripe setup saved, but Stripe still needs more information.',
                    this.isStripeReady() ? 'success' : 'warning'
                );
            }

            if (stripe === 'refresh') {
                this.showToast('Please continue completing your Stripe onboarding.', 'warning');
            }
        } finally {
            await this.router.navigate([], {
                relativeTo: this.route,
                queryParams: {},
                replaceUrl: true
            });
        }
    }

    async loadAvailability() {
        const profile = this.profileService.profile() as DriverProfile | null;
        if (!profile) return;

        this.driverService.isAvailable.set(profile.is_available ?? true);
        this.driverService.onlineStatus.set(profile.is_online ? 'online' : 'offline');
    }

    async toggleStatus(event: Event) {
        const customEvent = event as CustomEvent;
        const isOnline = !!customEvent.detail?.checked;

        if (isOnline) {
            await this.goOnline();
            return;
        }

        const profile = this.profileService.profile();

        this.driverService.onlineStatus.set('offline');
        this.driverService.availableJobs.set([]);

        if (profile) {
            await this.safeUpdateProfile(profile.id, {
                is_online: false,
                last_active_at: new Date().toISOString()
            });
        }

        this.checkTracking();
    }

    async goOnline() {
        if (!this.canDriverAcceptTrips()) {
            this.showToast('Complete Stripe Connect before going online.', 'warning');
            return;
        }

        const profile = this.profileService.profile();

        this.driverService.onlineStatus.set('online');
        this.driverService.isAvailable.set(true);

        if (profile) {
            await this.safeUpdateProfile(profile.id, {
                is_online: true,
                is_available: true,
                last_active_at: new Date().toISOString()
            });
        }

        await this.driverService.fetchAvailableJobs();
        this.checkTracking();
    }

    async toggleAvailability(event: Event) {
        const customEvent = event as CustomEvent;
        const available = !!customEvent.detail?.checked;
        const profile = this.profileService.profile();

        if (available && !this.canDriverAcceptTrips()) {
            this.showToast('Complete Stripe Connect before accepting trips.', 'warning');
            // Force the toggle back to off
            this.driverService.isAvailable.set(false);
            return;
        }

        this.driverService.isAvailable.set(available);

        if (profile) {
            await this.safeUpdateProfile(profile.id, {
                is_available: available,
                last_active_at: new Date().toISOString()
            });
        }

        if (available) {
            await this.driverService.fetchAvailableJobs();
        } else {
            this.driverService.availableJobs.set([]);
        }
    }

    private checkTracking() {
        const profile = this.profileService.profile();

        if (this.status() === 'online' && profile) {
            this.locationService.startTracking(profile.tenant_id);
        } else {
            this.locationService.stopTracking();
        }
    }

    async accept(jobId: string) {
        if (this.submitting()) return;

        this.submitting.set(true);

        const loading = await this.loadingCtrl.create({
            message: 'Accepting request...'
        });

        await loading.present();

        try {
            const user = this.auth.currentUser();

            if (!user?.id) {
                throw new Error('Please sign in again.');
            }

            const blockers = await this.driverService.getAcceptanceBlockers();
            if (blockers.length) {
                throw new Error(this.driverService.formatAcceptanceBlockers(blockers));
            }

            const job = this.driverService.availableJobs().find(item => item.id === jobId);
            const vehicle = this.driverService.vehicle() || await this.driverService.fetchVehicle();

            if (job && !this.vehicleCompatibility.isCompatible(job, vehicle)) {
                throw new Error(
                    `This request needs ${this.vehicleCompatibility.getRequiredLabel(job)}. Your saved vehicle is ${this.vehicleCompatibility.getVehicleLabel(vehicle)}.`
                );
            }

            const { error } = await this.supabase.client.rpc('accept_searching_job', {
                p_driver_id: user.id,
                p_job_id: jobId
            });

            if (error) {
                throw new Error(error.message || 'Request no longer available');
            }

            await this.driverService.fetchAvailableJobs();

            await loading.dismiss();
            this.submitting.set(false);

            await this.router.navigate(['/driver/job-details', jobId]);
        } catch (e: unknown) {
            await loading.dismiss();
            this.submitting.set(false);

            const message = e instanceof Error ? e.message : 'Request no longer available';
            this.showToast(message, 'danger');

            await this.driverService.fetchAvailableJobs();
        }
    }

    reject(jobId: string) {
        this.rememberPassedJob(jobId);
        this.driverService.availableJobs.update((jobs: Booking[]) =>
            jobs.filter((job: Booking) => job.id !== jobId)
        );
    }

    async resubmitDriverReview() {
        const profile = this.profileService.profile();

        if (!profile?.id || this.resubmittingReview()) return;

        this.resubmittingReview.set(true);

        try {
            await this.safeUpdateProfile(profile.id, {
                driver_review_status: 'under_review',
                verification_status: 'under_review',
                verification_notes: null,
                driver_review_notes: null,
                verification_blockers: [],
                driver_review_blockers: [],
                updated_at: new Date().toISOString()
            });

            if (typeof (this.profileService as any).fetchProfile === 'function') {
                await (this.profileService as any).fetchProfile(profile.id);
            }

            this.showToast('Resubmitted for manual review.', 'success');
        } finally {
            this.resubmittingReview.set(false);
        }
    }

    private loadPassedJobs() {
        try {
            const maxAgeMs = 60 * 60 * 1000;
            const parsed = JSON.parse(localStorage.getItem(this.passedJobsStorageKey) || '[]') as PassedJob[];
            const now = Date.now();
            const fresh = parsed.filter(item => item?.id && now - Number(item.passedAt || 0) < maxAgeMs);
            this.passedJobIds.set(new Set(fresh.map(item => item.id)));
            localStorage.setItem(this.passedJobsStorageKey, JSON.stringify(fresh));
        } catch {
            this.passedJobIds.set(new Set());
        }
    }

    private rememberPassedJob(jobId: string) {
        const now = Date.now();
        const next = new Set(this.passedJobIds());
        next.add(jobId);
        this.passedJobIds.set(next);

        const items = Array.from(next).map(id => ({
            id,
            passedAt: id === jobId ? now : now
        }));

        localStorage.setItem(this.passedJobsStorageKey, JSON.stringify(items));
    }

    getMetricLabel(value: number): string {
        if (value >= 85) return 'Excellent';
        if (value >= 70) return 'Good';
        return 'Needs work';
    }

    getMetricVariant(value: number): 'success' | 'warning' | 'error' | 'info' {
        if (value >= 85) return 'success';
        if (value >= 70) return 'info';
        return 'warning';
    }

    getStripeBadgeText(): string {
        const state = this.stripeUiState();

        if (this.isStripeReady()) return 'Connected';
        if (!state.accountId) return 'Not Started';

        const status = String(state.status || '').toLowerCase();

        if (status === 'restricted' || status === 'requires_action') return 'Action Required';

        return 'Pending';
    }

    getStripeBadgeVariant(): 'success' | 'warning' | 'info' | 'error' | 'secondary' | 'primary' {
        const state = this.stripeUiState();

        if (this.isStripeReady()) return 'success';
        if (!state.accountId) return 'secondary';

        const status = String(state.status || '').toLowerCase();

        if (status === 'restricted' || status === 'requires_action') return 'error';

        return 'warning';
    }

    getStripeDescription(): string {
        const state = this.stripeUiState();
        const status = String(state.status || '').toLowerCase();

        if (!state.accountId) {
            return 'Connect your payout account so earnings from ride, errand, delivery, and moving requests can be processed safely.';
        }

        if (status === 'restricted' || status === 'requires_action') {
            return 'Stripe still needs a few more details before payouts can be enabled.';
        }

        return 'Your Stripe account has started onboarding, but payouts are not fully enabled yet.';
    }

    togglePayoutPanel(): void {
        if (!this.isStripeReady()) {
            this.payoutPanelOpen.set(true);
            return;
        }

        this.payoutPanelOpen.update(open => !open);
    }

    getStripeCompactSummary(): string {
        if (this.isStripeReady()) return 'Payouts connected';
        if (this.isStripePending()) return 'Setup needs attention';
        return 'Setup required';
    }

    async openStripeDashboard() {
        await this.refreshStripeUiStateFromDb();

        const accountId = this.stripeUiState().accountId;

        if (!accountId) {
            this.showToast('Stripe account not found. Start setup first.', 'warning');
            return;
        }

        const loading = await this.loadingCtrl.create({
            message: 'Opening Stripe dashboard...'
        });

        await loading.present();

        try {
            const link = await this.connectService.getDashboardLink(accountId);
            window.location.href = link.url;
        } catch {
            this.showToast('Failed to open Stripe dashboard', 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    async setupPayouts() {
        const user = this.auth.currentUser();

        if (!user) {
            this.showToast('Please sign in again to continue payout setup.', 'warning');
            return;
        }

        const loading = await this.loadingCtrl.create({
            message: 'Loading payout settings...'
        });

        await loading.present();

        try {
            await this.refreshStripeUiStateFromDb();

            let accountId = this.stripeUiState().accountId;

            if (!accountId) {
                const { data: freshProfile, error } = await this.supabase.client
                    .from('profiles')
                    .select('id, tenant_id')
                    .eq('id', user.id)
                    .maybeSingle();

                if (error) throw error;

                const result = await this.connectService.createAccount(
                    user.id,
                    user.email || '',
                    (freshProfile as any)?.tenant_id || null
                );

                accountId = result.stripe_account_id;

                await this.safeUpdateProfile(user.id, {
                    stripe_account_id: accountId,
                    stripe_connect_status: 'pending'
                });

                await this.refreshStripeUiStateFromDb();
            }

            if (!accountId) throw new Error('Stripe account could not be created.');

            const settings = await this.connectService.getPayoutSettings();

            this.stripeUiState.set({
                accountId: settings.stripeAccountId || accountId,
                status: settings.connectStatus || 'pending',
                chargesEnabled: settings.chargesEnabled === true,
                payoutsEnabled: settings.payoutsEnabled === true
            });

            const returnUrl = `${window.location.origin}/driver?stripe=success`;
            const refreshUrl = `${window.location.origin}/driver?stripe=refresh`;

            const link = this.isStripeReady()
                ? await this.connectService.getDashboardLink(accountId)
                : await this.connectService.getOnboardingLink(accountId, returnUrl, refreshUrl);

            window.location.href = link.url;
        } catch (error) {
            console.warn('[DriverDashboard] Failed to load payout settings', error);
            this.showToast('Failed to load payout settings', 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    private async safeUpdateProfile(profileId: string, updates: Record<string, unknown>) {
        const cleanUpdates = this.cleanProfileUpdates(updates);

        if (!Object.keys(cleanUpdates).length) return;

        const { error } = await this.supabase.client
            .from('profiles')
            .update(cleanUpdates)
            .eq('id', profileId);

        if (!error) {
            this.mergeLocalProfile(cleanUpdates);
            return;
        }

        console.error('Profile update failed:', error);
        this.showToast('Could not update profile. Please try again.', 'danger');
    }

    private cleanProfileUpdates(updates: Record<string, unknown>) {
        const blockedKeys = new Set([
            'status',
            '_status',
            'moderated_by',
            'completed_at'
        ]);

        return Object.entries(updates).reduce<Record<string, unknown>>((acc, [key, value]) => {
            if (blockedKeys.has(key)) return acc;
            if (value === undefined) return acc;
            acc[key] = value;
            return acc;
        }, {});
    }

    private mergeLocalProfile(updates: Record<string, unknown>) {
        const current = this.profileService.profile() as any;
        if (!current) return;

        const next = {
            ...current,
            ...updates
        };

        const service = this.profileService as any;

        if (typeof service.profile?.set === 'function') {
            service.profile.set(next);
            return;
        }

        if (typeof service.setProfile === 'function') {
            service.setProfile(next);
        }
    }

    private showToast(message: string, color: ToastColor = 'success') {
        this.toastMessage.set(message);
        this.toastColor.set(color);
        this.toastVisible.set(true);

        window.setTimeout(() => {
            this.toastVisible.set(false);
        }, 2500);

        void this.showIonicToastFallback(message, color);
    }

    private async showIonicToastFallback(message: string, color: ToastColor) {
        try {
            const toast = await this.toastCtrl.create({
                message,
                duration: 1800,
                color,
                position: 'top'
            });

            await toast.present();
        } catch {
            // Signal toast is already visible.
        }
    }
}
