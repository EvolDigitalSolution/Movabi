import { Component, inject, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonIcon,
    IonRefresher,
    IonRefresherContent,
    RefresherCustomEvent,
    NavController
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
    arrowForward,
    cash,
    chevronBackOutline,
    receiptOutline,
    wallet,
    walletOutline,
    timeOutline,
    checkmarkCircleOutline,
    cardOutline,
    refreshOutline
} from 'ionicons/icons';

import { DriverService } from '../../../../../core/services/driver/driver.service';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';
import {
    ButtonComponent,
    EmptyStateComponent,
    BadgeComponent
} from '../../../../../shared/ui';

type EarningsPeriod = 'all' | 'today' | 'week' | 'month';

@Component({
    selector: 'app-earnings',
    standalone: true,
    imports: [
        CommonModule,
        IonHeader,
        IonToolbar,
        IonButtons,
        IonBackButton,
        IonTitle,
        IonContent,
        IonIcon,
        IonRefresher,
        IonRefresherContent,
        ButtonComponent,
        EmptyStateComponent,
        BadgeComponent
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-3 pt-4 bg-slate-50">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>

        <ion-title class="font-display font-black text-slate-950 tracking-tight">
          Earnings
        </ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <ion-refresher slot="fixed" (ionRefresh)="refresh($event)">
        <ion-refresher-content></ion-refresher-content>
      </ion-refresher>

      <div class="w-full max-w-xl mx-auto px-3 py-4 space-y-6 pb-20 overflow-x-hidden">
        <div class="relative overflow-hidden bg-gradient-to-br from-blue-600 via-blue-700 to-slate-950 rounded-[2rem] p-6 text-white shadow-2xl shadow-blue-600/20">
          <div class="absolute -right-12 -bottom-16 w-48 h-48 rounded-full bg-white/10 blur-2xl"></div>
          <ion-icon name="wallet" class="absolute -right-8 -bottom-8 text-[10rem] text-white/10 rotate-12"></ion-icon>

          <div class="relative z-10">
            <div class="flex items-start justify-between gap-4 mb-8">
              <div>
                <p class="text-blue-100/80 text-[10px] font-black mb-2 uppercase tracking-[0.22em]">
                  Available Balance
                </p>

                <h2 class="text-5xl font-display font-black tracking-tighter leading-none">
                  {{ formatPrice(totalBalance()) }}
                </h2>

                <p class="text-sm text-blue-100/80 font-semibold mt-3">
                  From completed and settled requests.
                </p>
              </div>

              <div class="w-14 h-14 bg-white/15 border border-white/10 rounded-2xl flex items-center justify-center shrink-0">
                <ion-icon name="wallet-outline" class="text-3xl"></ion-icon>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <button
                type="button"
                (click)="withdrawFunds()"
                class="h-12 rounded-2xl bg-white text-blue-700 font-black text-sm shadow-xl shadow-blue-950/10 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
              >
                Withdraw
                <ion-icon name="arrow-forward"></ion-icon>
              </button>

              <button
                type="button"
                (click)="nav.navigateRoot('/driver')"
                class="h-12 rounded-2xl bg-white/10 border border-white/15 text-white font-black text-sm active:scale-[0.98] transition-all flex items-center justify-center gap-2"
              >
                Dashboard
              </button>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-3 gap-3">
          <div class="bg-white rounded-[1.5rem] p-4 border border-slate-100 shadow-sm">
            <div class="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mb-3">
              <ion-icon name="checkmark-circle-outline" class="text-xl"></ion-icon>
            </div>
            <p class="text-[9px] uppercase tracking-widest font-black text-slate-400 mb-1">Paid</p>
            <p class="text-lg font-display font-black text-slate-950">{{ formatPrice(paidTotal()) }}</p>
          </div>

          <div class="bg-white rounded-[1.5rem] p-4 border border-slate-100 shadow-sm">
            <div class="w-10 h-10 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mb-3">
              <ion-icon name="time-outline" class="text-xl"></ion-icon>
            </div>
            <p class="text-[9px] uppercase tracking-widest font-black text-slate-400 mb-1">Pending</p>
            <p class="text-lg font-display font-black text-slate-950">{{ formatPrice(pendingTotal()) }}</p>
          </div>

          <div class="bg-white rounded-[1.5rem] p-4 border border-slate-100 shadow-sm">
            <div class="w-10 h-10 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center mb-3">
              <ion-icon name="card-outline" class="text-xl"></ion-icon>
            </div>
            <p class="text-[9px] uppercase tracking-widest font-black text-slate-400 mb-1">Fees</p>
            <p class="text-lg font-display font-black text-slate-950">{{ formatPrice(totalCommission()) }}</p>
          </div>
        </div>

        <div class="bg-white rounded-[1.75rem] p-3 border border-slate-100 shadow-sm">
          <div class="grid grid-cols-4 gap-2">
            <button
              type="button"
              (click)="period.set('all')"
              class="h-10 rounded-2xl text-xs font-black transition-all"
              [class.bg-slate-950]="period() === 'all'"
              [class.text-white]="period() === 'all'"
              [class.text-slate-500]="period() !== 'all'"
            >
              All
            </button>

            <button
              type="button"
              (click)="period.set('today')"
              class="h-10 rounded-2xl text-xs font-black transition-all"
              [class.bg-slate-950]="period() === 'today'"
              [class.text-white]="period() === 'today'"
              [class.text-slate-500]="period() !== 'today'"
            >
              Today
            </button>

            <button
              type="button"
              (click)="period.set('week')"
              class="h-10 rounded-2xl text-xs font-black transition-all"
              [class.bg-slate-950]="period() === 'week'"
              [class.text-white]="period() === 'week'"
              [class.text-slate-500]="period() !== 'week'"
            >
              Week
            </button>

            <button
              type="button"
              (click)="period.set('month')"
              class="h-10 rounded-2xl text-xs font-black transition-all"
              [class.bg-slate-950]="period() === 'month'"
              [class.text-white]="period() === 'month'"
              [class.text-slate-500]="period() !== 'month'"
            >
              Month
            </button>
          </div>
        </div>

        <div class="space-y-4">
          <div class="flex items-center justify-between px-1">
            <div class="flex items-center gap-3">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <div>
                <h3 class="text-xs font-black text-slate-500 uppercase tracking-[0.18em]">
                  Transactions
                </h3>
                <p class="text-[11px] text-slate-400 font-semibold mt-0.5">
                  {{ filteredEarnings().length }} record{{ filteredEarnings().length === 1 ? '' : 's' }}
                </p>
              </div>
            </div>

            <button
              type="button"
              (click)="loadEarnings()"
              class="w-10 h-10 rounded-2xl bg-white border border-slate-100 text-slate-500 flex items-center justify-center shadow-sm active:scale-95 transition-all"
              [disabled]="loading()"
            >
              <ion-icon name="refresh-outline" class="text-xl" [class.animate-spin]="loading()"></ion-icon>
            </button>
          </div>

          @if (loading() && earnings().length === 0) {
            <div class="bg-white rounded-[2rem] border border-slate-100 shadow-sm p-6 space-y-4">
              <div class="h-16 bg-slate-100 rounded-2xl animate-pulse"></div>
              <div class="h-16 bg-slate-100 rounded-2xl animate-pulse"></div>
              <div class="h-16 bg-slate-100 rounded-2xl animate-pulse"></div>
            </div>
          } @else if (filteredEarnings().length === 0) {
            <div class="bg-white rounded-[2rem] border border-slate-100 shadow-sm overflow-hidden py-10">
              <app-empty-state
                icon="receipt-outline"
                title="No earnings yet"
                description="Completed and settled requests will appear here. Keep your status online to receive nearby opportunities."
                actionLabel="Go to Dashboard"
                (action)="nav.navigateRoot('/driver')"
              ></app-empty-state>
            </div>
          } @else {
            <div class="space-y-3">
              @for (earning of filteredEarnings(); track earning.id) {
                <div class="bg-white rounded-[1.75rem] border border-slate-100 shadow-sm p-4">
                  <div class="flex items-start gap-4">
                    <div
                      class="w-12 h-12 rounded-2xl flex items-center justify-center border shrink-0"
                      [class.bg-emerald-50]="getEarningStatus(earning) === 'paid'"
                      [class.text-emerald-600]="getEarningStatus(earning) === 'paid'"
                      [class.border-emerald-100]="getEarningStatus(earning) === 'paid'"
                      [class.bg-amber-50]="getEarningStatus(earning) === 'pending'"
                      [class.text-amber-600]="getEarningStatus(earning) === 'pending'"
                      [class.border-amber-100]="getEarningStatus(earning) === 'pending'"
                    >
                      <ion-icon [name]="getEarningStatus(earning) === 'paid' ? 'cash' : 'time-outline'" class="text-2xl"></ion-icon>
                    </div>

                    <div class="flex-1 min-w-0">
                      <div class="flex items-start justify-between gap-3 mb-1">
                        <div class="min-w-0">
                          <h4 class="font-display font-black text-slate-950 text-base truncate">
                            {{ getEarningTitle(earning) }}
                          </h4>
                          <p class="text-[11px] text-slate-400 font-bold uppercase tracking-widest mt-1">
                            {{ earning.created_at | date:'mediumDate' }} • {{ earning.created_at | date:'shortTime' }}
                          </p>
                        </div>

                        <div class="text-right shrink-0">
                          <p class="text-xl font-display font-black text-emerald-600">
                            +{{ formatPrice(toNumber(earning.amount)) }}
                          </p>
                          <app-badge [variant]="getEarningStatus(earning) === 'paid' ? 'success' : 'warning'">
                            {{ getEarningStatus(earning) }}
                          </app-badge>
                        </div>
                      </div>

                      <div class="flex flex-wrap items-center gap-2 mt-3">
                        <app-badge [variant]="earning.pricing_plan_used === 'pro' ? 'primary' : 'secondary'">
                          {{ formatPlan(earning.pricing_plan_used) }}
                        </app-badge>

                        @if (toNumber(earning.commission_fee) > 0) {
                          <app-badge variant="warning">
                            Fee {{ formatPrice(toNumber(earning.commission_fee)) }}
                          </app-badge>
                        } @else if (earning.pricing_plan_used === 'pro') {
                          <app-badge variant="success">
                            0% commission
                          </app-badge>
                        }
                      </div>

                      @if (toNumber(earning.commission_fee) > 0) {
                        <p class="text-xs text-slate-500 font-semibold mt-3">
                          Commission deducted:
                          <span class="font-black text-slate-700">
                            {{ formatPrice(toNumber(earning.commission_fee)) }}
                          </span>
                          @if (earning.commission_rate_used !== null && earning.commission_rate_used !== undefined) {
                            <span>({{ earning.commission_rate_used }}%)</span>
                          }
                        </p>
                      }
                    </div>
                  </div>
                </div>
              }
            </div>
          }
        </div>
      </div>
    </ion-content>
  `
})
export class EarningsPage implements OnInit {
    private driverService = inject(DriverService);
    private config = inject(AppConfigService);
    public nav = inject(NavController);

    earnings = this.driverService.earnings;
    loading = signal(false);
    period = signal<EarningsPeriod>('all');

    filteredEarnings = computed(() => {
        const items = [...this.earnings()];
        const selectedPeriod = this.period();

        return items
            .filter((earning) => this.isInsidePeriod(earning.created_at, selectedPeriod))
            .sort((a, b) => {
                const aTime = new Date(a.created_at || 0).getTime();
                const bTime = new Date(b.created_at || 0).getTime();
                return bTime - aTime;
            });
    });

    totalBalance = computed(() => {
        return this.earnings()
            .filter((earning) => this.getEarningStatus(earning) === 'paid')
            .reduce((sum: number, earning) => sum + this.toNumber(earning.amount), 0);
    });

    paidTotal = computed(() => {
        return this.earnings()
            .filter((earning) => this.getEarningStatus(earning) === 'paid')
            .reduce((sum: number, earning) => sum + this.toNumber(earning.amount), 0);
    });

    pendingTotal = computed(() => {
        return this.earnings()
            .filter((earning) => this.getEarningStatus(earning) === 'pending')
            .reduce((sum: number, earning) => sum + this.toNumber(earning.amount), 0);
    });

    totalCommission = computed(() => {
        return this.earnings()
            .reduce((sum: number, earning) => sum + this.toNumber(earning.commission_fee), 0);
    });

    constructor() {
        addIcons({
            arrowForward,
            cash,
            chevronBackOutline,
            receiptOutline,
            wallet,
            walletOutline,
            timeOutline,
            checkmarkCircleOutline,
            cardOutline,
            refreshOutline
        });
    }

    ngOnInit() {
        void this.loadEarnings();
    }

    async loadEarnings() {
        if (this.loading()) return;

        this.loading.set(true);

        try {
            await this.driverService.fetchEarnings();
        } catch (error) {
            console.error('Failed to load earnings:', error);
        } finally {
            this.loading.set(false);
        }
    }

    async refresh(event: RefresherCustomEvent) {
        try {
            await this.driverService.fetchEarnings();
        } catch (error) {
            console.error('Failed to refresh earnings:', error);
        } finally {
            event.target.complete();
        }
    }

    withdrawFunds() {
        this.nav.navigateRoot('/driver');
    }

    formatPrice(amount: number | null | undefined) {
        return this.config.formatCurrency(this.toNumber(amount));
    }

    toNumber(value: unknown): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    formatPlan(plan: string | null | undefined): string {
        if (String(plan || '').toLowerCase() === 'pro') return 'Pro';
        return 'Starter';
    }

    getEarningTitle(earning: any): string {
        const serviceName =
            earning?.service_type_name ||
            earning?.service_name ||
            earning?.service_type?.name ||
            earning?.job_type ||
            'Request';

        return `${this.titleCase(String(serviceName))} Payment`;
    }

    getEarningStatus(earning: any): 'paid' | 'pending' {
        const status = String(
            earning?.status ||
            earning?.payout_status ||
            earning?.payment_status ||
            ''
        ).toLowerCase();

        if (['pending', 'processing', 'authorized', 'unpaid'].includes(status)) {
            return 'pending';
        }

        return 'paid';
    }

    private titleCase(value: string): string {
        return value
            .replace(/[_-]/g, ' ')
            .trim()
            .replace(/\s+/g, ' ')
            .replace(/\b\w/g, (char) => char.toUpperCase());
    }

    private isInsidePeriod(dateValue: string | null | undefined, period: EarningsPeriod): boolean {
        if (period === 'all') return true;

        const date = new Date(dateValue || 0);
        if (Number.isNaN(date.getTime())) return false;

        const now = new Date();

        if (period === 'today') {
            return date.toDateString() === now.toDateString();
        }

        const start = new Date(now);

        if (period === 'week') {
            start.setDate(now.getDate() - 7);
            return date >= start;
        }

        if (period === 'month') {
            start.setMonth(now.getMonth() - 1);
            return date >= start;
        }

        return true;
    }
}