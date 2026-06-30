import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
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
    walletOutline,
    settingsOutline
} from 'ionicons/icons';

import { AuthService } from '../../../../core/services/auth/auth.service';
import { WalletService } from '../../../../core/services/wallet/wallet.service';
import { AppConfigService } from '../../../../core/services/config/app-config.service';
import { BookingService } from '../../../../core/services/booking/booking.service';
import { SupabaseService } from '../../../../core/services/supabase/supabase.service';
import { RealtimeChannel } from '@supabase/supabase-js';
import { MovabiCarouselComponent, MovabiCarouselSlide } from '../../../../shared/ui';
import { OnboardingTourService } from '../../../../core/services/onboarding-tour/onboarding-tour.service';

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
        MovabiCarouselComponent
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
            (click)="router.navigate(['/account/settings'])"
            class="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center border border-amber-100 shadow-sm ml-3 active:scale-95 transition-all"
          >
            <ion-icon name="settings-outline" class="text-xl"></ion-icon>
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

    <ion-content class="movabi-page">
      <div class="max-w-2xl mx-auto p-3 sm:p-5 space-y-5 pb-12">
        <div class="movabi-hero min-h-[158px] flex items-center p-4">
          <div class="absolute inset-x-0 top-0 h-1.5 bg-amber-500"></div>
          <div class="relative z-10 w-full">
            <p class="text-slate-600 font-black text-[10px] uppercase tracking-[0.14em] mb-1">
              Welcome Back
            </p>

            <h1 class="text-[1.45rem] font-display font-black tracking-tight leading-tight text-slate-950 mb-1">
              Hello, {{ displayName() }}!
            </h1>

            <p class="text-sm font-semibold text-slate-600 leading-snug">
              Where can we take you today?
            </p>

            <div class="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                (click)="router.navigate(['/customer/wallet'])"
                class="rounded-2xl border border-white/80 bg-white/70 px-3 py-2 text-left shadow-sm active:scale-95 transition-all w-full"
              >
                <p class="text-[9px] font-black text-slate-500 uppercase tracking-[0.1em] mb-1">
                  Wallet
                </p>
                <p class="text-base font-display font-black text-slate-950 leading-tight">
                  {{ formatCurrency(walletService.wallet()?.available_balance || 0) }}
                </p>
              </button>

              <button
                type="button"
                (click)="router.navigate(['/customer/activity'])"
                class="rounded-2xl border border-white/80 bg-white/70 px-3 py-2 text-left shadow-sm active:scale-95 transition-all w-full"
              >
                <p class="text-[9px] font-black text-slate-500 uppercase tracking-[0.1em] mb-1">
                  Active
                </p>
                <p class="text-base font-display font-black text-slate-950 leading-tight">
                  {{ activeTrips() }}
                </p>
              </button>
            </div>
          </div>
        </div>

        @if (activeBooking(); as booking) {
          <button
            type="button"
            (click)="continueActiveBooking(booking.id)"
            class="w-full text-left rounded-2xl bg-white border border-slate-200 shadow-lg shadow-slate-900/10 p-5 active:scale-[0.99] transition-all"
          >
            <div class="flex items-start justify-between gap-4">
              <div class="flex items-start gap-3 min-w-0">
                <div class="w-12 h-12 rounded-2xl bg-amber-50 border border-amber-100 text-amber-600 flex items-center justify-center shrink-0">
                  <ion-icon [name]="getServiceIcon(booking)" class="text-2xl"></ion-icon>
                </div>
                <div class="min-w-0">
                  <p class="text-[10px] font-black uppercase tracking-[0.18em] text-amber-600">Active {{ getServiceName(booking) }}</p>
                  <h2 class="mt-1 text-lg font-display font-black text-slate-950 truncate">{{ activeJobStatusLabel(booking) }}</h2>
                  <p class="mt-1 text-xs font-semibold text-slate-500 line-clamp-2">{{ activeJobRouteLabel(booking) }}</p>
                </div>
              </div>
              <span class="shrink-0 rounded-full bg-emerald-50 border border-emerald-100 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-emerald-700">
                Live
              </span>
            </div>

            <div class="mt-5 h-2 rounded-full bg-slate-100 overflow-hidden">
              <div class="h-full rounded-full bg-amber-500 transition-all duration-500" [style.width.%]="activeJobProgress(booking)"></div>
            </div>

            <div class="mt-3 flex items-center justify-between gap-3">
              <p class="text-xs font-bold text-slate-600">{{ activeJobProgress(booking) }}% progress</p>
              <span class="inline-flex items-center gap-1 text-xs font-black text-amber-700">
                Continue tracking
                <ion-icon name="chevron-forward"></ion-icon>
              </span>
            </div>
          </button>
        }

        <app-movabi-carousel [slides]="customerCarouselSlides()"></app-movabi-carousel>

        <div class="space-y-3">
          <div class="movabi-section-header">
            <h3 class="movabi-section-title">
              Our Premium Services
            </h3>
          </div>

          <div class="grid grid-cols-2 max-[339px]:grid-cols-1 gap-3" data-tour="customer-services">
            <button
              type="button"
              (click)="goToBooking('ride')"
              class="w-full min-h-[158px] text-center group relative overflow-hidden rounded-[1.5rem] bg-white border border-slate-100 p-4 shadow-sm hover:shadow-xl hover:shadow-blue-600/10 hover:-translate-y-0.5 transition-all duration-300"
            >
              <div class="flex h-full flex-col items-center justify-center">
                <div class="w-12 h-12 min-[390px]:w-14 min-[390px]:h-14 bg-blue-600 rounded-[1.2rem] flex items-center justify-center text-white shadow-lg shadow-blue-600/20 group-hover:rotate-3 group-hover:scale-105 transition-transform">
                  <ion-icon name="car" class="text-3xl"></ion-icon>
                </div>

                <div class="mt-3 min-w-0">
                  <h2 class="text-base font-display font-black text-slate-900 leading-tight">
                    Ride
                  </h2>
                  <p class="mt-1 text-slate-500 text-xs font-semibold leading-snug">
                    Fixed fare trips.
                  </p>
                </div>

                <div class="mt-3 w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-all shrink-0">
                  <ion-icon name="chevron-forward" class="text-lg"></ion-icon>
                </div>
              </div>
            </button>

            <button
              type="button"
              (click)="goToBooking('errand')"
              class="w-full min-h-[158px] text-center group relative overflow-hidden rounded-[1.5rem] bg-white border border-slate-100 p-4 shadow-sm hover:shadow-xl hover:shadow-emerald-600/10 hover:-translate-y-0.5 transition-all duration-300"
            >
              <div class="flex h-full flex-col items-center justify-center">
                <div class="w-12 h-12 min-[390px]:w-14 min-[390px]:h-14 bg-emerald-600 rounded-[1.2rem] flex items-center justify-center text-white shadow-lg shadow-emerald-600/20 group-hover:rotate-3 group-hover:scale-105 transition-transform">
                  <ion-icon name="cart" class="text-3xl"></ion-icon>
                </div>

                <div class="mt-3 min-w-0">
                  <h2 class="text-base font-display font-black text-slate-900 leading-tight">
                    Errand
                  </h2>
                  <p class="mt-1 text-slate-500 text-xs font-semibold leading-snug">
                    Shop or collect.
                  </p>
                </div>

                <div class="mt-3 w-8 h-8 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-600 group-hover:bg-emerald-600 group-hover:text-white transition-all shrink-0">
                  <ion-icon name="chevron-forward" class="text-lg"></ion-icon>
                </div>
              </div>
            </button>

            <button
              type="button"
              (click)="goToBooking('delivery')"
              class="w-full min-h-[158px] text-center group relative overflow-hidden rounded-[1.5rem] bg-white border border-slate-100 p-4 shadow-sm hover:shadow-xl hover:shadow-amber-500/10 hover:-translate-y-0.5 transition-all duration-300"
            >
              <div class="flex h-full flex-col items-center justify-center">
                <div class="w-12 h-12 min-[390px]:w-14 min-[390px]:h-14 bg-amber-500 rounded-[1.2rem] flex items-center justify-center text-white shadow-lg shadow-amber-500/20 group-hover:rotate-3 group-hover:scale-105 transition-transform">
                  <ion-icon name="cube" class="text-3xl"></ion-icon>
                </div>

                <div class="mt-3 min-w-0">
                  <h2 class="text-base font-display font-black text-slate-900 leading-tight">
                    Package
                  </h2>
                  <p class="mt-1 text-slate-500 text-xs font-semibold leading-snug">
                    Local delivery.
                  </p>
                </div>

                <div class="mt-3 w-8 h-8 rounded-xl bg-amber-50 flex items-center justify-center text-amber-600 group-hover:bg-amber-500 group-hover:text-white transition-all shrink-0">
                  <ion-icon name="chevron-forward" class="text-lg"></ion-icon>
                </div>
              </div>
            </button>

            <button
              type="button"
              (click)="router.navigate(['/customer/van-moving/create'])"
              class="w-full min-h-[158px] text-center group relative overflow-hidden rounded-[1.5rem] bg-white border border-slate-100 p-4 shadow-sm hover:shadow-xl hover:shadow-indigo-600/10 hover:-translate-y-0.5 transition-all duration-300"
            >
              <div class="flex h-full flex-col items-center justify-center">
                <div class="w-12 h-12 min-[390px]:w-14 min-[390px]:h-14 bg-indigo-600 rounded-[1.2rem] flex items-center justify-center text-white shadow-lg shadow-indigo-600/20 group-hover:rotate-3 group-hover:scale-105 transition-transform">
                  <ion-icon name="bus" class="text-3xl"></ion-icon>
                </div>

                <div class="mt-3 min-w-0">
                  <h2 class="text-base font-display font-black text-slate-900 leading-tight">
                    Move
                  </h2>
                  <p class="mt-1 text-slate-500 text-xs font-semibold leading-snug">
                    Van and helper.
                  </p>
                </div>

                <div class="mt-3 w-8 h-8 rounded-xl bg-indigo-50 flex items-center justify-center text-indigo-600 group-hover:bg-indigo-600 group-hover:text-white transition-all shrink-0">
                  <ion-icon name="chevron-forward" class="text-lg"></ion-icon>
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
export class HomePage implements OnInit, OnDestroy {
    public router = inject(Router);
    public auth = inject(AuthService);
    public walletService = inject(WalletService);

    private config = inject(AppConfigService);
    private bookingService = inject(BookingService);
    private supabase = inject(SupabaseService);
    private toastCtrl = inject(ToastController);
    private tour = inject(OnboardingTourService);
    private jobsChannel?: RealtimeChannel;
    private readonly directlyActiveStatuses = new Set([
        'assigned',
        'accepted',
        'heading_to_pickup',
        'arrived',
        'in_progress',
        'arrived_at_store',
        'shopping_in_progress',
        'collected',
        'en_route_to_customer',
        'delivered',
        'over_budget_requested'
    ]);

    signingOut = signal(false);
    recentBookings = computed(() => this.bookingService.bookingHistory().slice(0, 2));
    activeTrips = computed(() => this.bookingService.bookingHistory().filter(
        booking => this.isDirectlyActiveBooking(booking)
    ).length);
    activeBooking = computed(() => this.bookingService.bookingHistory().find(
        booking => this.isDirectlyActiveBooking(booking)
    ) || null);
    customerCarouselSlides = computed<MovabiCarouselSlide[]>(() => [
        {
            eyebrow: 'Quick ride',
            title: 'Ride with clear fares',
            subtitle: 'Know the price before the driver accepts.',
            icon: 'car-sport-outline',
            cta: 'Book ride',
            tone: 'amber',
            accentColor: '#c2410c'
        },
        {
            eyebrow: 'Errands',
            title: 'Shop, collect, or deliver',
            subtitle: 'Everyday help with live updates.',
            icon: 'bag-handle-outline',
            cta: 'Start errand',
            tone: 'emerald',
            accentColor: '#047857'
        },
        {
            eyebrow: 'Delivery',
            title: 'Send packages locally',
            subtitle: 'Bike, car, or van based on size.',
            icon: 'cube-outline',
            cta: 'Send package',
            tone: 'blue',
            accentColor: '#1d4ed8'
        },
        {
            eyebrow: 'Moving',
            title: 'Move with the right van',
            subtitle: 'Choose van size and helper needs.',
            icon: 'storefront-outline',
            cta: 'Plan move',
            tone: 'slate',
            accentColor: '#0f172a'
        }
    ]);

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
            walletOutline,
            settingsOutline
        });
    }

    async ngOnInit(): Promise<void> {
        void this.walletService.fetchWallet();
        await this.bookingService.getHistory();
        this.subscribeToCustomerJobs();
        this.tour.startIfNeeded('customer');
    }

    ngOnDestroy(): void {
        if (this.jobsChannel) {
            void this.supabase.client.removeChannel(this.jobsChannel);
            this.jobsChannel = undefined;
        }
    }

    continueActiveBooking(bookingId: string): void {
        void this.router.navigate(['/customer/tracking', bookingId]);
    }

    private isDirectlyActiveBooking(booking: any): boolean {
        const status = String(booking?.status || '').toLowerCase();
        const hasAssignedDriver = Boolean(booking?.driver_id || booking?.accepted_driver_id);

        return hasAssignedDriver && this.directlyActiveStatuses.has(status);
    }

    activeJobStatusLabel(booking: any): string {
        const status = String(booking?.status || 'requested').toLowerCase();
        const labels: Record<string, string> = {
            requested: 'Request received',
            searching: 'Finding your driver',
            assigned: 'Driver assigned',
            accepted: 'Driver confirmed',
            heading_to_pickup: 'Driver heading to pickup',
            arrived: 'Driver has arrived',
            arrived_at_store: 'Driver at the shop',
            shopping_in_progress: 'Shopping in progress',
            collected: 'Items collected',
            en_route_to_customer: 'On the way to you',
            in_progress: 'Request in progress',
            over_budget_requested: 'Budget approval needed',
            delivered: 'Delivery arrived'
        };

        return labels[status] || this.formatStatus(status);
    }

    activeJobProgress(booking: any): number {
        const progress: Record<string, number> = {
            requested: 10,
            searching: 18,
            assigned: 30,
            accepted: 38,
            heading_to_pickup: 48,
            arrived: 58,
            arrived_at_store: 55,
            shopping_in_progress: 68,
            over_budget_requested: 68,
            collected: 78,
            in_progress: 72,
            en_route_to_customer: 88,
            delivered: 96
        };

        return progress[String(booking?.status || '').toLowerCase()] || 10;
    }

    activeJobRouteLabel(booking: any): string {
        const pickup = String(booking?.pickup_address || '').trim();
        const destination = String(booking?.dropoff_address || booking?.destination_address || '').trim();
        if (pickup && destination) return `${pickup} to ${destination}`;
        return destination || pickup || 'Open live details for the latest update';
    }

    private subscribeToCustomerJobs(): void {
        const userId = this.auth.currentUser()?.id;
        if (!userId || this.jobsChannel || !this.supabase.isConfigured) return;

        this.jobsChannel = this.supabase.client
            .channel(`customer-home-jobs-${userId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'jobs',
                    filter: `customer_id=eq.${userId}`
                },
                () => void this.bookingService.getHistory()
            )
            .subscribe();
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
