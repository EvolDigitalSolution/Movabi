import { Component, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { 
  IonHeader, 
  IonToolbar, 
  IonTitle, 
  IonButtons, 
  IonButton, 
  IonIcon, 
  IonContent, 
  ModalController 
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { closeOutline, checkmarkCircle, closeCircle, bulbOutline } from 'ionicons/icons';
import { ButtonComponent, BadgeComponent } from '../../../../../shared/ui';
import { AppConfigService } from '@core/services/config/app-config.service';
import { SubscriptionPlan } from '@shared/models/booking.model';

@Component({
  selector: 'app-plan-details-modal',
  standalone: true,
  imports: [
    CommonModule, 
    IonHeader, 
    IonToolbar, 
    IonTitle, 
    IonButtons, 
    IonButton, 
    IonIcon, 
    IonContent, 
    ButtonComponent, 
    BadgeComponent
  ],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-6 bg-white">
        <ion-title class="font-display font-bold text-slate-900">Plan Comparison</ion-title>
        <ion-buttons slot="end">
          <ion-button (click)="dismiss()" class="text-slate-400">
            <ion-icon name="close-outline" slot="icon-only"></ion-icon>
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding bg-white">
      <div class="space-y-8 pb-10">
        <div class="text-center space-y-2">
          <h2 class="text-2xl font-display font-bold text-slate-900">Choose your path</h2>
          <p class="text-slate-500 text-sm max-w-xs mx-auto">Select the plan that best fits your driving style and financial goals.</p>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full border-collapse">
            <thead>
              <tr>
                <th class="p-4 text-left text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100">Feature</th>
                <th class="p-4 text-center text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100 bg-slate-50/50">Starter</th>
                <th class="p-4 text-center text-[10px] font-bold text-blue-600 uppercase tracking-widest border-b border-blue-100 bg-blue-50/30">{{ proPlan()?.display_name || 'Weekly Pro' }}</th>
              </tr>
            </thead>
            <tbody class="text-sm">
              <tr>
                <td class="p-4 font-medium text-slate-700 border-b border-slate-50">Monthly Fee</td>
                <td class="p-4 text-center text-slate-900 font-bold border-b border-slate-50 bg-slate-50/50">{{ formatPrice(0) }}</td>
                <td class="p-4 text-center text-blue-600 font-bold border-b border-blue-50 bg-blue-50/30">
                  {{ formatPrice(proPlan()?.amount || 25) }}
                  <span class="text-[10px] font-medium">/{{ proPlan()?.interval === 'week' ? 'wk' : 'mo' }}</span>
                </td>
              </tr>
              <tr>
                <td class="p-4 font-medium text-slate-700 border-b border-slate-50">Service Fee</td>
                <td class="p-4 text-center text-slate-600 border-b border-slate-50 bg-slate-50/50">15%</td>
                <td class="p-4 text-center text-emerald-600 font-bold border-b border-blue-50 bg-blue-50/30">0%</td>
              </tr>
              <tr>
                <td class="p-4 font-medium text-slate-700 border-b border-slate-50">Job Priority</td>
                <td class="p-4 text-center text-slate-600 border-b border-slate-50 bg-slate-50/50">Standard</td>
                <td class="p-4 text-center text-slate-900 font-bold border-b border-blue-50 bg-blue-50/30">High</td>
              </tr>
              <tr>
                <td class="p-4 font-medium text-slate-700 border-b border-slate-50">Instant Payouts</td>
                <td class="p-4 text-center border-b border-slate-50 bg-slate-50/50">
                  <ion-icon name="checkmark-circle" class="text-emerald-500 text-lg"></ion-icon>
                </td>
                <td class="p-4 text-center border-b border-blue-50 bg-blue-50/30">
                  <ion-icon name="checkmark-circle" class="text-emerald-500 text-lg"></ion-icon>
                </td>
              </tr>
              <tr>
                <td class="p-4 font-medium text-slate-700 border-b border-slate-50">Premium Support</td>
                <td class="p-4 text-center border-b border-slate-50 bg-slate-50/50">
                  <ion-icon name="close-circle" class="text-slate-300 text-lg"></ion-icon>
                </td>
                <td class="p-4 text-center border-b border-blue-50 bg-blue-50/30">
                  <ion-icon name="checkmark-circle" class="text-emerald-500 text-lg"></ion-icon>
                </td>
              </tr>
              <tr>
                <td class="p-4 font-medium text-slate-700 border-b border-slate-50">Performance Badges</td>
                <td class="p-4 text-center border-b border-slate-50 bg-slate-50/50">
                  <ion-icon name="close-circle" class="text-slate-300 text-lg"></ion-icon>
                </td>
                <td class="p-4 text-center border-b border-blue-50 bg-blue-50/30">
                  <ion-icon name="checkmark-circle" class="text-emerald-500 text-lg"></ion-icon>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="p-6 bg-slate-50 rounded-3xl border border-slate-100 space-y-4">
          <h4 class="font-bold text-slate-900 flex items-center">
            <ion-icon name="bulb-outline" class="mr-2 text-blue-600"></ion-icon>
            Pro Tip
          </h4>
          <p class="text-sm text-slate-600 leading-relaxed">
            If you drive more than 10 hours a week, the <b>Weekly Pro</b> plan usually pays for itself through the 0% service fee savings.
          </p>
        </div>

        <app-button variant="primary" size="lg" class="w-full" (click)="dismiss()">
          Got it
        </app-button>
      </div>
    </ion-content>
  `
})
export class PlanDetailsModal {
  private modalCtrl = inject(ModalController);
  private config = inject(AppConfigService);

  plans = input<SubscriptionPlan[]>([]);

  constructor() {
    addIcons({ closeOutline, checkmarkCircle, closeCircle, bulbOutline });
  }

  dismiss() {
    this.modalCtrl.dismiss();
  }

  formatPrice(amount: number) {
    return this.config.formatCurrency(amount);
  }

  get proPlan() {
    return () => this.plans()?.find(p => p.plan_code === 'pro');
  }
}
