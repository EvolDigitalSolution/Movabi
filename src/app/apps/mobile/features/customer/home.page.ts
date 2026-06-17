import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonContent,
    IonIcon,
    ToastController
} from '@ionic/angular/standalone';
import { Router } from '@angular/router';
import { addIcons } from 'ionicons';
import {
    shieldCheckmark,
    timeOutline,
    logOutOutline,
    car,
    cart,
    bus,
    cube,
    chevronForward,
    receiptOutline,
    walletOutline
} from 'ionicons/icons';

import { AuthService } from '../../../../core/services/auth/auth.service';
import { WalletService } from '../../../../core/services/wallet/wallet.service';
import { AppConfigService } from '../../../../core/services/config/app-config.service';
import { BookingService } from '../../../../core/services/booking/booking.service';

@Component({
    selector: 'app-customer-home',
    standalone: true,
    imports: [
        CommonModule,
        IonHeader,
        IonToolbar,
        IonTitle,
        IonButtons,
        IonContent,
        IonIcon,
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-6 bg-slate-50">
        <ion-title class="font-display font-black text-3xl tracking-tighter text-slate-900">
          Movabi
        </ion-title>

        <ion-buttons slot="end">
          @if (auth.userRole() === 'admin') {
            <button
              type="button"
              (click)="goAdmin()"
              class="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-100 shadow-sm active:scale-95 transition-all"
            >
              <ion-icon name="shield-checkmark" class="text-xl"></ion-icon>
            </button>
          }

          <button
            type="button"
            (click)="router.navigate(['/customer/activity'])"
            class="w-12 h-12 rounded-2xl bg-white text-slate-600 flex items-center justify-center border border-slate-200 shadow-sm ml-3 active:scale-95 transition-all"
          >
            <ion-icon name="time-outline" class="text-xl"></ion-icon>
          </button>

          <button
            type="button"
            (click)="router.navigate(['/customer/wallet'])"
            class="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100 shadow-sm ml-3 active:scale-95 transition-all"
          >
            <ion-icon name="wallet-outline" class="text-xl"></ion-icon>
          </button>

          <button
            type="button"
            (click)="signOut()"
            [disabled]="signingOut()"
            class="w-12 h-12 rounded-2xl bg-red-50 text-red-600 flex items-center justify-center border border-red-100 shadow-sm ml-3 active:scale-95 transition-all disabled:opacity-50"
          >
            <ion-icon name="log-out-outline" class="text-xl"></ion-icon>
          </button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="max-w-2xl mx-auto p-4 sm:p-6 space-y-7 pb-12">
        <div class="relative bg-white rounded-[1.5rem] sm:rounded-[2rem] p-5 sm:p-7 shadow-xl shadow-slate-900/10 overflow-hidden min-h-[210px] flex items-center border border-slate-200">
          <div class="absolute inset-x-0 top-0 h-1.5 bg-blue-600"></div>
          <div class="relative z-10 w-full">
            <p class="text-slate-600 font-black text-[10px] uppercase tracking-[0.16em] mb-2">
              Welcome Back
            </p>

            <h1 class="text-2xl sm:text-3xl font-display font-black text-slate-950 mb-2 tracking-tight leading-tight">
              Hello, {{ displayName() }}!
            </h1>

            <p class="text-slate-600 font-semibold text-sm sm:text-base">
              Where can we take you today?
            </p>

            <div class="mt-5 grid grid-cols-2 gap-3">
              <button
                type="button"
                (click)="router.navigate(['/customer/wallet'])"
                class="bg-slate-50 rounded-2xl p-4 border border-slate-200 cursor-pointer active:scale-95 transition-all text-left w-full"
              >
                <p class="text-[10px] font-black text-slate-600 uppercase tracking-[0.12em] mb-1">
                  Wallet Balance
                </p>
                <p class="text-lg sm:text-xl font-display font-black text-slate-950">
                  {{ formatCurrency(walletService.wallet()?.available_balance || 0) }}
                </p>
              </button>

              <button
                type="button"
                (click)="router.navigate(['/customer/activity'])"
                class="bg-slate-50 rounded-2xl p-4 border border-slate-200 cursor-pointer active:scale-95 transition-all text-left w-full"
              >
                <p class="text-[10px] font-black text-slate-600 uppercase tracking-[0.12em] mb-1">
                  Active Trips
                </p>
                <p class="text-lg sm:text-xl font-display font-black text-slate-950">
                  {{ activeTrips() }}
                </p>
              </button>
            </div>
          </div>
        </div>

        <div class="space-y-6">
          <div class="flex items-center gap-3 ml-1">
            <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
            <h3 class="text-sm font-black text-slate-700">
              Our Premium Services
            </h3>
          </div>

          <div class="grid grid-cols-1 min-[430px]:grid-cols-2 gap-3 sm:gap-4">
            <button
              type="button"
              (click)="goToBooking('ride')"
              class="w-full min-h-[190px] text-left group relative overflow-hidden bg-white p-4 rounded-2xl border border-slate-100 shadow-sm hover:shadow-xl hover:shadow-blue-600/10 hover:-translate-y-0.5 transition-all duration-300"
            >
              <div class="flex h-full flex-col">
                <div class="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-blue-600/20 group-hover:rotate-3 transition-transform">
                  <ion-icon name="car" class="text-3xl"></ion-icon>
                </div>

                <div class="mt-4 flex-1 min-w-0">
                  <h2 class="text-lg font-display font-black text-slate-900 leading-tight">
                    Book a Ride
                  </h2>
                  <p class="mt-2 text-slate-500 text-xs font-semibold leading-snug">
                    Fixed price, no surge pricing.
                  </p>
                </div>

                <div class="mt-4 w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-all shrink-0">
                  <ion-icon name="chevron-forward" class="text-xl"></ion-icon>
                </div>
              </div>
            </button>

            <button
              type="button"
              (click)="goToBooking('errand')"
              class="w-full min-h-[190px] text-left group relative overflow-hidden bg-white p-4 rounded-2xl border border-slate-100 shadow-sm hover:shadow-xl hover:shadow-emerald-600/10 hover:-translate-y-0.5 transition-all duration-300"
            >
              <div class="flex h-full flex-col">
                <div class="w-14 h-14 bg-emerald-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-emerald-600/20 group-hover:rotate-3 transition-transform">
                  <ion-icon name="cart" class="text-3xl"></ion-icon>
                </div>

                <div class="mt-4 flex-1 min-w-0">
                  <h2 class="text-lg font-display font-black text-slate-900 leading-tight">
                    Run an Errand
                  </h2>
                  <p class="mt-2 text-slate-500 text-xs font-semibold leading-snug">
                    We shop and deliver for you.
                  </p>
                </div>

                <div class="mt-4 w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-600 group-hover:bg-emerald-600 group-hover:text-white transition-all shrink-0">
                  <ion-icon name="chevron-forward" class="text-xl"></ion-icon>
                </div>
              </div>
            </button>

            <button
              type="button"
              (click)="goToBooking('delivery')"
              class="w-full min-h-[190px] text-left group relative overflow-hidden bg-white p-4 rounded-2xl border border-slate-100 shadow-sm hover:shadow-xl hover:shadow-amber-500/10 hover:-translate-y-0.5 transition-all duration-300"
            >
              <div class="flex h-full flex-col">
                <div class="w-14 h-14 bg-amber-500 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-amber-500/20 group-hover:rotate-3 transition-transform">
                  <ion-icon name="cube" class="text-3xl"></ion-icon>
                </div>

                <div class="mt-4 flex-1 min-w-0">
                  <h2 class="text-lg font-display font-black text-slate-900 leading-tight">
                    Send a Package
                  </h2>
                  <p class="mt-2 text-slate-500 text-xs font-semibold leading-snug">
                    Bike, car, or van delivery.
                  </p>
                </div>

                <div class="mt-4 w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center text-amber-600 group-hover:bg-amber-500 group-hover:text-white transition-all shrink-0">
                  <ion-icon name="chevron-forward" class="text-xl"></ion-icon>
                </div>
              </div>
            </button>

            <button
              type="button"
              (click)="router.navigate(['/customer/van-moving/create'])"
              class="w-full min-h-[190px] text-left group relative overflow-hidden bg-white p-4 rounded-2xl border border-slate-100 shadow-sm hover:shadow-xl hover:shadow-indigo-600/10 hover:-translate-y-0.5 transition-all duration-300"
            >
              <div class="flex h-full flex-col">
                <div class="w-14 h-14 bg-indigo-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-indigo-600/20 group-hover:rotate-3 transition-transform">
                  <ion-icon name="bus" class="text-3xl"></ion-icon>
                </div>

                <div class="mt-4 flex-1 min-w-0">
                  <h2 class="text-lg font-display font-black text-slate-900 leading-tight">
                    Van Moving
                  </h2>
                  <p class="mt-2 text-slate-500 text-xs font-semibold leading-snug">
                    Professional help for your move.
                  </p>
                </div>

                <div class="mt-4 w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center text-indigo-600 group-hover:bg-indigo-600 group-hover:text-white transition-all shrink-0">
                  <ion-icon name="chevron-forward" class="text-xl"></ion-icon>
                </div>
              </div>
            </button>
          </div>
        </div>

        <div class="space-y-6">
          <div class="flex items-center justify-between px-1">
            <div class="flex items-center gap-3">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h3 class="text-sm font-black text-slate-700">
                Recent Activity
              </h3>
            </div>

            <button
              type="button"
              (click)="router.navigate(['/customer/activity'])"
              class="text-xs font-black text-blue-600 hover:text-blue-700 transition-colors"
            >
              View All
            </button>
          </div>

          @if (recentBookings().length === 0) {
            <button
              type="button"
              (click)="goToBooking('ride')"
              class="w-full bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-3 text-left active:scale-[0.99] transition-all"
            >
              <div class="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 flex items-center justify-center shrink-0">
                <ion-icon name="receipt-outline" class="text-xl"></ion-icon>
              </div>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-black text-slate-900">No recent activity</p>
                <p class="text-xs font-semibold text-slate-500 truncate">Your latest trips will appear here.</p>
              </div>
              <ion-icon name="chevron-forward" class="text-slate-300 text-lg shrink-0"></ion-icon>
            </button>
          } @else {
            <div class="space-y-3">
              @for (booking of recentBookings(); track booking.id) {
                <button
                  type="button"
                  (click)="router.navigate(['/customer/tracking', booking.id])"
                  class="w-full bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-3 text-left active:scale-[0.99] transition-all"
                >
                  <div class="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                    <ion-icon [name]="getServiceIcon(booking)" class="text-xl"></ion-icon>
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-black text-slate-900 truncate">{{ getServiceName(booking) }}</p>
                    <p class="text-xs font-semibold text-slate-500 truncate">{{ formatStatus(booking.status) }} · {{ booking.created_at | date:'mediumDate' }}</p>
                  </div>
                  <p class="text-sm font-black text-slate-900 shrink-0">{{ formatCurrency(booking.total_price || booking.price || 0) }}</p>
                </button>
              }
            </div>
          }
        </div>
      </div>
    </ion-content>
  `
})
export class HomePage implements OnInit {
    public router = inject(Router);
    public auth = inject(AuthService);
    public walletService = inject(WalletService);

    private config = inject(AppConfigService);
    private bookingService = inject(BookingService);
    private toastCtrl = inject(ToastController);

    signingOut = signal(false);
    recentBookings = computed(() => this.bookingService.bookingHistory().slice(0, 2));
    activeTrips = computed(() => {
        const activeStatuses = new Set([
            'requested',
            'searching',
            'assigned',
            'accepted',
            'heading_to_pickup',
            'arrived',
            'in_progress',
            'arrived_at_store',
            'shopping_in_progress',
            'collected',
            'en_route_to_customer',
            'delivered'
        ]);

        return this.bookingService.bookingHistory()
            .filter(booking => activeStatuses.has(String(booking.status || '').toLowerCase()))
            .length;
    });

    constructor() {
        addIcons({
            shieldCheckmark,
            timeOutline,
            logOutOutline,
            car,
            cart,
            bus,
            cube,
            chevronForward,
            receiptOutline,
            walletOutline
        });
    }

    ngOnInit(): void {
        void this.walletService.fetchWallet();
        void this.bookingService.getHistory();
    }

    displayName(): string {
        const email = this.auth.currentUser()?.email || '';
        const name = email.split('@')[0]?.trim();

        return name || 'Customer';
    }

    formatCurrency(amount: number): string {
        return this.config.formatCurrency(Number(amount || 0));
    }

    getServiceName(booking: any): string {
        const raw = String(
            booking?.service_slug ||
            booking?.service_type?.slug ||
            booking?.service_type?.name ||
            booking?.type ||
            'Booking'
        ).toLowerCase();

        if (raw.includes('ride')) return 'Ride';
        if (raw.includes('errand')) return 'Errand';
        if (raw.includes('delivery')) return 'Delivery';
        if (raw.includes('van') || raw.includes('moving')) return 'Van Moving';
        return 'Booking';
    }

    getServiceIcon(booking: any): string {
        const name = this.getServiceName(booking);
        if (name === 'Errand') return 'cart';
        if (name === 'Van Moving') return 'bus';
        return 'car';
    }

    formatStatus(status: string): string {
        return String(status || 'pending')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, char => char.toUpperCase());
    }

    goAdmin(): void {
        void this.router.navigate(['/dashboard']);
    }

    goToBooking(type: 'ride' | 'errand' | 'delivery'): void {
        void this.router.navigate(['/customer/request'], {
            queryParams: { type }
        });
    }

    async signOut(): Promise<void> {
        if (this.signingOut()) return;

        this.signingOut.set(true);

        try {
            await this.auth.signOut();
            await this.router.navigate(['/auth/login']);
        } catch (error) {
            console.error('Sign out failed:', error);

            const toast = await this.toastCtrl.create({
                message: 'Could not sign out. Please try again.',
                duration: 2500,
                color: 'danger'
            });

            await toast.present();
        } finally {
            this.signingOut.set(false);
        }
    }
}
