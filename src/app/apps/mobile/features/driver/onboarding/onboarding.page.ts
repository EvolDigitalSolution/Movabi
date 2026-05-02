import { Component, DestroyRef, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonIcon,
    LoadingController,
    ToastController
} from '@ionic/angular/standalone';
import { ActivatedRoute, Router } from '@angular/router';
import { addIcons } from 'ionicons';
import {
    personAddOutline,
    optionsOutline,
    cardOutline,
    shieldCheckmarkOutline,
    chevronBackOutline,
    carSportOutline,
    checkmarkCircleOutline,
    sparklesOutline,
    cashOutline,
    alertCircleOutline,
    lockClosedOutline,
    eyeOutline,
    businessOutline,
    calendarOutline,
    documentAttachOutline
} from 'ionicons/icons';

import { DriverService } from '@core/services/driver/driver.service';
import { AuthService } from '@core/services/auth/auth.service';
import { ProfileService } from '@core/services/profile/profile.service';
import { SupabaseService } from '@core/services/supabase/supabase.service';
import { DriverProfile, Vehicle } from '@shared/models/booking.model';
import { ButtonComponent, BadgeComponent } from '@shared/ui';

type DocumentType = 'license' | 'insurance';
type StripeMessageType = 'success' | 'warning';

type DriverOnboardingDraft = {
    form?: Record<string, unknown>;
    docs?: {
        license?: string;
        insurance?: string;
    };
};

@Component({
    selector: 'app-driver-onboarding',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        ReactiveFormsModule,
        IonHeader,
        IonToolbar,
        IonButtons,
        IonBackButton,
        IonTitle,
        IonContent,
        IonIcon,
        ButtonComponent,
        BadgeComponent
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-3 pt-4 bg-slate-50">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>

        <ion-title class="font-display font-black text-slate-950 tracking-tight">
          Driver Setup
        </ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="w-full max-w-xl mx-auto px-3 py-4 space-y-6 pb-24 overflow-x-hidden">
        <div class="relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 p-6 shadow-2xl shadow-slate-900/20">
          <div class="absolute -top-12 -right-8 w-32 h-32 bg-blue-400/20 rounded-full blur-3xl"></div>
          <div class="absolute -bottom-10 -left-6 w-28 h-28 bg-cyan-300/10 rounded-full blur-3xl"></div>

          <div class="relative z-10 text-center">
            <div class="w-20 h-20 bg-white/10 rounded-[1.75rem] flex items-center justify-center mx-auto mb-5 border border-white/10 shadow-xl">
              <ion-icon [name]="isReadOnly() ? 'eye-outline' : 'person-add-outline'" class="text-4xl text-white"></ion-icon>
            </div>

            <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 border border-white/10 text-white/90 text-[10px] font-black uppercase tracking-[0.2em] mb-4">
              <ion-icon [name]="isReadOnly() ? 'lock-closed-outline' : 'sparkles-outline'" class="text-sm"></ion-icon>
              {{ isReadOnly() ? 'Review mode' : 'Driver setup' }}
            </div>

            <h1 class="text-3xl font-display font-black text-white mb-3 tracking-tight">
              {{ pageTitle() }}
            </h1>

            <p class="text-slate-300 font-medium leading-relaxed max-w-sm mx-auto text-sm">
              {{ pageDescription() }}
            </p>
          </div>
        </div>

        @if (isActionRequired()) {
          <div class="rounded-[1.75rem] border border-rose-100 bg-rose-50 p-5 shadow-sm">
            <div class="flex items-start gap-3">
              <div class="w-10 h-10 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                <ion-icon name="alert-circle-outline" class="text-xl"></ion-icon>
              </div>

              <div class="min-w-0">
                <h3 class="font-display font-black text-slate-950">Changes Needed</h3>
                <p class="text-sm text-slate-600 font-medium leading-relaxed mt-1">
                  Please update your information and resubmit for manual review.
                </p>

                @if (verificationNotes()) {
                  <div class="mt-3 rounded-xl bg-white border border-rose-100 p-3 text-sm text-slate-700">
                    {{ verificationNotes() }}
                  </div>
                }
              </div>
            </div>
          </div>
        }

        @if (isReadOnly()) {
          <div class="rounded-[1.75rem] border border-amber-100 bg-amber-50 p-5 shadow-sm">
            <div class="flex items-start gap-3">
              <div class="w-10 h-10 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center shrink-0">
                <ion-icon name="lock-closed-outline" class="text-xl"></ion-icon>
              </div>

              <div class="min-w-0">
                <h3 class="font-display font-black text-slate-950">Review Only</h3>
                <p class="text-sm text-slate-600 font-medium leading-relaxed mt-1">
                  Editing is locked while your application is under manual review.
                </p>
              </div>
            </div>
          </div>
        }

        @if (stripeMessage()) {
          <div
            class="rounded-[1.75rem] border p-5 shadow-sm"
            [class.bg-emerald-50]="stripeMessageType() === 'success'"
            [class.border-emerald-100]="stripeMessageType() === 'success'"
            [class.bg-amber-50]="stripeMessageType() === 'warning'"
            [class.border-amber-100]="stripeMessageType() === 'warning'"
          >
            <div class="flex items-start gap-3">
              <div
                class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                [class.bg-emerald-100]="stripeMessageType() === 'success'"
                [class.text-emerald-600]="stripeMessageType() === 'success'"
                [class.bg-amber-100]="stripeMessageType() === 'warning'"
                [class.text-amber-600]="stripeMessageType() === 'warning'"
              >
                <ion-icon [name]="stripeMessageType() === 'success' ? 'checkmark-circle-outline' : 'alert-circle-outline'" class="text-xl"></ion-icon>
              </div>

              <div class="min-w-0">
                <h3 class="font-display font-black text-slate-950">
                  {{ stripeMessageType() === 'success' ? 'Stripe setup updated' : 'Continue Stripe setup' }}
                </h3>
                <p class="text-sm text-slate-600 font-medium leading-relaxed mt-1">
                  {{ stripeMessage() }}
                </p>
              </div>
            </div>
          </div>
        }

        <section class="space-y-4">
          <div class="flex items-center gap-3 ml-1">
            <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
            <h2 class="text-xs font-black text-slate-400 uppercase tracking-[0.18em]">Payouts</h2>
          </div>

          <div class="relative overflow-hidden bg-white rounded-[1.85rem] border border-slate-100 shadow-sm p-5">
            <div class="relative flex items-start gap-4 mb-5">
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
                <div class="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <h3 class="font-display font-black text-slate-950 text-lg">Stripe Connect</h3>
                    <p class="text-xs text-slate-500 font-semibold">Required for payouts and wallet-funded requests</p>
                  </div>

                  <app-badge [variant]="getStripeBadgeVariant()">
                    {{ getStripeBadgeText() }}
                  </app-badge>
                </div>

                <p class="text-sm text-slate-600 font-medium leading-relaxed">
                  @if (isStripeReady()) {
                    Your Stripe account is connected and ready for payouts.
                  } @else if (isStripePending()) {
                    Your Stripe onboarding has started, but payouts are not fully enabled yet.
                  } @else {
                    Connect payouts so your completed request earnings can be processed safely.
                  }
                </p>
              </div>
            </div>

            @if (!isStripeReady()) {
              <app-button
                variant="outline"
                size="sm"
                class="w-full"
                [disabled]="isReadOnly() || submitting()"
                (clicked)="setupPayouts()"
              >
                {{ isReadOnly() ? 'Locked During Review' : (isStripePending() ? 'Continue Stripe Setup' : 'Start Stripe Setup') }}
              </app-button>
            } @else {
              <div class="rounded-2xl bg-emerald-50 border border-emerald-100 p-4">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center">
                    <ion-icon name="checkmark-circle-outline" class="text-xl"></ion-icon>
                  </div>
                  <div>
                    <p class="font-black text-emerald-900">Payouts ready</p>
                    <p class="text-xs text-emerald-700 font-semibold">Stripe setup is complete.</p>
                  </div>
                </div>
              </div>
            }
          </div>
        </section>

        <div class="bg-white rounded-[1.85rem] p-5 border border-slate-100 shadow-sm">
          <div class="flex items-start gap-4">
            <div class="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100 shadow-sm shrink-0">
              <ion-icon name="options-outline" class="text-2xl"></ion-icon>
            </div>

            <div class="min-w-0">
              <div class="flex items-center gap-2 mb-2">
                <span class="text-[10px] font-black uppercase tracking-[0.22em] text-blue-600">How you earn</span>
                <div class="h-px flex-1 bg-slate-100"></div>
              </div>

              <h3 class="font-display font-black text-slate-950 text-lg mb-2">Starter by default</h3>
              <p class="text-sm text-slate-600 font-medium leading-relaxed">
                New drivers start on the <span class="font-black text-slate-950">Starter Plan</span>. Upgrade to
                <span class="font-black text-slate-950"> Pro</span> later only when you choose to subscribe.
              </p>
            </div>
          </div>
        </div>

        <form [formGroup]="onboardingForm" (ngSubmit)="submit()" class="space-y-6">
          <section class="space-y-4">
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h2 class="text-xs font-black text-slate-400 uppercase tracking-[0.18em]">Vehicle Details</h2>
            </div>

            <div class="bg-white rounded-[1.85rem] border border-slate-100 shadow-sm overflow-hidden">
              <div class="p-5 border-b border-slate-50">
                <div class="flex items-center gap-3">
                  <div class="w-12 h-12 rounded-2xl bg-slate-50 text-slate-700 flex items-center justify-center border border-slate-100">
                    <ion-icon name="car-sport-outline" class="text-2xl"></ion-icon>
                  </div>
                  <div>
                    <h3 class="font-display font-black text-slate-950">Your vehicle</h3>
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Used for dispatch and manual review</p>
                  </div>
                </div>
              </div>

              <div class="divide-y divide-slate-50">
                <div class="p-4">
                  <label for="make" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Make</label>
                  <input id="make" formControlName="make" placeholder="e.g. Toyota" [readonly]="isReadOnly()" class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-950 placeholder:text-slate-300">
                </div>

                <div class="p-4">
                  <label for="model" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Model</label>
                  <input id="model" formControlName="model" placeholder="e.g. Corolla" [readonly]="isReadOnly()" class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-950 placeholder:text-slate-300">
                </div>

                <div class="p-4">
                  <label for="year" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Year</label>
                  <input id="year" type="number" formControlName="year" placeholder="e.g. 2022" [readonly]="isReadOnly()" class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-950 placeholder:text-slate-300">
                </div>

                <div class="p-4">
                  <label for="license_plate" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">License Plate</label>
                  <input id="license_plate" formControlName="license_plate" placeholder="e.g. AB12 CDE" [readonly]="isReadOnly()" class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-950 placeholder:text-slate-300 uppercase">
                </div>
              </div>
            </div>
          </section>

          <section class="space-y-4">
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h2 class="text-xs font-black text-slate-400 uppercase tracking-[0.18em]">Council Taxi Licence</h2>
            </div>

            <div class="bg-white rounded-[1.85rem] border border-slate-100 shadow-sm overflow-hidden">
              <div class="p-5 border-b border-slate-50">
                <div class="flex items-center gap-3">
                  <div class="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100">
                    <ion-icon name="business-outline" class="text-2xl"></ion-icon>
                  </div>
                  <div>
                    <h3 class="font-display font-black text-slate-950">Manual approval details</h3>
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Council details are saved for review</p>
                  </div>
                </div>
              </div>

              <div class="divide-y divide-slate-50">
                <div class="p-4">
                  <label for="council_name" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Council Name</label>
                  <input id="council_name" formControlName="council_name" placeholder="e.g. Oldham Council" [readonly]="isReadOnly()" class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-950 placeholder:text-slate-300">
                </div>

                <div class="p-4">
                  <label for="council_license_number" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Council Licence Number</label>
                  <input id="council_license_number" formControlName="council_license_number" placeholder="e.g. PHV/123456" [readonly]="isReadOnly()" class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-950 placeholder:text-slate-300">
                </div>

                <div class="p-4">
                  <label for="taxi_badge_number" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Taxi Badge Number</label>
                  <input id="taxi_badge_number" formControlName="taxi_badge_number" placeholder="e.g. BADGE-1234" [readonly]="isReadOnly()" class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-950 placeholder:text-slate-300">
                </div>

                <div class="p-4">
                  <label for="taxi_license_expiry" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Taxi Licence Expiry Date</label>
                  <input id="taxi_license_expiry" type="date" formControlName="taxi_license_expiry" [readonly]="isReadOnly()" class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-950 placeholder:text-slate-300">
                </div>
              </div>
            </div>
          </section>

          <section class="space-y-4">
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h2 class="text-xs font-black text-slate-400 uppercase tracking-[0.18em]">Documents</h2>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <button type="button" (click)="handleDocumentClick('license')" class="bg-white rounded-[1.6rem] border border-slate-100 shadow-sm p-4 text-center active:scale-[0.98] transition-all text-slate-950">
                <div class="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto mb-4 border border-blue-100 shadow-sm">
                  <ion-icon name="card-outline" class="text-2xl"></ion-icon>
                </div>

                <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">
                  {{ isReadOnly() ? 'View' : 'Upload' }}
                </p>
                <h4 class="font-display font-black text-slate-950 text-sm mb-3">Driver Licence</h4>

                @if (docs().license) {
                  <app-badge variant="success">{{ isReadOnly() ? 'Open File' : 'Uploaded' }}</app-badge>
                } @else {
                  <p class="text-xs text-slate-500 font-semibold">{{ isReadOnly() ? 'Not saved' : 'Tap to select' }}</p>
                }
              </button>

              <button type="button" (click)="handleDocumentClick('insurance')" class="bg-white rounded-[1.6rem] border border-slate-100 shadow-sm p-4 text-center active:scale-[0.98] transition-all text-slate-950">
                <div class="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-4 border border-emerald-100 shadow-sm">
                  <ion-icon name="shield-checkmark-outline" class="text-2xl"></ion-icon>
                </div>

                <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">
                  {{ isReadOnly() ? 'View' : 'Upload' }}
                </p>
                <h4 class="font-display font-black text-slate-950 text-sm mb-3">Insurance</h4>

                @if (docs().insurance) {
                  <app-badge variant="success">{{ isReadOnly() ? 'Open File' : 'Uploaded' }}</app-badge>
                } @else {
                  <p class="text-xs text-slate-500 font-semibold">{{ isReadOnly() ? 'Not saved' : 'Tap to select' }}</p>
                }
              </button>
            </div>
          </section>

          <section class="space-y-4">
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h2 class="text-xs font-black text-slate-400 uppercase tracking-[0.18em]">Checklist</h2>
            </div>

            <div class="bg-white rounded-[1.85rem] border border-slate-100 shadow-sm p-5 space-y-4">
              <div class="flex items-center justify-between gap-3">
                <span class="text-sm font-semibold text-slate-700">Vehicle and council details</span>
                <app-badge [variant]="onboardingForm.valid ? 'success' : 'warning'">
                  {{ onboardingForm.valid ? 'Ready' : 'Pending' }}
                </app-badge>
              </div>

              <div class="flex items-center justify-between gap-3">
                <span class="text-sm font-semibold text-slate-700">Driver licence uploaded</span>
                <app-badge [variant]="docs().license ? 'success' : 'warning'">
                  {{ docs().license ? 'Uploaded' : 'Pending' }}
                </app-badge>
              </div>

              <div class="flex items-center justify-between gap-3">
                <span class="text-sm font-semibold text-slate-700">Insurance uploaded</span>
                <app-badge [variant]="docs().insurance ? 'success' : 'warning'">
                  {{ docs().insurance ? 'Uploaded' : 'Pending' }}
                </app-badge>
              </div>

              <div class="flex items-center justify-between gap-3">
                <span class="text-sm font-semibold text-slate-700">Stripe Connect</span>
                <app-badge [variant]="isStripeReady() ? 'success' : 'warning'">
                  {{ isStripeReady() ? 'Connected' : 'Pending' }}
                </app-badge>
              </div>
            </div>
          </section>

          <div class="pt-2">
            @if (!isReadOnly()) {
              <app-button
                type="submit"
                class="w-full shadow-xl shadow-blue-600/15"
                [disabled]="submitting() || !canSubmit()"
              >
                {{ submitting() ? 'Submitting...' : (isActionRequired() ? 'Resubmit for Manual Review' : 'Submit for Manual Review') }}
              </app-button>

              @if (!canSubmit()) {
                <p class="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-2xl p-4 mt-4 font-semibold leading-relaxed">
                  Complete vehicle details, council licence details, driver licence, insurance, and Stripe Connect before submitting.
                </p>
              }

              <p class="text-[10px] text-slate-400 font-black uppercase tracking-widest text-center mt-6 px-8 leading-relaxed">
                By submitting, you agree to our terms of service and driver agreement.
              </p>
            } @else {
              <app-button variant="outline" class="w-full" (clicked)="router.navigate(['/driver'])">
                Back to Driver Hub
              </app-button>

              <p class="text-[10px] text-slate-400 font-black uppercase tracking-widest text-center mt-6 px-8 leading-relaxed">
                Editing is disabled while your application is under manual review.
              </p>
            }
          </div>
        </form>
      </div>
    </ion-content>
  `
})
export class OnboardingPage implements OnInit {
    private fb = inject(FormBuilder);
    private destroyRef = inject(DestroyRef);
    private driverService = inject(DriverService);
    public authService = inject(AuthService);
    private profileService = inject(ProfileService);
    private supabase = inject(SupabaseService);
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);
    private route = inject(ActivatedRoute);
    public router = inject(Router);

    private readonly draftKey = 'driver_onboarding_draft_v2';
    private readonly maxUploadBytes = 8 * 1024 * 1024;

    onboardingForm: FormGroup;

    docs = signal<{ license?: string; insurance?: string }>({});
    stripeMessage = signal<string | null>(null);
    stripeMessageType = signal<StripeMessageType>('success');
    submitting = signal(false);

    stripeAccount = this.driverService.stripeAccount;
    profile = this.profileService.profile;
    vehicle = this.driverService.vehicle;

    verificationStatus = computed<'draft' | 'under_review' | 'action_required' | 'approved'>(() => {
        const profile = this.profile() as DriverProfile | null;

        if (!profile) return 'draft';
        if (profile.is_verified === true || profile.verification_status === 'approved') return 'approved';
        if (profile.verification_status === 'action_required') return 'action_required';
        if (profile.verification_status === 'under_review') return 'under_review';
        if (profile.onboarding_completed) return 'under_review';

        return 'draft';
    });

    verificationNotes = computed(() => {
        const profile = this.profile() as DriverProfile | null;
        return profile?.verification_notes ?? null;
    });

    isStripeReady = computed(() => {
        const account = this.stripeAccount();
        return !!(
            account?.stripe_account_id &&
            account?.charges_enabled === true &&
            account?.payouts_enabled === true
        );
    });

    isStripePending = computed(() => {
        const account = this.stripeAccount();
        return !!(account?.stripe_account_id && !this.isStripeReady());
    });

    isReadOnly = computed(() => this.verificationStatus() === 'under_review');
    isActionRequired = computed(() => this.verificationStatus() === 'action_required');

    canSubmit = computed(() => {
        return (
            this.onboardingForm.valid &&
            !!this.docs().license &&
            !!this.docs().insurance &&
            this.isStripeReady() &&
            !this.isReadOnly() &&
            !this.submitting()
        );
    });

    pageTitle = computed(() => {
        if (this.isReadOnly()) return 'Application Under Review';
        if (this.isActionRequired()) return 'Update Your Details';
        return 'Complete Your Profile';
    });

    pageDescription = computed(() => {
        if (this.isReadOnly()) {
            return 'Your details have been submitted and are currently under manual review.';
        }

        if (this.isActionRequired()) {
            return 'Update the requested details and resubmit your application for manual approval.';
        }

        return 'Add your vehicle, council licence details, documents, and payout setup to start receiving requests.';
    });

    constructor() {
        addIcons({
            personAddOutline,
            optionsOutline,
            cardOutline,
            shieldCheckmarkOutline,
            chevronBackOutline,
            carSportOutline,
            checkmarkCircleOutline,
            sparklesOutline,
            cashOutline,
            alertCircleOutline,
            lockClosedOutline,
            eyeOutline,
            businessOutline,
            calendarOutline,
            documentAttachOutline
        });

        this.onboardingForm = this.fb.group({
            make: ['', [Validators.required, Validators.minLength(2)]],
            model: ['', [Validators.required, Validators.minLength(1)]],
            year: [
                new Date().getFullYear(),
                [Validators.required, Validators.min(1900), Validators.max(new Date().getFullYear() + 1)]
            ],
            license_plate: ['', [Validators.required, Validators.minLength(2)]],
            council_name: ['', [Validators.required, Validators.minLength(2)]],
            council_license_number: ['', [Validators.required, Validators.minLength(2)]],
            taxi_badge_number: ['', [Validators.required, Validators.minLength(2)]],
            taxi_license_expiry: ['', Validators.required]
        });
    }

    async ngOnInit() {
        this.restoreDraft();

        await this.driverService.fetchStripeAccount();
        await this.driverService.fetchVehicle();
        this.loadExistingData();

        await this.handleStripeReturn();

        this.applyReadOnlyState();
        this.watchDraftChanges();
    }

    getStripeBadgeText(): string {
        if (this.isStripeReady()) return 'Connected';
        if (this.isStripePending()) return 'Pending';
        return 'Not Started';
    }

    getStripeBadgeVariant(): 'success' | 'warning' | 'secondary' {
        if (this.isStripeReady()) return 'success';
        if (this.isStripePending()) return 'warning';
        return 'secondary';
    }

    private watchDraftChanges() {
        this.onboardingForm.valueChanges
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
                if (!this.isReadOnly()) this.saveDraft();
            });
    }

    private saveDraft() {
        if (this.isReadOnly()) return;

        const draft: DriverOnboardingDraft = {
            form: this.onboardingForm.getRawValue(),
            docs: this.docs()
        };

        localStorage.setItem(this.draftKey, JSON.stringify(draft));
    }

    private restoreDraft() {
        const raw = localStorage.getItem(this.draftKey);
        if (!raw) return;

        try {
            const draft = JSON.parse(raw) as DriverOnboardingDraft;

            if (draft?.form) {
                this.onboardingForm.patchValue(
                    {
                        make: draft.form['make'] ?? '',
                        model: draft.form['model'] ?? '',
                        year: draft.form['year'] ?? new Date().getFullYear(),
                        license_plate: draft.form['license_plate'] ?? '',
                        council_name: draft.form['council_name'] ?? '',
                        council_license_number: draft.form['council_license_number'] ?? '',
                        taxi_badge_number: draft.form['taxi_badge_number'] ?? '',
                        taxi_license_expiry: draft.form['taxi_license_expiry'] ?? ''
                    },
                    { emitEvent: false }
                );
            }

            if (draft?.docs) {
                this.docs.set({
                    license: draft.docs.license,
                    insurance: draft.docs.insurance
                });
            }
        } catch {
            localStorage.removeItem(this.draftKey);
        }
    }

    private clearDraft() {
        localStorage.removeItem(this.draftKey);
    }

    private loadExistingData() {
        const vehicle = this.vehicle() as Vehicle | null;

        if (vehicle) {
            this.onboardingForm.patchValue(
                {
                    make: vehicle.make ?? '',
                    model: vehicle.model ?? '',
                    year: vehicle.year ?? new Date().getFullYear(),
                    license_plate: vehicle.license_plate ?? ''
                },
                { emitEvent: false }
            );
        }

        const profile = this.profile() as DriverProfile | any | null;

        if (profile) {
            const verificationItems = this.parseVerificationItems(profile.verification_items);

            this.onboardingForm.patchValue(
                {
                    council_name: verificationItems['council_name'] ?? profile.council_name ?? '',
                    council_license_number: verificationItems['council_license_number'] ?? profile.council_license_number ?? '',
                    taxi_badge_number: verificationItems['taxi_badge_number'] ?? profile.taxi_badge_number ?? '',
                    taxi_license_expiry: verificationItems['taxi_license_expiry'] ?? profile.taxi_license_expiry ?? ''
                },
                { emitEvent: false }
            );

            this.docs.set({
                license: profile.driver_license_url ?? this.docs().license,
                insurance: profile.insurance_url ?? this.docs().insurance
            });
        }
    }

    private parseVerificationItems(value: unknown): Record<string, string> {
        if (!value) return {};

        if (typeof value === 'object') {
            return value as Record<string, string>;
        }

        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                return typeof parsed === 'object' && parsed ? parsed : {};
            } catch {
                return {};
            }
        }

        return {};
    }

    private applyReadOnlyState() {
        if (this.isReadOnly()) {
            this.onboardingForm.disable({ emitEvent: false });
        } else {
            this.onboardingForm.enable({ emitEvent: false });
        }
    }

    handleDocumentClick(type: DocumentType) {
        if (this.isReadOnly()) {
            void this.openDocument(type);
            return;
        }

        void this.upload(type);
    }

    async openDocument(type: DocumentType) {
        const path = this.docs()[type];

        if (!path) {
            await this.showToast('No document available to open.', 'warning');
            return;
        }

        const url = await this.driverService.getDocumentSignedUrl(path);

        if (!url) {
            await this.showToast('Unable to open this document right now.', 'danger');
            return;
        }

        window.open(url, '_blank', 'noopener,noreferrer');
    }

    async handleStripeReturn() {
        const stripe = this.route.snapshot.queryParamMap.get('stripe');
        if (!stripe) return;

        try {
            await this.driverService.fetchStripeAccount();

            const accountId = this.driverService.stripeAccount()?.stripe_account_id;

            if (accountId) {
                await this.driverService.refreshStripeStatus(accountId, true);
                await this.driverService.fetchStripeAccount();
            }

            if (stripe === 'success') {
                this.stripeMessageType.set(this.isStripeReady() ? 'success' : 'warning');
                this.stripeMessage.set(
                    this.isStripeReady()
                        ? 'Your Stripe onboarding was completed successfully. You can continue finishing driver setup.'
                        : 'Stripe setup was saved, but Stripe still needs more information before payouts are enabled.'
                );
            }

            if (stripe === 'refresh') {
                this.stripeMessageType.set('warning');
                this.stripeMessage.set('Stripe needs a little more information. Tap the payout button below to continue setup.');
            }
        } catch {
            this.stripeMessageType.set('warning');
            this.stripeMessage.set('Stripe setup returned, but we could not refresh payout status yet. Please try again.');
        } finally {
            await this.router.navigate([], {
                relativeTo: this.route,
                queryParams: {},
                replaceUrl: true
            });
        }
    }

    async upload(type: DocumentType) {
        if (this.isReadOnly()) {
            await this.showToast('Documents cannot be changed while verification is in progress.', 'warning');
            return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/jpeg,image/png,image/webp,application/pdf';

        input.onchange = async (event: Event) => {
            const target = event.target as HTMLInputElement;
            const file = target.files?.[0];

            if (!file) return;

            if (!this.isAllowedFile(file)) {
                await this.showToast('Please upload a JPG, PNG, WEBP, or PDF file under 8MB.', 'warning');
                return;
            }

            const loading = await this.loadingCtrl.create({ message: 'Uploading document...' });
            await loading.present();

            try {
                const path = await this.driverService.uploadDocument(file, type);
                this.docs.update((current) => ({ ...current, [type]: path }));
                this.saveDraft();

                await this.showToast(`${type === 'license' ? 'Driver licence' : 'Insurance'} uploaded.`, 'success');
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : 'Upload failed.';
                await this.showToast(message, 'danger');
            } finally {
                await loading.dismiss();
                input.value = '';
            }
        };

        input.click();
    }

    private isAllowedFile(file: File): boolean {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        return allowedTypes.includes(file.type) && file.size <= this.maxUploadBytes;
    }

    async submit() {
        if (this.isReadOnly()) {
            await this.showToast('Your application is already under review.', 'warning');
            return;
        }

        this.onboardingForm.markAllAsTouched();

        if (!this.canSubmit()) {
            await this.showToast('Complete all required details, documents, and Stripe Connect before submitting.', 'warning');
            return;
        }

        const user = this.authService.currentUser();

        if (!user?.id) {
            await this.showToast('Please sign in again to continue.', 'danger');
            return;
        }

        this.submitting.set(true);

        const loading = await this.loadingCtrl.create({ message: 'Submitting for manual review...' });
        await loading.present();

        try {
            const raw = this.onboardingForm.getRawValue();

            await this.driverService.updateVehicle({
                make: String(raw.make || '').trim(),
                model: String(raw.model || '').trim(),
                year: Number(raw.year),
                license_plate: String(raw.license_plate || '').trim().toUpperCase()
            });

            await this.updateProfileSafely(user.id, {
                onboarding_completed: true,
                role: 'driver',
                pricing_plan: 'starter',
                subscription_status: 'inactive',
                driver_license_url: this.docs().license || null,
                insurance_url: this.docs().insurance || null,
                verification_status: 'under_review',
                verification_notes: null,
                verification_items: {
                    council_name: String(raw.council_name || '').trim(),
                    council_license_number: String(raw.council_license_number || '').trim(),
                    taxi_badge_number: String(raw.taxi_badge_number || '').trim(),
                    taxi_license_expiry: String(raw.taxi_license_expiry || '').trim()
                },
                is_verified: false
            });

            if (typeof (this.profileService as any).fetchProfile === 'function') {
                await (this.profileService as any).fetchProfile();
            }

            this.authService.onboardingCompleted.set(true);
            this.authService.userRole.set('driver');

            this.clearDraft();

            await this.showToast(
                this.isActionRequired()
                    ? 'Details updated and resubmitted for manual review.'
                    : 'Application submitted for manual review.',
                'success'
            );

            await this.router.navigate(['/driver'], { replaceUrl: true });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'An error occurred.';
            await this.showToast(message, 'danger');
        } finally {
            this.submitting.set(false);
            await loading.dismiss();
        }
    }

    private async updateProfileSafely(userId: string, updates: Record<string, unknown>) {
        const cleaned = this.cleanProfileUpdates(updates);

        let { error } = await this.supabase.client
            .from('profiles')
            .update(cleaned)
            .eq('id', userId);

        if (!error) {
            this.mergeLocalProfile(cleaned);
            return;
        }

        const missingColumn = this.extractMissingColumn(error);

        if (missingColumn && cleaned[missingColumn] !== undefined) {
            const retry = { ...cleaned };
            delete retry[missingColumn];

            const result = await this.supabase.client
                .from('profiles')
                .update(retry)
                .eq('id', userId);

            error = result.error;

            if (!error) {
                this.mergeLocalProfile(retry);
                return;
            }
        }

        throw error;
    }

    private cleanProfileUpdates(updates: Record<string, unknown>) {
        const blockedKeys = new Set([
            'status',
            '_status',
            'email',
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

    private extractMissingColumn(error: unknown): string | null {
        const maybeError = error as { code?: string; message?: string };
        const message = maybeError?.message || '';

        if (maybeError?.code !== '42703' && !message.includes('does not exist')) return null;

        const quoted = message.match(/column "([^"]+)"/i);
        if (quoted?.[1]) return quoted[1];

        const plain = message.match(/column ([a-zA-Z0-9_]+) does not exist/i);
        if (plain?.[1]) return plain[1];

        return null;
    }

    private mergeLocalProfile(updates: Record<string, unknown>) {
        const current = this.profile() as any;
        if (!current) return;

        const next = { ...current, ...updates };
        const service = this.profileService as any;

        if (typeof service.profile?.set === 'function') {
            service.profile.set(next);
            return;
        }

        if (typeof service.setProfile === 'function') {
            service.setProfile(next);
        }
    }

    async setupPayouts() {
        if (this.isReadOnly()) {
            await this.showToast('Payout setup is locked while verification is in progress.', 'warning');
            return;
        }

        const loading = await this.loadingCtrl.create({ message: 'Loading payout settings...' });
        await loading.present();

        try {
            this.saveDraft();
            const url = await this.driverService.setupStripeConnect();
            window.location.href = url;
        } catch {
            await this.showToast('Failed to load payout settings.', 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    private async showToast(message: string, color: 'success' | 'danger' | 'warning') {
        const toast = await this.toastCtrl.create({
            message,
            duration: 2400,
            color,
            position: 'top'
        });

        await toast.present();
    }
}