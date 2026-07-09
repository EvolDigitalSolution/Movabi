import {
    Component,
    inject,
    OnInit,
    AfterViewInit,
    signal,
    OnDestroy,
    effect,
    ElementRef,
    ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, ToastController, LoadingController } from '@ionic/angular';
import { ActivatedRoute, Router } from '@angular/router';
import { addIcons } from 'ionicons';
import {
    chevronBackOutline,
    cardOutline,
    walletOutline,
    checkmarkCircleOutline,
    alertCircleOutline,
    lockClosedOutline,
    sparklesOutline,
    timeOutline,
    navigateOutline,
    personOutline,
    checkmarkOutline
} from 'ionicons/icons';
import { SupabaseService } from '../../../../../core/services/supabase/supabase.service';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';
import { BookingService } from '../../../../../core/services/booking/booking.service';
import { PaymentService } from '../../../../../core/services/stripe/payment.service';
import { WalletService } from '../../../../../core/services/wallet/wallet.service';
import { AuthService } from '../../../../../core/services/auth/auth.service';
import { Booking } from '../../../../../shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';
import { StripeCardElement } from '@stripe/stripe-js';

@Component({
    selector: 'app-marketplace-payment',
    standalone: true,
    imports: [CommonModule, IonicModule],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 bg-white">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-slate-900">Payment Confirmation</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="movabi-page" [fullscreen]="true">
      @if (redirectingToTracking()) {
        <div class="h-full flex items-center justify-center p-6">
          <div class="text-center">
            <ion-spinner name="crescent" class="text-amber-500 mb-3"></ion-spinner>
            <p class="text-slate-600 font-semibold">Opening tracking...</p>
          </div>
        </div>
      } @else if (booking(); as job) {
        <div class="ion-padding">
          <!-- Fare Locked Animation Card -->
          <div class="bg-gradient-to-br from-emerald-50 to-green-50 rounded-3xl border border-emerald-200 shadow-lg p-6 mb-6 relative overflow-hidden">
            <div class="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-emerald-200/30 to-transparent rounded-full -mr-16 -mt-16"></div>
            <div class="relative">
              <div class="flex items-center justify-center mb-4">
                <div class="w-16 h-16 bg-emerald-500 rounded-full flex items-center justify-center animate-pulse">
                  <ion-icon name="lock-closed-outline" class="text-white text-2xl"></ion-icon>
                </div>
              </div>
              <h2 class="text-xl font-bold text-emerald-900 text-center mb-2">Fare Successfully Locked!</h2>
              <p class="text-emerald-700 text-center mb-4">Your agreed fare has been secured. Complete payment to confirm your booking.</p>
              
              <div class="bg-white/60 backdrop-blur rounded-2xl p-4 border border-emerald-100 space-y-3">
                @if (isErrand()) {
                  <div class="flex items-center justify-between">
                    <span class="text-sm font-medium text-emerald-600">Shopping Budget Reserved</span>
                    <span class="text-lg font-display font-bold text-emerald-900">{{ formatPrice(itemBudget()) }}</span>
                  </div>
                }
                <div class="flex items-center justify-between">
                  <span class="text-sm font-medium text-emerald-600">Service Fare</span>
                  <span class="text-lg font-display font-bold text-emerald-900">{{ formatPrice(serviceFare()) }}</span>
                </div>
                <div class="h-px bg-emerald-100"></div>
                <div class="flex items-center justify-between">
                  <span class="text-sm font-bold text-emerald-800">{{ isErrand() ? 'Total Authorisation' : 'Total to Pay' }}</span>
                  <div class="flex items-center gap-1">
                    <ion-icon name="sparkles-outline" class="text-emerald-500 text-sm"></ion-icon>
                    <span class="text-3xl font-display font-black text-emerald-900">{{ formatPrice(paymentTotal()) }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Enhanced Fare Breakdown -->
          @if (fareBreakdown()) {
            <div class="bg-white rounded-3xl border border-slate-200 shadow-md p-5 mb-6">
              <button
                type="button"
                (click)="showBreakdown.set(!showBreakdown())"
                class="w-full flex items-center justify-between text-left"
              >
                <span class="text-xs font-bold text-slate-500 uppercase tracking-wider">Fare Breakdown</span>
                <span class="text-sm font-bold text-amber-600">{{ showBreakdown() ? 'Hide fare breakdown' : 'View fare breakdown' }}</span>
              </button>
              @if (showBreakdown()) {
              <div class="space-y-3 mt-4">
                @if (fareBreakdown().baseFare !== undefined) {
                  <div class="flex justify-between items-center">
                    <div class="flex items-center gap-2">
                      <div class="w-2 h-2 bg-slate-400 rounded-full"></div>
                      <span class="text-sm text-slate-600">Base fare</span>
                    </div>
                    <span class="font-semibold text-slate-900">{{ formatPrice(fareBreakdown().baseFare) }}</span>
                  </div>
                }
                @if (fareBreakdown().distanceCost !== undefined) {
                  <div class="flex justify-between items-center">
                    <div class="flex items-center gap-2">
                      <div class="w-2 h-2 bg-blue-400 rounded-full"></div>
                      <span class="text-sm text-slate-600">Distance</span>
                    </div>
                    <span class="font-semibold text-slate-900">{{ formatPrice(fareBreakdown().distanceCost) }}</span>
                  </div>
                }
                @if (fareBreakdown().durationCost !== undefined) {
                  <div class="flex justify-between items-center">
                    <div class="flex items-center gap-2">
                      <div class="w-2 h-2 bg-sky-400 rounded-full"></div>
                      <span class="text-sm text-slate-600">Time</span>
                    </div>
                    <span class="font-semibold text-slate-900">{{ formatPrice(fareBreakdown().durationCost) }}</span>
                  </div>
                }
                @if (fareBreakdown().dynamicPricingAmount) {
                  <div class="flex justify-between items-center">
                    <div class="flex items-center gap-2">
                      <div class="w-2 h-2 bg-amber-400 rounded-full"></div>
                      <span class="text-sm text-slate-600">Dynamic pricing</span>
                    </div>
                    <span class="font-semibold text-amber-700">{{ formatPrice(fareBreakdown().dynamicPricingAmount) }}</span>
                  </div>
                }
                @if (fareBreakdown().platformFee !== undefined) {
                  <div class="flex justify-between items-center">
                    <div class="flex items-center gap-2">
                      <div class="w-2 h-2 bg-purple-400 rounded-full"></div>
                      <span class="text-sm text-slate-600">Platform fee</span>
                    </div>
                    <span class="font-semibold text-slate-900">{{ formatPrice(fareBreakdown().platformFee) }}</span>
                  </div>
                }
                @if (isErrand() && itemBudget() > 0) {
                  <div class="flex justify-between items-center pt-2 border-t border-slate-100">
                    <div class="flex items-center gap-2">
                      <div class="w-2 h-2 bg-emerald-400 rounded-full"></div>
                      <span class="text-sm text-slate-600">Shopping budget reserved</span>
                    </div>
                    <span class="font-semibold text-emerald-700">{{ formatPrice(itemBudget()) }}</span>
                  </div>
                }
              </div>
               
              <!-- Trip Details -->
              <div class="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-slate-100">
                <div class="bg-slate-50 rounded-xl p-3">
                  <div class="flex items-center gap-2 text-slate-600 mb-1">
                    <ion-icon name="navigate-outline" class="text-amber-500 text-sm"></ion-icon>
                    <span class="text-xs font-medium">Distance</span>
                  </div>
                  <p class="text-lg font-bold text-slate-900">{{ (booking()?.distance_km || 0).toFixed(1) }} km</p>
                </div>
                <div class="bg-slate-50 rounded-xl p-3">
                  <div class="flex items-center gap-2 text-slate-600 mb-1">
                    <ion-icon name="time-outline" class="text-amber-500 text-sm"></ion-icon>
                    <span class="text-xs font-medium">Duration</span>
                  </div>
                  <p class="text-lg font-bold text-slate-900">{{ formatDuration(booking()?.duration_seconds) }}</p>
                </div>
              </div>
              }
            </div>
          }

          <!-- Enhanced Wallet Payment -->
          @if (wallet() && wallet().available_balance >= paymentTotal()) {
            <div class="bg-gradient-to-br from-emerald-50 to-green-50 border border-emerald-200 rounded-3xl p-5 mb-6">
              <div class="flex items-center gap-3 mb-4">
                <div class="w-12 h-12 bg-emerald-500 rounded-full flex items-center justify-center">
                  <ion-icon name="wallet-outline" class="text-white text-xl"></ion-icon>
                </div>
                <div>
                  <p class="font-bold text-emerald-900">Wallet Payment Available</p>
                  <p class="text-sm text-emerald-700">Current balance: {{ formatPrice(wallet().available_balance) }}</p>
                </div>
              </div>
              <button
                type="button"
                (click)="payWithWallet()"
                [disabled]="paymentProcessing()"
                class="w-full py-4 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-2xl font-bold text-base active:scale-95 transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                @if (paymentProcessing()) {
                  <ion-spinner name="crescent"></ion-spinner>
                  <span>Processing payment...</span>
                } @else {
                  <ion-icon name="wallet-outline"></ion-icon>
                  <span>Pay {{ formatPrice(paymentTotal()) }} from Wallet</span>
                }
              </button>
            </div>
          }

          <!-- Enhanced Card Payment -->
          <div class="bg-white rounded-3xl border border-slate-200 shadow-md p-5 mb-6">
            <div class="flex items-center gap-3 mb-4">
              <div class="w-12 h-12 bg-blue-500 rounded-full flex items-center justify-center">
                <ion-icon name="card-outline" class="text-white text-xl"></ion-icon>
              </div>
              <div>
                <p class="font-bold text-slate-900">Card Payment</p>
                <p class="text-sm text-slate-600">Pay securely with credit/debit card</p>
              </div>
            </div>
            
            <div class="mb-4">
              @if (!cardReady()) {
                <div class="p-4 border-2 border-slate-200 rounded-2xl bg-slate-50 flex items-center gap-3">
                  <ion-spinner name="crescent" class="text-blue-500"></ion-spinner>
                  <span class="text-sm text-slate-500">Loading card input...</span>
                </div>
              }
              <div
                #cardElementHost
                class="p-4 border-2 border-slate-200 rounded-2xl bg-slate-50 focus-within:border-blue-500 focus-within:bg-white transition-all"
              ></div>
            </div>

            <button
              type="button"
              (click)="payWithCard()"
              [disabled]="paymentProcessing() || !cardComplete() || !cardReady()"
              class="w-full py-4 bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-2xl font-bold text-base active:scale-95 transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              @if (paymentProcessing()) {
                <ion-spinner name="crescent"></ion-spinner>
                <span>Processing payment...</span>
              } @else {
                <ion-icon name="card-outline"></ion-icon>
                <span>Pay {{ formatPrice(paymentTotal()) }} with Card</span>
              }
            </button>
          </div>

          <!-- Enhanced Error Display -->
          @if (paymentError()) {
            <div class="bg-gradient-to-br from-red-50 to-pink-50 border border-red-200 rounded-3xl p-5 flex items-start gap-4">
              <div class="w-10 h-10 bg-red-500 rounded-full flex items-center justify-center flex-shrink-0">
                <ion-icon name="alert-circle-outline" class="text-white text-xl"></ion-icon>
              </div>
              <div>
                <p class="font-bold text-red-900 mb-1">Payment Failed</p>
                <p class="text-sm text-red-700">{{ paymentError() }}</p>
                <button 
                  (click)="paymentError.set(null)" 
                  class="mt-3 text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          }
        </div>
      } @else {
        <div class="h-full flex items-center justify-center p-6">
          <p class="text-slate-500 font-semibold">Loading payment details...</p>
        </div>
      }
    </ion-content>
  `
})
export class MarketplacePaymentPage implements OnInit, AfterViewInit, OnDestroy {
    private route = inject(ActivatedRoute);
    private router = inject(Router);
    private supabase = inject(SupabaseService);
    private config = inject(AppConfigService);
    private bookingService = inject(BookingService);
    private paymentService = inject(PaymentService);
    private walletService = inject(WalletService);
    private auth = inject(AuthService);
    private toastCtrl = inject(ToastController);
    private loadingCtrl = inject(LoadingController);

    private cardElementHost: ElementRef<HTMLDivElement> | null = null;

    @ViewChild('cardElementHost')
    set cardElementHostRef(ref: ElementRef<HTMLDivElement> | undefined) {
        if (ref && !this.cardElementHost) {
            this.cardElementHost = ref;
            void this.initializeStripe();
        } else if (!ref) {
            this.cardMounted = false;
            this.cardReady.set(false);
            this.cardComplete.set(false);
            this.cardElementHost = null;
        }
    }

    booking = signal<Booking | null>(null);
    wallet = signal<any>(null);
    paymentProcessing = signal(false);
    paymentError = signal<string | null>(null);
    cardError = signal<string | null>(null);
    cardComplete = signal(false);
    cardReady = signal(false);
    redirectingToTracking = signal(false);
    showBreakdown = signal(false);
    private jobChannel?: RealtimeChannel;
    private card: StripeCardElement | null = null;
    private cardMounted = false;
    private stripeInitializing = false;

    constructor() {
        addIcons({
            chevronBackOutline,
            cardOutline,
            walletOutline,
            checkmarkCircleOutline,
            alertCircleOutline,
            lockClosedOutline,
            sparklesOutline,
            timeOutline,
            navigateOutline,
            personOutline,
            checkmarkOutline
        });

        effect(() => {
            const job = this.booking();
            if (this.isPaymentHandled(job)) {
                this.redirectToTracking(job!.id);
            }
        });
    }

    async ngOnInit() {
        const id = this.route.snapshot.paramMap.get('id');
        if (!id) {
            await this.router.navigate(['/customer']);
            return;
        }

        await this.loadBooking(id);
        await this.loadWallet();
        this.subscribeToJob(id);
    }

    async ngAfterViewInit() {
        if (this.redirectingToTracking() || this.isPaymentHandled(this.booking())) return;
        await this.initializeStripe();
    }

    ngOnDestroy() {
        this.jobChannel?.unsubscribe();
        if (this.card) {
            this.card.destroy();
            this.card = null;
        }
        this.cardMounted = false;
    }

    isErrand(): boolean {
        return String(this.booking()?.service_slug || '').toLowerCase() === 'errand';
    }

    serviceFare(): number {
        const job = this.booking();
        return Number(job?.agreed_fare || job?.total_price || 0);
    }

    itemBudget(): number {
        if (!this.isErrand()) return 0;
        const job = this.booking();
        return Number(
            job?.errand_funding?.amount_reserved ||
            job?.errand_details?.estimated_budget ||
            0
        );
    }

    paymentTotal(): number {
        return this.serviceFare() + this.itemBudget();
    }

    // Backward-compatible alias used by existing UI references
    agreedFare() {
        return this.serviceFare();
    }

    fareBreakdown() {
        return (this.booking() as any)?.fare_breakdown || null;
    }

    formatPrice(amount: number | string | null | undefined): string {
        const value = Number(amount || 0);
        return this.config.formatCurrency(value);
    }

    formatDuration(seconds: number | null | undefined): string {
        if (!seconds) return '—';
        const mins = Math.round(seconds / 60);
        return `${mins} min`;
    }

    async payWithWallet() {
        const job = this.booking();
        if (!job || !this.wallet()) return;

        if (this.isPaymentHandled(job)) {
            await this.redirectToTracking(job.id);
            return;
        }

        this.paymentProcessing.set(true);
        this.paymentError.set(null);

        const loading = await this.loadingCtrl.create({
            message: 'Processing wallet payment...'
        });

        try {
            await loading.present();

            if (this.isErrand() && this.itemBudget() > 0) {
                await this.walletService.reserveErrandFunds(
                    job.id,
                    this.itemBudget(),
                    this.serviceFare()
                );
            } else {
                await this.walletService.payJobFromWallet(
                    job.id,
                    this.paymentTotal(),
                    job.currency_code || 'GBP'
                );
            }

            await this.bookingService.confirmJobPayment(job.id, 'wallet_funded');

            await loading.dismiss();
            await this.showToast('Payment successful! Finding your driver...', 'success');

            // Navigate to tracking - the effect will handle the transition
            await this.router.navigate(['/customer/tracking', job.id]);
        } catch (error: any) {
            console.error('[MarketplacePayment] wallet payment failed', error);
            this.paymentError.set(error.message || 'Wallet payment failed. Please try again.');
            await this.showToast('Payment failed. Please try again.', 'danger');
            try { await loading.dismiss(); } catch { /* noop */ }
        } finally {
            this.paymentProcessing.set(false);
        }
    }

    async payWithCard() {
        const job = this.booking();
        if (!job || !this.card || !this.cardReady()) return;

        if (this.isPaymentHandled(job)) {
            await this.redirectToTracking(job.id);
            return;
        }

        if (!this.cardComplete()) {
            this.paymentError.set('Please complete your card details.');
            await this.showToast('Please complete your card details.', 'danger');
            return;
        }

        this.paymentProcessing.set(true);
        this.paymentError.set(null);

        const loading = await this.loadingCtrl.create({
            message: 'Initializing card payment...'
        });

        try {
            await loading.present();

            loading.message = 'Creating payment intent...';
            const { clientSecret } = await this.paymentService.createPaymentIntent(
                job.id,
                this.paymentTotal(),
                job.currency_code || 'GBP',
                this.auth.tenantId() || '',
                1
            );

            loading.message = 'Charging card...';
            // Use the same shared confirmPayment path as booking-request
            const paymentIntent = await this.paymentService.confirmPayment(clientSecret, this.card);

            if (
                paymentIntent.status === 'succeeded' ||
                paymentIntent.status === 'requires_capture'
            ) {
                loading.message = 'Activating booking...';
                await this.bookingService.confirmJobPayment(job.id, paymentIntent.id);
                await loading.dismiss();
                await this.showToast('Payment successful! Finding your driver...', 'success');
                await this.router.navigate(['/customer/tracking', job.id]);
            } else {
                throw new Error(`Payment not completed (status: ${paymentIntent.status})`);
            }
        } catch (error: any) {
            console.error('[MarketplacePayment] card payment failed', error);
            this.paymentError.set(error.message || 'Card payment failed. Please try again.');
            await this.showToast('Payment failed. Please try again.', 'danger');
            try { await loading.dismiss(); } catch { /* noop */ }
        } finally {
            this.paymentProcessing.set(false);
        }
    }

    private isPaymentHandled(job: Booking | null | undefined): boolean {
        if (!job) return false;

        return [
            'paid_ready_for_dispatch',
            'active',
            'completed',
            'cancelled'
        ].includes(this.bookingService.getBookingLifecycleState(job));
    }

    private async redirectToTracking(jobId: string): Promise<void> {
        if (this.redirectingToTracking()) return;
        this.redirectingToTracking.set(true);
        console.log('[MarketplacePayment] job already paid, redirecting to tracking', jobId);
        await this.router.navigate(['/customer/tracking', jobId], { replaceUrl: true });
    }

    private async loadBooking(id: string) {
        try {
            const job = await this.bookingService.getBooking(id);
            this.booking.set(job);
            if (this.isPaymentHandled(job)) await this.redirectToTracking(id);
        } catch (error) {
            console.error('[MarketplacePayment] load booking failed', error);
            await this.showToast('Could not load booking details.', 'danger');
            await this.router.navigate(['/customer']);
        }
    }

    private async loadWallet() {
        try {
            const walletData = await this.walletService.fetchWallet();
            this.wallet.set(walletData);
        } catch (error) {
            console.error('[MarketplacePayment] load wallet failed', error);
        }
    }

    private async initializeStripe() {
        if (this.cardMounted || this.stripeInitializing) return;
        if (this.redirectingToTracking() || this.isPaymentHandled(this.booking())) return;
        if (!this.cardElementHost?.nativeElement) return;

        this.stripeInitializing = true;
        this.cardReady.set(false);
        this.cardComplete.set(false);
        this.cardError.set(null);

        try {
            const stripe = await this.paymentService.getStripe();
            if (!stripe) {
                this.cardError.set('Payment service is unavailable right now.');
                return;
            }

            if (!this.card) {
                const elements = stripe.elements();
                this.card = elements.create('card', {
                    hidePostalCode: true,
                    style: {
                        base: {
                            fontSize: '16px',
                            color: '#0f172a',
                            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
                            lineHeight: '24px',
                            '::placeholder': { color: '#94a3b8' }
                        },
                        invalid: { color: '#ef4444', iconColor: '#ef4444' }
                    }
                });

                this.card.on('ready', () => {
                    this.cardReady.set(true);
                    this.cardError.set(null);
                });

                this.card.on('change', (event: any) => {
                    this.cardError.set(event.error?.message ?? null);
                    this.cardComplete.set(!!event.complete && !event.error);
                });
            }

            this.card.mount(this.cardElementHost.nativeElement);
            this.cardMounted = true;
        } catch (error) {
            console.error('[MarketplacePayment] Stripe init failed', error);
            this.paymentError.set('Unable to load card input right now.');
            this.cardReady.set(false);
            this.cardMounted = false;
        } finally {
            this.stripeInitializing = false;
        }
    }

    private subscribeToJob(id: string) {
        this.jobChannel = this.supabase
            .channel(`marketplace-payment-${id}`)
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'jobs',
                filter: `id=eq.${id}`
            }, payload => {
                const current = this.booking();
                if (current) {
                    this.booking.set({ ...current, ...payload.new } as Booking);
                }
            })
            .subscribe();
    }

    private async showToast(message: string, color: 'success' | 'warning' | 'danger' = 'success') {
        try {
            const toast = await this.toastCtrl.create({ message, duration: 3000, position: 'top', color });
            await toast.present();
        } catch (error) {
            console.warn('[MarketplacePayment] toast failed', error);
        }
    }
}
