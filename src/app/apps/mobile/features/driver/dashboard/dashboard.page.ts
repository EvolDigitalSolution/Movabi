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
    listOutline
} from 'ionicons/icons';
import { RealtimeChannel } from '@supabase/supabase-js';

import { DriverService } from '../../../../../core/services/driver/driver.service';
import { AuthService } from '../../../../../core/services/auth/auth.service';
import { LocationService } from '../../../../../core/services/logistics/location.service';
import { ProfileService } from '../../../../../core/services/profile/profile.service';
import { ConnectService } from '../../../../../core/services/stripe/connect.service';
import { SupabaseService } from '../../../../../core/services/supabase/supabase.service';
import {
    CardComponent,
    ButtonComponent,
    BadgeComponent,
    RatingComponent,
    EmptyStateComponent,
    PerformanceBadgeComponent
} from '../../../../../shared/ui';
import { Booking, DriverProfile } from '../../../../../shared/models/booking.model';
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
        PerformanceBadgeComponent
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
            (click)="auth.signOut()"
            class="w-11 h-11 rounded-2xl bg-red-50 text-red-600 flex items-center justify-center border border-red-100 shadow-sm ml-2 active:scale-95 transition-all"
          >
            <ion-icon name="log-out-outline" class="text-xl"></ion-icon>
          </button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="w-full max-w-xl mx-auto px-3 py-4 space-y-6 pb-20 overflow-x-hidden">
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
              <div class="w-20 h-20 bg-amber-50 rounded-[1.75rem] flex items-center justify-center mx-auto border border-amber-100">
                <ion-icon name="time-outline" class="text-4xl text-amber-600"></ion-icon>
              </div>

              <h2 class="text-2xl font-display font-bold text-slate-950">
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
              <div class="w-20 h-20 bg-rose-50 rounded-[1.75rem] flex items-center justify-center mx-auto border border-rose-100">
                <ion-icon name="alert-circle-outline" class="text-4xl text-rose-600"></ion-icon>
              </div>

              <h2 class="text-2xl font-display font-bold text-slate-950">
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

            <app-button variant="primary" color="error" (clicked)="router.navigate(['/driver/onboarding'])">
              Fix Details
            </app-button>
          </div>
        } @else if (!isVerified()) {
          <div class="bg-white rounded-[2rem] p-7 border border-slate-100 shadow-xl shadow-slate-200/50 text-center space-y-6">
            <div class="w-20 h-20 bg-blue-50 rounded-[2rem] flex items-center justify-center mx-auto border border-blue-100">
              <ion-icon name="person-add-outline" class="text-4xl text-blue-600"></ion-icon>
            </div>

            <div class="space-y-2">
              <h2 class="text-2xl font-display font-bold text-slate-950">Complete Onboarding</h2>
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
                  <ion-icon name="cash-outline" class="text-2xl"></ion-icon>
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

          <div class="relative overflow-hidden rounded-[2rem] p-5 shadow-2xl shadow-slate-900/20">
            <div class="absolute inset-0 bg-gradient-to-br from-slate-950 via-blue-950 to-slate-900"></div>
            <div class="absolute -top-20 -right-10 w-48 h-48 rounded-full bg-blue-500/20 blur-3xl"></div>

            <div class="relative z-10">
              <div class="flex flex-col gap-5 mb-6">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 border border-white/10 text-white/90 text-[9px] font-bold uppercase tracking-[0.18em] mb-4">
                      <ion-icon name="radio-outline" class="text-sm"></ion-icon>
                      Live status
                    </div>

                    <h2 class="text-3xl font-display font-bold text-white tracking-tight leading-none">
                      {{ status() === 'online' ? (isAvailable() ? 'Active' : 'Busy') : 'Offline' }}
                    </h2>

                    <p class="text-slate-300 font-medium text-sm mt-3 leading-relaxed max-w-[14rem]">
                      @if (status() === 'offline') {
                        Go online to receive nearby ride, errand, delivery, and moving requests.
                      } @else if (!isAvailable()) {
                        You're online, but temporarily marked as busy.
                      } @else {
                        You're live and ready for new requests.
                      }
                    </p>
                  </div>

                  <div class="rounded-[1.5rem] border border-white/10 bg-white/10 p-3 shadow-xl shrink-0">
                    <div class="grid grid-cols-2 gap-3">
                      <div class="flex flex-col items-center">
                        <span class="text-[7px] uppercase text-slate-300 font-bold mb-2 tracking-widest">Online</span>
                        <ion-toggle
                          [checked]="status() === 'online'"
                          (ionChange)="toggleStatus($event)"
                          color="success"
                        ></ion-toggle>
                      </div>

                      <div class="flex flex-col items-center">
                        <span class="text-[7px] uppercase text-slate-300 font-bold mb-2 tracking-widest">Free</span>
                        <ion-toggle
                          [checked]="isAvailable()"
                          (ionChange)="toggleAvailability($event)"
                          color="primary"
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

                  @if (!acceptanceMetric().isNew && (acceptanceMetric().value || 0) >= 95) {
                    <app-performance-badge type="reliable"></app-performance-badge>
                  }

                  @if (!isProDriver()) {
                    <app-badge variant="secondary">Starter Driver</app-badge>
                  }
                </div>
              </div>

              <div class="grid grid-cols-3 gap-2">
                <div class="rounded-2xl bg-white/10 border border-white/10 p-3 min-w-0">
                  <p class="text-[8px] uppercase tracking-widest font-bold text-slate-300 mb-1 truncate">Today</p>
                  <p class="text-lg font-display font-bold text-white">{{ jobs().length }}</p>
                  <p class="text-[9px] text-slate-300 font-medium leading-snug">Open requests</p>
                </div>

                <div class="rounded-2xl bg-white/10 border border-white/10 p-3 min-w-0">
                  <p class="text-[8px] uppercase tracking-widest font-bold text-slate-300 mb-1 truncate">Acceptance</p>
                  <p class="text-lg font-display font-bold text-white">{{ acceptanceMetric().display }}</p>
                  <p class="text-[9px] text-slate-300 font-medium leading-snug">{{ acceptanceMetric().label }}</p>
                </div>

                <div class="rounded-2xl bg-white/10 border border-white/10 p-3 min-w-0">
                  <p class="text-[8px] uppercase tracking-widest font-bold text-slate-300 mb-1 truncate">Rating</p>
                  <p class="text-lg font-display font-bold text-white">{{ ratingMetric().display }}</p>
                  <p class="text-[9px] text-slate-300 font-medium leading-snug">{{ ratingMetric().label }}</p>
                </div>
              </div>
            </div>
          </div>

          <div class="space-y-4">
            <div class="flex items-center justify-between px-1 gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <div
                  class="w-1.5 h-6 rounded-full shadow-lg shrink-0"
                  [class.bg-emerald-500]="isStripeReady()"
                  [class.bg-rose-500]="getStripeBadgeText() === 'Action Required'"
                  [class.bg-amber-500]="!isStripeReady() && getStripeBadgeText() !== 'Action Required'"
                ></div>

                <div class="min-w-0">
                  <h3 class="text-xs font-black text-slate-500 uppercase tracking-[0.18em]">
                    Payouts
                  </h3>
                  <p class="text-[11px] text-slate-400 font-semibold mt-0.5">
                    Stripe Connect
                  </p>
                </div>
              </div>

              <app-badge [variant]="getStripeBadgeVariant()">
                {{ getStripeBadgeText() }}
              </app-badge>
            </div>

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
          </div>

          <div class="space-y-4">
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h3 class="text-xs font-bold text-slate-500 uppercase tracking-[0.18em]">Performance Metrics</h3>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div class="bg-white p-5 rounded-[1.75rem] border border-slate-100 shadow-sm">
                <div class="flex items-center justify-between gap-3 mb-4">
                  <div class="flex items-center gap-3 min-w-0">
                    <div class="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 shadow-sm shrink-0">
                      <ion-icon name="checkmark-done-outline"></ion-icon>
                    </div>
                    <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest truncate">Acceptance</span>
                  </div>

                  <app-badge [variant]="acceptanceMetric().isNew ? 'secondary' : getMetricVariant(acceptanceMetric().value || 0)">
                    {{ acceptanceMetric().isNew ? 'New' : getMetricLabel(acceptanceMetric().value || 0) }}
                  </app-badge>
                </div>

                <p class="text-3xl font-display font-bold text-slate-950">{{ acceptanceMetric().display }}</p>
                <p class="text-sm text-slate-500 font-medium mt-1">{{ acceptanceMetric().label }}</p>
              </div>

              <div class="bg-white p-5 rounded-[1.75rem] border border-slate-100 shadow-sm">
                <div class="flex items-center justify-between gap-3 mb-4">
                  <div class="flex items-center gap-3 min-w-0">
                    <div class="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-600 shadow-sm shrink-0">
                      <ion-icon name="star-outline"></ion-icon>
                    </div>
                    <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest truncate">Rating</span>
                  </div>

                  <app-badge [variant]="ratingMetric().isNew ? 'secondary' : 'success'">
                    {{ ratingMetric().isNew ? 'New' : 'Live' }}
                  </app-badge>
                </div>

                @if (ratingMetric().isNew) {
                  <p class="text-3xl font-display font-bold text-slate-950">New</p>
                  <p class="text-sm text-slate-500 font-medium mt-1">
                    Rating will appear after your first customer review.
                  </p>
                } @else {
                  <p class="text-3xl font-display font-bold text-slate-950">{{ ratingMetric().display }}</p>
                  <app-rating [rating]="ratingMetric().value || 0"></app-rating>
                }
              </div>
            </div>
          </div>

          <div class="space-y-4" data-section="available-requests">
            <div class="flex items-center justify-between px-1 gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20 shrink-0"></div>
                <h3 class="text-xs font-bold text-slate-500 uppercase tracking-[0.18em] flex items-center min-w-0">
                  <span class="truncate">Available Requests</span>
                  <span class="ml-3 px-2.5 py-0.5 bg-blue-600 text-white rounded-full text-[10px] font-black">
                    {{ jobs().length }}
                  </span>
                </h3>
              </div>

              <button
                type="button"
                (click)="refreshAvailableJobs()"
                class="px-3 py-2 rounded-xl bg-white border border-slate-200 text-slate-600 text-[10px] font-black uppercase tracking-widest shadow-sm active:scale-95 transition-all"
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
              <div class="bg-white rounded-[2rem] border border-slate-100 shadow-sm overflow-hidden py-10">
                <app-empty-state
                  icon="search-outline"
                  title="Searching for requests"
                  description="New ride, errand, delivery, and moving requests will appear here automatically."
                ></app-empty-state>
              </div>
            } @else {
              <div class="space-y-5">
                @for (job of jobs(); track job.id) {
                  <app-card [hoverable]="true" class="group overflow-hidden border-slate-100">
                    <div class="flex justify-between items-start gap-4 mb-5">
                      <div class="space-y-2 min-w-0">
                        <app-badge variant="primary">{{ getServiceName(job) }}</app-badge>
                        <div class="flex items-center gap-2 text-slate-500 text-[10px] font-bold uppercase tracking-widest">
                          <ion-icon name="flash-outline"></ion-icon>
                          New nearby request
                        </div>
                      </div>

                      <div class="text-right shrink-0">
                        <span class="text-2xl font-display font-bold text-slate-950">
                          {{ formatPrice(getDriverPayout(job)) }}
                        </span>
                        <p class="text-[10px] font-black text-emerald-600 uppercase tracking-widest mt-1">
                          Est. Payout
                        </p>
                      </div>
                    </div>

                    <div class="space-y-4 mb-5">
                      <div class="rounded-2xl bg-slate-50 border border-slate-100 p-4 space-y-4">
                        <div>
                          <p class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Pickup</p>
                          <p class="text-sm font-bold text-slate-900 leading-snug">
                            {{ job.pickup_address || 'Pickup address unavailable' }}
                          </p>
                        </div>

                        <div class="h-px bg-slate-200/70"></div>

                        <div>
                          <p class="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Dropoff</p>
                          <p class="text-sm font-bold text-slate-900 leading-snug">
                            {{ job.dropoff_address || 'Dropoff address unavailable' }}
                          </p>
                        </div>
                      </div>

                      <div class="grid grid-cols-3 gap-2">
                        <div class="rounded-2xl bg-blue-50 border border-blue-100 p-3">
                          <p class="text-[8px] font-black text-blue-500 uppercase tracking-widest">Service</p>
                          <p class="text-xs font-bold text-slate-900 mt-1 truncate">
                            {{ getServiceName(job) }}
                          </p>
                        </div>

                        <div class="rounded-2xl bg-emerald-50 border border-emerald-100 p-3">
                          <p class="text-[8px] font-black text-emerald-600 uppercase tracking-widest">Distance</p>
                          <p class="text-xs font-bold text-slate-900 mt-1">
                            {{ formatDistance(job.estimated_distance) }}
                          </p>
                        </div>

                        <div class="rounded-2xl bg-amber-50 border border-amber-100 p-3">
                          <p class="text-[8px] font-black text-amber-600 uppercase tracking-widest">Time</p>
                          <p class="text-xs font-bold text-slate-900 mt-1">
                            {{ formatSearchTimeLeft(job) }}
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
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h3 class="text-xs font-bold text-slate-500 uppercase tracking-[0.18em]">Quick Actions</h3>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <button type="button" (click)="router.navigate(['/driver/earnings'])" class="relative min-h-[9.25rem] overflow-hidden flex flex-col items-start p-4 bg-white rounded-[1.5rem] border border-slate-100 shadow-sm active:scale-[0.98] transition-all text-left">
                <div class="w-12 h-12 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600 mb-4 border border-blue-100">
                  <ion-icon name="stats-chart" class="text-2xl"></ion-icon>
                </div>
                <h4 class="font-display font-bold text-slate-950 text-base mb-1">Earnings</h4>
                <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest leading-snug">View income</p>
              </button>

              <button type="button" (click)="router.navigate(['/driver/subscription'])" class="relative min-h-[9.25rem] overflow-hidden flex flex-col items-start p-4 bg-white rounded-[1.5rem] border border-slate-100 shadow-sm active:scale-[0.98] transition-all text-left">
                <div class="w-12 h-12 bg-amber-50 rounded-2xl flex items-center justify-center text-amber-600 mb-4 border border-amber-100">
                  <ion-icon name="star" class="text-2xl"></ion-icon>
                </div>
                <h4 class="font-display font-bold text-slate-950 text-base mb-1">Subscription</h4>
                <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest leading-snug">
                  {{ isProDriver() ? 'Pro plan active' : 'Starter plan' }}
                </p>
              </button>

              <button type="button" (click)="browseRequests()" class="relative min-h-[9.25rem] overflow-hidden flex flex-col items-start p-4 bg-white rounded-[1.5rem] border border-slate-100 shadow-sm active:scale-[0.98] transition-all text-left">
                <div class="w-12 h-12 bg-indigo-50 rounded-2xl flex items-center justify-center text-indigo-600 mb-4 border border-indigo-100">
                  <ion-icon name="list-outline" class="text-2xl"></ion-icon>
                </div>
                <h4 class="font-display font-bold text-slate-950 text-base mb-1">Requests</h4>
                <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest leading-snug">Ride, errand & moving</p>
              </button>

              <button type="button" (click)="setupPayouts()" class="relative min-h-[9.25rem] overflow-hidden flex flex-col items-start p-4 bg-white rounded-[1.5rem] border border-slate-100 shadow-sm active:scale-[0.98] transition-all text-left">
                <div class="w-12 h-12 bg-emerald-50 rounded-2xl flex items-center justify-center text-emerald-600 mb-4 border border-emerald-100">
                  <ion-icon name="card" class="text-2xl"></ion-icon>
                </div>
                <h4 class="font-display font-bold text-slate-950 text-base mb-1">Payouts</h4>
                <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest leading-snug">Stripe Connect</p>
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
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);
    private config = inject(AppConfigService);

    status = this.driverService.onlineStatus;
    isAvailable = this.driverService.isAvailable;
    jobs = this.driverService.availableJobs;
    locationError = this.locationService.locationError;

    submitting = signal(false);
    toastVisible = signal(false);
    toastMessage = signal('');
    toastColor = signal<ToastColor>('success');

    stripeUiState = signal<StripeUiState>({
        accountId: null,
        status: 'not_started',
        chargesEnabled: false,
        payoutsEnabled: false
    });

    private jobsChannel?: RealtimeChannel;
    private jobsRefreshInterval?: ReturnType<typeof setInterval>;

    verificationStatus = computed<'draft' | 'under_review' | 'action_required' | 'approved'>(() => {
        const profile = this.profileService.profile() as DriverProfile | null;

        if (!profile) return 'draft';
        if (profile.is_verified === true || profile.verification_status === 'approved') return 'approved';
        if (profile.verification_status === 'action_required') return 'action_required';
        if (profile.verification_status === 'under_review') return 'under_review';
        if (profile.onboarding_completed) return 'under_review';

        return 'draft';
    });

    verificationNotes = computed(() => {
        const profile = this.profileService.profile() as DriverProfile | null;
        return profile?.verification_notes ?? null;
    });

    isVerified = computed(() => this.verificationStatus() === 'approved');
    isUnderReview = computed(() => this.verificationStatus() === 'under_review');
    isActionRequired = computed(() => this.verificationStatus() === 'action_required');

    acceptanceMetric = computed<MetricState>(() => {
        const profile = this.profileService.profile() as any;
        const value = this.toNullableNumber(profile?.acceptance_rate ?? null);

        if (value === null || value <= 0) {
            return {
                value: null,
                label: 'No accepted requests yet',
                display: 'New',
                isNew: true
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
                value: null,
                label: 'No reviews yet',
                display: 'New',
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

    isStripeReady = computed(() => {
        const state = this.stripeUiState();
        if (!state.accountId) return false;
        return state.chargesEnabled === true && state.payoutsEnabled === true;
    });

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
            listOutline
        });
    }

    async ngOnInit() {
        if (!this.supabase.isConfigured) return;

        await this.refreshStripeUiStateFromDb();
        await this.loadAvailability();
        await this.handleStripeReturn();

        await this.driverService.fetchAvailableJobs();

        this.subscribeToAvailableJobsRealtime();
        this.startJobsAutoRefresh();

        if (this.isVerified()) {
            this.checkTracking();
            await this.loadAvailability();
        }
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

    getDriverPayout(job: Booking): number {
        const raw = job as any;

        const payout = Number(raw.driver_payout);
        if (Number.isFinite(payout) && payout > 0) return payout;

        const total = Number(raw.total_price);
        if (Number.isFinite(total) && total > 0) return total;

        const estimated = Number(raw.estimated_price);
        if (Number.isFinite(estimated) && estimated > 0) return estimated;

        return 0;
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
            return '5:00';
        }

        const expiresAt = new Date(raw.driver_search_expires_at).getTime();

        if (!Number.isFinite(expiresAt)) {
            return '5:00';
        }

        const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;

        return `${mins}:${secs.toString().padStart(2, '0')}`;
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

    formatDistance(distance: unknown): string {
        const value = Number(distance || 0);

        if (!Number.isFinite(value) || value <= 0) {
            return 'N/A';
        }

        return `${value.toFixed(1)} km`;
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

                    if (
                        newStatus === 'searching' ||
                        oldStatus === 'searching' ||
                        newStatus === 'accepted' ||
                        newStatus === 'assigned' ||
                        newStatus === 'no_driver_found'
                    ) {
                        await this.driverService.fetchAvailableJobs();
                    }
                }
            )
            .subscribe((status) => {
                console.log('[driver-dashboard] jobs realtime:', status);
            });
    }

    private startJobsAutoRefresh(): void {
        if (this.jobsRefreshInterval) return;

        this.jobsRefreshInterval = setInterval(async () => {
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
        } catch {
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
        this.driverService.availableJobs.update((jobs: Booking[]) =>
            jobs.filter((job: Booking) => job.id !== jobId)
        );
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

            const status = await this.connectService.refreshAccountStatus(accountId, user.id);

            this.stripeUiState.set({
                accountId: status.stripe_account_id || accountId,
                status: status.status || 'pending',
                chargesEnabled: status.charges_enabled === true,
                payoutsEnabled: status.payouts_enabled === true
            });

            const returnUrl = `${window.location.origin}/driver?stripe=success`;
            const refreshUrl = `${window.location.origin}/driver?stripe=refresh`;

            const link = this.isStripeReady()
                ? await this.connectService.getDashboardLink(accountId)
                : await this.connectService.getOnboardingLink(accountId, returnUrl, refreshUrl);

            window.location.href = link.url;
        } catch {
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