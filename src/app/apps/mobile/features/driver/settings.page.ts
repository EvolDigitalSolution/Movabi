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
      <ion-toolbar class="px-3 pt-4 bg-slate-50">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>

        <ion-title class="font-display font-black text-slate-950 tracking-tight">
          Driver Settings
        </ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="w-full max-w-xl mx-auto px-3 py-4 space-y-6 pb-24 overflow-x-hidden">
        <div class="relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 p-6 text-white shadow-2xl shadow-slate-900/20">
          <div class="absolute -right-12 -bottom-16 w-48 h-48 rounded-full bg-white/10 blur-2xl"></div>

          <div class="relative z-10">
            <p class="text-white/70 text-[10px] font-black mb-2 uppercase tracking-[0.22em]">
              Account
            </p>

            <h1 class="text-4xl font-display font-black tracking-tight leading-none">
              Driver Settings
            </h1>

            <p class="text-sm text-white/80 font-semibold mt-3 max-w-xs leading-relaxed">
              Manage your region, verification documents, vehicle, payouts, and subscription.
            </p>

            <div class="mt-6 flex flex-wrap gap-2">
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

        <section class="space-y-4">
          <div class="flex items-center gap-3 ml-1">
            <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
            <h2 class="text-xs font-black text-slate-400 uppercase tracking-[0.18em]">Region & Language</h2>
          </div>

          <app-card class="p-5">
            <div class="flex items-center justify-between gap-4">
              <div class="flex items-center gap-4 min-w-0">
                <div class="w-12 h-12 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 border border-blue-100 shrink-0">
                  <ion-icon name="globe-outline" class="text-2xl"></ion-icon>
                </div>

                <div class="min-w-0">
                  <h3 class="text-sm font-black text-slate-950">Current Country</h3>
                  <p class="text-[10px] text-slate-400 font-black uppercase tracking-widest mt-0.5">
                    {{ config.currentCountry().name }}
                  </p>
                </div>
              </div>

              <ion-select
                [value]="config.currentCountry().code"
                (ionChange)="onCountryChange($event)"
                interface="popover"
                class="text-xs font-black text-blue-600 uppercase tracking-widest max-w-[9rem]"
              >
                @for (country of config.countries(); track country.code) {
                  <ion-select-option [value]="country.code">
                    {{ country.name }}
                  </ion-select-option>
                }
              </ion-select>
            </div>
          </app-card>
        </section>

        <section class="space-y-4">
          <div class="flex items-center gap-3 ml-1">
            <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
            <h2 class="text-xs font-black text-slate-400 uppercase tracking-[0.18em]">Verification</h2>
          </div>

          <div class="space-y-3">
            <app-card class="p-5 cursor-pointer active:scale-[0.98] transition-transform" (click)="handleDocumentClick('license')">
              <div class="flex items-center justify-between gap-4">
                <div class="flex items-center gap-4 min-w-0">
                  <div class="w-12 h-12 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 border border-blue-100 shrink-0">
                    <ion-icon name="card-outline" class="text-2xl"></ion-icon>
                  </div>

                  <div class="min-w-0">
                    <h3 class="text-sm font-black text-slate-950">Driver Licence</h3>
                    <p class="text-[10px] text-slate-400 font-black uppercase tracking-widest mt-0.5">
                      {{ docs().license ? 'Document saved' : 'Required for manual review' }}
                    </p>
                  </div>
                </div>

                <app-badge [variant]="docs().license ? 'success' : 'warning'">
                  {{ docs().license ? 'Uploaded' : 'Pending' }}
                </app-badge>
              </div>
            </app-card>

            <app-card class="p-5 cursor-pointer active:scale-[0.98] transition-transform" (click)="handleDocumentClick('insurance')">
              <div class="flex items-center justify-between gap-4">
                <div class="flex items-center gap-4 min-w-0">
                  <div class="w-12 h-12 rounded-2xl bg-emerald-50 flex items-center justify-center text-emerald-600 border border-emerald-100 shrink-0">
                    <ion-icon name="shield-checkmark-outline" class="text-2xl"></ion-icon>
                  </div>

                  <div class="min-w-0">
                    <h3 class="text-sm font-black text-slate-950">Vehicle Insurance</h3>
                    <p class="text-[10px] text-slate-400 font-black uppercase tracking-widest mt-0.5">
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
              <div class="rounded-[1.5rem] border border-amber-100 bg-amber-50 p-4 flex gap-3">
                <ion-icon name="lock-closed-outline" class="text-amber-600 text-xl shrink-0 mt-0.5"></ion-icon>
                <p class="text-sm text-amber-800 font-semibold leading-relaxed">
                  Document changes are locked while your application is under manual review.
                </p>
              </div>
            }
          </div>
        </section>

        <section class="space-y-4">
          <div class="flex items-center gap-3 ml-1">
            <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
            <h2 class="text-xs font-black text-slate-400 uppercase tracking-[0.18em]">Vehicle Details</h2>
          </div>

          <app-card class="p-5 cursor-pointer active:scale-[0.98] transition-transform" (click)="router.navigate(['/driver/onboarding'])">
            <div class="flex items-center justify-between gap-4">
              <div class="flex items-center gap-4 min-w-0">
                <div class="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center text-slate-600 border border-slate-200 shrink-0">
                  <ion-icon name="car-outline" class="text-2xl"></ion-icon>
                </div>

                <div class="min-w-0">
                  <h3 class="text-sm font-black text-slate-950 truncate">{{ vehicleTitle() }}</h3>
                  <p class="text-[10px] text-slate-400 font-black uppercase tracking-widest mt-0.5 truncate">
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

        <section class="space-y-4">
          <div class="flex items-center gap-3 ml-1">
            <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
            <h2 class="text-xs font-black text-slate-400 uppercase tracking-[0.18em]">Payments & Payouts</h2>
          </div>

          <app-card class="p-5">
            <div class="space-y-5">
              <div class="flex items-center justify-between gap-4">
                <div class="flex items-center gap-4 min-w-0">
                  <div class="w-12 h-12 rounded-2xl bg-indigo-50 flex items-center justify-center text-indigo-600 border border-indigo-100 shrink-0">
                    <ion-icon name="wallet-outline" class="text-2xl"></ion-icon>
                  </div>

                  <div class="min-w-0">
                    <h3 class="text-sm font-black text-slate-950">Stripe Connect</h3>
                    <p class="text-[10px] text-slate-400 font-black uppercase tracking-widest mt-0.5">
                      {{ stripeSubtitle() }}
                    </p>
                  </div>
                </div>

                <app-badge [variant]="getStripeBadgeVariant()">
                  {{ getStripeBadgeText() }}
                </app-badge>
              </div>

              @if (!isStripeReady()) {
                <div class="bg-amber-50 rounded-2xl p-4 border border-amber-100 flex gap-3">
                  <ion-icon name="alert-circle-outline" class="text-amber-600 text-xl shrink-0 mt-0.5"></ion-icon>

                  <div class="space-y-3 flex-1">
                    <p class="text-xs text-amber-900 leading-relaxed font-semibold">
                      Complete Stripe onboarding to receive payouts directly to your bank account.
                    </p>

                    <app-button size="sm" class="w-full" [disabled]="loadingStripe()" (clicked)="setupStripe()">
                      {{ loadingStripe() ? 'Opening...' : (isStripePending() ? 'Continue Setup' : 'Complete Setup') }}
                    </app-button>
                  </div>
                </div>
              } @else {
                <div class="grid grid-cols-2 gap-3">
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

        <section class="space-y-4">
          <div class="flex items-center gap-3 ml-1">
            <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
            <h2 class="text-xs font-black text-slate-400 uppercase tracking-[0.18em]">Subscription</h2>
          </div>

          <app-card class="p-5 cursor-pointer active:scale-[0.98] transition-transform" (click)="router.navigate(['/driver/subscription'])">
            <div class="flex items-center justify-between gap-4">
              <div class="flex items-center gap-4 min-w-0">
                <div class="w-12 h-12 rounded-2xl bg-amber-50 flex items-center justify-center text-amber-600 border border-amber-100 shrink-0">
                  <ion-icon name="star-outline" class="text-2xl"></ion-icon>
                </div>

                <div class="min-w-0">
                  <h3 class="text-sm font-black text-slate-950">{{ isProDriver() ? 'Pro Plan' : 'Starter Plan' }}</h3>
                  <p class="text-[10px] text-slate-400 font-black uppercase tracking-widest mt-0.5">
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

        <div class="pt-6">
          <app-button variant="error" class="w-full" (clicked)="confirmDeleteAccount()">
            Delete Account
          </app-button>

          <p class="text-[10px] text-slate-400 font-black uppercase tracking-widest text-center mt-6">
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
        const plate = vehicle.license_plate ? String(vehicle.license_plate).toUpperCase() : '';

        return [year, plate].filter(Boolean).join(' • ') || 'Vehicle details saved';
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

    onCountryChange(event: Event) {
        const customEvent = event as CustomEvent;
        const code = customEvent.detail?.value;

        if (code) {
            this.config.setCountry(code);
        }
    }

    async handleDocumentClick(type: DocType) {
        if (this.isUnderReview()) {
            await this.openDoc(type);
            return;
        }

        await this.uploadDoc(type);
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
            await (this.profileService as any).fetchProfile();
        }
    }

    async confirmDeleteAccount() {
        const alert = await this.alertCtrl.create({
            header: 'Delete Account',
            message: 'Account deletion is permanent. Please contact support if you want your driver account removed.',
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Contact Support',
                    role: 'confirm',
                    handler: () => {
                        window.location.href = 'mailto:support@movabi.com?subject=Driver%20Account%20Deletion%20Request';
                    }
                }
            ]
        });

        await alert.present();
    }

    private isAllowedFile(file: File): boolean {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        const maxBytes = 8 * 1024 * 1024;

        return allowedTypes.includes(file.type) && file.size <= maxBytes;
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