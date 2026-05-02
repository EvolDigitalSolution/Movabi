import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonButton,
    IonContent,
    IonIcon,
    IonRefresher,
    IonRefresherContent,
    NavController,
    AlertController,
    LoadingController,
    ToastController,
    ModalController,
    RefresherCustomEvent
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
    alertCircle,
    calendarOutline,
    checkmark,
    chevronBackOutline,
    star,
    sparklesOutline,
    shieldCheckmarkOutline,
    walletOutline,
    refreshOutline
} from 'ionicons/icons';

import { SubscriptionService } from '@core/services/subscription/subscription.service';
import { Subscription, SubscriptionPlan } from '@shared/models/booking.model';
import { AppConfigService } from '@core/services/config/app-config.service';
import { PlanDetailsModal } from './plan-details.modal';
import { BadgeComponent, ButtonComponent } from '../../../../../shared/ui';

@Component({
    selector: 'app-subscription',
    standalone: true,
    imports: [
        CommonModule,
        IonHeader,
        IonToolbar,
        IonButtons,
        IonBackButton,
        IonTitle,
        IonButton,
        IonContent,
        IonIcon,
        IonRefresher,
        IonRefresherContent,
        BadgeComponent,
        ButtonComponent
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-3 pt-4 bg-slate-50">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>

        <ion-title class="font-display font-black text-slate-950 tracking-tight">
          Subscription
        </ion-title>

        <ion-buttons slot="end">
          <ion-button (click)="showPlanDetails()" class="text-blue-600 font-black text-sm">
            Compare
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <ion-refresher slot="fixed" (ionRefresh)="refresh($event)">
        <ion-refresher-content></ion-refresher-content>
      </ion-refresher>

      <div class="w-full max-w-xl mx-auto px-3 py-4 space-y-6 pb-20 overflow-x-hidden">
        <div
          class="relative overflow-hidden rounded-[2rem] p-6 text-white shadow-2xl"
          [class.bg-gradient-to-br]="true"
          [class.from-emerald-600]="isProActive()"
          [class.via-emerald-700]="isProActive()"
          [class.to-slate-950]="isProActive()"
          [class.shadow-emerald-600/20]="isProActive()"
          [class.from-blue-600]="!isProActive()"
          [class.via-blue-700]="!isProActive()"
          [class.shadow-blue-600/20]="!isProActive()"
        >
          <div class="absolute -right-12 -bottom-16 w-48 h-48 rounded-full bg-white/10 blur-2xl"></div>
          <ion-icon [name]="isProActive() ? 'star' : 'wallet-outline'" class="absolute -right-8 -bottom-8 text-[10rem] text-white/10 rotate-12"></ion-icon>

          <div class="relative z-10">
            <div class="flex items-start justify-between gap-4 mb-8">
              <div>
                <p class="text-white/70 text-[10px] font-black mb-2 uppercase tracking-[0.22em]">
                  Current Plan
                </p>

                <h2 class="text-4xl font-display font-black tracking-tight leading-none">
                  {{ currentPlanName() }}
                </h2>

                <p class="text-sm text-white/80 font-semibold mt-3 max-w-xs leading-relaxed">
                  {{ currentPlanDescription() }}
                </p>
              </div>

              <app-badge [variant]="isProActive() ? 'success' : 'secondary'">
                {{ isProActive() ? 'Pro Active' : 'Starter' }}
              </app-badge>
            </div>

            @if (isProActive() && activeSub()?.current_period_end) {
              <div class="inline-flex items-center px-4 py-2 bg-white/10 rounded-full text-xs font-bold border border-white/20">
                <ion-icon name="calendar-outline" class="mr-2"></ion-icon>
                Renews {{ activeSub()?.current_period_end | date:'mediumDate' }}
              </div>
            } @else {
              <div class="inline-flex items-center px-4 py-2 bg-white/10 rounded-full text-xs font-bold border border-white/20">
                <ion-icon name="shield-checkmark-outline" class="mr-2"></ion-icon>
                No monthly commitment
              </div>
            }
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="bg-white rounded-[1.5rem] p-4 border border-slate-100 shadow-sm">
            <div class="w-10 h-10 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mb-3">
              <ion-icon name="wallet-outline" class="text-xl"></ion-icon>
            </div>
            <p class="text-[9px] uppercase tracking-widest font-black text-slate-400 mb-1">Starter Fee</p>
            <p class="text-lg font-display font-black text-slate-950">15%</p>
            <p class="text-xs text-slate-500 font-semibold">commission</p>
          </div>

          <div class="bg-white rounded-[1.5rem] p-4 border border-slate-100 shadow-sm">
            <div class="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mb-3">
              <ion-icon name="sparkles-outline" class="text-xl"></ion-icon>
            </div>
            <p class="text-[9px] uppercase tracking-widest font-black text-slate-400 mb-1">Pro Fee</p>
            <p class="text-lg font-display font-black text-slate-950">0%</p>
            <p class="text-xs text-slate-500 font-semibold">commission</p>
          </div>
        </div>

        <div class="space-y-4">
          <div class="flex items-center justify-between px-1">
            <div class="flex items-center gap-3">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <div>
                <h3 class="text-xs font-black text-slate-500 uppercase tracking-[0.18em]">
                  Available Plans
                </h3>
                <p class="text-[11px] text-slate-400 font-semibold mt-0.5">
                  Starter is always available
                </p>
              </div>
            </div>

            <button
              type="button"
              (click)="loadAll()"
              class="w-10 h-10 rounded-2xl bg-white border border-slate-100 text-slate-500 flex items-center justify-center shadow-sm active:scale-95 transition-all"
              [disabled]="loading()"
            >
              <ion-icon name="refresh-outline" class="text-xl" [class.animate-spin]="loading()"></ion-icon>
            </button>
          </div>

          <div class="space-y-4">
            <div
              class="bg-white rounded-[2rem] border shadow-sm overflow-hidden relative"
              [class.border-blue-200]="!isProActive()"
              [class.border-slate-100]="isProActive()"
            >
              @if (!isProActive()) {
                <div class="absolute top-5 right-5">
                  <app-badge variant="success">Current Plan</app-badge>
                </div>
              }

              <div class="p-6">
                <div class="mb-6">
                  <h4 class="text-2xl font-display font-black text-slate-950 mb-2">Starter</h4>
                  <div class="flex items-baseline">
                    <span class="text-5xl font-display font-black text-slate-950">{{ formatPrice(0) }}</span>
                    <span class="text-slate-400 font-bold ml-2">/month</span>
                  </div>
                  <p class="text-sm text-slate-500 font-semibold mt-3">
                    Default plan for all drivers. No subscription required.
                  </p>
                </div>

                <div class="space-y-4 mb-6">
                  @for (feature of starterFeatures; track feature) {
                    <div class="flex items-center text-slate-600 font-semibold">
                      <div class="w-6 h-6 bg-blue-50 rounded-full flex items-center justify-center mr-3 border border-blue-100 shrink-0">
                        <ion-icon name="checkmark" class="text-blue-600 text-sm"></ion-icon>
                      </div>
                      {{ feature }}
                    </div>
                  }
                </div>

                @if (!isProActive()) {
                  <div class="w-full h-14 rounded-2xl bg-slate-50 flex items-center justify-center text-slate-400 font-black uppercase tracking-widest border border-slate-100">
                    Active
                  </div>
                } @else {
                  <app-button variant="secondary" size="lg" class="w-full h-14 rounded-2xl" (clicked)="manageSubscription()">
                    Switch to Starter
                  </app-button>
                }
              </div>
            </div>

            @if (loading() && plans().length === 0) {
              <div class="bg-white rounded-[2rem] border border-slate-100 shadow-sm p-6 space-y-4">
                <div class="h-20 bg-slate-100 rounded-2xl animate-pulse"></div>
                <div class="h-20 bg-slate-100 rounded-2xl animate-pulse"></div>
              </div>
            }

            @for (plan of proPlans(); track plan.id || plan.stripe_price_id || plan.plan_code) {
              <div
                class="bg-white rounded-[2rem] border-2 shadow-xl overflow-hidden relative"
                [class.border-blue-600]="activeSub()?.stripe_price_id !== plan.stripe_price_id"
                [class.shadow-blue-600/10]="activeSub()?.stripe_price_id !== plan.stripe_price_id"
                [class.border-emerald-500]="activeSub()?.stripe_price_id === plan.stripe_price_id"
                [class.shadow-emerald-500/10]="activeSub()?.stripe_price_id === plan.stripe_price_id"
              >
                <div class="absolute top-5 right-5">
                  <app-badge [variant]="activeSub()?.stripe_price_id === plan.stripe_price_id ? 'success' : 'primary'">
                    {{ activeSub()?.stripe_price_id === plan.stripe_price_id ? 'Current Plan' : 'Optional Upgrade' }}
                  </app-badge>
                </div>

                <div class="p-6">
                  <div class="mb-6 pr-20">
                    <h4 class="text-2xl font-display font-black text-slate-950 mb-2">
                      {{ plan.display_name || 'Pro' }}
                    </h4>

                    <div class="flex items-baseline">
                      <span class="text-5xl font-display font-black text-slate-950">
                        {{ formatPrice(planAmount(plan)) }}
                      </span>
                      <span class="text-slate-400 font-bold ml-2">
                        /{{ formatInterval(plan.interval) }}
                      </span>
                    </div>

                    <p class="text-sm text-slate-500 font-semibold mt-3">
                      Keep 100% of request fares while your subscription is active.
                    </p>
                  </div>

                  <div class="space-y-4 mb-6">
                    @for (feature of getPlanFeatures(plan); track feature) {
                      <div class="flex items-center text-slate-600 font-semibold">
                        <div class="w-6 h-6 bg-emerald-50 rounded-full flex items-center justify-center mr-3 border border-emerald-100 shrink-0">
                          <ion-icon name="checkmark" class="text-emerald-600 text-sm"></ion-icon>
                        </div>
                        {{ feature }}
                      </div>
                    }
                  </div>

                  <app-button
                    variant="primary"
                    size="lg"
                    class="w-full h-14 rounded-2xl shadow-xl shadow-blue-600/20"
                    [disabled]="loading()"
                    (clicked)="subscribe(plan.stripe_price_id || '')"
                  >
                    {{ activeSub()?.stripe_price_id === plan.stripe_price_id ? 'Manage Subscription' : 'Subscribe to Pro' }}
                  </app-button>
                </div>
              </div>
            }

            @if (!loading() && proPlans().length === 0) {
              <div class="bg-white rounded-[2rem] border border-slate-100 shadow-sm p-6 text-center">
                <ion-icon name="alert-circle" class="text-4xl text-amber-500 mb-3"></ion-icon>
                <h4 class="font-display font-black text-slate-950 text-lg">No Pro plan available</h4>
                <p class="text-sm text-slate-500 font-semibold mt-2">
                  Starter remains active. Pro plans will appear here once configured.
                </p>
              </div>
            }
          </div>
        </div>

        @if (isProActive()) {
          <div class="pt-2 text-center">
            <app-button variant="secondary" size="lg" [fullWidth]="false" (clicked)="manageSubscription()" class="px-8">
              Manage Billing
            </app-button>
          </div>
        }
      </div>
    </ion-content>
  `
})
export class SubscriptionPage implements OnInit {
    private subscriptionService = inject(SubscriptionService);
    private alertCtrl = inject(AlertController);
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);
    private modalCtrl = inject(ModalController);
    private config = inject(AppConfigService);
    public nav = inject(NavController);

    activeSub = signal<Subscription | null>(null);
    plans = signal<SubscriptionPlan[]>([]);
    loading = signal(false);

    starterFeatures = [
        'Pay as you earn',
        '15% service commission',
        'Standard request matching',
        'No monthly subscription'
    ];

    proPlans = computed(() => {
        return this.plans().filter((plan) => String(plan.plan_code || '').toLowerCase() === 'pro');
    });

    isProActive = computed(() => {
        const sub = this.activeSub();
        if (!sub) return false;

        const status = String(sub.status || '').toLowerCase();
        return ['active', 'trialing'].includes(status) && !!sub.stripe_price_id;
    });

    currentPlanName = computed(() => {
        if (!this.isProActive()) return 'Starter';

        const plan = this.plans().find((item) => item.stripe_price_id === this.activeSub()?.stripe_price_id);
        return plan?.display_name || 'Pro';
    });

    currentPlanDescription = computed(() => {
        if (!this.isProActive()) {
            return 'You are on the default Starter plan. Pay commission only when you earn.';
        }

        return 'Your Pro subscription is active. You keep 100% of eligible request fares.';
    });

    constructor() {
        addIcons({
            alertCircle,
            calendarOutline,
            checkmark,
            chevronBackOutline,
            star,
            sparklesOutline,
            shieldCheckmarkOutline,
            walletOutline,
            refreshOutline
        });
    }

    async ngOnInit() {
        await this.loadAll();
    }

    async loadAll() {
        if (this.loading()) return;

        this.loading.set(true);

        try {
            await Promise.all([
                this.loadSubscription(),
                this.loadPlans()
            ]);
        } finally {
            this.loading.set(false);
        }
    }

    async refresh(event: RefresherCustomEvent) {
        try {
            await Promise.all([
                this.loadSubscription(),
                this.loadPlans()
            ]);
        } finally {
            event.target.complete();
        }
    }

    async loadSubscription() {
        try {
            const sub = await this.subscriptionService.checkSubscription();
            this.activeSub.set(sub);
        } catch {
            this.activeSub.set(null);
        }
    }

    async loadPlans() {
        try {
            const countryCode = this.config.currentCountry().code;
            const currencyCode = this.config.currencyCode;
            const plans = await this.subscriptionService.getAvailablePlans(countryCode, currencyCode);
            this.plans.set(plans || []);
        } catch {
            this.plans.set([]);
            await this.showToast('Could not load subscription plans.', 'warning');
        }
    }

    formatPrice(amount: number | null | undefined) {
        return this.config.formatCurrency(Number(amount || 0));
    }

    planAmount(plan: SubscriptionPlan): number {
        return Number((plan as any)?.amount ?? (plan as any)?.price ?? 0);
    }

    formatInterval(interval: string | null | undefined): string {
        const value = String(interval || 'month').toLowerCase();

        if (value === 'week') return 'week';
        if (value === 'month') return 'month';
        if (value === 'year') return 'year';

        return value;
    }

    getPlanFeatures(plan: SubscriptionPlan): string[] {
        const features = Array.isArray((plan as any)?.features) ? (plan as any).features : [];

        if (features.length > 0) {
            return features.map((feature: unknown) => String(feature));
        }

        return [
            '0% service commission',
            'Priority request matching',
            'Pro driver badge',
            'Premium support'
        ];
    }

    async showPlanDetails() {
        const modal = await this.modalCtrl.create({
            component: PlanDetailsModal,
            breakpoints: [0, 0.9],
            initialBreakpoint: 0.9,
            handle: true,
            componentProps: {
                plans: this.plans()
            }
        });

        await modal.present();
    }

    async subscribe(priceId: string) {
        if (!priceId) {
            await this.showToast('This plan is missing a Stripe Price ID.', 'warning');
            return;
        }

        if (this.activeSub()?.stripe_price_id === priceId) {
            await this.manageSubscription();
            return;
        }

        const alert = await this.alertCtrl.create({
            header: 'Subscribe to Pro',
            message: 'You will be redirected to Stripe to complete your subscription securely.',
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Continue',
                    handler: () => {
                        void this.startCheckout(priceId);
                    }
                }
            ]
        });

        await alert.present();
    }

    private async startCheckout(priceId: string) {
        const loading = await this.loadingCtrl.create({ message: 'Redirecting to Stripe...' });
        await loading.present();

        try {
            const countryCode = this.config.currentCountry().code;
            const currencyCode = this.config.currencyCode;
            const url = await this.subscriptionService.createCheckoutSession(priceId, countryCode, currencyCode);
            window.location.href = url;
        } catch {
            await this.showToast('Failed to start checkout. Please try again.', 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    async manageSubscription() {
        const loading = await this.loadingCtrl.create({ message: 'Opening billing portal...' });
        await loading.present();

        try {
            await this.subscriptionService.openCustomerPortal();
        } catch {
            await this.showToast('Failed to open billing portal.', 'danger');
        } finally {
            await loading.dismiss();
        }
    }

    private async showToast(message: string, color: 'success' | 'danger' | 'warning') {
        const toast = await this.toastCtrl.create({
            message,
            duration: 2600,
            color,
            position: 'top'
        });

        await toast.present();
    }
}