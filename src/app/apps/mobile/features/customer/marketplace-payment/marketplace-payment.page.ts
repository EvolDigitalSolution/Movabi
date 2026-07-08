import {
    Component,
    inject,
    OnInit,
    signal,
    OnDestroy,
    effect
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
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
import { loadStripe, Stripe } from '@stripe/stripe-js';
import { environment } from '../../../../../../environments/environment';

@Component({
    selector: 'app-marketplace-payment',
    standalone: true,
    imports: [CommonModule, FormsModule, IonicModule],
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
      @if (booking(); as job) {
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
              
              <div class="bg-white/60 backdrop-blur rounded-2xl p-4 border border-emerald-100">
                <div class="flex items-center justify-between mb-2">
                  <span class="text-sm font-medium text-emerald-600">Final Agreed Fare</span>
                  <div class="flex items-center gap-1">
                    <ion-icon name="sparkles-outline" class="text-emerald-500 text-sm"></ion-icon>
                    <span class="text-3xl font-display font-black text-emerald-900">{{ formatPrice(job.agreed_fare || job.total_price || 0) }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Enhanced Fare Breakdown -->
          @if (fareBreakdown()) {
            <div class="bg-white rounded-3xl border border-slate-200 shadow-md p-5 mb-6">
              <p class="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">Fare Breakdown</p>
              <div class="space-y-3">
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
            </div>
          }

          <!-- Enhanced Wallet Payment -->
          @if (wallet() && wallet().available_balance >= agreedFare()) {
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
                  <span>Pay {{ formatPrice(agreedFare()) }} from Wallet</span>
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
              <div id="card-element" class="p-4 border-2 border-slate-200 rounded-2xl bg-slate-50 focus-within:border-blue-500 focus-within:bg-white transition-all">
                <!-- Stripe Elements will be mounted here -->
              </div>
            </div>

            <button
              type="button"
              (click)="payWithCard()"
              [disabled]="paymentProcessing() || !cardComplete()"
              class="w-full py-4 bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-2xl font-bold text-base active:scale-95 transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              @if (paymentProcessing()) {
                <ion-spinner name="crescent"></ion-spinner>
                <span>Processing payment...</span>
              } @else {
                <ion-icon name="card-outline"></ion-icon>
                <span>Pay {{ formatPrice(agreedFare()) }} with Card</span>
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
export class MarketplacePaymentPage implements OnInit, OnDestroy {
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

    booking = signal<Booking | null>(null);
    wallet = signal<any>(null);
    paymentProcessing = signal(false);
    paymentError = signal<string | null>(null);
    private jobChannel?: RealtimeChannel;
    private stripe: Stripe | null = null;
    private cardElement: any = null;
    cardComplete = signal(false);

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
            if (job?.status === 'searching' || job?.status === 'assigned') {
                // Payment successful and job is being dispatched
                this.router.navigate(['/customer/tracking', job.id]);
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
        await this.initializeStripe();
    }

    ngOnDestroy() {
        this.jobChannel?.unsubscribe();
        if (this.cardElement) {
            this.cardElement.destroy();
        }
    }

    agreedFare() {
        const job = this.booking();
        return job?.agreed_fare || job?.total_price || 0;
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

        this.paymentProcessing.set(true);
        this.paymentError.set(null);

        try {
            const loading = await this.loadingCtrl.create({
                message: 'Processing wallet payment...'
            });
            await loading.present();

            await this.walletService.payJobFromWallet(
                job.id,
                this.agreedFare(),
                job.currency_code || 'GBP'
            );

            await this.bookingService.confirmJobPayment(job.id, 'wallet_funded');

            await loading.dismiss();
            await this.showToast('Payment successful! Finding your driver...', 'success');
            
            // Navigate to tracking - the effect will handle the transition
            await this.router.navigate(['/customer/tracking', job.id]);
        } catch (error: any) {
            console.error('[MarketplacePayment] wallet payment failed', error);
            this.paymentError.set(error.message || 'Wallet payment failed. Please try again.');
            await this.showToast('Payment failed. Please try again.', 'danger');
        } finally {
            this.paymentProcessing.set(false);
        }
    }

    async payWithCard() {
        const job = this.booking();
        if (!job || !this.stripe || !this.cardElement) return;

        this.paymentProcessing.set(true);
        this.paymentError.set(null);

        try {
            const loading = await this.loadingCtrl.create({
                message: 'Processing card payment...'
            });
            await loading.present();

            // Create payment intent with agreed fare
            const { clientSecret } = await this.paymentService.createPaymentIntent(
                job.id,
                this.agreedFare(),
                job.currency_code || 'GBP',
                this.auth.tenantId() || '',
                1 // surge multiplier (not relevant for marketplace)
            );

            // Confirm payment with Stripe
            const { error: stripeError, paymentIntent } = await this.stripe.confirmCardPayment(clientSecret, {
                payment_method: {
                    card: this.cardElement,
                    billing_details: {
                        address: {
                            country: job.country_code || 'GB'
                        }
                    }
                }
            });

            if (stripeError) {
                throw new Error(stripeError.message);
            }

            if (paymentIntent?.status === 'succeeded' || paymentIntent?.status === 'requires_capture') {
                await this.bookingService.confirmJobPayment(job.id, paymentIntent.id);
                await loading.dismiss();
                await this.showToast('Payment successful! Finding your driver...', 'success');

                // Navigate to tracking - the effect will handle the transition
                await this.router.navigate(['/customer/tracking', job.id]);
            } else {
                throw new Error(`Payment was not successful (status: ${paymentIntent?.status || 'unknown'})`);
            }
        } catch (error: any) {
            console.error('[MarketplacePayment] card payment failed', error);
            this.paymentError.set(error.message || 'Card payment failed. Please try again.');
            await this.showToast('Payment failed. Please try again.', 'danger');
        } finally {
            this.paymentProcessing.set(false);
        }
    }

    private async loadBooking(id: string) {
        try {
            const job = await this.bookingService.getBooking(id);
            this.booking.set(job);
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
        try {
            this.stripe = await loadStripe(environment.stripePublicKey);
            if (!this.stripe) {
                throw new Error('Failed to load Stripe');
            }

            const elements = this.stripe.elements();
            this.cardElement = elements.create('card', {
                style: {
                    base: {
                        fontSize: '16px',
                        color: '#424770',
                        '::placeholder': {
                            color: '#aab7c4',
                        },
                    },
                },
            });

            this.cardElement.mount('#card-element');
            this.cardElement.on('change', (event: any) => {
                this.cardComplete.set(event.complete);
                if (event.error) {
                    this.paymentError.set(event.error.message);
                } else {
                    this.paymentError.set(null);
                }
            });
        } catch (error) {
            console.error('[MarketplacePayment] Stripe initialization failed', error);
            this.paymentError.set('Payment system unavailable. Please try again later.');
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
