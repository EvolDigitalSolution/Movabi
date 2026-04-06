import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController, AlertController, LoadingController, ToastController, ModalController } from '@ionic/angular';
import { SubscriptionService } from '@core/services/subscription/subscription.service';
import { Subscription, SubscriptionPlan } from '@shared/models/booking.model';
import { AppConfigService } from '@core/services/config/app-config.service';
import { PlanDetailsModal } from './plan-details.modal';

import { BadgeComponent, ButtonComponent } from '../../../../../shared/ui';

@Component({
  selector: 'app-subscription',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-6 bg-slate-50">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-slate-900">Subscription</ion-title>
        <ion-buttons slot="end">
          <ion-button (click)="showPlanDetails()" class="text-blue-600 font-bold text-sm">
            Compare
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding bg-slate-50">
      <div class="max-w-2xl mx-auto space-y-10 pb-12">
        @if (activeSub()) {
          <div class="p-10 bg-emerald-600 rounded-[2.5rem] text-white shadow-2xl shadow-emerald-600/20 text-center relative overflow-hidden">
            <div class="relative z-10">
              <p class="text-emerald-100/80 text-[10px] font-bold mb-3 uppercase tracking-[0.2em]">Current Status</p>
              <h2 class="text-4xl font-display font-bold capitalize mb-4">{{ activeSub()?.status }}</h2>
              <div class="inline-flex items-center px-4 py-2 bg-white/10 rounded-full text-xs font-medium border border-white/20">
                <ion-icon name="calendar-outline" class="mr-2"></ion-icon>
                Period End: {{ activeSub()?.current_period_end | date:'longDate' }}
              </div>
            </div>
            <ion-icon name="star" class="absolute -right-8 -bottom-8 text-[12rem] text-white/10 rotate-12"></ion-icon>
          </div>
        } @else {
          <div class="p-10 bg-amber-500 rounded-[2.5rem] text-white shadow-2xl shadow-amber-500/20 text-center relative overflow-hidden">
            <div class="relative z-10">
              <p class="text-amber-100/80 text-[10px] font-bold mb-3 uppercase tracking-[0.2em]">Current Status</p>
              <h2 class="text-4xl font-display font-bold capitalize mb-4">No Active Plan</h2>
              <p class="text-amber-50/90 font-medium max-w-xs mx-auto">Subscribe to a plan to start receiving job requests and earning.</p>
            </div>
            <ion-icon name="alert-circle" class="absolute -right-8 -bottom-8 text-[12rem] text-white/10 rotate-12"></ion-icon>
          </div>
        }

        <div class="space-y-6">
          <div class="flex justify-between items-center px-1">
            <h3 class="text-xs font-bold text-slate-400 uppercase tracking-widest">Available Plans</h3>
            <button (click)="showPlanDetails()" class="text-[10px] font-bold text-blue-600 uppercase tracking-widest">View Details</button>
          </div>
          
          <div class="grid grid-cols-1 gap-8">
            <!-- Starter Plan -->
            <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-xl shadow-slate-200/40 overflow-hidden relative group">
              @if (!activeSub()) {
                <div class="absolute top-6 right-6">
                  <app-badge variant="success">CURRENT PLAN</app-badge>
                </div>
              }
              <div class="p-10">
                <div class="mb-10">
                  <h4 class="text-2xl font-display font-bold text-slate-900 mb-2">Starter</h4>
                  <div class="flex items-baseline">
                    <span class="text-5xl font-display font-bold text-slate-900">{{ formatPrice(0) }}</span>
                    <span class="text-slate-400 font-medium ml-2">/month</span>
                  </div>
                </div>
                <div class="space-y-5 mb-10">
                  <div class="flex items-center text-slate-600 font-medium">
                    <div class="w-6 h-6 bg-blue-50 rounded-full flex items-center justify-center mr-4 border border-blue-100">
                      <ion-icon name="checkmark" class="text-blue-600 text-sm"></ion-icon>
                    </div>
                    Pay as you earn
                  </div>
                  <div class="flex items-center text-slate-600 font-medium">
                    <div class="w-6 h-6 bg-blue-50 rounded-full flex items-center justify-center mr-4 border border-blue-100">
                      <ion-icon name="checkmark" class="text-blue-600 text-sm"></ion-icon>
                    </div>
                    15% Service commission
                  </div>
                  <div class="flex items-center text-slate-600 font-medium">
                    <div class="w-6 h-6 bg-blue-50 rounded-full flex items-center justify-center mr-4 border border-blue-100">
                      <ion-icon name="checkmark" class="text-blue-600 text-sm"></ion-icon>
                    </div>
                    Standard job matching
                  </div>
                </div>
                @if (!activeSub()) {
                  <div class="w-full h-16 rounded-2xl bg-slate-50 flex items-center justify-center text-slate-400 font-bold uppercase tracking-widest border border-slate-100">
                    Active
                  </div>
                } @else {
                  <app-button variant="secondary" size="lg" class="w-full h-16 rounded-2xl" (click)="cancelSubscription()">
                    Switch to Starter
                  </app-button>
                }
              </div>
            </div>

            <!-- Dynamic Plans -->
            @for (plan of plans(); track plan.id) {
              <div class="bg-white rounded-[2.5rem] border-2 border-blue-600 shadow-2xl shadow-blue-600/10 overflow-hidden relative group">
                @if (activeSub()?.stripe_price_id === plan.stripe_price_id) {
                  <div class="absolute top-6 right-6">
                    <app-badge variant="primary" class="bg-blue-600 text-white border-blue-600 shadow-lg shadow-blue-600/20">CURRENT PLAN</app-badge>
                  </div>
                } @else {
                  <div class="absolute top-6 right-6">
                    <app-badge variant="primary" class="bg-blue-600 text-white border-blue-600 shadow-lg shadow-blue-600/20">MOST POPULAR</app-badge>
                  </div>
                }

                <div class="p-10">
                  <div class="mb-10">
                    <h4 class="text-2xl font-display font-bold text-slate-900 mb-2">{{ plan.display_name }}</h4>
                    <div class="flex items-baseline">
                      <span class="text-5xl font-display font-bold text-slate-900">{{ formatPrice(plan.amount) }}</span>
                      <span class="text-slate-400 font-medium ml-2">/{{ plan.interval }}</span>
                    </div>
                  </div>

                  <div class="space-y-5 mb-10">
                    @for (feature of plan.features; track feature) {
                      <div class="flex items-center text-slate-600 font-medium">
                        <div class="w-6 h-6 bg-emerald-50 rounded-full flex items-center justify-center mr-4 border border-emerald-100">
                          <ion-icon name="checkmark" class="text-emerald-600 text-sm"></ion-icon>
                        </div>
                        {{ feature }}
                      </div>
                    }
                  </div>

                  <app-button variant="primary" size="lg" class="w-full h-16 rounded-2xl shadow-xl shadow-blue-600/20" (click)="subscribe(plan.stripe_price_id)">
                    {{ activeSub()?.stripe_price_id === plan.stripe_price_id ? 'Manage Subscription' : 'Subscribe Now' }}
                  </app-button>
                </div>
              </div>
            }
          </div>
        </div>

        @if (activeSub()?.stripe_customer_id) {
          <div class="pt-4 text-center">
            <app-button variant="secondary" size="lg" [fullWidth]="false" (click)="manageSubscription()" class="px-8">
              Manage Billing & Cancellation
            </app-button>
          </div>
        }
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, BadgeComponent, ButtonComponent]
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

  async ngOnInit() {
    await Promise.all([
      this.loadSubscription(),
      this.loadPlans()
    ]);
  }

  async loadSubscription() {
    const sub = await this.subscriptionService.checkSubscription();
    this.activeSub.set(sub);
  }

  async loadPlans() {
    try {
      const countryCode = this.config.currentCountry().code;
      const currencyCode = this.config.currencyCode;
      const plans = await this.subscriptionService.getAvailablePlans(countryCode, currencyCode);
      this.plans.set(plans || []);
    } catch (error) {
      console.error('Error loading plans:', error);
    }
  }

  formatPrice(amount: number) {
    return this.config.formatCurrency(amount);
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
    if (this.activeSub()?.stripe_price_id === priceId) {
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
              const countryCode = this.config.currentCountry().code;
              const currencyCode = this.config.currencyCode;
              const url = await this.subscriptionService.createCheckoutSession(priceId, countryCode, currencyCode);
              window.location.href = url;
            } catch {
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
    } catch {
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
