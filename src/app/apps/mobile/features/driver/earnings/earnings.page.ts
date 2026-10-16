import { ConnectService } from '../../../../../core/services/stripe/connect.service';
import { Component, inject, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
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
    refreshOutline,
    chevronDownOutline,
    chevronUpOutline,
    openOutline
} from 'ionicons/icons';

import { DriverService } from '../../../../../core/services/driver/driver.service';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';
import {
    EmptyStateComponent
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
    IonInfiniteScroll,
    IonInfiniteScrollContent,
        IonIcon,
        IonRefresher,
        IonRefresherContent,
        EmptyStateComponent
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
        <div class="relative overflow-hidden bg-white rounded-[2rem] p-6 shadow-xl shadow-slate-900/10 border border-slate-200">
          <div class="absolute inset-x-0 top-0 h-1.5 bg-blue-600"></div>
          <ion-icon name="wallet" class="absolute -right-8 -bottom-8 text-[10rem] text-slate-900/[0.04] rotate-12"></ion-icon>

          <div class="relative z-10">
            <div class="flex items-start justify-between gap-4 mb-8">
              <div>
                <p class="text-slate-600 text-xs font-black mb-2">
                  Transferred to Stripe
                </p>

                <h2 class="text-xl font-display font-black tracking-tight leading-none text-slate-950">
                  {{ formatPrice(totalBalance()) }}
                </h2>

                <p class="text-sm text-slate-600 font-semibold mt-3 leading-relaxed max-w-[16rem]">
                  Completed request payouts sent to your Stripe Express account.
                </p>
              </div>

              <div class="w-14 h-14 bg-slate-50 border border-slate-200 rounded-2xl flex items-center justify-center shrink-0 text-slate-700">
                <ion-icon name="wallet-outline" class="text-2xl"></ion-icon>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <button
                type="button"
                (click)="withdrawFunds()"
                [disabled]="withdrawLoading()"
                class="h-12 rounded-2xl bg-blue-600 text-white font-black text-sm shadow-xl shadow-blue-600/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-70"
              >
                {{ withdrawLoading() ? 'Opening...' : 'Open Stripe' }}
                <ion-icon [name]="withdrawLoading() ? 'refresh-outline' : 'arrow-forward'" [class.animate-spin]="withdrawLoading()"></ion-icon>
              </button>

              <button
                type="button"
                (click)="nav.navigateRoot('/driver')"
                class="h-12 rounded-2xl bg-slate-50 border border-slate-200 text-slate-900 font-black text-sm active:scale-[0.98] transition-all flex items-center justify-center gap-2"
              >
                Dashboard
              </button>
            </div>

            @if (withdrawError()) {
              <p class="mt-3 text-xs font-bold text-red-700 bg-red-50 border border-red-100 rounded-2xl px-3 py-2">
                {{ withdrawError() }}
              </p>
            }
          </div>
        </div>

        <div class="earning-totals">
          <div class="bg-white rounded-[1.5rem] p-4 border border-slate-100 shadow-sm">
            <div class="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mb-3">
              <ion-icon name="checkmark-circle-outline" class="text-xl"></ion-icon>
            </div>
            <p class="text-[10px] uppercase tracking-[0.08em] font-black text-slate-400 mb-1">Paid</p>
            <p class="text-lg font-display font-black text-slate-950">{{ formatPrice(paidTotal()) }}</p>
          </div>

          <div class="bg-white rounded-[1.5rem] p-4 border border-slate-100 shadow-sm">
            <div class="w-10 h-10 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mb-3">
              <ion-icon name="time-outline" class="text-xl"></ion-icon>
            </div>
            <p class="text-[10px] uppercase tracking-[0.08em] font-black text-slate-400 mb-1">Pending</p>
            <p class="text-lg font-display font-black text-slate-950">{{ formatPrice(pendingTotal()) }}</p>
          </div>

          <div class="bg-white rounded-[1.5rem] p-4 border border-slate-100 shadow-sm">
            <div class="w-10 h-10 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center mb-3">
              <ion-icon name="card-outline" class="text-xl"></ion-icon>
            </div>
            <p class="text-[10px] uppercase tracking-[0.08em] font-black text-slate-400 mb-1">Fees</p>
            <p class="text-lg font-display font-black text-slate-950">{{ formatPrice(totalCommission()) }}</p>
          </div>
        </div>

        <div class="bg-white rounded-[1.75rem] p-3 border border-slate-100 shadow-sm">
          <div class="grid grid-cols-4 gap-2">
            <button
              type="button"
              (click)="setPeriod('all')"
              class="h-10 rounded-2xl text-xs font-black transition-all"
              [class.bg-slate-950]="period() === 'all'"
              [class.text-white]="period() === 'all'"
              [class.text-slate-500]="period() !== 'all'"
            >
              All
            </button>

            <button
              type="button"
              (click)="setPeriod('today')"
              class="h-10 rounded-2xl text-xs font-black transition-all"
              [class.bg-slate-950]="period() === 'today'"
              [class.text-white]="period() === 'today'"
              [class.text-slate-500]="period() !== 'today'"
            >
              Today
            </button>

            <button
              type="button"
              (click)="setPeriod('week')"
              class="h-10 rounded-2xl text-xs font-black transition-all"
              [class.bg-slate-950]="period() === 'week'"
              [class.text-white]="period() === 'week'"
              [class.text-slate-500]="period() !== 'week'"
            >
              Week
            </button>

            <button
              type="button"
              (click)="setPeriod('month')"
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
                <h3 class="text-xs font-black text-slate-500">
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
              @for (earning of visibleEarnings(); track getEarningKey(earning)) {
                <article class="earning-record">
                  <button type="button" class="earning-summary" (click)="toggleEarning(earning)" [attr.aria-expanded]="isSelected(earning)">
                    <span class="font-black">{{ getEarningTitle(earning) }}</span>
                    <span class="earning-amount">+{{ formatPrice(toNumber(earning.amount)) }}</span>
                    <span>{{ earning.created_at | date:'medium' }}</span>
                    <span class="earning-status">{{ getStripePayoutLabel(earning) }}</span>
                    <span>{{ formatPlan(earning.pricing_plan_used) }} · Commission {{ formatPrice(getCommissionAmount(earning)) }}</span>
                    <span>{{ isSelected(earning)?'Hide transaction details':'View transaction details' }}</span>
                  </button>
                  @if(isSelected(earning)) {
                    <dl class="earning-details"><dt>Net payout</dt><dd>{{ formatPrice(toNumber(earning.amount)) }}</dd><dt>Commission</dt><dd>{{ formatPrice(getCommissionAmount(earning)) }} @if(earning.commission_rate_used!==null && earning.commission_rate_used!==undefined){({{earning.commission_rate_used}}%)}</dd><dt>Gross earnings</dt><dd>{{ formatPrice(getGrossAmount(earning)) }}</dd>
                    @if($any(earning).stripe_transfer_id){<dt>Stripe transfer</dt><dd>{{ $any(earning).stripe_transfer_id }}</dd>}
                    @if(earning.job_id){<dt>Booking reference</dt><dd>{{earning.job_id}}</dd>}
                    </dl>
                  }
                  @if(earning.job_id){<button type="button" class="earning-booking" (click)="openBooking(earning.job_id)">View booking record</button>}
                </article>
              }
            </div>
          }
        </div>
      </div>
      <ion-infinite-scroll threshold="120px" [disabled]="visibleEarnings().length >= filteredEarnings().length" (ionInfinite)="loadMoreEarnings($event)">
        <ion-infinite-scroll-content loadingSpinner="crescent" loadingText="Loading more transactions…"></ion-infinite-scroll-content>
      </ion-infinite-scroll>
    </ion-content>
  `,
    styles: [`.earning-record{background:white;border:1px solid #e2e8f0;border-radius:1.3rem;padding:1rem;min-width:0;max-width:100%;overflow-wrap:anywhere}.earning-summary{display:grid;grid-template-columns:minmax(0,1fr);width:100%;gap:.6rem;text-align:left;white-space:normal;min-width:0;line-height:1.4}.earning-summary>*{min-width:0;max-width:100%}.earning-amount{font-weight:800;color:#047857;font-size:1.2rem}.earning-status{background:#f1f5f9;border-radius:.7rem;padding:.45rem .6rem;line-height:1.4}.earning-details{display:grid;gap:.4rem;margin-top:1rem;border-top:1px solid #e2e8f0;padding-top:1rem}.earning-details dt{font-weight:700;color:#64748b}.earning-details dd{margin:0;margin-bottom:.5rem;overflow-wrap:anywhere}.earning-booking{margin-top:1rem;background:#fef3c7;border-radius:.75rem;padding:.75rem 1rem;font-weight:700;width:100%;white-space:normal;text-align:left}.earning-totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr));gap:.75rem}.earning-record button:focus-visible{outline:3px solid #2563eb;outline-offset:3px}`]
})
export class EarningsPage implements OnInit {
    openBooking(id:string){void this.nav.navigateForward('/driver/history/'+encodeURIComponent(id));}

    private driverService = inject(DriverService);
    private connectService = inject(ConnectService);
    private config = inject(AppConfigService);
    public nav = inject(NavController);

    earnings = this.driverService.earnings;
    loading = signal(false);
    withdrawLoading = signal(false);
    withdrawError = signal<string | null>(null);
    selectedEarningId = signal<string | null>(null);
    period = signal<EarningsPeriod>('all');

    visibleCount = signal(10);
    visibleEarnings = computed(() => this.filteredEarnings().slice(0, this.visibleCount()));
    setPeriod(period: EarningsPeriod): void { this.period.set(period); this.visibleCount.set(10); }
    async loadMoreEarnings(event: Event): Promise<void> {
        try { this.visibleCount.update(count => Math.min(count + 10, this.filteredEarnings().length)); }
        finally { await (event.target as HTMLIonInfiniteScrollElement).complete(); }
    }

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
            .reduce((sum: number, earning) => sum + this.getCommissionAmount(earning), 0);
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
            refreshOutline,
            chevronDownOutline,
            chevronUpOutline,
            openOutline
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

    async withdrawFunds() {
        if(this.withdrawLoading())return;
        this.withdrawError.set(null);this.withdrawLoading.set(true);
        let dashboardTab:Window|null=null;
        try{
            dashboardTab=this.connectService.prepareDashboardTab();
            // An empty account argument lets the authenticated server resolve this driver.
            const link=await this.connectService.getDashboardLink('');
            await this.connectService.openDashboard(link.url,dashboardTab);
        }catch(error:any){
            dashboardTab?.close();
            this.withdrawError.set(error?.message || 'Unable to open Stripe Express. Please retry.');
        }finally{this.withdrawLoading.set(false);}
    }

    toggleEarning(earning: any) {
        const key = this.getEarningKey(earning);
        if (!key) return;

        this.selectedEarningId.set(
            this.selectedEarningId() === key ? null : key
        );
    }

    isSelected(earning: any): boolean {
        return this.selectedEarningId() === this.getEarningKey(earning);
    }

    getEarningKey(earning: any): string {
        return String(earning?.id || earning?.job_id || earning?.created_at || '');
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

    getStripePayoutLabel(earning: any): string {
        // "Transferred to Stripe account" is NOT "paid to bank": the transfer
        // landed in the driver's Stripe balance; the bank payout is Stripe's
        // separate, automatic step. Never label a transfer as a bank payment.
        if (earning?.stripe_transfer_id) {
            return 'Transferred to Stripe account';
        }

        return 'Pending transfer';
    }

    getCommissionAmount(earning: any): number {
        // This card shows total deductions, including platform fee and commission.
        // Persisted gross/net earnings reconcile without fetching live pricing.
        const gross = Number(earning?.gross_amount);
        const net = Number(earning?.amount);
        if (earning?.gross_amount != null && earning?.amount != null &&
            Number.isFinite(gross) && Number.isFinite(net) && gross >= net && net >= 0) {
            return Math.round((gross - net + Number.EPSILON) * 100) / 100;
        }
        return this.toNumber(
            earning?.commission_fee ??
            earning?.platform_fee ??
            earning?.fee ??
            0
        );
    }

    getGrossAmount(earning: any): number {
        const explicitGross = this.toNumber(
            earning?.gross_amount ??
            earning?.total_price ??
            earning?.job_total ??
            0
        );

        if (explicitGross > 0) return explicitGross;

        return this.toNumber(earning?.amount) + this.getCommissionAmount(earning);
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
