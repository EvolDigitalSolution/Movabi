import { Component, inject, signal, OnInit, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Stripe, StripeElements, StripeCardElement } from '@stripe/stripe-js';
import {
    IonHeader, IonToolbar, IonTitle, IonContent, IonButtons,
    IonBackButton, IonCard, IonCardHeader, IonCardTitle,
    IonCardContent, IonButton, IonIcon, IonItem, IonLabel,
    IonInput, IonList, IonBadge, IonRefresher, IonRefresherContent
} from '@ionic/angular/standalone';
import { WalletService } from '@core/services/wallet/wallet.service';
import { AppConfigService } from '@core/services/config/app-config.service';
import { PaymentService } from '@core/services/stripe/payment.service';
import { AuthService } from '@core/services/auth/auth.service';
import { FormsModule } from '@angular/forms';
import { ToastController, LoadingController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { informationCircleOutline } from 'ionicons/icons';

@Component({
    selector: 'app-wallet',
    standalone: true,
    imports: [
        CommonModule, FormsModule, IonHeader, IonToolbar, IonTitle,
        IonContent, IonButtons, IonBackButton, IonCard, IonCardHeader,
        IonCardTitle, IonCardContent, IonButton, IonIcon, IonItem,
        IonLabel, IonInput, IonList, IonBadge, IonRefresher, IonRefresherContent
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

      <ion-card class="bg-indigo-600 text-white m-0 mb-6">
        <ion-card-content class="py-8 text-center">
          <p class="text-indigo-100 text-sm uppercase tracking-wider mb-2">Available Balance</p>
          <h1 class="text-4xl font-bold">
            {{ appConfig.formatCurrency(walletService.wallet()?.available_balance || 0) }}
          </h1>
        </ion-card-content>
      </ion-card>

      <div class="space-y-4">
        <h2 class="text-lg font-bold">Top Up Wallet</h2>
        <ion-card class="m-0">
          <ion-card-content>
            <ion-item lines="none" class="bg-gray-50 rounded-lg mb-4">
              <ion-label position="stacked">Amount to Add</ion-label>
              <ion-input
                type="number"
                [(ngModel)]="topUpAmount"
                placeholder="0.00"
                class="text-xl font-bold"
              ></ion-input>
            </ion-item>

            <div class="grid grid-cols-3 gap-2 mb-4">
              @for (amount of quickAmounts; track amount) {
                <ion-button
                  fill="outline"
                  size="small"
                  (click)="topUpAmount = amount"
                  [color]="topUpAmount === amount ? 'primary' : 'medium'"
                >
                  +{{ appConfig.formatCurrency(amount) }}
                </ion-button>
              }
            </div>

            <div class="mb-6">
              <span class="block text-sm font-medium text-gray-700 mb-2">Card Details</span>
              <div #cardElementContainer class="p-4 bg-gray-50 rounded-lg border border-gray-200 min-h-[44px]">
                <!-- Stripe Card Element will be mounted here -->
              </div>
              @if (cardError()) {
                <p id="card-errors" role="alert" class="mt-2 text-sm text-red-600">
                  {{ cardError() }}
                </p>
              }
            </div>

            <ion-button
              expand="block"
              (click)="handleTopUp()"
             [disabled]="!canSubmitTopUp"
            >
              @if (loading()) {
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

    private stripe: Stripe | null = null;
    private elements: StripeElements | null = null;
    private card: StripeCardElement | null = null;

    constructor() {
        addIcons({ informationCircleOutline });
    }

    ngOnInit() {
        void this.walletService.fetchWallet();
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
        await this.walletService.fetchWallet();
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
                this.topUpAmount,
                this.appConfig.currencyCode
            );

            loading.message = 'Confirming payment...';

            await this.paymentService.confirmCardPayment(clientSecret, this.card);

            loading.message = 'Finalizing top-up...';
            await new Promise(resolve => setTimeout(resolve, 2000));

            await this.walletService.fetchWallet();

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