import { Component, inject, signal, OnInit, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Stripe, StripeElements, StripeCardElement } from '@stripe/stripe-js';
import {
    IonHeader, IonToolbar, IonTitle, IonContent, IonButtons,
    IonBackButton, IonCard, IonCardHeader, IonCardTitle,
    IonCardContent, IonButton, IonIcon, IonItem, IonLabel,
    IonInput, IonList, IonBadge, IonRefresher, IonRefresherContent,
    IonListHeader, IonNote
} from '@ionic/angular/standalone';
import { WalletService } from '@core/services/wallet/wallet.service';
import { AppConfigService } from '@core/services/config/app-config.service';
import { PaymentService } from '@core/services/stripe/payment.service';
import { AuthService } from '@core/services/auth/auth.service';
import { FormsModule } from '@angular/forms';
import { ToastController, LoadingController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { informationCircleOutline } from 'ionicons/icons';
import { IonicModule } from '@ionic/angular';

@Component({
    selector: 'app-wallet',
    standalone: true,
    imports: [
        CommonModule, FormsModule, IonHeader, IonToolbar, IonTitle,
        IonicModule,   // ✅ MUST BE HERE
        IonContent, IonButtons, IonBackButton, IonCard, IonCardHeader,
        IonCardTitle, IonCardContent, IonButton, IonIcon, IonItem,
        IonLabel, IonInput, IonList, IonBadge, IonRefresher, IonRefresherContent,
        IonListHeader, IonNote
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

      <ion-card class="bg-indigo-600 text-white m-0 mb-6 shadow-lg rounded-[2rem] overflow-hidden">
        <ion-card-content class="py-10 text-center relative">
          <div class="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16 blur-2xl"></div>
          <div class="absolute bottom-0 left-0 w-24 h-24 bg-indigo-400/20 rounded-full -ml-12 -mb-12 blur-xl"></div>
          
          <p class="text-indigo-100 text-[10px] font-bold uppercase tracking-[0.2em] mb-3">Available Balance</p>
          <h1 class="text-5xl font-display font-bold tracking-tight">
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
              <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Amount to Add</p>
              <ion-input
                type="number"
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
                  (click)="topUpAmount = amount"
                  [color]="topUpAmount === amount ? 'primary' : 'medium'"
                  class="h-10 rounded-xl"
                >
                  +{{ amount }}
                </ion-button>
              }
            </div>

            <div class="mb-8">
              <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Card Details</p>
              <div #cardElementContainer class="p-4 bg-white rounded-2xl border border-slate-200 shadow-sm min-h-[50px] flex items-center">
                <!-- Stripe Card Element will be mounted here -->
              </div>
              @if (cardError()) {
                <p id="card-errors" role="alert" class="mt-3 text-xs font-medium text-rose-500 flex items-center gap-1">
                  <ion-icon name="alert-circle-outline"></ion-icon>
                  {{ cardError() }}
                </p>
              }
            </div>

            <ion-button
              expand="block"
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
            Funds in your wallet can be used to pay for errands, including item budgets and service fees.
          </p>
        </div>

        <div class="mt-8">
          <h2 class="text-lg font-bold mb-4">Transaction History</h2>
          <ion-list class="bg-transparent">
            @for (tx of transactions(); track tx['id']) {
              <ion-item lines="full" class="bg-white rounded-xl mb-2 overflow-hidden">
                <ion-label>
                  <div class="flex justify-between items-center mb-1">
                    <span class="font-bold text-slate-900">{{ tx['description'] || 'Transaction' }}</span>
                    <span [class]="tx['type'] === 'credit' ? 'text-emerald-600 font-bold' : 'text-rose-600 font-bold'">
                      {{ tx['type'] === 'credit' ? '+' : '-' }}{{ appConfig.formatCurrency($any(tx['amount'])) }}
                    </span>
                  </div>
                  <div class="flex justify-between items-center">
                    <ion-note class="text-xs">{{ $any(tx['created_at']) | date:'medium' }}</ion-note>
                    <ion-note class="text-[10px] uppercase tracking-tighter">{{ tx['type'] }}</ion-note>
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
    @ViewChild('cardElementContainer') cardElementContainer!: ElementRef;

    walletService = inject(WalletService);
    appConfig = inject(AppConfigService);
    paymentService = inject(PaymentService);
    auth = inject(AuthService);
    toastCtrl = inject(ToastController);
    loadingCtrl = inject(LoadingController);

    topUpAmount = 0;
    quickAmounts = [10, 20, 50];
    loading = signal(false);
    cardError = signal<string | null>(null);
    transactions = signal<Record<string, unknown>[]>([]);

    private stripe: Stripe | null = null;
    private elements: StripeElements | null = null;
    private card: StripeCardElement | null = null;

    constructor() {
        addIcons({ informationCircleOutline });
    }

    ngOnInit() {
        void this.walletService.fetchWallet();
        void this.loadTransactions();
    }

    async loadTransactions() {
        const user = this.auth.currentUser();
        if (user) {
            try {
                const txs = await this.paymentService.getTransactions(user.id);
                this.transactions.set(txs);
            } catch (error) {
                console.error('Failed to load transactions:', error);
            }
        }
    }

    async ngAfterViewInit() {
        await this.initStripeElements();
    }

    ngOnDestroy() {
        if (this.card) {
            this.card.destroy();
        }
    }

    get canSubmitTopUp(): boolean {
        return !!this.topUpAmount && this.topUpAmount > 0 && !this.loading() && !!this.stripe && !!this.card;
    }

    private async initStripeElements() {
        this.stripe = await this.paymentService.getStripe();
        if (!this.stripe) {
            this.cardError.set('Payment service is unavailable right now.');
            return;
        }

        this.elements = this.stripe.elements();
        this.card = this.elements.create('card', {
            style: {
                base: {
                    fontSize: '16px',
                    color: '#32325d',
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
                    '::placeholder': {
                        color: '#aab7c4'
                    }
                },
                invalid: {
                    color: '#fa755a',
                    iconColor: '#fa755a'
                }
            }
        });

        this.card.mount(this.cardElementContainer.nativeElement);

        this.card.on('change', (event) => {
            if (event.error) {
                this.cardError.set(event.error.message);
            } else {
                this.cardError.set(null);
            }
        });
    }

    async handleRefresh(event: { target: { complete: () => void } }) {
        await Promise.all([
            this.walletService.fetchWallet(),
            this.loadTransactions()
        ]);
        event.target.complete();
    }

    async handleTopUp() {
        if (this.topUpAmount <= 0) {
            return;
        }

        const user = this.auth.currentUser();
        if (!user) {
            return;
        }

        if (!this.card) {
            const toast = await this.toastCtrl.create({
                message: 'Card details are not ready yet. Please enter your card information.',
                duration: 3000,
                color: 'warning'
            });
            await toast.present();
            return;
        }

        const loading = await this.loadingCtrl.create({
            message: 'Initializing payment...',
            duration: 30000
        });
        await loading.present();

        this.loading.set(true);

        try {
            const { clientSecret } = await this.paymentService.createWalletTopupIntent(
                Number(this.topUpAmount),
                this.appConfig.currencyCode,
                user.id,
                this.auth.tenantId() || ''
            );

            loading.message = 'Confirming payment...';

            const paymentIntent = await this.paymentService.confirmCardPayment(clientSecret, this.card);

            loading.message = 'Finalizing top-up...';
            
            await this.paymentService.confirmWalletTopup({
                paymentIntentId: paymentIntent.id,
                userId: user.id,
                amount: Number(this.topUpAmount)
            });

            await Promise.all([
                this.walletService.fetchWallet(),
                this.loadTransactions()
            ]);

            const toast = await this.toastCtrl.create({
                message: `Successfully added ${this.appConfig.formatCurrency(this.topUpAmount)} to your wallet!`,
                duration: 3000,
                color: 'success'
            });
            await toast.present();

            this.topUpAmount = 0;
        } catch (error: unknown) {
            console.error('Top up failed:', error);
            const errorMessage = error instanceof Error ? error.message : 'Payment failed. Please try again.';

            const toast = await this.toastCtrl.create({
                message: errorMessage,
                duration: 4000,
                color: 'danger'
            });
            await toast.present();
        } finally {
            await loading.dismiss();
            this.loading.set(false);
        }
    }
}