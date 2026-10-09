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
    IonIcon,
    IonList,
    IonItem,
    IonLabel,
    IonNote,
    IonRefresher,
    IonRefresherContent,
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
        IonIcon,
        IonList,
        IonItem,
        IonLabel,
        IonNote,
        IonRefresher,
        IonRefresherContent,
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

      <div class="relative mb-6 overflow-hidden rounded-[2rem] bg-white px-6 py-8 text-center shadow-lg shadow-slate-900/10 border border-slate-200">
        <div class="absolute inset-x-0 top-0 h-1.5 bg-blue-600"></div>

        <p class="relative text-slate-600 text-sm font-black mb-3">
          Available Balance
        </p>

        <h1 class="relative text-slate-950 text-5xl font-display font-black tracking-tight">
          {{ appConfig.formatCurrency(walletService.wallet()?.available_balance || 0) }}
        </h1>
      </div>

      <div class="space-y-6">
        <div class="bg-blue-50 p-4 rounded-xl">
          <p class="text-sm text-blue-800">
            Wallet top-ups are no longer available. You can use your existing balance for bookings.
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
              <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 flex items-center justify-center shrink-0">
                  <ion-icon name="receipt-outline" class="text-xl"></ion-icon>
                </div>
                <div class="min-w-0">
                  <p class="text-sm font-black text-slate-900">No transactions yet</p>
                  <p class="text-xs font-semibold text-slate-500 truncate">Your wallet payments and refunds will appear here.</p>
                </div>
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
        // No card collection: new wallet funding is retired.
    }

    ngOnDestroy(): void {
        this.isDestroyed = true;

        if (this.card) {
            this.card.destroy();
            this.card = null;
        }
    }

    get canSubmitTopUp(): boolean {
        return false;
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
        await this.showToast('Wallet top-ups are no longer available. Pay directly when booking.', 'warning');
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
