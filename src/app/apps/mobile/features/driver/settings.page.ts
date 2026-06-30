import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonIcon,
    IonSelect,
    IonSelectOption,
    LoadingController,
    ToastController,
    AlertController
} from '@ionic/angular/standalone';
import { Router } from '@angular/router';
import { addIcons } from 'ionicons';
import {
    alertCircleOutline,
    cardOutline,
    carOutline,
    chevronBackOutline,
    globeOutline,
    lockClosedOutline,
    openOutline,
    refreshOutline,
    shieldCheckmarkOutline,
    starOutline,
    walletOutline
} from 'ionicons/icons';

import { DriverService } from '../../../../core/services/driver/driver.service';
import { ProfileService } from '../../../../core/services/profile/profile.service';
import { AppConfigService } from '../../../../core/services/config/app-config.service';
import { AuthService } from '../../../../core/services/auth/auth.service';
import { ConnectService } from '../../../../core/services/stripe/connect.service';
import { DriverProfile, Vehicle } from '../../../../shared/models/booking.model';

import { CardComponent, ButtonComponent, BadgeComponent } from '../../../../shared/ui';

type DocType = 'license' | 'insurance';

@Component({
    selector: 'app-driver-settings',
    standalone: true,
    imports: [
        CommonModule,
        IonHeader,
        IonToolbar,
        IonButtons,
        IonBackButton,
        IonTitle,
        IonContent,
        IonIcon,
        IonSelect,
        IonSelectOption,
        CardComponent,
        ButtonComponent,
        BadgeComponent
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-3 pt-3 bg-slate-50">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>

        <ion-title class="font-display font-black text-slate-950 tracking-tight">
          Driver Settings
        </ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="movabi-page">
      <div class="w-full max-w-xl mx-auto px-3 py-2 space-y-4 pb-16 overflow-x-hidden">

        <div class="movabi-hero bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 text-white">
          <div class="absolute -right-12 -bottom-16 w-48 h-48 rounded-full bg-white/10 blur-2xl"></div>

          <div class="relative z-10">
            <p class="text-white/70 text-[10px] font-black mb-1 uppercase tracking-[0.16em]">
              Account
            </p>

            <h1 class="text-[1.55rem] font-display font-black tracking-tight leading-tight">
              Driver Settings
            </h1>

            <p class="text-xs text-white/80 font-semibold mt-2 max-w-sm leading-5">
              Manage your region, verification documents, vehicle, payouts, and subscription.
            </p>

            <div class="mt-4 flex flex-wrap gap-2">
              <app-badge [variant]="isVerified() ? 'success' : 'warning'">
                {{ verificationLabel() }}
              </app-badge>

              <app-badge [variant]="isStripeReady() ? 'success' : 'warning'">
                {{ isStripeReady() ? 'Payouts Ready' : 'Payouts Pending' }}
              </app-badge>

              <app-badge [variant]="isProDriver() ? 'primary' : 'secondary'">
                {{ isProDriver() ? 'Pro' : 'Starter' }}
              </app-badge>
            </div>
          </div>
        </div>

        @if (isActionRequired()) {
          <app-card class="p-4 border border-rose-100 shadow-rose-100/30">
            <div class="flex gap-3">
              <div class="w-10 h-10 rounded-2xl bg-rose-50 flex items-center justify-center text-rose-600 border border-rose-100 shrink-0">
                <ion-icon name="alert-circle-outline" class="text-xl"></ion-icon>
              </div>

              <div class="min-w-0 flex-1 space-y-3">
                <div>
                  <h2 class="text-sm font-black text-slate-950">Action required</h2>
                  <p class="text-xs text-slate-600 font-semibold leading-relaxed mt-1">
                    Admin needs more information before your driver account can be approved.
                  </p>
                </div>

                @if (verificationNotes()) {
                  <div class="rounded-2xl bg-rose-50 border border-rose-100 p-3 text-xs text-slate-700 font-semibold leading-relaxed">
                    {{ verificationNotes() }}
                  </div>
                }

                @if (reviewBlockers().length) {
                  <ul class="rounded-2xl bg-rose-50 border border-rose-100 p-3 space-y-2">
                    @for (blocker of reviewBlockers(); track blocker) {
                      <li class="text-xs text-rose-900 font-bold leading-relaxed">• {{ blocker }}</li>
                    }
                  </ul>
                }

                <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <app-button size="sm" variant="secondary" class="w-full" (clicked)="router.navigate(['/driver/onboarding'])">
                    Update Details
                  </app-button>
                  <app-button size="sm" variant="secondary" class="w-full" (clicked)="router.navigate(['/driver/onboarding'])">
                    Upload Documents
                  </app-button>
                  <app-button size="sm" color="error" class="w-full" [disabled]="resubmitting()" (clicked)="resubmitDriverReview()">
                    {{ resubmitting() ? 'Sending...' : 'Resubmit' }}
                  </app-button>
                </div>
              </div>
            </div>
          </app-card>
        }

        <section class="space-y-2">
          <div class="movabi-section-header">
            <h2 class="movabi-section-title">Profile</h2>
          </div>

          <app-card class="p-4 cursor-pointer active:scale-[0.98] transition-transform" (click)="router.navigate(['/account/settings'])">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-10 h-10 rounded-2xl bg-amber-50 flex items-center justify-center text-amber-600 border border-amber-100 shrink-0">
                  <ion-icon name="card-outline" class="text-xl"></ion-icon>
                </div>

                <div class="min-w-0">
                  <h3 class="text-sm font-black text-slate-950">Personal details</h3>
                  <p class="text-[10px] text-slate-400 font-black uppercase tracking-[0.1em] mt-0.5 leading-snug">
                    Edit name, phone, country, or close account
                  </p>
                </div>
              </div>

              <app-badge variant="secondary">Edit</app-badge>
            </div>
          </app-card>
        </section>

        <section class="space-y-2">
          <div class="movabi-section-header">
            <h2 class="movabi-section-title">Region & Language</h2>
          </div>

          <app-card class="p-4">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-10 h-10 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 border border-blue-100 shrink-0">
                  <ion-icon name="globe-outline" class="text-xl"></ion-icon>
                </div>

                <div class="min-w-0">
                  <h3 class="text-sm font-black text-slate-950">Current Country</h3>
                  <p class="text-[10px] text-slate-400 font-black uppercase tracking-[0.1em] mt-0.5 leading-snug">
                    {{ config.currentCountry().name }}
                  </p>
                </div>
              </div>

              <ion-select
                [value]="config.currentCountry().code"
                (ionChange)="onCountryChange($event)"
                interface="popover"
                class="text-[11px] font-black text-blue-600 uppercase tracking-[0.08em] max-w-[8rem]"
              >
                @for (country of config.countries(); track country.code) {
                  <ion-select-option [value]="country.code">
                    {{ country.name }}
                  </ion-select-option>
                }
              </ion-select>
            </div>

            <div class="mt-3 grid grid-cols-2 gap-2">
              <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3">
                <p class="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{{ config.t('currency_preview') }}</p>
                <p class="mt-1 text-sm font-black text-slate-950">GBP 10 -> {{ config.formatConvertedFromGbp(10) }}</p>
              </div>

              <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3">
                <p class="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{{ config.t('language_preview') }}</p>
                <p class="mt-1 text-sm font-black text-slate-950 uppercase">{{ config.selectedLanguage() }}</p>
              </div>
            </div>
          </app-card>
        </section>

        <section class="space-y-2">
          <div class="movabi-section-header">
            <h2 class="movabi-section-title">Verification</h2>
          </div>

          <div class="space-y-2">
            <app-card class="p-4 cursor-pointer active:scale-[0.98] transition-transform" (click)="handleDocumentClick('license')">
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-3 min-w-0">
                  <div class="w-10 h-10 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 border border-blue-100 shrink-0">
                    <ion-icon name="card-outline" class="text-xl"></ion-icon>
                  </div>

                  <div class="min-w-0">
                    <h3 class="text-sm font-black text-slate-950">Driver Licence</h3>
                    <p class="text-[10px] text-slate-400 font-black uppercase tracking-[0.1em] mt-0.5 leading-snug">
                      {{ docs().license ? 'Document saved' : 'Required for manual review' }}
                    </p>
                  </div>
                </div>

                <app-badge [variant]="docs().license ? 'success' : 'warning'">
                  {{ docs().license ? 'Uploaded' : 'Pending' }}
                </app-badge>
              </div>
            </app-card>

            <app-card class="p-4 cursor-pointer active:scale-[0.98] transition-transform" (click)="handleDocumentClick('insurance')">
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-3 min-w-0">
                  <div class="w-10 h-10 rounded-2xl bg-emerald-50 flex items-center justify-center text-emerald-600 border border-emerald-100 shrink-0">
                    <ion-icon name="shield-checkmark-outline" class="text-xl"></ion-icon>
                  </div>

                  <div class="min-w-0">
                    <h3 class="text-sm font-black text-slate-950">Vehicle Insurance</h3>
                    <p class="text-[10px] text-slate-400 font-black uppercase tracking-[0.1em] mt-0.5 leading-snug">
                      {{ docs().insurance ? 'Document saved' : 'Proof of coverage required' }}
                    </p>
                  </div>
                </div>

                <app-badge [variant]="docs().insurance ? 'success' : 'warning'">
                  {{ docs().insurance ? 'Uploaded' : 'Pending' }}
                </app-badge>
              </div>
            </app-card>

            @if (isUnderReview()) {
              <div class="rounded-[1.5rem] border border-amber-100 bg-amber-50 p-3 flex gap-3">
                <ion-icon name="lock-closed-outline" class="text-amber-600 text-xl shrink-0 mt-0.5"></ion-icon>
                <p class="text-xs text-amber-800 font-semibold leading-relaxed">
                  Document changes are locked while your application is under manual review.
                </p>
              </div>
            }
          </div>
        </section>

        <section class="space-y-2">
          <div class="movabi-section-header">
            <h2 class="movabi-section-title">Vehicle Details</h2>
          </div>

          <app-card class="p-4 cursor-pointer active:scale-[0.98] transition-transform" (click)="router.navigate(['/driver/onboarding'])">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-10 h-10 rounded-2xl bg-slate-100 flex items-center justify-center text-slate-600 border border-slate-200 shrink-0">
                  <ion-icon name="car-outline" class="text-xl"></ion-icon>
                </div>

                <div class="min-w-0">
                  <h3 class="text-sm font-black text-slate-950 leading-tight whitespace-normal">{{ vehicleTitle() }}</h3>
                  <p class="text-[10px] text-slate-400 font-black uppercase tracking-[0.08em] mt-0.5 leading-snug whitespace-normal">
                    {{ vehicleSubtitle() }}
                  </p>
                </div>
              </div>

              <app-badge [variant]="vehicle() ? 'success' : 'warning'">
                {{ vehicle() ? 'Saved' : 'Pending' }}
              </app-badge>
            </div>
          </app-card>
        </section>

        <section class="space-y-2">
          <div class="movabi-section-header">
            <h2 class="movabi-section-title">Payments & Payouts</h2>
          </div>

          <app-card class="p-4">
            <div class="space-y-3">
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-3 min-w-0">
                  <div class="w-10 h-10 rounded-2xl bg-indigo-50 flex items-center justify-center text-indigo-600 border border-indigo-100 shrink-0">
                    <ion-icon name="wallet-outline" class="text-xl"></ion-icon>
                  </div>

                  <div class="min-w-0">
                    <h3 class="text-sm font-black text-slate-950">Stripe Connect</h3>
                    <p class="text-[10px] text-slate-400 font-black uppercase tracking-[0.1em] mt-0.5 leading-snug">
                      {{ stripeSubtitle() }}
                    </p>
                  </div>
                </div>

                <app-badge [variant]="getStripeBadgeVariant()">
                  {{ getStripeBadgeText() }}
                </app-badge>
              </div>

              @if (!isStripeReady()) {
                <div class="bg-amber-50 rounded-2xl p-3 border border-amber-100 flex gap-3">
                  <ion-icon name="alert-circle-outline" class="text-amber-600 text-xl shrink-0 mt-0.5"></ion-icon>

                  <div class="space-y-2 flex-1">
                    <p class="text-xs text-amber-900 leading-relaxed font-semibold">
                      Complete Stripe onboarding to receive payouts directly to your bank account.
                    </p>

                    <app-button size="sm" class="w-full" [disabled]="loadingStripe()" (clicked)="setupStripe()">
                      {{ loadingStripe() ? 'Opening...' : (isStripePending() ? 'Continue Setup' : 'Complete Setup') }}
                    </app-button>
                  </div>
                </div>
              } @else {
                <div class="grid grid-cols-2 gap-2">
                  <app-button variant="secondary" size="sm" class="w-full" [disabled]="loadingStripe()" (clicked)="openStripeDashboard()">
                    Dashboard
                  </app-button>

                  <app-button variant="secondary" size="sm" class="w-full" [disabled]="loadingStripe()" (clicked)="refreshStripe()">
                    Refresh
                  </app-button>
                </div>
              }
            </div>
          </app-card>
        </section>

        <section class="space-y-2">
          <div class="movabi-section-header">
            <h2 class="movabi-section-title">Movabi Pay Card</h2>
          </div>

          <app-card class="p-4">
            <div class="space-y-3">
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <h3 class="text-sm font-black text-slate-950">Errand item budgets</h3>
                  <p class="text-xs text-slate-500 font-semibold leading-relaxed mt-1">
                    Choose how you want to spend approved customer item budgets. Virtual card is instant. Posted card must be received before budget errands can be accepted.
                  </p>
                </div>
                <app-badge [variant]="cardPreference() === 'posted' && physicalCardStatus() !== 'received' ? 'warning' : 'success'">
                  {{ cardPreference() === 'posted' ? physicalCardLabel() : 'Virtual' }}
                </app-badge>
              </div>

              <div class="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  class="rounded-2xl border p-3 text-left active:scale-[0.98] transition"
                  [ngClass]="cardPreference() === 'virtual' ? 'border-amber-400 bg-amber-50 text-slate-950' : 'border-slate-200 bg-white text-slate-600'"
                  (click)="setCardPreference('virtual')"
                >
                  <span class="block text-xs font-black">Virtual card</span>
                  <span class="block text-[10px] font-bold mt-1 leading-snug">Use phone wallet or secure card details.</span>
                </button>

                <button
                  type="button"
                  class="rounded-2xl border p-3 text-left active:scale-[0.98] transition"
                  [ngClass]="cardPreference() === 'posted' ? 'border-amber-400 bg-amber-50 text-slate-950' : 'border-slate-200 bg-white text-slate-600'"
                  (click)="setCardPreference('posted')"
                >
                  <span class="block text-xs font-black">Posted card</span>
                  <span class="block text-[10px] font-bold mt-1 leading-snug">Wait for the physical Movabi card.</span>
                </button>
              </div>

              @if (cardPreference() === 'posted') {
                <div class="rounded-2xl border border-amber-100 bg-amber-50 p-3">
                  <p class="text-xs font-semibold leading-relaxed text-amber-900">
                    Posted card drivers cannot accept errand item-budget jobs until the card is marked as received.
                  </p>
                  <app-button class="mt-3" size="sm" color="success" [disabled]="physicalCardStatus() === 'received'" (clicked)="confirmPhysicalCardReceived()">
                    {{ physicalCardStatus() === 'received' ? 'Card Received' : 'I have received my card' }}
                  </app-button>
                </div>
              }
            </div>
          </app-card>
        </section>

        <section class="space-y-2">
          <div class="flex items-center gap-2 mb-1">
            <div class="w-1.5 h-5 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
            <h2 class="text-[11px] font-bold text-slate-500 uppercase tracking-[0.12em] leading-none">Subscription</h2>
          </div>

          <app-card class="p-4 cursor-pointer active:scale-[0.98] transition-transform" (click)="router.navigate(['/driver/subscription'])">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-10 h-10 rounded-2xl bg-amber-50 flex items-center justify-center text-amber-600 border border-amber-100 shrink-0">
                  <ion-icon name="star-outline" class="text-xl"></ion-icon>
                </div>

                <div class="min-w-0">
                  <h3 class="text-sm font-black text-slate-950">{{ isProDriver() ? 'Pro Plan' : 'Starter Plan' }}</h3>
                  <p class="text-[10px] text-slate-400 font-black uppercase tracking-[0.1em] mt-0.5 leading-snug">
                    {{ isProDriver() ? '0% service commission while active' : 'Default plan • 15% commission' }}
                  </p>
                </div>
              </div>

              <app-badge [variant]="isProDriver() ? 'primary' : 'secondary'">
                {{ isProDriver() ? 'Active' : 'Starter' }}
              </app-badge>
            </div>
          </app-card>
        </section>

        <div class="pt-3">
          <app-button variant="error" class="w-full" (clicked)="confirmDeleteAccount()">
            Close Account
          </app-button>

          <p class="text-[10px] text-slate-400 font-black uppercase tracking-widest text-center mt-4">
            Movabi Driver v1.0.0
          </p>
        </div>
      </div>
    </ion-content>
  `
})
export class DriverSettingsPage implements OnInit {
    public router = inject(Router);
    public driverService = inject(DriverService);
    public config = inject(AppConfigService);

    private profileService = inject(ProfileService);
    private auth = inject(AuthService);
    private connectService = inject(ConnectService);
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);
    private alertCtrl = inject(AlertController);

    profile = this.profileService.profile;
    vehicle = this.driverService.vehicle;
    stripeAccount = this.driverService.stripeAccount;

    docs = computed(() => {
        const profile = this.profile() as DriverProfile | null;

        return {
            license: profile?.driver_license_url || null,
            insurance: profile?.insurance_url || null
        };
    });

    loadingStripe = signal(false);
    resubmitting = signal(false);

    constructor() {
        addIcons({
            alertCircleOutline,
            cardOutline,
            carOutline,
            chevronBackOutline,
            globeOutline,
            lockClosedOutline,
            openOutline,
            refreshOutline,
            shieldCheckmarkOutline,
            starOutline,
            walletOutline
        });
    }

    async ngOnInit() {
        await Promise.all([
            this.driverService.fetchVehicle(),
            this.driverService.fetchStripeAccount()
        ]);
    }

    isVerified(): boolean {
        const profile = this.profile() as DriverProfile | null;
        return profile?.is_verified === true || profile?.verification_status === 'approved';
    }

    isUnderReview(): boolean {
        const profile = this.profile() as DriverProfile | null;
        return profile?.verification_status === 'under_review' || (!!profile?.onboarding_completed && !this.isVerified());
    }

    isActionRequired(): boolean {
        const profile = this.profile() as DriverProfile | null;
        return profile?.driver_review_status === 'action_required' || profile?.verification_status === 'action_required';
    }

    verificationNotes(): string | null {
        const profile = this.profile() as DriverProfile | null;
        return profile?.driver_review_notes || profile?.verification_notes || null;
    }

    reviewBlockers(): string[] {
        const profile = this.profile() as DriverProfile | null;
        return this.parseStringList(profile?.driver_review_blockers ?? profile?.verification_blockers);
    }

    verificationLabel(): string {
        const profile = this.profile() as DriverProfile | null;

        if (this.isVerified()) return 'Manually Approved';
        if (profile?.verification_status === 'action_required') return 'Action Required';
        if (this.isUnderReview()) return 'Manual Review';
        return 'Setup Needed';
    }

    isStripeReady(): boolean {
        const account = this.stripeAccount();

        return !!(
            account?.stripe_account_id &&
            account?.charges_enabled === true &&
            account?.payouts_enabled === true
        );
    }

    isStripePending(): boolean {
        const account = this.stripeAccount();
        return !!(account?.stripe_account_id && !this.isStripeReady());
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

    stripeSubtitle(): string {
        if (this.isStripeReady()) return 'Charges and payouts enabled';
        if (this.isStripePending()) return 'Stripe needs more information';
        return 'Setup required for payouts';
    }

    isProDriver(): boolean {
        const profile = this.profile() as DriverProfile | any | null;
        return profile?.pricing_plan === 'pro' && profile?.subscription_status === 'active';
    }

    vehicleTitle(): string {
        const vehicle = this.vehicle() as Vehicle | null;

        if (!vehicle) return 'Vehicle not added';

        return `${vehicle.make || ''} ${vehicle.model || ''}`.trim() || 'Vehicle saved';
    }

    vehicleSubtitle(): string {
        const vehicle = this.vehicle() as Vehicle | null;

        if (!vehicle) return 'Add vehicle details in onboarding';

        const year = vehicle.year ? String(vehicle.year) : '';
        const color = vehicle.color ? String(vehicle.color) : '';
        const plate = vehicle.license_plate ? String(vehicle.license_plate).toUpperCase() : '';

        return [color, year, plate].filter(Boolean).join(' • ') || 'Vehicle details saved';
    }

    async setupStripe() {
        if (this.loadingStripe()) return;

        this.loadingStripe.set(true);

        const loading = await this.loadingCtrl.create({ message: 'Opening Stripe setup...' });
        await loading.present();

        try {
            const url = await this.driverService.setupStripeConnect();
            window.location.href = url;
        } catch {
            await this.showToast('Failed to load Stripe setup.', 'danger');
        } finally {
            this.loadingStripe.set(false);
            await loading.dismiss();
        }
    }

    async openStripeDashboard() {
        const accountId = this.driverService.stripeAccount()?.stripe_account_id;

        if (!accountId) {
            await this.showToast('Stripe account not found.', 'warning');
            return;
        }

        if (this.loadingStripe()) return;

        this.loadingStripe.set(true);

        const loading = await this.loadingCtrl.create({ message: 'Opening Stripe dashboard...' });
        await loading.present();

        try {
            const link = await this.connectService.getDashboardLink(accountId);
            window.location.href = link.url;
        } catch {
            await this.showToast('Failed to open Stripe dashboard.', 'danger');
        } finally {
            this.loadingStripe.set(false);
            await loading.dismiss();
        }
    }

    async refreshStripe() {
        const accountId = this.driverService.stripeAccount()?.stripe_account_id;

        if (!accountId) {
            await this.showToast('Stripe account not found.', 'warning');
            return;
        }

        if (this.loadingStripe()) return;

        this.loadingStripe.set(true);

        try {
            await this.driverService.refreshStripeStatus(accountId, true);
            await this.driverService.fetchStripeAccount();
            await this.showToast('Stripe status refreshed.', 'success');
        } catch {
            await this.showToast('Could not refresh Stripe status.', 'danger');
        } finally {
            this.loadingStripe.set(false);
        }
    }

    async onCountryChange(event: Event) {
        const customEvent = event as CustomEvent;
        const code = customEvent.detail?.value;

        if (code) {
            this.config.setCountry(code);
            const user = this.auth.currentUser();
            if (user?.id) {
                try {
                    await this.profileService.updateProfile(user.id, {
                        country_code: this.config.currentCountry().code,
                        currency_code: this.config.currencyCode
                    } as any);
                } catch {
                    await this.showToast('Country changed on this device. Profile sync failed.', 'warning');
                    return;
                }
            }
            await this.showToast(`${this.config.t('country_updated')}: ${this.config.currentCountry().name}`, 'success');
        }
    }

    cardPreference(): 'virtual' | 'posted' {
        const profile = this.profile() as DriverProfile | null;
        return profile?.movabi_pay_card_preference === 'posted' ? 'posted' : 'virtual';
    }

    physicalCardStatus(): 'not_requested' | 'requested' | 'posted' | 'received' {
        const profile = this.profile() as DriverProfile | null;
        return (profile?.movabi_pay_physical_card_status as any) || 'not_requested';
    }

    physicalCardLabel(): string {
        const status = this.physicalCardStatus();
        if (status === 'received') return 'Received';
        if (status === 'posted') return 'Posted';
        if (status === 'requested') return 'Requested';
        return 'Not ready';
    }

    async setCardPreference(preference: 'virtual' | 'posted') {
        const user = this.auth.currentUser();
        if (!user?.id) return;

        try {
            await this.profileService.updateProfile(user.id, {
                movabi_pay_card_preference: preference,
                movabi_pay_physical_card_status: preference === 'posted' ? this.physicalCardStatus() : 'not_requested'
            } as any);
            await this.showToast(preference === 'virtual' ? 'Virtual Movabi Pay selected.' : 'Posted Movabi card selected.', 'success');
        } catch {
            await this.showToast('Could not update Movabi Pay card choice.', 'danger');
        }
    }

    async confirmPhysicalCardReceived() {
        const user = this.auth.currentUser();
        if (!user?.id) return;

        try {
            await this.profileService.updateProfile(user.id, {
                movabi_pay_card_preference: 'posted',
                movabi_pay_physical_card_status: 'received',
                movabi_pay_physical_card_received_at: new Date().toISOString()
            } as any);
            await this.showToast('Physical Movabi card confirmed.', 'success');
        } catch {
            await this.showToast('Could not confirm card received.', 'danger');
        }
    }

    async handleDocumentClick(type: DocType) {
        if (this.isUnderReview()) {
            await this.openDoc(type);
            return;
        }

        await this.uploadDoc(type);
    }

    async resubmitDriverReview() {
        const user = this.auth.currentUser();

        if (!user?.id || this.resubmitting()) return;

        this.resubmitting.set(true);

        try {
            await this.profileService.updateProfile(user.id, {
                driver_review_status: 'under_review',
                verification_status: 'under_review',
                verification_notes: null,
                driver_review_notes: null,
                verification_blockers: [],
                driver_review_blockers: [],
                updated_at: new Date().toISOString()
            } as any);

            if (typeof (this.profileService as any).fetchProfile === 'function') {
                await (this.profileService as any).fetchProfile(user.id);
            }

            await this.showToast('Resubmitted for manual review.', 'success');
        } catch {
            await this.showToast('Could not resubmit for review. Please try again.', 'danger');
        } finally {
            this.resubmitting.set(false);
        }
    }

    async openDoc(type: DocType) {
        const path = this.docs()[type];

        if (!path) {
            await this.showToast('No document available.', 'warning');
            return;
        }

        const url = await this.driverService.getDocumentSignedUrl(path);

        if (!url) {
            await this.showToast('Could not open document.', 'danger');
            return;
        }

        window.open(url, '_blank', 'noopener,noreferrer');
    }

    async uploadDoc(type: DocType) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/jpeg,image/png,image/webp,application/pdf';

        input.onchange = async (event: Event) => {
            const target = event.target as HTMLInputElement;
            const file = target.files?.[0];

            if (!file) return;

            if (!this.isAllowedFile(file)) {
                await this.showToast('Please upload a JPG, PNG, WEBP, or PDF under 8MB.', 'warning');
                return;
            }

            const loading = await this.loadingCtrl.create({ message: 'Uploading document...' });
            await loading.present();

            try {
                const path = await this.driverService.uploadDocument(file, type);
                await this.updateProfileDoc(type, path);
                await this.showToast(`${type === 'license' ? 'Driver licence' : 'Insurance'} uploaded.`, 'success');
            } catch {
                await this.showToast('Document upload failed.', 'danger');
            } finally {
                target.value = '';
                await loading.dismiss();
            }
        };

        input.click();
    }

    private async updateProfileDoc(type: DocType, path: string | undefined) {
        const user = this.auth.currentUser();

        if (!user?.id || !path) return;

        const updates =
            type === 'license'
                ? { driver_license_url: path }
                : { insurance_url: path };

        await this.profileService.updateProfile(user.id, updates as any);

        if (typeof (this.profileService as any).fetchProfile === 'function') {
            await (this.profileService as any).fetchProfile(user.id);
        }
    }

    async confirmDeleteAccount() {
        const alert = await this.alertCtrl.create({
            header: 'Close account?',
            message: 'This disables your Movabi account and starts the closure process. Booking, payout, tax, safety, and legal records may be retained where required by law.',
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Request Closure',
                    role: 'confirm',
                    handler: () => void this.requestAccountClosure()
                }
            ]
        });

        await alert.present();
    }

    private async requestAccountClosure() {
        const user = this.auth.currentUser();

        if (!user?.id) {
            await this.showToast('Please sign in again to close your account.', 'danger');
            return;
        }

        const loading = await this.loadingCtrl.create({ message: 'Requesting account closure...' });
        await loading.present();

        try {
            await this.profileService.updateProfile(user.id, { account_status: 'closure_requested' as any });
            await this.showToast('Account closure requested. You have been signed out.', 'success');
            await this.auth.signOut();
        } catch {
            await this.showToast('Could not request closure. Please try again.', 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    private isAllowedFile(file: File): boolean {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        const maxBytes = 8 * 1024 * 1024;

        return allowedTypes.includes(file.type) && file.size <= maxBytes;
    }

    private parseStringList(raw: unknown): string[] {
        if (Array.isArray(raw)) {
            return raw.map((item) => String(item || '').trim()).filter(Boolean);
        }

        if (typeof raw === 'string') {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    return parsed.map((item) => String(item || '').trim()).filter(Boolean);
                }
            } catch {
                return raw.split('\n').map((item) => item.replace(/^[-•]\s*/, '').trim()).filter(Boolean);
            }
        }

        return [];
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
