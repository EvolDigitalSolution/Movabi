import { Component, inject, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController } from '@ionic/angular';
import { DriverService } from '../../../../../core/services/driver/driver.service';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';

import { ButtonComponent, EmptyStateComponent, BadgeComponent } from '../../../../../shared/ui';

@Component({
  selector: 'app-earnings',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-6 bg-slate-50">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-slate-900">My Earnings</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding bg-slate-50">
      <div class="max-w-2xl mx-auto space-y-10 pb-12">
        <!-- Balance Card -->
        <div class="bg-blue-600 rounded-[2.5rem] p-10 text-white shadow-2xl shadow-blue-600/20 text-center relative overflow-hidden">
          <div class="relative z-10">
            <p class="text-blue-100/80 text-[10px] font-bold mb-3 uppercase tracking-[0.2em]">Total Balance</p>
            <h2 class="text-6xl font-display font-bold tracking-tighter mb-8">{{ formatPrice(totalBalance()) }}</h2>
            <app-button variant="primary" class="bg-white text-blue-600 border-white hover:bg-blue-50 transition-colors h-14 rounded-2xl shadow-xl shadow-blue-900/10">
              Withdraw Funds <ion-icon name="arrow-forward" slot="end" class="ml-2"></ion-icon>
            </app-button>
          </div>
          <ion-icon name="wallet" class="absolute -right-8 -bottom-8 text-[12rem] text-white/10 rotate-12"></ion-icon>
        </div>

        <!-- Transactions Section -->
        <div class="space-y-6">
          <h3 class="text-xs font-bold text-slate-400 uppercase tracking-widest ml-1">Recent Transactions</h3>
          
          @if (earnings().length === 0) {
            <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden py-12">
              <app-empty-state 
                icon="receipt-outline"
                title="No earnings yet"
                description="Your completed trips and payments will appear here. Start driving to see your balance grow."
                actionLabel="Go to Dashboard"
                (action)="nav.navigateRoot('/driver')"
              ></app-empty-state>
            </div>
          } @else {
            <div class="space-y-4">
              @for (earning of earnings(); track earning.id) {
                <div class="flex items-center p-6 bg-white rounded-[2rem] border border-slate-100 shadow-sm hover:shadow-md transition-all group">
                  <div class="w-14 h-14 bg-emerald-50 rounded-2xl flex items-center justify-center text-emerald-600 mr-5 border border-emerald-100 group-hover:scale-110 transition-transform">
                    <ion-icon name="cash" class="text-2xl"></ion-icon>
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="flex justify-between items-center mb-1">
                      <h3 class="font-bold text-slate-900 text-lg">Trip Payment</h3>
                      <span class="text-xl font-display font-bold text-emerald-600">+{{ formatPrice(earning.amount) }}</span>
                    </div>
                    <div class="flex items-center gap-3 mb-2">
                      <p class="text-xs text-slate-400 font-medium uppercase tracking-widest">{{ earning.created_at | date:'medium' }}</p>
                      <app-badge [variant]="earning.pricing_plan_used === 'pro' ? 'primary' : 'secondary'">
                        {{ earning.pricing_plan_used || 'starter' }}
                      </app-badge>
                    </div>
                    @if (earning.commission_fee > 0) {
                      <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                        Commission: -{{ formatPrice(earning.commission_fee) }} ({{ earning.commission_rate_used }}%)
                      </p>
                    } @else if (earning.pricing_plan_used === 'pro') {
                      <p class="text-[10px] text-emerald-600 font-bold uppercase tracking-widest">
                        Pro Plan: 0% Commission
                      </p>
                    }
                  </div>
                </div>
              }
            </div>
          }
        </div>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, ButtonComponent, EmptyStateComponent, BadgeComponent]
})
export class EarningsPage implements OnInit {
  private driverService = inject(DriverService);
  private config = inject(AppConfigService);
  public nav = inject(NavController);

  earnings = this.driverService.earnings;
  totalBalance = computed(() => {
    return this.earnings().reduce((sum: number, e) => sum + e.amount, 0);
  });

  ngOnInit() {
    this.driverService.fetchEarnings();
  }

  formatPrice(amount: number) {
    return this.config.formatCurrency(amount);
  }
}
