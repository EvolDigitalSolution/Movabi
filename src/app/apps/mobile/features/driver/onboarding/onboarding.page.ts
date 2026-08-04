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
    IonRefresher,
    IonRefresherContent,
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
    bicycleOutline,
    busOutline,
    peopleOutline,
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
import { StorageUploadService } from '@core/services/storage/storage-upload.service';
import { AppConfigService } from '@core/services/config/app-config.service';
import { DriverOnboardingStatusService } from '@core/services/driver/driver-onboarding-status.service';
import { DriverProfile, Vehicle } from '@shared/models/booking.model';
import { ButtonComponent, BadgeComponent } from '@shared/ui';
import {
    getBlockingRequirements,
    getVehiclePlateValue,
    isRideSelected as engineRideSelected,
    normaliseSelectedServices,
    normaliseVehicleClass,
    vehicleRequiresRegistration
} from '@shared/verification/driver-requirements.engine';

type DocumentType = 'license' | 'insurance';
type StripeMessageType = 'success' | 'warning';
type DriverVehicleClass = 'bike' | 'standard' | 'xl' | 'small_van' | 'large_van';
type DriverServiceSelection = 'ride' | 'errand' | 'delivery' | 'van';

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
        IonRefresher,
        IonRefresherContent,
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
      <ion-refresher slot="fixed" (ionRefresh)="pullToRefresh($event)"><ion-refresher-content></ion-refresher-content></ion-refresher>
      <div class="w-full max-w-xl mx-auto px-3 py-4 space-y-6 pb-24 overflow-x-hidden">
        <div class="relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 p-6 shadow-2xl shadow-slate-900/20 text-white">
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

            <h1 class="text-3xl font-display font-black mb-3 tracking-tight" style="color: #ffffff;">
              {{ pageTitle() }}
            </h1>

            <p class="font-medium leading-relaxed max-w-sm mx-auto text-sm" style="color: #dbe4f0;">
              {{ pageDescription() }}
            </p>
          </div>
        </div>

        <section class="rounded-[1.75rem] border border-slate-200 bg-white p-5 shadow-sm">
          <div class="flex items-center justify-between gap-3"><h2 class="font-display font-black text-slate-950">Outstanding Requests</h2><button type="button" class="text-xs font-bold text-blue-600" (click)="refreshOnboardingStatus()">Refresh</button></div>
          @if (onboardingStatus.loading()) { <p class="mt-3 text-sm text-slate-500">Loading requests…</p> }
          @else if (onboardingStatus.error()) { <p class="mt-3 text-sm font-semibold text-rose-600">{{ onboardingStatus.error() }}</p> }
          @else if (!onboardingStatus.state()?.outstandingRequests?.length) { <p class="mt-3 text-sm text-slate-500">No outstanding requests.</p> }
          @else { <div class="mt-3 space-y-3">@for (request of onboardingStatus.state()!.outstandingRequests; track request.id) {
            <div class="rounded-xl border border-slate-100 p-3"><div class="flex justify-between gap-2"><span class="text-sm font-bold text-slate-900">{{request.item}}</span><app-badge [variant]="request.status === 'approved' ? 'success' : request.status === 'rejected' ? 'warning' : 'secondary'">{{request.status}}</app-badge></div>
            @if(request.adminMessage){<p class="mt-2 text-xs text-slate-600">{{request.adminMessage}}</p>}<p class="mt-2 text-xs font-semibold text-slate-500">{{request.nextAction}}</p></div>
          }</div> }
        </section>

        @if (isActionRequired()) {
          <div class="rounded-[1.75rem] border border-rose-100 bg-rose-50 p-5 shadow-sm">
            <div class="flex items-start gap-3">
              <div class="w-10 h-10 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                <ion-icon name="alert-circle-outline" class="text-xl"></ion-icon>
              </div>

              <div class="min-w-0">
                <h3 class="font-display font-black text-slate-950">Action required</h3>
                <p class="text-sm text-slate-600 font-medium leading-relaxed mt-1">
                  Your verification needs more information. Please update the items below and resubmit.
                </p>

                @if (verificationNotes()) {
                  <div class="mt-3 rounded-xl bg-white border border-rose-100 p-3 text-sm text-slate-700">
                    {{ verificationNotes() }}
                  </div>
                }

                @if (reviewBlockers().length) {
                  <ul class="mt-3 rounded-xl bg-white border border-rose-100 p-3 space-y-2">
                    @for (blocker of reviewBlockers(); track blocker) {
                      <li class="text-sm text-rose-900 font-semibold leading-relaxed">• {{ blocker }}</li>
                    }
                  </ul>
                }

                <div class="grid sm:grid-cols-3 gap-2 mt-4">
                  <button type="button" class="rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-800 border border-rose-100" (click)="scrollToSetup()">
                    Update Details
                  </button>
                  <button type="button" class="rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-800 border border-rose-100" (click)="scrollToDocuments()">
                    Upload Documents
                  </button>
                  <button type="button" class="rounded-xl bg-rose-600 px-3 py-2 text-xs font-bold text-white" (click)="submit()">
                    Resubmit for Review
                  </button>
                </div>
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
              <h2 class="text-xs font-black text-slate-400 uppercase tracking-[0.18em]">Profile Photo</h2>
            </div>

            <div class="bg-white rounded-[1.85rem] border border-slate-100 shadow-sm p-5">
              <div class="flex items-center gap-4">
                <div class="w-20 h-20 rounded-[1.65rem] overflow-hidden bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400 shrink-0">
                  @if (driverPhotoUrl()) {
                    <img [src]="driverPhotoUrl()" alt="Driver photo" class="w-full h-full object-cover" />
                  } @else {
                    <ion-icon name="person-add-outline" class="text-4xl"></ion-icon>
                  }
                </div>

                <div class="min-w-0 flex-1">
                  <h3 class="font-display font-black text-slate-950">Customer trust photo</h3>
                  <p class="text-sm text-slate-600 font-semibold leading-relaxed mt-1">
                    Customers see this while waiting for you. Use a clear photo of your face.
                  </p>
                </div>
              </div>

              <div class="mt-4">
                <app-button variant="secondary" size="sm" class="w-full" [disabled]="isReadOnly()" (clicked)="uploadDriverPhoto()">
                  {{ driverPhotoUrl() ? 'Change Photo' : 'Upload Photo' }}
                </app-button>
              </div>
            </div>
          </section>

          <section class="space-y-4" data-driver-documents>
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h2 class="text-xs font-black text-slate-400 uppercase tracking-[0.18em]">Personal Details</h2>
            </div>

            <div class="bg-white rounded-[1.85rem] border border-slate-100 shadow-sm overflow-hidden">
              <div class="p-5 border-b border-slate-50">
                <div class="flex items-center gap-3">
                  <div class="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center border border-amber-100">
                    <ion-icon name="card-outline" class="text-2xl"></ion-icon>
                  </div>
                  <div>
                    <h3 class="font-display font-black text-slate-950">Personal details</h3>
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Used for verification and payouts</p>
                  </div>
                </div>
              </div>

              <div class="p-4 space-y-3">
                <div>
                  <label for="full_name" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Full Legal Name</label>
                  <input id="full_name" type="text" formControlName="full_name" placeholder="Your legal name" [readonly]="isReadOnly()" [class]="fieldInputClass()">
                </div>

                <div>
                  <label for="email" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Email</label>
                  <input id="email" type="email" formControlName="email" placeholder="Email from your sign in" readonly [class]="fieldInputClass() + ' bg-slate-50 text-slate-500'">
                  <p class="mt-1 text-[11px] font-semibold text-slate-500">We use your signed-in email for driver verification.</p>
                </div>

                <div>
                  <label for="phone" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Mobile Number</label>
                  <input id="phone" type="tel" formControlName="phone" placeholder="e.g. 07898 473 840" [readonly]="isReadOnly()" [class]="fieldInputClass()">
                </div>

                <div>
                  <label for="date_of_birth" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Date of Birth</label>
                  <input id="date_of_birth" type="date" formControlName="date_of_birth" [readonly]="isReadOnly()" [class]="fieldInputClass()">
                </div>

                <p class="text-xs font-semibold text-slate-500">
                  These details keep your account review accurate. Stripe may also require them before Movabi Pay activation.
                </p>
              </div>
            </div>
          </section>

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
                <div class="p-4 space-y-3">
                  <div>
                    <p class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Vehicle Class</p>
                    <p class="text-xs font-semibold text-slate-500">Choose the vehicle you will use.</p>
                  </div>

                  <div class="grid grid-cols-2 gap-3">
                    @for (option of vehicleClassOptions; track option.id) {
                      <button
                        type="button"
                        (click)="setVehicleClass(option.id)"
                        [disabled]="isReadOnly()"
                        [class.bg-blue-600]="onboardingForm.get('vehicle_class')?.value === option.id"
                        [class.text-white]="onboardingForm.get('vehicle_class')?.value === option.id"
                        [class.border-blue-600]="onboardingForm.get('vehicle_class')?.value === option.id"
                        [class.bg-slate-50]="onboardingForm.get('vehicle_class')?.value !== option.id"
                        [class.text-slate-700]="onboardingForm.get('vehicle_class')?.value !== option.id"
                        class="min-h-[92px] rounded-2xl border border-slate-100 p-3 text-left transition-all active:scale-95 disabled:opacity-60"
                      >
                        <div class="flex items-center gap-3">
                          <ion-icon [name]="option.icon" class="text-xl shrink-0"></ion-icon>
                          <div class="min-w-0">
                            <p class="text-sm font-black">{{ option.label }}</p>
                            <p class="text-[10px] font-bold opacity-80 leading-tight">{{ option.helper }}</p>
                          </div>
                        </div>
                      </button>
                    }
                  </div>
                </div>

                <div class="p-4 space-y-3">
                  <div>
                    <p class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Services You Want To Accept</p>
                    <p class="text-xs font-semibold text-slate-500">Choose the type of work you want to receive.</p>
                  </div>

                  <div class="grid grid-cols-2 gap-3">
                    @for (option of availableServiceOptions(); track option.id) {
                      <button
                        type="button"
                        (click)="toggleServiceType(option.id)"
                        [disabled]="isReadOnly()"
                        [class.bg-amber-500]="isServiceSelected(option.id)"
                        [class.text-slate-950]="isServiceSelected(option.id)"
                        [class.border-amber-500]="isServiceSelected(option.id)"
                        [class.bg-slate-50]="!isServiceSelected(option.id)"
                        [class.text-slate-700]="!isServiceSelected(option.id)"
                        class="min-h-[82px] rounded-2xl border border-slate-100 p-3 text-left transition-all active:scale-95 disabled:opacity-60"
                      >
                        <div class="flex items-center gap-3">
                          <ion-icon [name]="option.icon" class="text-xl shrink-0"></ion-icon>
                          <div class="min-w-0">
                            <p class="text-sm font-black">{{ option.label }}</p>
                            <p class="text-[10px] font-bold opacity-80 leading-tight">{{ option.helper }}</p>
                          </div>
                        </div>
                      </button>
                    }
                  </div>
                </div>

                <div class="p-4">
                  <div class="rounded-2xl border border-amber-100 bg-amber-50 p-4">
                    <div class="flex items-start gap-3">
                      <div class="w-10 h-10 rounded-xl bg-white text-amber-600 border border-amber-100 flex items-center justify-center shrink-0">
                        <ion-icon [name]="isBikeVehicle() ? 'bicycle-outline' : 'car-sport-outline'"></ion-icon>
                      </div>
                      <div>
                        <p class="text-sm font-black text-slate-950">{{ vehicleSetupTitle() }}</p>
                        <p class="mt-1 text-xs font-semibold text-slate-600 leading-relaxed">{{ vehicleSetupMessage() }}</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="p-4">
                  <label for="make" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{{ vehicleMakeLabel() }}</label>
                  <input id="make" formControlName="make" [placeholder]="vehicleMakePlaceholder()" [readonly]="isReadOnly()" [class]="fieldInputClass()">
                </div>

                <div class="p-4">
                  <label for="model" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{{ vehicleModelLabel() }}</label>
                  <input id="model" formControlName="model" [placeholder]="vehicleModelPlaceholder()" [readonly]="isReadOnly()" [class]="fieldInputClass()">
                </div>

                <div class="p-4">
                  <label for="color" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{{ vehicleColorLabel() }}</label>
                  <input id="color" formControlName="color" [placeholder]="vehicleColorPlaceholder()" [readonly]="isReadOnly()" [class]="fieldInputClass()">
                </div>

                <div class="p-4">
                  <label for="year" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{{ vehicleYearLabel() }}</label>
                  <input id="year" type="number" formControlName="year" [placeholder]="vehicleYearPlaceholder()" [readonly]="isReadOnly()" [class]="fieldInputClass()">
                </div>

                @if (!isBikeVehicle()) {
                  <div class="p-4">
                    <div class="flex items-center justify-between gap-3 mb-1">
                      <label for="license_plate" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest">License Plate</label>
                      @if (appConfig.vehiclePlateLookupEnabled()) {
                        <button
                          type="button"
                          (click)="lookupVehicleByPlate()"
                          [disabled]="isReadOnly()"
                          class="text-[10px] font-black uppercase tracking-widest text-amber-600 disabled:text-slate-300"
                        >
                          Find details
                        </button>
                      }
                    </div>
                    <input id="license_plate" formControlName="license_plate" placeholder="e.g. AB12 CDE" [readonly]="isReadOnly()" (blur)="normalizePlate()" [class]="fieldInputClass() + ' uppercase'">
                    @if (appConfig.vehiclePlateLookupEnabled()) {
                      <p class="mt-2 text-xs font-semibold text-slate-500">
                        Use your plate to help confirm make, colour, and model where lookup is configured.
                      </p>
                    }
                  </div>
                }

              </div>
            </div>
          </section>

          @if (requiresTaxiLicence()) {
          <section class="space-y-4">
            <div class="flex items-center gap-3 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
                  <h2 class="text-xs font-black text-slate-400 uppercase tracking-[0.18em]">Passenger Ride Approval</h2>
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
                  <input id="council_name" formControlName="council_name" placeholder="e.g. Oldham Council" [readonly]="isReadOnly()" [class]="fieldInputClass()">
                </div>

                <div class="p-4">
                  <label for="council_license_number" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Council Licence Number</label>
                  <input id="council_license_number" formControlName="council_license_number" placeholder="e.g. PHV/123456" [readonly]="isReadOnly()" [class]="fieldInputClass()">
                </div>

                <div class="p-4">
                  <label for="taxi_badge_number" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Taxi Badge Number</label>
                  <input id="taxi_badge_number" formControlName="taxi_badge_number" placeholder="e.g. BADGE-1234" [readonly]="isReadOnly()" [class]="fieldInputClass()">
                </div>

                <div class="p-4">
                  <label for="taxi_license_expiry" class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Taxi Licence Expiry Date</label>
                  <input id="taxi_license_expiry" type="date" formControlName="taxi_license_expiry" [readonly]="isReadOnly()" [class]="fieldInputClass()">
                </div>
              </div>
            </div>
          </section>
          }

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
                <h4 class="font-display font-black text-slate-950 text-sm mb-3">{{ primaryDocumentLabel() }}</h4>

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
                <h4 class="font-display font-black text-slate-950 text-sm mb-3">{{ secondaryDocumentLabel() }}</h4>

                @if (docs().insurance) {
                  <app-badge variant="success">{{ isReadOnly() ? 'Open File' : 'Uploaded' }}</app-badge>
                } @else {
                  <p class="text-xs text-slate-500 font-semibold">{{ secondaryDocumentPendingLabel() }}</p>
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
                <span class="text-sm font-semibold text-slate-700">{{ vehicleChecklistLabel() }}</span>
                <app-badge [variant]="activeVehicleDetailsReady() ? 'success' : 'warning'">
                  {{ activeVehicleDetailsReady() ? 'Ready' : 'Pending' }}
                </app-badge>
              </div>

              <div class="flex items-center justify-between gap-3">
                <span class="text-sm font-semibold text-slate-700">{{ primaryDocumentLabel() }} uploaded</span>
                <app-badge [variant]="docs().license ? 'success' : 'warning'">
                  {{ docs().license ? 'Uploaded' : 'Pending' }}
                </app-badge>
              </div>

              <div class="flex items-center justify-between gap-3">
                <span class="text-sm font-semibold text-slate-700">{{ secondaryDocumentLabel() }}</span>
                <app-badge [variant]="secondaryDocumentReady() ? 'success' : 'warning'">
                  {{ secondaryDocumentReady() ? secondaryDocumentReadyLabel() : secondaryDocumentPendingLabel() }}
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
                [disabled]="submitting()"
              >
                {{ submitting() ? 'Submitting...' : (isActionRequired() ? 'Resubmit for Manual Review' : 'Submit for Manual Review') }}
              </app-button>

              @if (!canSubmit()) {
                <p class="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-2xl p-4 mt-4 font-semibold leading-relaxed">
                  {{ setupBlockingMessage() }}
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
    private storageUpload = inject(StorageUploadService);
    public appConfig = inject(AppConfigService);
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);
    private route = inject(ActivatedRoute);
    public router = inject(Router);
    readonly onboardingStatus = inject(DriverOnboardingStatusService);

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

    driverPhotoUrl = computed(() => {
        const profile = this.profile() as DriverProfile | null;
        return profile?.avatar_url || null;
    });

    vehicleClassOptions: Array<{ id: DriverVehicleClass; label: string; helper: string; icon: string }> = [
        { id: 'bike', label: 'Bike', helper: 'Your bicycle, e-bike, scooter, or motorcycle', icon: 'bicycle-outline' },
        { id: 'standard', label: 'Car', helper: 'Standard car for local work', icon: 'car-sport-outline' },
        { id: 'xl', label: 'XL / 7 Seater', helper: 'Larger car with 5-7 seats', icon: 'people-outline' },
        { id: 'small_van', label: 'Small Van', helper: 'Small van for parcels and light moves', icon: 'bus-outline' },
        { id: 'large_van', label: 'Large Van', helper: 'Large van for bulky delivery and moves', icon: 'bus-outline' }
    ];

    serviceOptions: Array<{ id: DriverServiceSelection; label: string; helper: string; icon: string }> = [
        { id: 'ride', label: 'Ride / Passenger', helper: 'Passenger trips only after taxi/private hire approval', icon: 'people-outline' },
        { id: 'errand', label: 'Shop', helper: 'Collect, deliver, or shop for customers', icon: 'options-outline' },
        { id: 'delivery', label: 'Deliver', helper: 'Small parcels and local deliveries', icon: 'document-attach-outline' },
        { id: 'van', label: 'Move', helper: 'Moving and bulky transport jobs', icon: 'bus-outline' }
    ];

    verificationStatus = computed<'draft' | 'under_review' | 'action_required' | 'approved'>(() => {
        const profile = this.profile() as DriverProfile | null;

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
        const profile = this.profile() as DriverProfile | null;
        return profile?.driver_review_notes ?? profile?.verification_notes ?? null;
    });

    reviewBlockers = computed(() => {
        const profile = this.profile() as DriverProfile | null;
        const vehicle = this.vehicle() as Vehicle | null;
        const selectedServices = normaliseSelectedServices(profile, vehicle);
        const authUser = this.authService.currentUser();
        const engineBlockers = getBlockingRequirements({
            countryCode: (profile as any)?.country_code || (profile as any)?.country,
            driver: { ...(profile || {}), auth_email: authUser?.email, user: authUser },
            vehicle,
            documents: { ...(profile || {}), ...(vehicle || {}) },
            selectedServices
        }).map(requirement => requirement.message);

        return this.filterResolvedBlockers([
            ...this.parseStringList(profile?.driver_review_blockers ?? profile?.verification_blockers),
            ...engineBlockers
        ], profile, vehicle, selectedServices);
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
            this.activeVehicleDetailsReady() &&
            !!this.docs().license &&
            this.secondaryDocumentReady() &&
            this.isStripeReady() &&
            !this.isReadOnly() &&
            !this.submitting()
        );
    });

    activeVehicleDetailsReady = computed(() => {
        const vehicle = this.vehicle() as Vehicle | null;
        console.log('[DriverOnboarding] Checklist vehicle:', vehicle);

        return this.activeVehicleControls().every(controlName => this.isActiveVehicleControlReady(controlName, vehicle));
    });

    setupBlockingMessage = computed(() => {
        if (!this.activeVehicleDetailsReady()) {
            const invalid = this.activeVehicleControls().filter(controlName => this.onboardingForm.get(controlName)?.invalid);
            const hiddenInvalid = Object.keys(this.onboardingForm.controls).filter(controlName => !this.activeVehicleControls().includes(controlName) && this.onboardingForm.get(controlName)?.invalid);

            if (hiddenInvalid.length) {
                console.warn('[DriverOnboarding] Ignoring hidden invalid controls for selected vehicle class:', hiddenInvalid);
            }

            if (invalid.some(controlName => ['make', 'model', 'color', 'year'].includes(controlName))) {
                return this.isBikeVehicle()
                    ? 'Complete your bike brand, type, colour, and year before submitting.'
                    : 'Complete your vehicle make, model, colour, and year before submitting.';
            }

            if (invalid.includes('license_plate')) return 'Add the vehicle registration plate before submitting.';

            if (invalid.some(controlName => ['council_name', 'council_license_number', 'taxi_badge_number', 'taxi_license_expiry'].includes(controlName))) {
                return 'Complete the council taxi licence details before submitting.';
            }

            return this.isBikeVehicle()
                ? 'Complete the visible bike setup fields before submitting.'
                : 'Complete the visible vehicle setup fields before submitting.';
        }

        if (!this.docs().license) return `Upload your ${this.primaryDocumentLabel().toLowerCase()} before submitting.`;
        if (!this.secondaryDocumentReady()) return `Upload your ${this.secondaryDocumentLabel().toLowerCase()} before submitting.`;
        if (!this.isStripeReady()) return 'Complete Stripe Connect before submitting.';
        return 'Complete the remaining required setup before submitting.';
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
            bicycleOutline,
            busOutline,
            peopleOutline,
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
            full_name: [''],
            email: [''],
            phone: [''],
            date_of_birth: [''],
            make: ['', [Validators.required, Validators.minLength(2)]],
            model: ['', [Validators.required, Validators.minLength(1)]],
            color: ['', [Validators.required, Validators.minLength(2)]],
            year: [
                new Date().getFullYear(),
                [Validators.required, Validators.min(1900), Validators.max(new Date().getFullYear() + 1)]
            ],
            license_plate: ['', [Validators.required, Validators.minLength(2)]],
            vehicle_class: ['standard', Validators.required],
            service_types: [['errand', 'delivery'] as DriverServiceSelection[], Validators.required],
            council_name: ['', [Validators.required, Validators.minLength(2)]],
            council_license_number: ['', [Validators.required, Validators.minLength(2)]],
            taxi_badge_number: ['', [Validators.required, Validators.minLength(2)]],
            taxi_license_expiry: ['', Validators.required]
        });

        this.applyVehicleClassRules('standard');
    }

    async ngOnInit() {
        try {
            await this.onboardingStatus.refresh();
            await this.onboardingStatus.recordRegistrationStartOnce();
        } catch (error) {
            await this.showToast(error instanceof Error?error.message:'Driver onboarding is not available in this area yet.','warning');
            await this.router.navigate(['/driver'],{replaceUrl:true});
            return;
        }
        this.restoreDraft();

        await this.driverService.fetchStripeAccount();
        await this.driverService.fetchVehicle();
        this.loadExistingData();

        await this.handleStripeReturn();

        this.applyReadOnlyState();
        this.applyVehicleClassRules(this.selectedVehicleClass());
        this.watchVehicleClassChanges();
        this.watchDraftChanges();
    }

    async refreshOnboardingStatus(): Promise<void> { try { await this.onboardingStatus.refresh(); } catch { /* state exposes the error */ } }
    async pullToRefresh(event: CustomEvent): Promise<void> { await this.refreshOnboardingStatus(); await (event.target as HTMLIonRefresherElement).complete(); }

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

    private watchVehicleClassChanges() {
        this.onboardingForm.get('vehicle_class')?.valueChanges
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((value) => this.applyVehicleClassRules(String(value || 'standard') as DriverVehicleClass));
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
                        color: draft.form['color'] ?? '',
                        year: draft.form['year'] ?? new Date().getFullYear(),
                        license_plate: draft.form['license_plate'] ?? '',
                        vehicle_class: draft.form['vehicle_class'] ?? 'standard',
                        service_types: this.normaliseServiceTypes(draft.form['service_types'], draft.form['vehicle_class'] as DriverVehicleClass),
                        council_name: draft.form['council_name'] ?? '',
                        council_license_number: draft.form['council_license_number'] ?? '',
                        taxi_badge_number: draft.form['taxi_badge_number'] ?? '',
                        taxi_license_expiry: draft.form['taxi_license_expiry'] ?? '',
                        phone: draft.form['phone'] ?? ''
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
                    color: vehicle.color ?? '',
                    year: vehicle.year ?? new Date().getFullYear(),
                    license_plate: vehicle.license_plate ?? '',
                    vehicle_class: this.vehicleClassFromVehicle(vehicle),
                    service_types: this.normaliseServiceTypes((vehicle as any).service_eligibility, this.vehicleClassFromVehicle(vehicle))
                },
                { emitEvent: false }
            );
        }

        const profile = this.profile() as DriverProfile | any | null;
        const user = this.authService.currentUser();

        if (profile) {
            const verificationItems = this.parseVerificationItems(profile.verification_items);
            const profileWithVerificationItems = { ...verificationItems, ...profile };

            this.onboardingForm.patchValue(
                {
                    full_name: profile.full_name ?? profile.legal_name ?? profile.name ?? user?.user_metadata?.['full_name'] ?? '',
                    email: profile.email ?? user?.email ?? '',
                    council_name: this.firstProfileValue(profileWithVerificationItems, ['council_name', 'councilName', 'licensing_authority', 'private_hire_authority', 'council_license_authority']),
                    council_license_number: this.firstProfileValue(profileWithVerificationItems, ['council_license_number', 'councilLicenceNumber', 'council_licence_number', 'private_hire_license_number', 'private_hire_licence_number']),
                    taxi_badge_number: this.firstProfileValue(profileWithVerificationItems, ['taxi_badge_number', 'taxiBadgeNumber', 'badge_number', 'driver_badge_number']),
                    taxi_license_expiry: this.firstProfileValue(profileWithVerificationItems, ['taxi_license_expiry', 'taxiLicenceExpiry', 'taxi_licence_expiry', 'private_hire_license_expiry', 'private_hire_licence_expiry']),
                    service_types: this.normaliseServiceTypes(verificationItems['driver_service_types'], this.selectedVehicleClass()),
                    phone: profile.phone ?? profile.phone_number ?? profile.mobile ?? profile.contact_phone ?? '',
                    date_of_birth: this.formatDateForInput(profile.date_of_birth ?? profile.dob)
                },
                { emitEvent: false }
            );

            this.docs.set({
                license: profile.driver_license_url ?? this.docs().license,
                insurance: profile.insurance_url ?? this.docs().insurance
            });
        }
    }

    selectedVehicleClass(): DriverVehicleClass {
        const value = String(this.onboardingForm.get('vehicle_class')?.value || 'standard') as DriverVehicleClass;
        return this.vehicleClassOptions.some(option => option.id === value) ? value : 'standard';
    }

    selectedServiceTypes(): DriverServiceSelection[] {
        return this.normaliseServiceTypes(this.onboardingForm.get('service_types')?.value, this.selectedVehicleClass());
    }

    availableServiceOptions() {
        const allowed = this.allowedServicesForClass(this.selectedVehicleClass());
        return this.serviceOptions.filter(option => allowed.includes(option.id));
    }

    isServiceSelected(value: DriverServiceSelection): boolean {
        return this.selectedServiceTypes().includes(value);
    }

    toggleServiceType(value: DriverServiceSelection) {
        if (this.isReadOnly()) return;

        const allowed = this.allowedServicesForClass(this.selectedVehicleClass());
        if (!allowed.includes(value)) return;

        const selected = new Set(this.selectedServiceTypes());
        if (selected.has(value)) {
            selected.delete(value);
        } else {
            selected.add(value);
        }

        const next = Array.from(selected).filter(item => allowed.includes(item));
        this.onboardingForm.get('service_types')?.setValue(next.length ? next : this.defaultServicesForClass(this.selectedVehicleClass()), { emitEvent: true });
        this.applyVehicleClassRules(this.selectedVehicleClass());
    }

    isBikeVehicle(): boolean {
        return this.selectedVehicleClass() === 'bike';
    }

    requiresTaxiLicence(): boolean {
        return engineRideSelected(
            { verification_items: { driver_service_types: this.selectedServiceTypes() }, driver_service_types: this.selectedServiceTypes() },
            { service_eligibility: this.selectedServiceTypes(), capacity: this.selectedVehicleClass() }
        );
    }

    private filterResolvedBlockers(blockers: string[], profile: DriverProfile | null, vehicle: Vehicle | null, selectedServices: string[]): string[] {
        const plate = getVehiclePlateValue(vehicle);
        const needsRegistration = vehicleRequiresRegistration(
            normaliseVehicleClass(vehicle),
            selectedServices,
            (profile as any)?.country_code || (profile as any)?.country
        );
        const needsRide = selectedServices.includes('ride');
        const hasInsurance = !!(
            (profile as any)?.insurance_url ||
            (profile as any)?.courier_insurance_url ||
            (profile as any)?.hire_reward_insurance_url ||
            this.docs().insurance
        );

        return Array.from(new Set(blockers.filter((blocker) => {
            const text = String(blocker || '').toLowerCase();
            if ((!needsRegistration || plate) && text.includes('registration')) return false;
            if (!needsRide && (
                text.includes('council') ||
                text.includes('taxi') ||
                text.includes('private hire') ||
                text.includes('badge')
            )) return false;
            if (hasInsurance && (text.includes('insurance document is missing') || text.includes('courier insurance') || text.includes('hire and reward'))) return false;
            return true;
        })));
    }

    fieldInputClass(): string {
        return 'w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-950 outline-none transition-all placeholder:text-slate-400 focus:border-amber-500 focus:ring-4 focus:ring-amber-100 disabled:bg-slate-50 disabled:text-slate-400';
    }

    vehicleSetupTitle(): string {
        if (this.isBikeVehicle()) return 'Bike courier setup';
        if (this.selectedVehicleClass() === 'small_van' || this.selectedVehicleClass() === 'large_van') return 'Van setup';
        return 'Car setup';
    }

    vehicleSetupMessage(): string {
        const selected = this.selectedServiceTypes();

        if (selected.includes('ride')) {
            return 'Passenger rides require private hire/taxi approval, vehicle licence, insurance, and local licensing details.';
        }

        if (selected.includes('van')) {
            return 'Moving jobs require vehicle details, registration plate, suitable insurance, goods-in-transit/public-liability documents where required, and payout setup.';
        }

        return 'Shop and deliver require vehicle details, registration plate, suitable insurance, and payout setup. Bike couriers do not need a taxi licence.';
    }

    vehicleMakeLabel(): string {
        return this.isBikeVehicle() ? 'Bike Brand' : 'Make';
    }

    vehicleMakePlaceholder(): string {
        return this.isBikeVehicle() ? 'e.g. Trek, Raleigh, Honda' : 'e.g. Toyota';
    }

    vehicleModelLabel(): string {
        return this.isBikeVehicle() ? 'Bike Type / Model' : 'Model';
    }

    vehicleModelPlaceholder(): string {
        return this.isBikeVehicle() ? 'e.g. E-bike, road bike, PCX' : 'e.g. Corolla';
    }

    vehicleColorLabel(): string {
        return this.isBikeVehicle() ? 'Bike Colour' : 'Colour';
    }

    vehicleColorPlaceholder(): string {
        return this.isBikeVehicle() ? 'e.g. Black' : 'e.g. Silver';
    }

    vehicleYearLabel(): string {
        return this.isBikeVehicle() ? 'Bike Year' : 'Year';
    }

    vehicleYearPlaceholder(): string {
        return this.isBikeVehicle() ? 'e.g. 2023' : 'e.g. 2022';
    }

    primaryDocumentLabel(): string {
        return this.isBikeVehicle() ? 'Photo ID' : 'Driver Licence';
    }

    secondaryDocumentLabel(): string {
        return this.isBikeVehicle() ? 'Courier insurance' : 'Insurance';
    }

    secondaryDocumentReady(): boolean {
        return this.isBikeVehicle() || !!this.docs().insurance;
    }

    secondaryDocumentReadyLabel(): string {
        if (this.isBikeVehicle() && !this.docs().insurance) return 'Optional';
        return 'Uploaded';
    }

    secondaryDocumentPendingLabel(): string {
        if (this.isBikeVehicle()) return this.isReadOnly() ? 'Not saved' : 'Optional';
        return this.isReadOnly() ? 'Not saved' : 'Tap to select';
    }

    vehicleChecklistLabel(): string {
        if (this.isBikeVehicle()) return 'Bike details and ID checks';
        return this.requiresTaxiLicence() ? 'Vehicle and passenger ride approval' : 'Vehicle details and documents';
    }

    private applyVehicleClassRules(value: DriverVehicleClass) {
        const plate = this.onboardingForm.get('license_plate');
        const services = this.onboardingForm.get('service_types');
        const councilName = this.onboardingForm.get('council_name');
        const councilNumber = this.onboardingForm.get('council_license_number');
        const taxiBadge = this.onboardingForm.get('taxi_badge_number');
        const taxiExpiry = this.onboardingForm.get('taxi_license_expiry');
        const isBike = value === 'bike';
        const allowedServices = this.allowedServicesForClass(value);
        const selectedServices = this.normaliseServiceTypes(services?.value, value).filter(service => allowedServices.includes(service));
        const nextServices = selectedServices.length ? selectedServices : this.defaultServicesForClass(value);
        const needsTaxiLicence = nextServices.includes('ride');

        services?.setValue(nextServices, { emitEvent: false });
        services?.setValidators([Validators.required]);

        if (isBike) {
            plate?.clearValidators();
            plate?.setErrors(null);
            plate?.setValue('', { emitEvent: false });
        } else {
            plate?.setValidators([Validators.required, Validators.minLength(2)]);
        }

        if (needsTaxiLicence) {
            councilName?.setValidators([Validators.required, Validators.minLength(2)]);
            councilNumber?.setValidators([Validators.required, Validators.minLength(2)]);
            taxiBadge?.setValidators([Validators.required, Validators.minLength(2)]);
            taxiExpiry?.setValidators(Validators.required);
        } else {
            councilName?.clearValidators();
            councilNumber?.clearValidators();
            taxiBadge?.clearValidators();
            taxiExpiry?.clearValidators();
            councilName?.setErrors(null);
            councilNumber?.setErrors(null);
            taxiBadge?.setErrors(null);
            taxiExpiry?.setErrors(null);
            councilName?.setValue('', { emitEvent: false });
            councilNumber?.setValue('', { emitEvent: false });
            taxiBadge?.setValue('', { emitEvent: false });
            taxiExpiry?.setValue('', { emitEvent: false });
        }

        [plate, services, councilName, councilNumber, taxiBadge, taxiExpiry].forEach(control => {
            control?.updateValueAndValidity({ emitEvent: false });
        });
    }

    private allowedServicesForClass(value: DriverVehicleClass): DriverServiceSelection[] {
        switch (value) {
            case 'bike':
                return ['errand', 'delivery'];
            case 'standard':
            case 'xl':
                return ['ride', 'errand', 'delivery'];
            case 'small_van':
            case 'large_van':
                return ['delivery', 'van'];
            default:
                return ['errand', 'delivery'];
        }
    }

    private defaultServicesForClass(value: DriverVehicleClass): DriverServiceSelection[] {
        const allowed = this.allowedServicesForClass(value);
        return allowed.filter(service => service !== 'ride') || allowed;
    }

    private normaliseServiceTypes(value: unknown, vehicleClass: DriverVehicleClass = 'standard'): DriverServiceSelection[] {
        const allowed = this.allowedServicesForClass(vehicleClass);
        let raw: unknown[] = [];

        if (Array.isArray(value)) {
            raw = value;
        } else if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                raw = Array.isArray(parsed) ? parsed : value.split(',');
            } catch {
                raw = value.split(',');
            }
        }

        const selected = raw
            .map(item => String(item || '').trim().toLowerCase())
            .map(item => item === 'van-moving' || item === 'moving' ? 'van' : item)
            .map(item => item === 'package' || item === 'package_delivery' ? 'delivery' : item)
            .filter((item): item is DriverServiceSelection => ['ride', 'errand', 'delivery', 'van'].includes(item))
            .filter(item => allowed.includes(item));

        return selected.length ? Array.from(new Set(selected)) : this.defaultServicesForClass(vehicleClass);
    }

    private activeVehicleControls(): string[] {
        const controls = ['make', 'model', 'color', 'year', 'vehicle_class', 'service_types'];

        if (!this.isBikeVehicle()) {
            controls.push('license_plate');
        }

        if (this.requiresTaxiLicence()) {
            controls.push('council_name', 'council_license_number', 'taxi_badge_number', 'taxi_license_expiry');
        }

        return controls;
    }

    private isActiveVehicleControlReady(controlName: string, vehicle: Vehicle | null): boolean {
        const control = this.onboardingForm.get(controlName);

        if (control?.valid) {
            return true;
        }

        switch (controlName) {
            case 'make':
                return this.hasText(vehicle?.make);
            case 'model':
                return this.hasText(vehicle?.model);
            case 'color':
                return this.hasText(vehicle?.color);
            case 'year':
                return Number(vehicle?.year) >= 1900;
            case 'license_plate':
                return this.hasText(vehicle?.license_plate);
            case 'vehicle_class':
                return !!vehicle && !!this.vehicleClassFromVehicle(vehicle);
            case 'service_types':
                return this.selectedServiceTypes().length > 0;
            default:
                return false;
        }
    }

    private hasText(value: unknown): boolean {
        return String(value ?? '').trim().length > 0;
    }

    private firstProfileValue(profile: Record<string, unknown> | null | undefined, keys: string[]): string {
        if (!profile) return '';
        for (const key of keys) {
            const value = profile[key];
            if (this.hasText(value)) return String(value).trim();
        }
        return '';
    }

    private getCanonicalPlate(vehicle: Vehicle | null | undefined, fallback?: unknown): string {
        return String(vehicle?.license_plate ?? fallback ?? '').trim();
    }

    private async refreshVehicleForValidation(): Promise<Vehicle | null> {
        const vehicle = await this.driverService.fetchVehicle();
        console.log('[DriverOnboarding] Validation vehicle:', vehicle);

        if (vehicle) {
            this.onboardingForm.patchValue(
                {
                    make: this.hasText(this.onboardingForm.get('make')?.value) ? this.onboardingForm.get('make')?.value : vehicle.make ?? '',
                    model: this.hasText(this.onboardingForm.get('model')?.value) ? this.onboardingForm.get('model')?.value : vehicle.model ?? '',
                    color: this.hasText(this.onboardingForm.get('color')?.value) ? this.onboardingForm.get('color')?.value : vehicle.color ?? '',
                    year: this.onboardingForm.get('year')?.value || vehicle.year || new Date().getFullYear(),
                    license_plate: this.hasText(this.onboardingForm.get('license_plate')?.value)
                        ? this.onboardingForm.get('license_plate')?.value
                        : this.getCanonicalPlate(vehicle),
                    vehicle_class: this.onboardingForm.get('vehicle_class')?.value || this.vehicleClassFromVehicle(vehicle)
                },
                { emitEvent: false }
            );
            this.onboardingForm.updateValueAndValidity({ emitEvent: false });
        }

        return vehicle;
    }

    private buildVehiclePayload(raw: Record<string, unknown>, vehicle: Vehicle | null): Partial<Vehicle> {
        const vehicleClass = String(raw['vehicle_class'] || this.vehicleClassFromVehicle(vehicle) || 'standard') as DriverVehicleClass;
        const plate = this.getCanonicalPlate(vehicle, raw['license_plate']);
        const isBike = vehicleClass === 'bike';

        const registrationRequired = vehicleRequiresRegistration(
            normaliseVehicleClass({ capacity: vehicleClass, type: this.vehicleTypeFromClass(vehicleClass) }),
            this.selectedServiceTypes(),
            (this.profile() as any)?.country_code || (this.profile() as any)?.country
        );

        if (registrationRequired && (!plate || plate.length === 0)) {
            throw new Error('Add the vehicle registration plate before submitting.');
        }

        return {
            make: String(raw['make'] || vehicle?.make || '').trim(),
            model: String(raw['model'] || vehicle?.model || '').trim(),
            color: String(raw['color'] || vehicle?.color || '').trim(),
            year: Number(raw['year'] || vehicle?.year),
            license_plate: registrationRequired ? plate.toUpperCase() : '',
            type: this.vehicleTypeFromClass(vehicleClass),
            capacity: vehicleClass,
            service_eligibility: this.selectedServiceTypes()
        };
    }

    private parseVerificationItems(value: unknown): Record<string, string> {
        if (!value) return {};

        if (Array.isArray(value)) {
            return value.reduce<Record<string, string>>((items, entry) => {
                if (!entry || typeof entry !== 'object') return items;

                const record = entry as Record<string, unknown>;
                const key = String(record['key'] || record['name'] || record['field'] || '').trim();
                const rawValue = record['value'] ?? record['label'] ?? '';

                if (key) items[key] = String(rawValue);
                return items;
            }, {});
        }

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

    private buildVerificationItems(raw: Record<string, unknown>): Array<{ key: string; value: string }> {
        const items: Array<{ key: string; value: string }> = [
            { key: 'vehicle_class', value: String(raw['vehicle_class'] || 'standard').trim() },
            { key: 'vehicle_type', value: this.vehicleTypeFromClass(String(raw['vehicle_class'] || 'standard') as DriverVehicleClass) },
            { key: 'driver_service_types', value: JSON.stringify(this.selectedServiceTypes()) }
        ];

        if (this.requiresTaxiLicence()) {
            items.push(
                { key: 'council_name', value: String(raw['council_name'] || '').trim() },
                { key: 'council_license_number', value: String(raw['council_license_number'] || '').trim() },
                { key: 'taxi_badge_number', value: String(raw['taxi_badge_number'] || '').trim() },
                { key: 'taxi_license_expiry', value: String(raw['taxi_license_expiry'] || '').trim() }
            );
        }

        return items.filter(item => item.value.length > 0);
    }

    private buildRideCompliancePayload(raw: Record<string, unknown>, profile?: Record<string, unknown> | null): Record<string, unknown> {
        if (!this.requiresTaxiLicence()) return {};

        const payload = {
            council_name: String(raw['council_name'] || '').trim(),
            council_license_number: String(raw['council_license_number'] || '').trim(),
            taxi_badge_number: String(raw['taxi_badge_number'] || '').trim(),
            taxi_license_expiry: String(raw['taxi_license_expiry'] || '').trim() || null,
            private_hire_vehicle_license_url: this.firstProfileValue(profile, [
                'private_hire_vehicle_license_url',
                'privateHireVehicleLicenseUrl',
                'phv_license_url',
                'vehicle_license_url',
                'private_hire_vehicle_licence_url',
                'phv_licence_url'
            ]) || null
        };

        console.log('[driver-compliance] saving ride fields', payload);
        return payload;
    }

    private vehicleClassFromVehicle(vehicle: Vehicle | null): DriverVehicleClass {
        const type = String((vehicle as any)?.type || '').toLowerCase();
        const capacity = String((vehicle as any)?.capacity || '').toLowerCase();

        if (type.includes('motorcycle') || type.includes('bike') || capacity.includes('bike')) return 'bike';
        if (capacity.includes('large_van') || capacity.includes('large van')) return 'large_van';
        if (type.includes('van') || capacity.includes('small_van') || capacity.includes('van')) return 'small_van';
        if (capacity.includes('xl') || capacity.includes('7')) return 'xl';
        return 'standard';
    }

    private vehicleTypeFromClass(value: DriverVehicleClass): 'car' | 'van' | 'motorcycle' {
        if (value === 'bike') return 'motorcycle';
        if (value === 'small_van' || value === 'large_van') return 'van';
        return 'car';
    }

    private applyReadOnlyState() {
        if (this.isReadOnly()) {
            this.onboardingForm.disable({ emitEvent: false });
        } else {
            this.onboardingForm.enable({ emitEvent: false });
        }
    }

    setVehicleClass(value: DriverVehicleClass) {
        if (this.isReadOnly()) return;
        this.onboardingForm.get('vehicle_class')?.setValue(value, { emitEvent: true });
    }

    normalizePlate() {
        const control = this.onboardingForm.get('license_plate');
        const plate = String(control?.value || '').toUpperCase().replace(/\s+/g, ' ').trim();
        control?.setValue(plate, { emitEvent: true });
    }

    async lookupVehicleByPlate() {
        if (this.isReadOnly()) return;

        this.normalizePlate();
        const plate = String(this.onboardingForm.get('license_plate')?.value || '').trim();

        if (!plate) {
            await this.showToast('Enter the vehicle registration first.', 'warning');
            return;
        }

        await this.showToast('Plate lookup is ready for provider connection. Please enter make, model, colour, and year manually for now.', 'warning');
    }

    handleDocumentClick(type: DocumentType) {
        if (this.isReadOnly()) {
            void this.openDocument(type);
            return;
        }

        void this.upload(type);
    }

    async uploadDriverPhoto() {
        if (this.isReadOnly()) {
            await this.showToast('Photo cannot be changed while verification is in progress.', 'warning');
            return;
        }

        const user = this.authService.currentUser();

        if (!user?.id) {
            await this.showToast('Please sign in again to upload your photo.', 'danger');
            return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/jpeg,image/png,image/webp';

        input.onchange = async (event: Event) => {
            const target = event.target as HTMLInputElement;
            const file = target.files?.[0];

            if (!file) return;

            if (!this.isAllowedImage(file)) {
                await this.showToast('Please upload a JPG, PNG, or WEBP photo under 8MB.', 'warning');
                return;
            }

            const loading = await this.loadingCtrl.create({ message: 'Uploading driver photo...' });
            await loading.present();

            try {
                const path = await this.storageUpload.uploadProfileImage(user.id, file);
                const publicUrl = await this.storageUpload.getPublicUrl('profiles', path);

                await this.updateProfileSafely(user.id, { avatar_url: publicUrl });
                await this.showToast('Driver photo uploaded.', 'success');
            } catch (error: any) {
                console.error('[DriverOnboarding] Driver photo upload failed:', error);
                await this.showToast(error?.message || 'Driver photo upload failed.', 'danger');
            } finally {
                target.value = '';
                await loading.dismiss();
            }
        };

        input.click();
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
                const replacing = !!this.docs()[type];
                const path = await this.driverService.uploadDocument(file, type);
                this.docs.update((current) => ({ ...current, [type]: path }));
                this.saveDraft();

                await this.persistUploadedDocument(type, path);
                await this.onboardingStatus.recordEvent(
                    this.isActionRequired() ? 'driver_document_resubmitted' : replacing ? 'driver_document_replaced' : 'driver_document_uploaded',
                    type, replacing ? 'uploaded' : 'missing', 'uploaded'
                );
                await this.refreshOnboardingStatus();

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

    private async persistUploadedDocument(type: DocumentType, path: string | undefined) {
        const user = this.authService.currentUser();

        if (!user?.id || !path) return;

        await this.updateProfileSafely(user.id, type === 'license'
            ? { driver_license_url: path }
            : { insurance_url: path });

        if (typeof (this.profileService as any).fetchProfile === 'function') {
            await (this.profileService as any).fetchProfile(user.id);
        }

        await this.driverService.fetchVehicle();
    }

    private isAllowedFile(file: File): boolean {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        return allowedTypes.includes(file.type) && file.size <= this.maxUploadBytes;
    }

    private isAllowedImage(file: File): boolean {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        return allowedTypes.includes(file.type) && file.size <= this.maxUploadBytes;
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

    async submit() {
        if (this.isReadOnly()) {
            await this.showToast('Your application is already under review.', 'warning');
            return;
        }

        await this.refreshVehicleForValidation();
        this.onboardingForm.markAllAsTouched();

        if (!this.canSubmit()) {
            await this.showToast(this.setupBlockingMessage(), 'warning');
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
            const latestVehicle = await this.driverService.fetchVehicle();
            console.log('[DriverOnboarding] Validation vehicle:', latestVehicle);
            const vehiclePayload = this.buildVehiclePayload(raw, latestVehicle);
            const rideCompliancePayload = this.buildRideCompliancePayload(raw, this.profile() as any);

            const savedVehicle = await this.driverService.updateVehicle(vehiclePayload);
            console.log('[DriverOnboarding] Saved vehicle:', savedVehicle);
            await this.driverService.fetchVehicle();
            await this.onboardingStatus.recordEvent(
                latestVehicle ? 'driver_vehicle_updated' : 'driver_vehicle_submitted',
                'vehicle', latestVehicle ? 'saved' : 'missing', 'under_review'
            );

            await this.updateProfileSafely(user.id, {
                onboarding_completed: true,
                role: 'driver',
                pricing_plan: 'starter',
                subscription_status: 'inactive',
                full_name: String(raw.full_name || '').trim(),
                phone: String(raw.phone || '').trim(),
                date_of_birth: String(raw.date_of_birth || '').trim() || null,
                ...rideCompliancePayload,
                driver_license_url: this.docs().license || null,
                insurance_url: this.docs().insurance || null,
                verification_status: 'under_review',
                driver_review_status: 'under_review',
                verification_notes: null,
                driver_review_notes: null,
                verification_blockers: [],
                driver_review_blockers: [],
                verification_items: this.buildVerificationItems(raw),
                is_verified: false
            });

            await this.onboardingStatus.recordEvent('driver_onboarding_submitted', 'onboarding', this.verificationStatus(), 'under_review');
            await this.refreshOnboardingStatus();

            if (typeof (this.profileService as any).fetchProfile === 'function') {
                await (this.profileService as any).fetchProfile(user.id);
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

    scrollToSetup() {
        document.querySelector('form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    scrollToDocuments() {
        document.querySelector('[data-driver-documents]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    private async updateProfileSafely(userId: string, updates: Record<string, unknown>) {
        const cleaned = this.cleanProfileUpdates(updates);
        const pending = { ...cleaned };

        for (let attempt = 0; attempt < 8; attempt++) {
            const { error } = await this.supabase.client
                .from('profiles')
                .update(pending)
                .eq('id', userId);

            if (!error) {
                this.mergeLocalProfile(pending);
                return;
            }

            const missingColumn = this.extractMissingColumn(error);
            if (!missingColumn || pending[missingColumn] === undefined) {
                throw error;
            }

            delete pending[missingColumn];
        }

        throw new Error('Could not save profile updates after removing unsupported optional fields.');
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

    private formatDateForInput(value: unknown): string {
        if (!value) return '';
        return String(value).slice(0, 10);
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
        } catch (error) {
            console.warn('[DriverOnboarding] Failed to load payout settings', error);
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
