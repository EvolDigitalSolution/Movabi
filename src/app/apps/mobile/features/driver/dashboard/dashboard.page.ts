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
    IonSpinner,
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
    optionsOutline,
    star,
    statsChart,
    bus,
    card,
    timeOutline,
    alertCircleOutline,
    sparklesOutline,
    flashOutline,
    radioOutline,
    cashOutline,
    arrowForwardOutline,
    checkmarkCircleOutline,
    personAddOutline
} from 'ionicons/icons';
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

@Component({
    selector: 'app-driver-dashboard',
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-6 bg-slate-50">
        <ion-title class="font-display font-black text-3xl tracking-tighter text-slate-900">
          Driver Hub
        </ion-title>

        <ion-buttons slot="end">
          @if (auth.userRole() === 'admin') {
            <button
              (click)="router.navigate(['/admin'])"
              class="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100 shadow-sm active:scale-95 transition-all"
            >
              <ion-icon name="shield-checkmark" class="text-xl"></ion-icon>
            </button>
          }

          <button
            (click)="router.navigate(['/driver/earnings'])"
            class="w-12 h-12 rounded-2xl bg-white text-slate-600 flex items-center justify-center border border-slate-200 shadow-sm ml-3 active:scale-95 transition-all"
          >
            <ion-icon name="wallet-outline" class="text-xl"></ion-icon>
          </button>

          <button
            (click)="auth.signOut()"
            class="w-12 h-12 rounded-2xl bg-red-50 text-red-600 flex items-center justify-center border border-red-100 shadow-sm ml-3 active:scale-95 transition-all"
          >
            <ion-icon name="log-out-outline" class="text-xl"></ion-icon>
          </button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="max-w-2xl mx-auto p-6 space-y-10 pb-16">

        @if (isUnderReview()) {
          <div class="bg-white rounded-[2.5rem] p-8 border border-slate-100 shadow-xl shadow-slate-200/50 space-y-6">
            <div class="text-center space-y-4">
              <div class="w-20 h-20 bg-amber-50 rounded-[2rem] flex items-center justify-center mx-auto border border-amber-100 shadow-lg shadow-amber-100/50">
                <ion-icon name="time-outline" class="text-4xl text-amber-600"></ion-icon>
              </div>

              <h2 class="text-2xl font-display font-bold text-slate-900">
                Verification in Progress
              </h2>

              <p class="text-slate-600 font-medium leading-relaxed">
                We are reviewing your profile and documents. This usually takes
                24 to 48 hours.
              </p>
            </div>

            <div class="rounded-2xl bg-slate-50 border border-slate-100 p-4 text-left space-y-3">
              <div class="flex items-center justify-between">
                <span class="text-sm font-semibold text-slate-700">Documents submitted</span>
                <app-badge variant="success">Done</app-badge>
              </div>

              <div class="flex items-center justify-between">
                <span class="text-sm font-semibold text-slate-700">Verification review</span>
                <app-badge variant="warning">In Progress</app-badge>
              </div>

              <div class="flex items-center justify-between">
                <span class="text-sm font-semibold text-slate-700">Account approval</span>
                <app-badge variant="secondary">Next</app-badge>
              </div>
            </div>

            <div class="text-center">
              <p class="text-sm text-slate-400 font-medium mb-4">
                We will notify you as soon as your account is approved.
              </p>

              <app-button variant="outline" (clicked)="router.navigate(['/driver/onboarding'])">
                Review Documents
              </app-button>
            </div>
          </div>
        } @else if (isActionRequired()) {
          <div class="bg-white rounded-[2.5rem] p-8 border border-rose-100 shadow-xl shadow-rose-100/30 space-y-6">
            <div class="text-center space-y-4">
              <div class="w-20 h-20 bg-rose-50 rounded-[2rem] flex items-center justify-center mx-auto border border-rose-100 shadow-lg shadow-rose-100/40">
                <ion-icon name="alert-circle-outline" class="text-4xl text-rose-600"></ion-icon>
              </div>

              <h2 class="text-2xl font-display font-bold text-slate-900">
                Changes Needed
              </h2>

              <p class="text-slate-600 font-medium leading-relaxed">
                We found a problem with your submitted details. Please review the note below,
                update your information, and resubmit.
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
          <div class="bg-white rounded-[2.5rem] p-10 border border-slate-100 shadow-xl shadow-slate-200/50 text-center space-y-6">
            <div class="w-20 h-20 bg-blue-50 rounded-[2rem] flex items-center justify-center mx-auto border border-blue-100 shadow-lg shadow-blue-100/50">
              <ion-icon name="person-add-outline" class="text-4xl text-blue-600"></ion-icon>
            </div>

            <div class="space-y-2">
              <h2 class="text-2xl font-display font-bold text-slate-900">Complete Onboarding</h2>
              <p class="text-slate-500 font-medium leading-relaxed">
                Add your vehicle, upload documents, and connect payouts to start driving.
              </p>
            </div>

            <div class="pt-4">
              <app-button variant="primary" (clicked)="router.navigate(['/driver/onboarding'])">
                Continue Setup
              </app-button>
            </div>
          </div>
        } @else {

          @if (!isStripeReady()) {
            <div class="relative overflow-hidden rounded-[2.25rem] border border-rose-100 bg-gradient-to-br from-rose-50 via-white to-rose-50 p-7 shadow-lg shadow-rose-100/40 animate-in fade-in slide-in-from-top duration-500">
              <div class="absolute -top-10 -right-10 w-32 h-32 bg-rose-100/60 rounded-full blur-2xl"></div>

              <div class="relative flex items-start gap-4">
                <div class="w-14 h-14 bg-rose-100 rounded-2xl flex items-center justify-center text-rose-600 shadow-sm shrink-0">
                  <ion-icon name="alert-circle-outline" class="text-2xl"></ion-icon>
                </div>

                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-2">
                    <span class="text-[10px] font-bold uppercase tracking-[0.25em] text-rose-500">Payouts setup</span>
                    <div class="h-px flex-1 bg-rose-100"></div>
                  </div>

                  <h3 class="font-display font-bold text-rose-900 text-xl mb-1">Stripe Connect not completed</h3>
                  <p class="text-sm text-rose-700/90 font-medium leading-relaxed">
                    Complete onboarding to receive payouts and accept wallet-funded errands.
                  </p>

                  <div class="mt-5">
                    <app-button variant="primary" color="error" size="sm" class="w-full" (clicked)="setupPayouts()">
                      Continue Stripe Setup
                    </app-button>
                  </div>
                </div>
              </div>
            </div>
          }

          @if (locationError() && status() === 'online') {
            <div class="bg-amber-50 border border-amber-100 rounded-2xl p-4 flex items-center gap-3 text-amber-700 text-sm animate-in fade-in slide-in-from-top duration-300 shadow-sm">
              <ion-icon name="location-outline" class="text-xl shrink-0"></ion-icon>
              <p class="font-medium">{{ locationError() }} Tracking is disabled.</p>
            </div>
          }

          <div class="relative overflow-hidden rounded-[2.75rem] p-10 shadow-2xl shadow-slate-900/20 min-h-[340px]">
            <div class="absolute inset-0">
              <img
                src="https://picsum.photos/seed/driver/1920/1080?blur=4"
                alt="Driver Dashboard"
                class="w-full h-full object-cover opacity-35"
                referrerpolicy="no-referrer"
              />
            </div>

            <div class="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.45),transparent_25%),linear-gradient(135deg,#020617_0%,#0f172a_45%,#111827_100%)]"></div>
            <div class="absolute -top-20 -right-10 w-56 h-56 rounded-full bg-blue-500/20 blur-3xl"></div>
            <div class="absolute -bottom-20 -left-10 w-56 h-56 rounded-full bg-cyan-400/10 blur-3xl"></div>

            <div class="relative z-10">
              <div class="flex items-start justify-between gap-6 mb-10">
                <div>
                  <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 border border-white/10 text-white/90 text-[10px] font-bold uppercase tracking-[0.25em] mb-4 backdrop-blur-sm">
                    <ion-icon name="radio-outline" class="text-sm"></ion-icon>
                    Live driver status
                  </div>

                  <h2 class="text-4xl font-display font-bold text-white tracking-tight leading-none">
                    {{ status() === 'online' ? (isAvailable() ? 'Active' : 'Busy') : 'Offline' }}
                  </h2>

                  <p class="text-slate-300 font-medium text-lg mt-4 max-w-sm">
                    @if (status() === 'offline') {
                      Go online to start receiving nearby ride and errand requests.
                    } @else if (!isAvailable()) {
                      You’re online, but temporarily marked as busy.
                    } @else {
                      You’re live and ready for new requests.
                    }
                  </p>
                </div>

                <div class="rounded-[2rem] border border-white/10 bg-white/10 backdrop-blur-md p-4 shadow-xl">
                  <div class="grid grid-cols-2 gap-5">
                    <div class="flex flex-col items-center">
                      <span class="text-[8px] uppercase text-slate-300 font-bold mb-2 tracking-widest">Online</span>
                      <ion-toggle
                        [checked]="status() === 'online'"
                        (ionChange)="toggleStatus($event)"
                        class="custom-toggle"
                        color="success"
                      ></ion-toggle>
                    </div>

                    <div class="flex flex-col items-center">
                      <span class="text-[8px] uppercase text-slate-300 font-bold mb-2 tracking-widest">Available</span>
                      <ion-toggle
                        [checked]="isAvailable()"
                        (ionChange)="toggleAvailability($event)"
                        class="custom-toggle"
                        color="primary"
                      ></ion-toggle>
                    </div>
                  </div>
                </div>
              </div>

              <div class="flex flex-wrap gap-2 mb-6">
                <app-performance-badge type="pro-driver"></app-performance-badge>
                @if (rating() >= 4.8) {
                  <app-performance-badge type="top-rated"></app-performance-badge>
                }
                @if (acceptanceRate() >= 95) {
                  <app-performance-badge type="reliable"></app-performance-badge>
                }
              </div>

              <div class="grid grid-cols-3 gap-3">
                <div class="rounded-2xl bg-white/10 border border-white/10 backdrop-blur-sm p-4">
                  <p class="text-[9px] uppercase tracking-widest font-bold text-slate-300 mb-1">Today</p>
                  <p class="text-xl font-display font-bold text-white">{{ jobs().length }}</p>
                  <p class="text-[10px] text-slate-300 font-medium">Open requests</p>
                </div>

                <div class="rounded-2xl bg-white/10 border border-white/10 backdrop-blur-sm p-4">
                  <p class="text-[9px] uppercase tracking-widest font-bold text-slate-300 mb-1">Acceptance</p>
                  <p class="text-xl font-display font-bold text-white">{{ acceptanceRate() }}%</p>
                  <p class="text-[10px] text-slate-300 font-medium">Performance</p>
                </div>

                <div class="rounded-2xl bg-white/10 border border-white/10 backdrop-blur-sm p-4">
                  <p class="text-[9px] uppercase tracking-widest font-bold text-slate-300 mb-1">Rating</p>
                  <p class="text-xl font-display font-bold text-white">{{ rating() || 'N/A' }}</p>
                  <p class="text-[10px] text-slate-300 font-medium">Driver score</p>
                </div>
              </div>
            </div>
          </div>

          <div class="space-y-6">
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h3 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Payouts</h3>
            </div>

            <div class="relative overflow-hidden bg-white rounded-[2.5rem] border border-slate-100 shadow-sm p-7">
              <div class="absolute -top-10 -right-10 w-28 h-28 rounded-full blur-2xl"
                [class.bg-emerald-100/60]="isStripeReady()"
                [class.bg-amber-100/60]="!isStripeReady()"
              ></div>

              <div class="relative flex items-start gap-4">
                <div
                  class="w-14 h-14 rounded-2xl flex items-center justify-center border shadow-sm shrink-0"
                  [class.bg-emerald-50]="isStripeReady()"
                  [class.text-emerald-600]="isStripeReady()"
                  [class.border-emerald-100]="isStripeReady()"
                  [class.bg-amber-50]="!isStripeReady()"
                  [class.text-amber-600]="!isStripeReady()"
                  [class.border-amber-100]="!isStripeReady()"
                >
                  <ion-icon [name]="isStripeReady() ? 'checkmark-circle-outline' : 'cash-outline'" class="text-2xl"></ion-icon>
                </div>

                <div class="flex-1 min-w-0">
                  <div class="flex items-center justify-between gap-3 mb-2">
                    <div>
                      <h3 class="font-display font-bold text-slate-900 text-xl">Stripe Connect</h3>
                      <p class="text-sm text-slate-500 font-medium">
                        Required for wallet-funded errands and payouts
                      </p>
                    </div>

                    <app-badge [variant]="getStripeBadgeVariant()">
                      {{ getStripeBadgeText() }}
                    </app-badge>
                  </div>

                  <p class="text-sm text-slate-600 font-medium leading-relaxed">
                    @if (isStripeReady()) {
                      Your Stripe account is connected and ready to receive payouts.
                    } @else if (isStripePending()) {
                      Your Stripe account has started onboarding, but more information is still required.
                    } @else {
                      Connect your payout account so earnings and funded errand payments can be processed safely.
                    }
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

          <div class="space-y-6">
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h3 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Performance Metrics</h3>
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div class="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm hover:shadow-xl hover:shadow-blue-100/40 transition-all">
                <div class="flex items-center justify-between mb-4">
                  <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 shadow-sm">
                      <ion-icon name="checkmark-done-outline"></ion-icon>
                    </div>
                    <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Acceptance</span>
                  </div>
                  <app-badge [variant]="getMetricVariant(acceptanceRate())">
                    {{ getMetricLabel(acceptanceRate()) }}
                  </app-badge>
                </div>

                <p class="text-3xl font-display font-bold text-slate-900">{{ acceptanceRate() }}%</p>

                <div class="mt-3 h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                  <div class="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-500" [style.width.%]="acceptanceRate()"></div>
                </div>
              </div>

              <div class="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm hover:shadow-xl hover:shadow-emerald-100/40 transition-all">
                <div class="flex items-center gap-3 mb-4">
                  <div class="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-600 shadow-sm">
                    <ion-icon name="star-outline"></ion-icon>
                  </div>
                  <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Rating</span>
                </div>

                <div class="flex flex-col gap-2">
                  <p class="text-3xl font-display font-bold text-slate-900">{{ rating() || 'N/A' }}</p>
                  <app-rating [rating]="rating()"></app-rating>
                </div>
              </div>
            </div>
          </div>

          <div class="space-y-6">
            <div class="flex items-center justify-between px-1">
              <div class="flex items-center gap-3">
                <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
                <h3 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em] flex items-center">
                  Available Requests
                  <span class="ml-3 px-2.5 py-0.5 bg-blue-600 text-white rounded-full text-[10px] font-black">
                    {{ jobs().length }}
                  </span>
                </h3>
              </div>
            </div>

            @if (status() === 'offline') {
              <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden py-12">
                <app-empty-state
                  icon="moon-outline"
                  title="You are offline"
                  description="Go online to see available jobs in your area and start earning."
                  actionLabel="Go Online"
                  (action)="goOnline()"
                ></app-empty-state>
              </div>
            } @else if (jobs().length === 0) {
              <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden py-12">
                <app-empty-state
                  icon="search-outline"
                  title="Searching for jobs"
                  description="We're scanning your area for nearby opportunities. New requests will appear here automatically."
                ></app-empty-state>
              </div>
            } @else {
              <div class="space-y-5">
                @for (job of jobs(); track job.id) {
                  <app-card [hoverable]="true" class="group overflow-hidden border-slate-100">
                    <div class="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-cyan-500 to-emerald-500 opacity-80"></div>

                    <div class="flex justify-between items-start mb-8">
                      <div class="space-y-2">
                        <app-badge variant="primary">{{ job.service_type?.name }}</app-badge>
                        <div class="flex items-center gap-2 text-slate-400 text-[10px] font-bold uppercase tracking-widest">
                          <ion-icon name="flash-outline"></ion-icon>
                          New nearby request
                        </div>
                      </div>

                      <div class="text-right">
                        <span class="text-3xl font-display font-bold text-slate-900">
                          {{ formatPrice(job.total_price) }}
                        </span>
                        <p class="text-[10px] font-black text-emerald-600 uppercase tracking-widest mt-1">
                          Est. Payout
                        </p>
                      </div>
                    </div>

                    <div class="relative pl-10 space-y-8 mb-10">
                      <div class="absolute left-4 top-2 bottom-2 w-0.5 border-l-2 border-slate-200 border-dashed"></div>

                      <div class="relative">
                        <div class="absolute -left-8 top-1 w-4 h-4 rounded-full bg-white border-4 border-blue-600 shadow-sm z-10"></div>
                        <div>
                          <p class="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1.5">Pickup</p>
                          <p class="font-bold text-slate-900 leading-relaxed text-sm">{{ job.pickup_address }}</p>
                        </div>
                      </div>

                      <div class="relative">
                        <div class="absolute -left-8 top-1 w-4 h-4 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                        <div>
                          <p class="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1.5">Destination</p>
                          <p class="font-bold text-slate-900 leading-relaxed text-sm">{{ job.dropoff_address }}</p>
                        </div>
                      </div>
                    </div>

                    <div class="grid grid-cols-2 gap-4">
                      <app-button
                        variant="outline"
                        class="w-full"
                        [disabled]="submitting()"
                        (clicked)="reject(job.id)"
                      >
                        Pass
                      </app-button>

                      <app-button
                        variant="primary"
                        class="w-full shadow-xl shadow-blue-600/20"
                        [disabled]="submitting()"
                        (clicked)="accept(job.id)"
                      >
                        {{ submitting() ? 'Accepting...' : 'Accept Job' }}
                      </app-button>
                    </div>
                  </app-card>
                }
              </div>
            }
          </div>

          <div class="space-y-6">
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h3 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Quick Actions</h3>
            </div>

            <div class="grid grid-cols-2 gap-5">
              <button
                (click)="router.navigate(['/driver/earnings'])"
                class="relative overflow-hidden flex flex-col items-start p-8 bg-white rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-2xl hover:shadow-blue-600/10 hover:-translate-y-1 transition-all duration-500 text-left group"
              >
                <div class="absolute -top-10 -right-10 w-24 h-24 rounded-full bg-blue-100/50 blur-2xl"></div>
                <div class="relative w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600 mb-6 border border-blue-100 group-hover:bg-blue-600 group-hover:text-white transition-all">
                  <ion-icon name="stats-chart" class="text-2xl"></ion-icon>
                </div>
                <h4 class="relative font-display font-bold text-slate-900 text-lg mb-1">Earnings</h4>
                <p class="relative text-[10px] text-slate-400 font-bold uppercase tracking-widest">View your income</p>
              </button>

              <button
                (click)="router.navigate(['/driver/subscription'])"
                class="relative overflow-hidden flex flex-col items-start p-8 bg-white rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-2xl hover:shadow-amber-600/10 hover:-translate-y-1 transition-all duration-500 text-left group"
              >
                <div class="absolute -top-10 -right-10 w-24 h-24 rounded-full bg-amber-100/50 blur-2xl"></div>
                <div class="relative w-14 h-14 bg-amber-50 rounded-2xl flex items-center justify-center text-amber-600 mb-6 border border-amber-100 group-hover:bg-amber-600 group-hover:text-white transition-all">
                  <ion-icon name="star" class="text-2xl"></ion-icon>
                </div>
                <h4 class="relative font-display font-bold text-slate-900 text-lg mb-1">Subscription</h4>
                <p class="relative text-[10px] text-slate-400 font-bold uppercase tracking-widest">Manage your plan</p>
              </button>

              <button
                (click)="router.navigate(['/driver/van-moving'])"
                class="relative overflow-hidden flex flex-col items-start p-8 bg-white rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-2xl hover:shadow-indigo-600/10 hover:-translate-y-1 transition-all duration-500 text-left group"
              >
                <div class="absolute -top-10 -right-10 w-24 h-24 rounded-full bg-indigo-100/50 blur-2xl"></div>
                <div class="relative w-14 h-14 bg-indigo-50 rounded-2xl flex items-center justify-center text-indigo-600 mb-6 border border-indigo-100 group-hover:bg-indigo-600 group-hover:text-white transition-all">
                  <ion-icon name="bus" class="text-2xl"></ion-icon>
                </div>
                <h4 class="relative font-display font-bold text-slate-900 text-lg mb-1">Van Jobs</h4>
                <p class="relative text-[10px] text-slate-400 font-bold uppercase tracking-widest">Moving requests</p>
              </button>

              <button
                (click)="setupPayouts()"
                class="relative overflow-hidden flex flex-col items-start p-8 bg-white rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-2xl hover:shadow-emerald-600/10 hover:-translate-y-1 transition-all duration-500 text-left group"
              >
                <div class="absolute -top-10 -right-10 w-24 h-24 rounded-full bg-emerald-100/50 blur-2xl"></div>
                <div class="relative w-14 h-14 bg-emerald-50 rounded-2xl flex items-center justify-center text-emerald-600 mb-6 border border-emerald-100 group-hover:bg-emerald-600 group-hover:text-white transition-all">
                  <ion-icon name="card" class="text-2xl"></ion-icon>
                </div>
                <h4 class="relative font-display font-bold text-slate-900 text-lg mb-1">Payouts</h4>
                <p class="relative text-[10px] text-slate-400 font-bold uppercase tracking-widest">Stripe Connect</p>
              </button>
            </div>
          </div>
        }
      </div>
    </ion-content>
  `,
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
        IonSpinner,
        CardComponent,
        ButtonComponent,
        BadgeComponent,
        RatingComponent,
        EmptyStateComponent,
        PerformanceBadgeComponent
    ]
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
    stripeAccount = this.driverService.stripeAccount;
    submitting = signal(false);

    verificationStatus = computed<'draft' | 'under_review' | 'action_required' | 'approved'>(() => {
        const profile = this.profileService.profile() as DriverProfile | null;

        if (!profile) return 'draft';

        if (profile.is_verified === true || profile.verification_status === 'approved') {
            return 'approved';
        }

        if (profile.verification_status === 'action_required') {
            return 'action_required';
        }

        if (profile.verification_status === 'under_review') {
            return 'under_review';
        }

        if (profile.onboarding_completed) {
            return 'under_review';
        }

        return 'draft';
    });

    verificationNotes = computed(() => {
        const profile = this.profileService.profile() as DriverProfile | null;
        return profile?.verification_notes ?? null;
    });

    isVerified = computed(() => this.verificationStatus() === 'approved');
    isUnderReview = computed(() => this.verificationStatus() === 'under_review');
    isActionRequired = computed(() => this.verificationStatus() === 'action_required');

    acceptanceRate = computed(() => {
        const profile = this.profileService.profile() as DriverProfile | null;
        return profile?.acceptance_rate ?? 98;
    });

    rating = computed(() => {
        const profile = this.profileService.profile() as DriverProfile | null;
        return profile?.rating ?? 4.9;
    });

    isStripeReady = computed(() => {
        const account = this.stripeAccount();
        return !!(account?.onboarding_complete && account?.charges_enabled && account?.payouts_enabled);
    });

    isStripePending = computed(() => {
        const account = this.stripeAccount();
        return !!(account?.stripe_account_id && !this.isStripeReady());
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
            optionsOutline,
            star,
            statsChart,
            bus,
            card,
            timeOutline,
            alertCircleOutline,
            sparklesOutline,
            flashOutline,
            radioOutline,
            cashOutline,
            arrowForwardOutline,
            checkmarkCircleOutline,
            personAddOutline
        });
    }

    formatPrice(amount: number) {
        return this.config.formatCurrency(amount);
    }

    async ngOnInit() {
        if (!this.supabase.isConfigured) {
            console.warn('DriverDashboard: Supabase is not configured.');
            return;
        }

        await this.driverService.fetchStripeAccount();
        await this.handleStripeReturn();

        if (this.isVerified()) {
            await this.driverService.fetchAvailableJobs();
            this.checkTracking();
            await this.loadAvailability();
        }
    }

    async handleStripeReturn() {
        const stripe = this.route.snapshot.queryParamMap.get('stripe');
        if (!stripe) return;

        try {
            const accountId = this.driverService.stripeAccount()?.stripe_account_id;
            if (accountId) {
                await this.driverService.refreshStripeStatus(accountId, true);
                await this.driverService.fetchStripeAccount();
            }

            if (stripe === 'success') {
                const toast = await this.toastCtrl.create({
                    message: 'Stripe onboarding completed successfully.',
                    duration: 3000,
                    color: 'success'
                });
                await toast.present();
            }

            if (stripe === 'refresh') {
                const toast = await this.toastCtrl.create({
                    message: 'Please continue completing your Stripe onboarding.',
                    duration: 3000,
                    color: 'warning'
                });
                await toast.present();
            }
        } catch (error) {
            console.error('Stripe return handling failed', error);
        } finally {
            this.router.navigate([], {
                relativeTo: this.route,
                queryParams: {},
                replaceUrl: true
            });
        }
    }

    async loadAvailability() {
        const profile = this.profileService.profile() as (DriverProfile & { status?: 'online' | 'offline' }) | null;
        if (profile) {
            this.driverService.isAvailable.set(profile.is_available ?? true);
            this.driverService.onlineStatus.set(profile.status ?? 'offline');
        }
    }

    ngOnDestroy() {
        this.locationService.stopTracking();
    }

    async toggleStatus(event: Event) {
        const customEvent = event as CustomEvent;
        const isOnline = customEvent.detail.checked;
        await this.driverService.toggleOnline(isOnline ? 'online' : 'offline');

        const profile = this.profileService.profile();
        if (profile) {
            await this.profileService.updateProfile(profile.id, {
                is_online: isOnline,
                last_active_at: new Date().toISOString()
            });
        }

        this.checkTracking();
    }

    async goOnline() {
        await this.driverService.toggleOnline('online');
        const profile = this.profileService.profile();
        if (profile) {
            await this.profileService.updateProfile(profile.id, {
                is_online: true,
                last_active_at: new Date().toISOString()
            });
        }
        this.checkTracking();
    }

    async toggleAvailability(event: Event) {
        const customEvent = event as CustomEvent;
        const available = customEvent.detail.checked;
        await this.driverService.toggleAvailability(available);
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
        const loading = await this.loadingCtrl.create({ message: 'Accepting job...' });
        await loading.present();

        try {
            await this.driverService.acceptJob(jobId);
            await loading.dismiss();
            this.router.navigate(['/driver/job-details', jobId]);
        } catch (e: unknown) {
            await loading.dismiss();
            this.submitting.set(false);
            const message = e instanceof Error ? e.message : 'Job no longer available';
            const toast = await this.toastCtrl.create({ message, duration: 2000, color: 'danger' });
            await toast.present();
            await this.driverService.fetchAvailableJobs();
        }
    }

    reject(jobId: string) {
        this.driverService.availableJobs.update((jobs: Booking[]) => jobs.filter((j: Booking) => j.id !== jobId));
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
        const account = this.stripeAccount();
        if (this.isStripeReady()) return 'Connected';
        if (account?.stripe_account_id) return 'Pending';
        return 'Not Started';
    }

    getStripeBadgeVariant(): 'success' | 'warning' | 'info' | 'error' | 'secondary' | 'primary' {
        if (this.isStripeReady()) return 'success';
        if (this.isStripePending()) return 'warning';
        return 'secondary';
    }

    async openStripeDashboard() {
        const accountId = this.stripeAccount()?.stripe_account_id;
        if (!accountId) return;

        const loading = await this.loadingCtrl.create({ message: 'Opening Stripe dashboard...' });
        await loading.present();

        try {
            const link = await this.connectService.getDashboardLink(accountId);
            window.location.href = link.url;
        } catch (error) {
            console.error('Open Stripe Dashboard Error:', error);
            const toast = await this.toastCtrl.create({
                message: 'Failed to open Stripe dashboard',
                duration: 2000,
                color: 'danger'
            });
            await toast.present();
        } finally {
            await loading.dismiss();
        }
    }

    async setupPayouts() {
        const user = this.auth.currentUser();
        const profile = this.profileService.profile();
        if (!user || !profile) return;

        const loading = await this.loadingCtrl.create({ message: 'Loading payout settings...' });
        await loading.present();

        try {
            await this.driverService.fetchStripeAccount();

            let accountId = this.driverService.stripeAccount()?.stripe_account_id;

            if (!accountId) {
                const result = await this.connectService.createAccount(user.id, user.email!, profile.tenant_id);
                accountId = result.stripe_account_id;
                await this.driverService.fetchStripeAccount();
            }

            const account = this.driverService.stripeAccount();

            if (account?.payouts_enabled && account?.charges_enabled) {
                const link = await this.connectService.getDashboardLink(accountId);
                window.location.href = link.url;
            } else {
                const returnUrl = `${window.location.origin}/driver?stripe=success`;
                const refreshUrl = `${window.location.origin}/driver?stripe=refresh`;
                const link = await this.connectService.getOnboardingLink(accountId, returnUrl, refreshUrl);
                window.location.href = link.url;
            }
        } catch (error) {
            console.error('Payout Setup Error:', error);
            const toast = await this.toastCtrl.create({
                message: 'Failed to load payout settings',
                duration: 2000,
                color: 'danger'
            });
            await toast.present();
        } finally {
            await loading.dismiss();
        }
    }
}