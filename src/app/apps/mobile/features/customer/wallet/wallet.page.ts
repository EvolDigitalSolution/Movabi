import {CustomerWalletSandboxComponent} from './wallet-sandbox.component';
import {CustomerDebtsComponent} from '@shared/ui/customer-debts.component';
import {ReferralPanelComponent} from '@shared/ui/referral-panel.component';
import {recordedWalletTransaction} from '@shared/utils/wallet-recorded-money';
import {
    Component,
    inject,
    signal,
    computed,
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
        CustomerWalletSandboxComponent,
        CustomerDebtsComponent,
        ReferralPanelComponent,
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

        <h1 class="relative text-slate-950 font-display font-black tracking-tight break-words" [class.text-5xl]="!!walletService.wallet()" [class.text-lg]="!walletService.wallet()">
          {{ walletService.walletBalanceText() }}
        </h1>
        @if(walletService.walletError()) {<p role="alert" class="mt-3 text-sm text-red-700">{{walletService.walletError()}}</p>}
        @if(!walletService.walletLoading() && !walletService.walletError() && !walletService.wallet()) {<p class="mt-3 text-sm text-slate-600">No wallet has been set up for this account.</p>}
      </div>

      <div class="space-y-6">
        @if(topupReadiness()?.collectionAvailable) {
          <div class="bg-white p-4 rounded-xl border border-slate-200 space-y-3">
            <h2 class="text-sm font-bold text-slate-900">Top up wallet</h2>
            <div class="flex gap-2">
              @for (amount of quickAmounts; track amount) {
                <button type="button" class="px-3 py-1.5 rounded-lg border text-sm font-semibold" [class.border-blue-600]="topUpAmount===amount" (click)="setQuickAmount(amount)">£{{ amount }}</button>
              }
            </div>
            <input type="number" min="1" step="0.01" [(ngModel)]="topUpAmount" placeholder="Amount ({{ topupReadiness()?.currency || 'GBP' }})" class="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
            @if(!collectionQuote()) {<div #cardElementContainer class="border border-slate-300 rounded-lg px-3 py-3"></div>}
            @if(cardError()) {<p role="alert" class="text-xs text-red-700">{{cardError()}}</p>}
            @if(collectionQuote(); as quote) {
              <div class="bg-slate-50 rounded-lg p-3 text-sm space-y-1">
                <p class="flex justify-between"><span>Wallet credit</span><span class="font-bold">{{ quote.walletAmountMinor/100 | currency:quote.currency }}</span></p>
                <p class="flex justify-between"><span>{{ quote.feeLabel }}</span><span>{{ quote.feeMinor/100 | currency:quote.currency }}</span></p>
                <p class="flex justify-between font-bold"><span>Charged to card</span><span>{{ quote.totalChargeMinor/100 | currency:quote.currency }}</span></p>
              </div>
            }
            <button type="button" class="w-full bg-blue-600 text-white rounded-lg py-2.5 font-bold disabled:opacity-40" [disabled]="!canSubmitTopUp || topupBusy()" (click)="handleTopUp()">
              {{ topupBusy() ? 'Processing…' : (collectionQuote() ? 'Confirm and pay' : 'Top up wallet') }}
            </button>
            @if(topupMessage()) {<p class="text-xs" [class.text-emerald-700]="topupSuccess()" [class.text-red-700]="!topupSuccess()">{{topupMessage()}}</p>}
          </div>
        } @else {
          <div class="bg-blue-50 p-4 rounded-xl">
            <p class="text-sm text-blue-800">
              Wallet top-ups are not available for your account yet. You can use your existing balance for bookings.
            </p>
          </div>
        }

        <app-customer-wallet-sandbox />
        <app-customer-debts class="block mt-4" />
        <app-referral-panel class="block mt-4" />

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
                      {{ formatRecordedTransaction(tx) }}
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

    formatRecordedTransaction(tx:WalletTransaction):string {return recordedWalletTransaction(tx,this.isPositiveTransaction(tx));}
    walletService = inject(WalletService);
    appConfig = inject(AppConfigService);
    paymentService = inject(PaymentService);
    auth = inject(AuthService);
    toastCtrl = inject(ToastController);
    loadingCtrl = inject(LoadingController);

    topUpAmount: number | null = null;

    loading = signal(false);
    cardError = signal<string | null>(null);
    cardReady = signal(false);
    private readonly storedTransactions=signal<WalletTransaction[]>([]);
    private readonly transactionOwner=signal<string|null>(null);
    private transactionRead=0;
    readonly transactions=computed(()=>this.transactionOwner()===this.auth.currentUser()?.id?this.storedTransactions():[]);

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

    topupReadiness = signal<any>(null);
    collectionQuote = signal<any>(null);
    topupBusy = signal(false);
    topupMessage = signal<string | null>(null);
    topupSuccess = signal(false);
    readonly quickAmounts = [10, 20, 50, 100];

    get canSubmitTopUp(): boolean {
        return !!this.topupReadiness()?.collectionAvailable && !!this.topUpAmount && this.topUpAmount > 0
            && (this.cardReady() || !!this.collectionQuote());
    }

    setQuickAmount(amount: number): void {
        this.topUpAmount = amount;
        this.collectionQuote.set(null);
    }

    async refreshWalletData(): Promise<void> {
        await Promise.all([
            this.walletService.fetchWallet(),
            this.loadTransactions(),
            this.loadTopupReadiness()
        ]);
    }

    private async loadTopupReadiness(): Promise<void> {
        try {
            const readiness = await this.walletService.topupReadiness();
            this.topupReadiness.set(readiness);
            if (readiness?.collectionAvailable) setTimeout(() => void this.initStripeElements(), 0);
        } catch {
            this.topupReadiness.set(null);
        }
    }

    async loadTransactions(): Promise<void> {
        const user = this.auth.currentUser();
        const read=++this.transactionRead;
        this.transactionOwner.set(user?.id||null);
        this.storedTransactions.set([]);

        if (!user?.id) {
            this.storedTransactions.set([]);
            return;
        }

        try {
            const txs = await this.paymentService.getTransactions(user.id);
            if(read===this.transactionRead&&user.id===this.auth.currentUser()?.id)this.storedTransactions.set(Array.isArray(txs)?txs:[]);
        } catch (error) {
            console.error('Failed to load transactions:', error);
            if(read===this.transactionRead&&user.id===this.auth.currentUser()?.id)this.storedTransactions.set([]);
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
        if (!this.topupReadiness()?.collectionAvailable || this.topupBusy()) return;
        this.topupBusy.set(true);
        this.topupMessage.set(null);
        try {
            const amountMinor = Math.round(Number(this.topUpAmount) * 100);
            if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('Enter a valid amount');
            const idempotencyKey = crypto.randomUUID();
            // Stage 1: frozen quote (server returns the immutable terms).
            let quote = this.collectionQuote();
            if (!quote) {
                quote = await this.walletService.collectionCheckout({ amountMinor, idempotencyKey });
                if (quote?.kind !== 'quote') throw new Error('Top-up quote was unavailable');
                this.collectionQuote.set(quote);
                return; // render the confirm step; next click submits payment
            }
            // Stage 2: submit the confirmed total, then confirm the card payment.
            const checkout = await this.walletService.collectionCheckout({ amountMinor, idempotencyKey, confirmedTotalMinor: quote.totalChargeMinor });
            if (!checkout?.clientSecret) throw new Error('Card checkout was unavailable');
            if (!this.stripe || !this.card) throw new Error('Card form is not ready');
            const confirmed = await this.stripe.confirmCardPayment(checkout.clientSecret, { payment_method: { card: this.card } });
            if (confirmed.error) throw new Error(confirmed.error.message || 'Card payment failed');
            if (confirmed.paymentIntent?.status !== 'succeeded') throw new Error('Payment did not complete');
            // Stage 3: server-side verification credits the wallet.
            await this.walletService.collectionVerify(quote.attemptId);
            this.topupSuccess.set(true);
            this.topupMessage.set('Wallet topped up successfully.');
            this.collectionQuote.set(null);
            this.topUpAmount = null;
            await this.refreshWalletData();
        } catch (error: any) {
            this.topupSuccess.set(false);
            this.topupMessage.set(error?.message || 'Top-up could not be completed. Please retry.');
        } finally {
            this.topupBusy.set(false);
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
