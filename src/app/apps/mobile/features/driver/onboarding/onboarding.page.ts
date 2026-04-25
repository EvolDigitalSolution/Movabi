import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import {
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonIcon,
    IonSpinner,
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
    documentTextOutline,
    checkmarkCircleOutline,
    sparklesOutline,
    cashOutline,
    alertCircleOutline,
    arrowForwardOutline,
    lockClosedOutline,
    eyeOutline
} from 'ionicons/icons';
import { DriverService } from '@core/services/driver/driver.service';
import { AuthService } from '@core/services/auth/auth.service';
import { ProfileService } from '@core/services/profile/profile.service';
import { DriverProfile, Vehicle } from '@shared/models/booking.model';

import { CardComponent, ButtonComponent, BadgeComponent } from '@shared/ui';

@Component({
    selector: 'app-driver-onboarding',
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-4 bg-slate-50">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-xl text-slate-900">Driver Onboarding</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="max-w-md mx-auto p-6 space-y-8 pb-14">

        <div class="relative overflow-hidden rounded-[2.5rem] bg-gradient-to-br from-slate-900 via-slate-800 to-blue-900 p-8 shadow-2xl shadow-slate-900/20">
          <div class="absolute -top-12 -right-8 w-32 h-32 bg-blue-400/20 rounded-full blur-3xl"></div>
          <div class="absolute -bottom-10 -left-6 w-28 h-28 bg-cyan-300/10 rounded-full blur-3xl"></div>

          <div class="relative z-10 text-center">
            <div class="w-24 h-24 bg-white/10 backdrop-blur-md rounded-[2rem] flex items-center justify-center mx-auto mb-6 border border-white/10 shadow-xl">
              <ion-icon [name]="isReadOnly() ? 'eye-outline' : 'person-add-outline'" class="text-4xl text-white"></ion-icon>
            </div>

            <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 border border-white/10 text-white/90 text-[10px] font-bold uppercase tracking-[0.25em] mb-4">
              <ion-icon [name]="isReadOnly() ? 'lock-closed-outline' : 'sparkles-outline'" class="text-sm"></ion-icon>
              {{ isReadOnly() ? 'Review mode' : 'Driver setup' }}
            </div>

            <h1 class="text-3xl font-display font-bold text-white mb-3 tracking-tight" style="color:#ffffff;">
              {{ isReadOnly() ? 'Application Under Review' : (isActionRequired() ? 'Update Your Details' : 'Complete Your Profile') }}
            </h1>

            <p class="text-slate-300 font-medium leading-relaxed max-w-sm mx-auto">
              @if (isReadOnly()) {
                Your details have been submitted and are currently under review. You can view them here, but editing is disabled until verification is complete.
              } @else if (isActionRequired()) {
                We found a few issues with your submission. Review the notes below, update your information, and resubmit for approval.
              } @else {
                Add your vehicle, upload required documents, and connect payouts so you’re ready to start earning.
              }
            </p>
          </div>
        </div>

        @if (isActionRequired()) {
          <div class="rounded-[2rem] border border-rose-100 bg-rose-50 p-5 shadow-sm">
            <div class="flex items-start gap-3">
              <div class="w-10 h-10 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                <ion-icon name="alert-circle-outline" class="text-xl"></ion-icon>
              </div>

              <div class="min-w-0">
                <h3 class="font-display font-bold text-slate-900">Changes Needed</h3>
                <p class="text-sm text-slate-600 font-medium leading-relaxed mt-1">
                  We reviewed your application and need a few corrections before approval.
                  Please update your details and resubmit.
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
          <div class="rounded-[2rem] border border-amber-100 bg-amber-50 p-5 shadow-sm">
            <div class="flex items-start gap-3">
              <div class="w-10 h-10 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center shrink-0">
                <ion-icon name="lock-closed-outline" class="text-xl"></ion-icon>
              </div>

              <div class="min-w-0">
                <h3 class="font-display font-bold text-slate-900">Review Only</h3>
                <p class="text-sm text-slate-600 font-medium leading-relaxed mt-1">
                  Your application is being reviewed. Vehicle details, documents, and payout setup are locked until verification is complete.
                </p>
              </div>
            </div>
          </div>
        }

        @if (stripeMessage()) {
          <div
            class="rounded-[2rem] border p-5 shadow-sm animate-in fade-in slide-in-from-top duration-300"
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
                <h3 class="font-display font-bold text-slate-900">
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
            <h2 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Payouts</h2>
          </div>

          <div class="relative overflow-hidden bg-white rounded-[2.25rem] border border-slate-100 shadow-sm p-6">
            <div
              class="absolute -top-10 -right-10 w-24 h-24 rounded-full blur-2xl"
              [class.bg-emerald-100/40]="isStripeReady()"
              [class.bg-amber-100/40]="!isStripeReady()"
            ></div>

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
                <div class="flex items-center justify-between gap-3 mb-2">
                  <div>
                    <h3 class="font-display font-bold text-slate-900 text-lg">Stripe Connect</h3>
                    <p class="text-xs text-slate-500 font-medium">Required for wallet-funded errands and payouts</p>
                  </div>

                  <app-badge [variant]="getStripeBadgeVariant()">
                    {{ getStripeBadgeText() }}
                  </app-badge>
                </div>

                <p class="text-sm text-slate-600 font-medium leading-relaxed">
                  @if (isStripeReady()) {
                    Your Stripe account is connected and ready for payouts.
                  } @else if (isStripePending()) {
                    Your Stripe onboarding has started, but more information is still required.
                  } @else {
                    Connect payouts first, then come back here to finish the rest of your profile without losing your progress.
                  }
                </p>
              </div>
            </div>

            @if (!isStripeReady()) {
              <app-button
                variant="outline"
                size="sm"
                class="w-full"
                [disabled]="isReadOnly()"
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
                    <p class="font-bold text-emerald-900">Payouts ready</p>
                    <p class="text-xs text-emerald-700 font-medium">Your Stripe setup looks complete.</p>
                  </div>
                </div>
              </div>
            }
          </div>
        </section>

        <div class="bg-white rounded-[2.25rem] p-6 border border-slate-100 shadow-sm">
          <div class="flex items-start gap-4">
            <div class="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100 shadow-sm shrink-0">
              <ion-icon name="options-outline" class="text-2xl"></ion-icon>
            </div>

            <div class="min-w-0">
              <div class="flex items-center gap-2 mb-2">
                <span class="text-[10px] font-bold uppercase tracking-[0.25em] text-blue-600">How you earn</span>
                <div class="h-px flex-1 bg-slate-100"></div>
              </div>

              <h3 class="font-display font-bold text-slate-900 text-lg mb-2">Choose your path</h3>
              <p class="text-sm text-slate-600 font-medium leading-relaxed">
                Start on the <span class="font-bold text-slate-900">Starter Plan</span> (£0/month) and pay only when you earn,
                or upgrade to <span class="font-bold text-slate-900">Pro</span> to keep 100% of your fares.
              </p>
            </div>
          </div>
        </div>

        <form [formGroup]="onboardingForm" (ngSubmit)="submit()" class="space-y-8">

          <section class="space-y-4">
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h2 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Vehicle Details</h2>
            </div>

            <div class="bg-white rounded-[2.25rem] border border-slate-100 shadow-sm overflow-hidden">
              <div class="p-5 border-b border-slate-50">
                <div class="flex items-center gap-3">
                  <div class="w-12 h-12 rounded-2xl bg-slate-50 text-slate-700 flex items-center justify-center border border-slate-100">
                    <ion-icon name="car-sport-outline" class="text-2xl"></ion-icon>
                  </div>
                  <div>
                    <h3 class="font-display font-bold text-slate-900">Your vehicle</h3>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Used for dispatch and verification</p>
                  </div>
                </div>
              </div>

              <div class="divide-y divide-slate-50">
                <div class="p-4 group">
                  <label for="make" class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
                    Make
                  </label>
                  <input
                    id="make"
                    formControlName="make"
                    placeholder="e.g. Toyota"
                    [readonly]="isReadOnly()"
                    class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-900 placeholder:text-slate-300"
                  >
                </div>

                <div class="p-4 group">
                  <label for="model" class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
                    Model
                  </label>
                  <input
                    id="model"
                    formControlName="model"
                    placeholder="e.g. Corolla"
                    [readonly]="isReadOnly()"
                    class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-900 placeholder:text-slate-300"
                  >
                </div>

                <div class="p-4 group">
                  <label for="year" class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
                    Year
                  </label>
                  <input
                    id="year"
                    type="number"
                    formControlName="year"
                    placeholder="e.g. 2022"
                    [readonly]="isReadOnly()"
                    class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-900 placeholder:text-slate-300"
                  >
                </div>

                <div class="p-4 group">
                  <label for="license_plate" class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
                    License Plate
                  </label>
                  <input
                    id="license_plate"
                    formControlName="license_plate"
                    placeholder="e.g. ABC-1234"
                    [readonly]="isReadOnly()"
                    class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-900 placeholder:text-slate-300"
                  >
                </div>
              </div>
            </div>
          </section>

          <section class="space-y-4">
  <div class="flex items-center gap-3 ml-1">
    <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
    <h2 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Council Taxi Licence</h2>
  </div>

  <div class="bg-white rounded-[2.25rem] border border-slate-100 shadow-sm overflow-hidden">
    <div class="divide-y divide-slate-50">
      <div class="p-4">
        <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
          Council Name
        </label>
        <input formControlName="council_name" placeholder="e.g. Oldham Council" [readonly]="isReadOnly()"
          class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-900 placeholder:text-slate-300">
      </div>

      <div class="p-4">
        <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
          Council Licence Number
        </label>
        <input formControlName="council_license_number" placeholder="e.g. PHV/123456" [readonly]="isReadOnly()"
          class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-900 placeholder:text-slate-300">
      </div>

      <div class="p-4">
        <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
          Taxi Badge Number
        </label>
        <input formControlName="taxi_badge_number" placeholder="e.g. BADGE-1234" [readonly]="isReadOnly()"
          class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-900 placeholder:text-slate-300">
      </div>

      <div class="p-4">
        <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
          Taxi Licence Expiry Date
        </label>
        <input type="date" formControlName="taxi_license_expiry" [readonly]="isReadOnly()"
          class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-900 placeholder:text-slate-300">
      </div>
    </div>
  </div>
</section>

          <section class="space-y-4">
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h2 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Documents</h2>
            </div>

            <div class="grid grid-cols-2 gap-4">
              <button
                type="button"
                (click)="handleDocumentClick('license')"
                class="bg-white rounded-[2rem] border border-slate-100 shadow-sm p-6 text-center transition-all hover:shadow-xl hover:shadow-blue-100/30 hover:-translate-y-0.5 active:scale-[0.98] text-slate-900 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:shadow-sm disabled:hover:-translate-y-0"
              >
                <div class="w-14 h-14 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto mb-4 border border-blue-100 shadow-sm">
                  <ion-icon name="card-outline" class="text-2xl text-blue-600"></ion-icon>
                </div>

                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
                  {{ isReadOnly() ? 'View' : 'Upload' }}
                </p>
                <h4 class="font-display font-bold text-slate-900 text-base mb-3">Driver’s License</h4>

                @if (docs().license) {
                  <app-badge variant="success">
                    {{ isReadOnly() ? 'Open File' : 'Uploaded' }}
                  </app-badge>
                } @else {
                  <p class="text-xs text-slate-600 font-medium">
                    {{ isReadOnly() ? 'No document saved' : 'Tap to select file' }}
                  </p>
                }
              </button>

              <button
                type="button"
                (click)="handleDocumentClick('insurance')"
                class="bg-white rounded-[2rem] border border-slate-100 shadow-sm p-6 text-center transition-all hover:shadow-xl hover:shadow-emerald-100/30 hover:-translate-y-0.5 active:scale-[0.98] text-slate-900 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:shadow-sm disabled:hover:-translate-y-0"
              >
                <div class="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-4 border border-emerald-100 shadow-sm">
                  <ion-icon name="shield-checkmark-outline" class="text-2xl text-emerald-600"></ion-icon>
                </div>

                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
                  {{ isReadOnly() ? 'View' : 'Upload' }}
                </p>
                <h4 class="font-display font-bold text-slate-900 text-base mb-3">Insurance</h4>

                @if (docs().insurance) {
                  <app-badge variant="success">
                    {{ isReadOnly() ? 'Open File' : 'Uploaded' }}
                  </app-badge>
                } @else {
                  <p class="text-xs text-slate-600 font-medium">
                    {{ isReadOnly() ? 'No document saved' : 'Tap to select file' }}
                  </p>
                }
              </button>
            </div>
          </section>

          <section class="space-y-4">
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h2 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Checklist</h2>
            </div>

            <div class="bg-white rounded-[2.25rem] border border-slate-100 shadow-sm p-5 space-y-4">
              <div class="flex items-center justify-between">
                <span class="text-sm font-semibold text-slate-700">Vehicle details added</span>
                <app-badge [variant]="onboardingForm.valid ? 'success' : 'warning'">
                  {{ onboardingForm.valid ? 'Ready' : 'Pending' }}
                </app-badge>
              </div>

              <div class="flex items-center justify-between">
                <span class="text-sm font-semibold text-slate-700">Driver’s license uploaded</span>
                <app-badge [variant]="docs().license ? 'success' : 'warning'">
                  {{ docs().license ? 'Uploaded' : 'Pending' }}
                </app-badge>
              </div>

              <div class="flex items-center justify-between">
                <span class="text-sm font-semibold text-slate-700">Insurance uploaded</span>
                <app-badge [variant]="docs().insurance ? 'success' : 'warning'">
                  {{ docs().insurance ? 'Uploaded' : 'Pending' }}
                </app-badge>
              </div>

              <div class="flex items-center justify-between">
                <span class="text-sm font-semibold text-slate-700">Stripe Connect completed</span>
                <app-badge [variant]="isStripeReady() ? 'success' : 'warning'">
                  {{ isStripeReady() ? 'Connected' : 'Pending' }}
                </app-badge>
              </div>
            </div>
          </section>

          <div class="pt-4">
            @if (!isReadOnly()) {
              <app-button
                type="submit"
                class="w-full shadow-xl shadow-blue-600/15"
                [disabled]="!onboardingForm.valid || !docs().license || !docs().insurance"
              >
                {{ isActionRequired() ? 'Resubmit for Verification' : 'Submit for Verification' }}
              </app-button>

              <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest text-center mt-6 px-8 leading-relaxed">
                By submitting, you agree to our terms of service and driver agreement.
              </p>
            } @else {
              <app-button variant="outline" class="w-full" (clicked)="router.navigate(['/driver'])">
                Back to Driver Hub
              </app-button>

              <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest text-center mt-6 px-8 leading-relaxed">
                Editing is disabled while your application is under review.
              </p>
            }
          </div>
        </form>
      </div>
    </ion-content>
  `,
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
        IonSpinner,
        CardComponent,
        ButtonComponent,
        BadgeComponent
    ]
})
export class OnboardingPage implements OnInit {
    private fb = inject(FormBuilder);
    private driverService = inject(DriverService);
    public authService = inject(AuthService);
    private profileService = inject(ProfileService);
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);
    private route = inject(ActivatedRoute);
    public router = inject(Router);

    private readonly draftKey = 'driver_onboarding_draft_v1';

    onboardingForm: FormGroup;
    docs = signal<{ license?: string; insurance?: string }>({});
    stripeMessage = signal<string | null>(null);
    stripeMessageType = signal<'success' | 'warning'>('success');

    stripeAccount = this.driverService.stripeAccount;
    profile = this.profileService.profile;
    vehicle = this.driverService.vehicle;

    verificationStatus = computed<'draft' | 'under_review' | 'action_required' | 'approved'>(() => {
        const profile = this.profile() as DriverProfile | null;

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
        const profile = this.profile() as DriverProfile | null;
        return profile?.verification_notes ?? null;
    });

    isStripeReady = computed(() => {
        const account = this.stripeAccount();
        return !!(account?.onboarding_complete && account?.charges_enabled && account?.payouts_enabled);
    });

    isStripePending = computed(() => {
        const account = this.stripeAccount();
        return !!(account?.stripe_account_id && !this.isStripeReady());
    });

    isReadOnly = computed(() => this.verificationStatus() === 'under_review');
    isActionRequired = computed(() => this.verificationStatus() === 'action_required');

    constructor() {
        addIcons({
            personAddOutline,
            optionsOutline,
            cardOutline,
            shieldCheckmarkOutline,
            chevronBackOutline,
            carSportOutline,
            documentTextOutline,
            checkmarkCircleOutline,
            sparklesOutline,
            cashOutline,
            alertCircleOutline,
            arrowForwardOutline,
            lockClosedOutline,
            eyeOutline
        });

        this.onboardingForm = this.fb.group({
            make: ['', Validators.required],
            model: ['', Validators.required],
            year: [new Date().getFullYear(), [Validators.required, Validators.min(1900)]],
            license_plate: ['', Validators.required],

            council_name: ['', Validators.required],
            council_license_number: ['', Validators.required],
            taxi_badge_number: ['', Validators.required],
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
        this.onboardingForm.valueChanges.subscribe(() => {
            if (!this.isReadOnly()) {
                this.saveDraft();
            }
        });
    }

    private saveDraft() {
        if (this.isReadOnly()) return;

        const draft = {
            form: this.onboardingForm.getRawValue(),
            docs: this.docs()
        };

        localStorage.setItem(this.draftKey, JSON.stringify(draft));
    }

    private restoreDraft() {
        const raw = localStorage.getItem(this.draftKey);
        if (!raw) return;

        try {
            const draft = JSON.parse(raw);

            if (draft?.form) {
                this.onboardingForm.patchValue(
                    {
                        make: draft.form.make ?? '',
                        model: draft.form.model ?? '',
                        year: draft.form.year ?? new Date().getFullYear(),
                        license_plate: draft.form.license_plate ?? ''
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
        } catch (error) {
            console.error('Failed to restore onboarding draft', error);
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

        const profile = this.profile() as DriverProfile | null;
        if (profile) {
            this.docs.set({
                license: profile.driver_license_url ?? this.docs().license,
                insurance: profile.insurance_url ?? this.docs().insurance
            });
        }
    }

    private applyReadOnlyState() {
        if (this.isReadOnly()) {
            this.onboardingForm.disable({ emitEvent: false });
        } else {
            this.onboardingForm.enable({ emitEvent: false });
        }
    }

    handleDocumentClick(type: 'license' | 'insurance') {
        if (this.isReadOnly()) {
            this.openDocument(type);
            return;
        }

        this.upload(type);
    }

    async openDocument(type: 'license' | 'insurance') {
        const path = this.docs()[type];

        if (!path) {
            const toast = await this.toastCtrl.create({
                message: 'No document available to open.',
                duration: 2200,
                color: 'warning'
            });
            await toast.present();
            return;
        }

        const url = await this.getDocumentUrl(path);

        if (!url) {
            const toast = await this.toastCtrl.create({
                message: 'Unable to open this document right now.',
                duration: 2500,
                color: 'danger'
            });
            await toast.present();
            return;
        }

        window.open(url, '_blank', 'noopener,noreferrer');
    }

    async getDocumentUrl(path: string): Promise<string | null> {
        return this.driverService.getDocumentSignedUrl(path);
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
                this.stripeMessageType.set('success');
                this.stripeMessage.set('Your Stripe onboarding was completed successfully. You can continue finishing your driver setup.');
            }

            if (stripe === 'refresh') {
                this.stripeMessageType.set('warning');
                this.stripeMessage.set('Stripe needs a little more information. Tap the payout button below to continue setup.');
            }
        } catch (error) {
            console.error('Stripe return handling failed', error);
            this.stripeMessageType.set('warning');
            this.stripeMessage.set('Stripe setup returned, but we could not refresh your payout status yet. Please try again in a moment.');
        } finally {
            this.router.navigate([], {
                relativeTo: this.route,
                queryParams: {},
                replaceUrl: true
            });
        }
    }

    async upload(type: 'license' | 'insurance') {
        if (this.isReadOnly()) {
            const toast = await this.toastCtrl.create({
                message: 'Documents cannot be changed while verification is in progress.',
                duration: 2500,
                color: 'warning'
            });
            await toast.present();
            return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/jpeg,image/png,image/webp,application/pdf';

        input.onchange = async (e: Event) => {
            const target = e.target as HTMLInputElement;
            const file = target.files?.[0];

            if (!file) return;

            const loading = await this.loadingCtrl.create({ message: 'Uploading...' });
            await loading.present();

            try {
                const path = await this.driverService.uploadDocument(file, type);
                this.docs.update(d => ({ ...d, [type]: path }));
                this.saveDraft();

                await loading.dismiss();

                const toast = await this.toastCtrl.create({
                    message: `${type === 'license' ? 'Driver’s license' : 'Insurance'} uploaded successfully.`,
                    duration: 2200,
                    color: 'success'
                });
                await toast.present();
            } catch (error: unknown) {
                await loading.dismiss();

                const message = error instanceof Error ? error.message : 'Upload failed';

                const toast = await this.toastCtrl.create({
                    message,
                    duration: 2500,
                    color: 'danger'
                });
                await toast.present();
            }
        };

        input.click();
    }

    async submit() {
        if (this.isReadOnly()) {
            const toast = await this.toastCtrl.create({
                message: 'Your application is already under review.',
                duration: 2500,
                color: 'warning'
            });
            await toast.present();
            return;
        }

        const loading = await this.loadingCtrl.create({ message: 'Saving details...' });
        await loading.present();

        try {
            await this.driverService.updateVehicle(this.onboardingForm.value);

            const user = this.authService.currentUser();
            if (user) {
                await this.profileService.updateProfile(user.id, {
                    onboarding_completed: true,
                    role: 'driver',

                    council_name: this.onboardingForm.value.council_name,
                    council_license_number: this.onboardingForm.value.council_license_number,
                    taxi_badge_number: this.onboardingForm.value.taxi_badge_number,
                    taxi_license_expiry: this.onboardingForm.value.taxi_license_expiry,

                    driver_license_url: this.docs().license || null,
                    insurance_url: this.docs().insurance || null,
                    verification_status: 'under_review',
                    verification_notes: null,
                    verification_items: null,
                    is_verified: false
                } as any);

                if (typeof (this.profileService as any).fetchProfile === 'function') {
                    await (this.profileService as any).fetchProfile();
                }

                this.authService.onboardingCompleted.set(true);
                this.authService.userRole.set('driver');
            }

            await loading.dismiss();

            const toast = await this.toastCtrl.create({
                message: this.isActionRequired()
                    ? 'Details updated and resubmitted for verification.'
                    : 'Application submitted! We will verify your documents shortly.',
                duration: 3000,
                color: 'success'
            });
            await toast.present();

            this.clearDraft();
            await this.authService.handlePostAuthRedirect();
        } catch (err: unknown) {
            await loading.dismiss();

            const message = err instanceof Error ? err.message : 'An error occurred';
            const toast = await this.toastCtrl.create({
                message,
                duration: 3000,
                color: 'danger'
            });
            await toast.present();
        }
    }

    async setupPayouts() {
        if (this.isReadOnly()) {
            const toast = await this.toastCtrl.create({
                message: 'Payout setup is locked while verification is in progress.',
                duration: 2500,
                color: 'warning'
            });
            await toast.present();
            return;
        }

        const loading = await this.loadingCtrl.create({ message: 'Loading payout settings...' });
        await loading.present();

        try {
            this.saveDraft();
            const url = await this.driverService.setupStripeConnect();
            window.location.href = url;
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