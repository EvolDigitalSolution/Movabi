import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { Router } from '@angular/router';
import { DriverService } from '../../../../core/services/driver/driver.service';
import { AppConfigService } from '../../../../core/services/config/app-config.service';

import { CardComponent, ButtonComponent, BadgeComponent } from '../../../../shared/ui';

import { addIcons } from 'ionicons';
import { 
  globeOutline, 
  cardOutline, 
  shieldCheckmarkOutline, 
  carOutline, 
  starOutline, 
  walletOutline, 
  openOutline, 
  refreshOutline,
  alertCircleOutline
} from 'ionicons/icons';

@Component({
  selector: 'app-driver-settings',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-4 bg-white">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" class="text-slate-900"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-xl text-slate-900">Driver Settings</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="p-6 space-y-8">
        <!-- Region Section -->
        <section>
          <div class="flex items-center gap-3 mb-4 ml-1">
            <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
            <h2 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Region & Language</h2>
          </div>
          
          <app-card>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-4">
                <div class="w-12 h-12 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 border border-blue-100">
                  <ion-icon name="globe-outline" class="text-2xl"></ion-icon>
                </div>
                <div>
                  <h3 class="text-sm font-bold text-slate-900">Current Country</h3>
                  <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">{{ config.currentCountry().name }}</p>
                </div>
              </div>
              <ion-select [value]="config.currentCountry().code" (ionChange)="onCountryChange($event)" class="text-xs font-black text-blue-600 uppercase tracking-widest">
                @for (country of config.countries(); track country.code) {
                  <ion-select-option [value]="country.code">{{ country.name }}</ion-select-option>
                }
              </ion-select>
            </div>
          </app-card>
        </section>

        <!-- Verification Section -->
        <section>
          <div class="flex items-center gap-3 mb-4 ml-1">
            <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
            <h2 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Verification</h2>
          </div>
          
          <div class="space-y-4">
            <app-card (click)="uploadDoc('license')" class="cursor-pointer active:scale-[0.98] transition-transform">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-4">
                  <div class="w-12 h-12 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 border border-blue-100">
                    <ion-icon name="card-outline" class="text-2xl"></ion-icon>
                  </div>
                  <div>
                    <h3 class="text-sm font-bold text-slate-900">Driver's License</h3>
                    <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">Required for verification</p>
                  </div>
                </div>
                <app-badge variant="warning">Pending</app-badge>
              </div>
            </app-card>

            <app-card (click)="uploadDoc('insurance')" class="cursor-pointer active:scale-[0.98] transition-transform">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-4">
                  <div class="w-12 h-12 rounded-2xl bg-emerald-50 flex items-center justify-center text-emerald-600 border border-emerald-100">
                    <ion-icon name="shield-checkmark-outline" class="text-2xl"></ion-icon>
                  </div>
                  <div>
                    <h3 class="text-sm font-bold text-slate-900">Vehicle Insurance</h3>
                    <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">Proof of coverage</p>
                  </div>
                </div>
                <app-badge variant="error">Missing</app-badge>
              </div>
            </app-card>
          </div>
        </section>

        <!-- Vehicle Section -->
        <section>
          <div class="flex items-center gap-3 mb-4 ml-1">
            <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
            <h2 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Vehicle Details</h2>
          </div>
          
          <app-card>
            <div class="flex items-center gap-4">
              <div class="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center text-slate-600 border border-slate-200">
                <ion-icon name="car-outline" class="text-2xl"></ion-icon>
              </div>
              <div>
                <h3 class="text-sm font-bold text-slate-900">Toyota Prius</h3>
                <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">ABC-1234 • White</p>
              </div>
            </div>
          </app-card>
        </section>

        <!-- Payments & Payouts Section -->
        <section>
          <div class="flex items-center gap-3 mb-4 ml-1">
            <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
            <h2 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Payments & Payouts</h2>
          </div>
          
          <app-card>
            <div class="space-y-6">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-4">
                  <div class="w-12 h-12 rounded-2xl bg-indigo-50 flex items-center justify-center text-indigo-600 border border-indigo-100">
                    <ion-icon name="wallet-outline" class="text-2xl"></ion-icon>
                  </div>
                  <div>
                    <h3 class="text-sm font-bold text-slate-900">Stripe Connect</h3>
                    <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">
                      @if (driverService.stripeAccount()?.onboarding_complete) {
                        Payouts Enabled
                      } @else {
                        Setup required for payouts
                      }
                    </p>
                  </div>
                </div>
                @if (driverService.stripeAccount()?.onboarding_complete) {
                  <app-badge variant="success">Enabled</app-badge>
                } @else {
                  <app-badge variant="warning">Action Required</app-badge>
                }
              </div>

              @if (!driverService.stripeAccount()?.onboarding_complete) {
                <div class="bg-amber-50 rounded-2xl p-4 border border-amber-100 flex gap-3">
                  <ion-icon name="alert-circle-outline" class="text-amber-600 text-xl shrink-0"></ion-icon>
                  <div class="space-y-3">
                    <p class="text-xs text-amber-900 leading-relaxed">
                      Complete your Stripe onboarding to receive payouts directly to your bank account.
                    </p>
                    <app-button size="sm" (click)="setupStripe()" class="w-full">
                      Complete Setup
                    </app-button>
                  </div>
                </div>
              } @else {
                <div class="grid grid-cols-2 gap-3">
                  <app-button variant="secondary" size="sm" (click)="openStripeDashboard()" class="w-full">
                    <ion-icon name="open-outline" slot="start"></ion-icon>
                    Dashboard
                  </app-button>
                  <app-button variant="secondary" size="sm" (click)="refreshStripe()" class="w-full">
                    <ion-icon name="refresh-outline" slot="start"></ion-icon>
                    Refresh
                  </app-button>
                </div>
              }
            </div>
          </app-card>
        </section>

        <!-- Subscription Section -->
        <section>
          <div class="flex items-center gap-3 mb-4 ml-1">
            <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
            <h2 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Subscription</h2>
          </div>
          
          <app-card (click)="router.navigate(['/driver/subscription'])" class="cursor-pointer active:scale-[0.98] transition-transform">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-4">
                <div class="w-12 h-12 rounded-2xl bg-amber-50 flex items-center justify-center text-amber-600 border border-amber-100">
                  <ion-icon name="star-outline" class="text-2xl"></ion-icon>
                </div>
                <div>
                  <h3 class="text-sm font-bold text-slate-900">Weekly Plan</h3>
                  <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">Next billing: Apr 12, 2026</p>
                </div>
              </div>
              <app-badge variant="success">Active</app-badge>
            </div>
          </app-card>
        </section>

        <div class="pt-10">
          <app-button variant="error" class="w-full">
            Delete Account
          </app-button>
          <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest text-center mt-6">
            Movabi Driver v1.0.0
          </p>
        </div>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, CardComponent, ButtonComponent, BadgeComponent]
})
export class DriverSettingsPage {
  public router = inject(Router);
  public driverService = inject(DriverService);
  public config = inject(AppConfigService);

  constructor() {
    addIcons({ 
      globeOutline, 
      cardOutline, 
      shieldCheckmarkOutline, 
      carOutline, 
      starOutline, 
      walletOutline, 
      openOutline, 
      refreshOutline,
      alertCircleOutline
    });
  }

  async setupStripe() {
    try {
      const url = await this.driverService.setupStripeConnect();
      window.location.href = url;
    } catch (e) {
      console.error('Failed to setup stripe', e);
    }
  }

  async openStripeDashboard() {
    const accountId = this.driverService.stripeAccount()?.stripe_account_id;
    if (accountId) {
      // In a real app, this would call the backend to get a login link
      console.log('Open dashboard for:', accountId);
    }
  }

  async refreshStripe() {
    const accountId = this.driverService.stripeAccount()?.stripe_account_id;
    if (accountId) {
      await this.driverService.refreshStripeStatus(accountId);
    }
  }

  onCountryChange(event: Event) {
    const customEvent = event as CustomEvent;
    const code = customEvent.detail.value;
    this.config.setCountry(code);
  }

  async uploadDoc(type: string) {
    // In a real app, this would open a file picker
    console.log('Upload doc:', type);
  }
}
