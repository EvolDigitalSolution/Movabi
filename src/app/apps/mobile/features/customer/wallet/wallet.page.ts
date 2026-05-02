import {
    Component,
    inject,
    signal,
    OnInit,
    ViewChild,
    ElementRef,
    AfterViewInit,
    OnDestroy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonButtons,
    IonBackButton,
    IonCard,
    IonCardContent,
    IonButton,
    IonIcon,
    IonInput,
    IonList,
    IonItem,
    IonLabel,
    IonNote,
    IonRefresher,
    IonRefresherContent,
    IonSpinner,
    ToastController,
    LoadingController
} from '@ionic/angular/standalone';
import { Stripe, StripeElements, StripeCardElement } from '@stripe/stripe-js';
import { addIcons } from 'ionicons';
import {
    informationCircleOutline,
    alertCircleOutline,
    receiptOutline
} from 'ionicons/icons';

import { WalletService } from '@core/services/wallet/wallet.service';
import { AppConfigService } from '@core/services/config/app-config.service';
import { PaymentService } from '@core/services/stripe/payment.service';
import { AuthService } from '@core/services/auth/auth.service';

type WalletTransaction = Record<string, unknown>;

@Component({
    selector: 'app-wallet',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        IonHeader,
        IonToolbar,
        IonTitle,
        IonContent,
        IonButtons,
        IonBackButton,
        IonCard,
        IonCardContent,
        IonButton,
        IonIcon,
        IonInput,
        IonList,
        IonItem,
        IonLabel,
        IonNote,
        IonRefresher,
        IonRefresherContent,
        IonSpinner
    ],
    template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer"></ion-back-button>
        </ion-buttons>
        <ion-title>My Wallet</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <ion-refresher slot="fixed" (ionRefresh)="handleRefresh($event)">
        <ion-refresher-content></ion-refresher-content>
      </ion-refresher>

      <ion-card
        class="m-0 mb-6 shadow-lg rounded-[2rem] overflow-hidden"
        style="--background: linear-gradient(135deg, #4f46e5 0%, #4338ca 100%); --color: #ffffff;"
      >
        <ion-card-content class="py-10 text-center relative">
          <div class="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16 blur-2xl"></div>
          <div class="absolute bottom-0 left-0 w-24 h-24 bg-indigo-400/20 rounded-full -ml-12 -mb-12 blur-xl"></div>

          <p class="text-white/80 text-[10px] font-bold uppercase tracking-[0.2em] mb-3">
            Available Balance
          </p>

          <h1 class="text-white text-5xl font-display font-bold tracking-tight">
            {{ appConfig.formatCurrency(walletService.wallet()?.available_balance || 0) }}
          </h1>
        </ion-card-content>
      </ion-card>

      <div class="space-y-6">
        <div class="flex justify-between items-center px-1">
          <h2 class="text-xl font-display font-bold text-slate-900">Top Up Wallet</h2>
        </div>

        <ion-card class="m-0 shadow-xl shadow-slate-200/50 rounded-[2rem] border border-slate-100">
          <ion-card-content class="p-6">
            <div class="bg-slate-50 rounded-2xl p-4 mb-6 border border-slate-100">
              <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
                Amount to Add
              </p>

              <ion-input
                type="number"
                inputmode="decimal"
                min="1"
                [(ngModel)]="topUpAmount"
                placeholder="0.00"
                class="text-2xl font-display font-bold text-slate-900"
              ></ion-input>
            </div>

            <div class="grid grid-cols-3 gap-3 mb-8">
              @for (amount of quickAmounts; track amount) {
                <ion-button
                  fill="outline"
                  size="small"
                  type="button"
                  (click)="setQuickAmount(amount)"
                  [color]="toNumber(topUpAmount) === amount ? 'primary' : 'medium'"
                  class="h-10 rounded-xl"
                >
                  +{{ amount }}
                </ion-button>
              }
            </div>

            <div class="mb-8">
              <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">
                Card Details
              </p>

              <div
                #cardElementContainer
                class="w-full p-4 bg-white rounded-2xl border border-slate-200 shadow-sm min-h-[52px] cursor-text"
              ></div>

              @if (cardError()) {
                <p
                  id="card-errors"
                  role="alert"
                  class="mt-3 text-xs font-medium text-rose-500 flex items-center gap-1"
                >
                  <ion-icon name="alert-circle-outline"></ion-icon>
                  {{ cardError() }}
                </p>
              }
            </div>

            <ion-button
              expand="block"
              type="button"
              (click)="handleTopUp()"
              [disabled]="!canSubmitTopUp"
              class="h-14 font-bold text-lg rounded-2xl shadow-lg shadow-indigo-200"
            >
              @if (loading()) {
                <ion-spinner name="crescent" class="mr-2"></ion-spinner>
                Processing...
              } @else {
                Top Up Now
              }
            </ion-button>
          </ion-card-content>
        </ion-card>

        <div class="bg-blue-50 p-4 rounded-xl flex gap-3 items-start">
          <ion-icon name="information-circle-outline" class="text-blue-600 text-xl"></ion-icon>
          <p class="text-sm text-blue-800">
            Funds in your wallet can be used for errands, service fees and item budgets.
          </p>
        </div>

        <div class="mt-8">
          <h2 class="text-lg font-bold mb-4">Transaction History</h2>

          <ion-list class="bg-transparent">
            @for (tx of transactions(); track trackTransaction(tx)) {
              <ion-item lines="full" class="bg-white rounded-xl mb-2 overflow-hidden">
                <ion-label>
                  <div class="flex justify-between items-center mb-1 gap-3">
                    <span class="font-bold text-slate-900 truncate">
                      {{ tx['description'] || getTransactionLabel(tx) }}
                    </span>

                    <span
                      class="shrink-0"
                      [class]="isPositiveTransaction(tx) ? 'text-emerald-600 font-bold' : 'text-rose-600 font-bold'"
                    >
                      {{ isPositiveTransaction(tx) ? '+' : '-' }}{{ appConfig.formatCurrency(toNumber(tx['amount'])) }}
                    </span>
                  </div>

                  <div class="flex justify-between items-center gap-3">
                    <ion-note class="text-xs">
                      {{ $any(tx['created_at']) | date:'medium' }}
                    </ion-note>

                    <ion-note class="text-[10px] uppercase tracking-tighter">
                      {{ tx['transaction_type'] || tx['type'] || 'transaction' }}
                    </ion-note>
                  </div>
                </ion-label>
              </ion-item>
            } @empty {
              <div class="text-center py-8 text-slate-400">
                <ion-icon name="receipt-outline" class="text-4xl mb-2"></ion-icon>
                <p>No transactions yet</p>
              </div>
            }
          </ion-list>
        </div>
      </div>
    </ion-content>
  `
})
export class WalletPage implements OnInit, AfterViewInit, OnDestroy {
    @ViewChild('cardElementContainer') cardElementContainer?: ElementRef<HTMLElement>;

    walletService = inject(WalletService);
    appConfig = inject(AppConfigService);
    paymentService = inject(PaymentService);
    auth = inject(AuthService);
    toastCtrl = inject(ToastController);
    loadingCtrl = inject(LoadingController);

    topUpAmount: number | null = null;
    quickAmounts = [10, 20, 50];

    loading = signal(false);
    cardError = signal<string | null>(null);
    cardReady = signal(false);
    transactions = signal<WalletTransaction[]>([]);

    private stripe: Stripe | null = null;
    private elements: StripeElements | null = null;
    private card: StripeCardElement | null = null;
    private isDestroyed = false;

    constructor() {
        addIcons({
            informationCircleOutline,
            alertCircleOutline,
            receiptOutline
        });
    }

    ngOnInit(): void {
        void this.refreshWalletData();
    }

    ngAfterViewInit(): void {
        setTimeout(() => void this.initStripeElements(), 100);
    }

    ngOnDestroy(): void {
        this.isDestroyed = true;

        if (this.card) {
            this.card.destroy();
            this.card = null;
        }
    }

    get canSubmitTopUp(): boolean {
        const amount = this.toNumber(this.topUpAmount);

        return (
            amount > 0 &&
            !this.loading() &&
            !!this.stripe &&
            !!this.card &&
            this.cardReady() &&
            !this.cardError()
        );
    }

    setQuickAmount(amount: number): void {
        this.topUpAmount = amount;
    }

    async refreshWalletData(): Promise<void> {
        await Promise.all([
            this.walletService.fetchWallet(),
            this.loadTransactions()
        ]);
    }

    async loadTransactions(): Promise<void> {
        const user = this.auth.currentUser();

        if (!user?.id) {
            this.transactions.set([]);
            return;
        }

        try {
            const txs = await this.paymentService.getTransactions(user.id);
            this.transactions.set(Array.isArray(txs) ? txs : []);
        } catch (error) {
            console.error('Failed to load transactions:', error);
            this.transactions.set([]);
        }
    }

    private async initStripeElements(): Promise<void> {
        if (this.isDestroyed || this.card || !this.cardElementContainer?.nativeElement) return;

        try {
            this.stripe = await this.paymentService.getStripe();

            if (!this.stripe) {
                this.cardError.set('Payment service is unavailable right now.');
                return;
            }

            this.elements = this.stripe.elements();

            this.card = this.elements.create('card', {
                hidePostalCode: true,
                style: {
                    base: {
                        fontSize: '16px',
                        color: '#0f172a',
                        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
                        lineHeight: '24px',
                        '::placeholder': {
                            color: '#94a3b8'
                        }
                    },
                    invalid: {
                        color: '#ef4444',
                        iconColor: '#ef4444'
                    }
                }
            });

            this.card.mount(this.cardElementContainer.nativeElement);

            this.card.on('ready', () => {
                this.cardReady.set(true);
            });

            this.card.on('change', (event) => {
                this.cardError.set(event.error?.message || null);
            });
        } catch (error) {
            console.error('Stripe initialization failed:', error);
            this.cardError.set('Could not load card payment form.');
        }
    }

    async handleRefresh(event: CustomEvent): Promise<void> {
        try {
            await this.refreshWalletData();
        } finally {
            const target = event.target as HTMLIonRefresherElement | null;
            await target?.complete();
        }
    }

    async handleTopUp(): Promise<void> {
        if (this.loading()) return;

        const amount = this.toNumber(this.topUpAmount);
        const user = this.auth.currentUser();

        if (!user?.id) {
            await this.showToast('Please sign in again.', 'warning');
            return;
        }

        if (amount <= 0) {
            await this.showToast('Enter a valid amount.', 'warning');
            return;
        }

        if (!this.stripe || !this.card || !this.cardReady()) {
            await this.showToast('Card details are not ready yet.', 'warning');
            return;
        }

        this.loading.set(true);

        const loadingOverlay = await this.loadingCtrl.create({
            message: 'Initializing payment...'
        });

        await loadingOverlay.present();

        try {
            const tenantId = this.auth.tenantId?.() || '';

            const { clientSecret } = await this.paymentService.createWalletTopupIntent(
                amount,
                this.appConfig.currencyCode,
                user.id,
                tenantId
            );

            if (!clientSecret) {
                throw new Error('Payment could not be initialized.');
            }

            loadingOverlay.message = 'Confirming payment...';

            const paymentIntent = await this.paymentService.confirmCardPayment(clientSecret, this.card);

            if (!paymentIntent?.id) {
                throw new Error('Payment confirmation failed.');
            }

            loadingOverlay.message = 'Finalizing top-up...';

            await this.paymentService.confirmWalletTopup({
                paymentIntentId: paymentIntent.id,
                userId: user.id,
                amount
            });

            await this.refreshWalletData();

            await this.showToast(
                `Successfully added ${this.appConfig.formatCurrency(amount)} to your wallet.`,
                'success'
            );

            this.topUpAmount = null;
            this.card.clear();
            this.cardError.set(null);
        } catch (error: unknown) {
            console.error('Top up failed:', error);

            const message = error instanceof Error ? error.message : 'Payment failed. Please try again.';
            await this.showToast(message, 'danger');
        } finally {
            await loadingOverlay.dismiss();
            this.loading.set(false);
        }
    }

    isPositiveTransaction(tx: WalletTransaction): boolean {
        const transactionType = String(tx['transaction_type'] || tx['type'] || '').toLowerCase();

        return [
            'topup',
            'top_up',
            'wallet_topup',
            'refund',
            'release',
            'credit'
        ].includes(transactionType);
    }

    getTransactionLabel(tx: WalletTransaction): string {
        const transactionType = String(tx['transaction_type'] || tx['type'] || '').toLowerCase();

        switch (transactionType) {
            case 'topup':
            case 'top_up':
            case 'wallet_topup':
                return 'Wallet top-up';
            case 'reservation':
            case 'reserve':
                return 'Funds reserved';
            case 'release':
                return 'Funds released';
            case 'settlement':
            case 'payment':
                return 'Payment settled';
            case 'refund':
                return 'Refund';
            case 'adjustment':
                return 'Balance adjustment';
            default:
                return 'Transaction';
        }
    }

    trackTransaction(tx: WalletTransaction): string {
        return String(tx['id'] || tx['created_at'] || tx['payment_intent_id'] || Math.random());
    }

    toNumber(value: unknown): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    private async showToast(
        message: string,
        color: 'success' | 'warning' | 'danger' | 'medium' = 'medium'
    ): Promise<void> {
        const toast = await this.toastCtrl.create({
            message,
            duration: 3000,
            color
        });

        await toast.present();
    }
}