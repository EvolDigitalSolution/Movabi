import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController, AlertController, LoadingController, ToastController } from '@ionic/angular';
import { SubscriptionService } from '@core/services/subscription/subscription.service';
import { Subscription } from '@shared/models/booking.model';

@Component({
  selector: 'app-subscription',
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver"></ion-back-button>
        </ion-buttons>
        <ion-title>Subscription</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      @if (activeSub()) {
        <div class="mb-8 p-8 bg-emerald-500 rounded-3xl text-white shadow-lg text-center relative overflow-hidden">
          <div class="relative z-10">
            <p class="text-emerald-100 text-sm font-medium mb-2 uppercase tracking-widest">Current Status</p>
            <h2 class="text-4xl font-bold capitalize">{{ activeSub()?.status }}</h2>
            <p class="text-emerald-100 mt-2">Period End: {{ activeSub()?.current_period_end | date:'longDate' }}</p>
          </div>
          <ion-icon name="star" class="absolute -right-4 -bottom-4 text-9xl text-white/10 rotate-12"></ion-icon>
        </div>
      } @else {
        <div class="mb-8 p-8 bg-amber-500 rounded-3xl text-white shadow-lg text-center relative overflow-hidden">
          <div class="relative z-10">
            <p class="text-amber-100 text-sm font-medium mb-2 uppercase tracking-widest">Current Status</p>
            <h2 class="text-4xl font-bold capitalize">No Active Plan</h2>
            <p class="text-amber-100 mt-2">Subscribe to start receiving jobs.</p>
          </div>
          <ion-icon name="alert-circle" class="absolute -right-4 -bottom-4 text-9xl text-white/10 rotate-12"></ion-icon>
        </div>
      }

      <h3 class="text-lg font-bold mb-4">Available Plans</h3>
      
      <div class="grid grid-cols-1 gap-6">
        <ion-card class="m-0 rounded-3xl border-2 border-blue-600 shadow-xl overflow-hidden">
          <div class="bg-blue-600 p-4 text-center">
            <h4 class="text-white font-bold text-xl">Weekly MVP</h4>
          </div>
          <ion-card-content class="p-6">
            <div class="text-center mb-6">
              <span class="text-4xl font-bold text-gray-900">£25.00</span>
              <span class="text-gray-500">/week</span>
            </div>
            <ion-list lines="none">
              <ion-item>
                <ion-icon name="checkmark-circle" color="success" slot="start"></ion-icon>
                <ion-label>Priority job matching</ion-label>
              </ion-item>
              <ion-item>
                <ion-icon name="checkmark-circle" color="success" slot="start"></ion-icon>
                <ion-label>Keep 100% of your fares</ion-label>
              </ion-item>
              <ion-item>
                <ion-icon name="checkmark-circle" color="success" slot="start"></ion-icon>
                <ion-label>24/7 Premium support</ion-label>
              </ion-item>
            </ion-list>
            <ion-button expand="block" class="mt-6" (click)="subscribe('price_mock_weekly_mvp')">
              {{ activeSub() ? 'Manage Subscription' : 'Subscribe Now' }}
            </ion-button>
          </ion-card-content>
        </ion-card>
      </div>

      @if (activeSub()?.stripe_customer_id) {
        <div class="mt-8 text-center">
          <ion-button fill="clear" color="primary" (click)="manageSubscription()">
            Manage Billing & Cancellation
          </ion-button>
        </div>
      }
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule]
})
export class SubscriptionPage implements OnInit {
  private subscriptionService = inject(SubscriptionService);
  private alertCtrl = inject(AlertController);
  private loadingCtrl = inject(LoadingController);
  private toastCtrl = inject(ToastController);
  public nav = inject(NavController);

  activeSub = signal<Subscription | null>(null);

  async ngOnInit() {
    await this.loadSubscription();
  }

  async loadSubscription() {
    const sub = await this.subscriptionService.checkSubscription();
    this.activeSub.set(sub);
  }

  async subscribe(priceId: string) {
    if (this.activeSub()) {
      await this.manageSubscription();
      return;
    }

    const alert = await this.alertCtrl.create({
      header: 'Confirm Subscription',
      message: 'You will be redirected to Stripe to complete your payment.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Subscribe',
          handler: async () => {
            const loading = await this.loadingCtrl.create({ message: 'Redirecting to Stripe...' });
            await loading.present();
            
            try {
              const url = await this.subscriptionService.createCheckoutSession(priceId);
              window.location.href = url;
            } catch (error) {
              const toast = await this.toastCtrl.create({ 
                message: 'Failed to start checkout. Please try again.', 
                duration: 3000, 
                color: 'danger' 
              });
              toast.present();
            } finally {
              await loading.dismiss();
            }
          }
        }
      ]
    });
    await alert.present();
  }

  async manageSubscription() {
    const loading = await this.loadingCtrl.create({ message: 'Opening billing portal...' });
    await loading.present();
    
    try {
      await this.subscriptionService.openCustomerPortal();
    } catch (error) {
      const toast = await this.toastCtrl.create({ 
        message: 'Failed to open billing portal.', 
        duration: 3000, 
        color: 'danger' 
      });
      toast.present();
    } finally {
      await loading.dismiss();
    }
  }

  async cancelSubscription() {
    // This is now handled via the customer portal
    await this.manageSubscription();
  }
}
