import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
    IonHeader,
    IonToolbar,
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
    settingsOutline,
    searchOutline,
    calendarClearOutline,
    locateOutline,
    swapHorizontalOutline,
    businessOutline,
    cubeOutline,
    airplaneOutline,
    arrowForward,
    personCircleOutline
} from 'ionicons/icons';

import { AuthService } from '../../../../core/services/auth/auth.service';
import { WalletService } from '../../../../core/services/wallet/wallet.service';
import { AppConfigService } from '../../../../core/services/config/app-config.service';
import { BookingService } from '../../../../core/services/booking/booking.service';
import { SupabaseService } from '../../../../core/services/supabase/supabase.service';
import { RealtimeChannel } from '@supabase/supabase-js';
import { OnboardingTourService } from '../../../../core/services/onboarding-tour/onboarding-tour.service';
import { CustomerBottomNavComponent } from '../../../../shared/components/customer-shell/customer-bottom-nav.component';

type HomeServiceMode = 'ride' | 'errand' | 'delivery' | 'van-moving';

interface ForYouShortcut {
    label: string;
    icon: string;
    tone: 'blue' | 'emerald' | 'amber' | 'indigo' | 'slate';
    badge?: 'New' | 'Promo' | 'Soon';
    type: HomeServiceMode;
    mode?: string;
}

interface TopModeTab {
    id: HomeServiceMode;
    label: string;
    icon: string;
    placeholder: string;
}

interface UniverseTile {
    type: HomeServiceMode;
    title: string;
    description: string;
    icon: string;
    color: string;
    tintColor: string;
    textColor: string;
    ariaLabel: string;
}

@Component({
    selector: 'app-customer-home',
    standalone: true,
    imports: [
        CommonModule,
        IonHeader,
        IonToolbar,
        IonContent,
        IonIcon,
        CustomerBottomNavComponent
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="home-toolbar bg-slate-50">
        <div class="home-header">
          <span class="font-display font-black text-2xl tracking-tighter text-slate-900">
            Movabi
          </span>

          <div class="flex items-center gap-2">
            @if (auth.userRole() === 'admin') {
              <button
                type="button"
                (click)="goAdmin()"
                aria-label="Admin dashboard"
                class="w-11 h-11 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center active:scale-95 transition-all"
              >
                <ion-icon name="shield-checkmark" class="text-lg"></ion-icon>
              </button>
            }

            <button
              type="button"
              (click)="router.navigate(['/customer/wallet'])"
              aria-label="Wallet balance"
              class="wallet-pill"
            >
              <ion-icon name="wallet-outline" class="text-base"></ion-icon>
              <span>{{ formatCurrency(walletService.wallet()?.available_balance || 0) }}</span>
            </button>

            <button
              type="button"
              (click)="router.navigate(['/account/settings'])"
              aria-label="Account"
              class="w-11 h-11 rounded-2xl bg-white border border-slate-100 text-slate-600 flex items-center justify-center shadow-sm active:scale-95 transition-all"
            >
              <ion-icon name="person-circle-outline" class="text-xl"></ion-icon>
            </button>
          </div>
        </div>
      </ion-toolbar>
    </ion-header>

    <ion-content class="movabi-page">
      <div class="max-w-2xl mx-auto p-3 sm:p-5 space-y-6 native-safe-bottom">

        <!-- Top service mode navigation -->
        <div class="service-tabs" role="tablist" aria-label="Service mode">
          @for (tab of topTabs; track tab.id) {
            <button
              type="button"
              role="tab"
              [attr.aria-selected]="activeMode() === tab.id"
              (click)="activeMode.set(tab.id)"
              class="service-tab"
              [class.service-tab--selected]="activeMode() === tab.id"
            >
              <ion-icon [name]="tab.icon" class="service-tab__icon"></ion-icon>
              <span class="service-tab__label">{{ tab.label }}</span>
            </button>
          }
        </div>

        <!-- Main action / search card -->
        <button
          type="button"
          (click)="goToBooking(activeMode())"
          class="w-full text-left rounded-[1.75rem] bg-white border border-slate-100 shadow-lg shadow-slate-900/5 p-4 flex items-center gap-3 active:scale-[0.99] transition-all"
        >
          <span class="w-11 h-11 rounded-2xl bg-slate-50 text-slate-400 flex items-center justify-center shrink-0">
            <ion-icon name="search-outline" class="text-xl"></ion-icon>
          </span>
          <span class="flex-1 min-w-0">
            <span class="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-0.5">
              Hi {{ displayName() }}
            </span>
            <span class="block text-base font-display font-black text-slate-950 truncate">
              {{ activeModePlaceholder() }}
            </span>
          </span>
        </button>

        <div class="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            (click)="onScheduleTap()"
            class="min-h-12 rounded-2xl bg-white border border-slate-100 shadow-sm px-4 flex items-center justify-center gap-2 font-black text-xs text-slate-700 active:scale-95 transition-all"
          >
            <ion-icon name="calendar-clear-outline" class="text-base text-slate-400"></ion-icon>
            Schedule
            <span class="text-[8px] font-black uppercase tracking-widest text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full">Soon</span>
          </button>

          <button
            type="button"
            (click)="goToBooking(activeMode())"
            class="min-h-12 rounded-2xl bg-white border border-slate-100 shadow-sm px-4 flex items-center justify-center gap-2 font-black text-xs text-slate-700 active:scale-95 transition-all"
          >
            <ion-icon name="locate-outline" class="text-base text-slate-400"></ion-icon>
            Current location
          </button>
        </div>

        <!-- For you shortcuts -->
        <div class="space-y-3">
          <div class="flex items-center justify-between px-1">
            <h3 class="movabi-section-title">For you</h3>
          </div>

          <div class="grid grid-cols-4 max-[359px]:grid-cols-3 gap-x-2 gap-y-4" data-tour="customer-services">
            @for (shortcut of forYouShortcuts; track shortcut.label) {
              <button
                type="button"
                (click)="onShortcutTap(shortcut)"
                class="flex flex-col items-center gap-1.5 text-center active:scale-95 transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500 rounded-2xl"
                [class.opacity-60]="shortcut.badge === 'Soon'"
                [attr.aria-disabled]="shortcut.badge === 'Soon'"
                [attr.aria-label]="shortcut.label"
              >
                <span class="relative w-14 h-14 rounded-full flex items-center justify-center shrink-0"
                  [class.bg-blue-50]="shortcut.tone === 'blue'"
                  [class.text-blue-600]="shortcut.tone === 'blue'"
                  [class.bg-emerald-50]="shortcut.tone === 'emerald'"
                  [class.text-emerald-600]="shortcut.tone === 'emerald'"
                  [class.bg-amber-50]="shortcut.tone === 'amber'"
                  [class.text-amber-600]="shortcut.tone === 'amber'"
                  [class.bg-indigo-50]="shortcut.tone === 'indigo'"
                  [class.text-indigo-600]="shortcut.tone === 'indigo'"
                  [class.bg-slate-100]="shortcut.tone === 'slate'"
                  [class.text-slate-500]="shortcut.tone === 'slate'"
                >
                  <ion-icon [name]="shortcut.icon" class="text-2xl"></ion-icon>
                  @if (shortcut.badge) {
                    <span
                      class="absolute -top-1 -right-1 text-[7px] font-black uppercase tracking-wide px-1.5 py-0.5 rounded-full text-white"
                      [class.bg-emerald-500]="shortcut.badge === 'New'"
                      [class.bg-orange-500]="shortcut.badge === 'Promo'"
                      [class.bg-slate-400]="shortcut.badge === 'Soon'"
                    >
                      {{ shortcut.badge }}
                    </span>
                  }
                </span>
                <span class="text-[10px] font-bold text-slate-700 leading-tight">{{ shortcut.label }}</span>
              </button>
            }
          </div>
        </div>

        @if (pendingMarketplaceBookings().length > 0) {
          <div class="space-y-3">
            <div class="flex items-center gap-3 px-1">
              <div class="w-1.5 h-6 bg-amber-500 rounded-full shadow-lg shadow-amber-500/20"></div>
              <h3 class="text-sm font-black text-slate-700">
                Pending Marketplace Requests
              </h3>
            </div>

            <div class="space-y-3">
              @for (booking of pendingMarketplaceBookings(); track booking.id) {
                <button
                  type="button"
                  (click)="continuePendingMarketplaceBooking(booking)"
                  class="w-full bg-white rounded-2xl border border-amber-200 shadow-sm p-4 flex items-center gap-3 text-left active:scale-[0.99] transition-all"
                >
                  <div class="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center shrink-0">
                    <ion-icon [name]="getServiceIcon(booking)" class="text-xl"></ion-icon>
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-black text-slate-900 truncate">{{ getServiceName(booking) }}</p>
                    <p class="text-xs font-semibold text-amber-700 truncate">
                      {{ formatStatus(booking.status) }} — continue negotiation
                    </p>
                  </div>
                  <div class="text-right shrink-0">
                    <p class="text-sm font-black text-slate-900">{{ formatCurrency(booking.negotiated_fare || booking.agreed_fare || booking.total_price || 0) }}</p>
                    <ion-icon name="chevron-forward" class="text-slate-300 text-lg"></ion-icon>
                  </div>
                </button>
              }
            </div>
          </div>
        }

        <!-- Movabi Universe -->
        <div class="space-y-3">
          <div class="movabi-section-header">
            <h3 class="movabi-section-title">
              The Movabi Universe
            </h3>
          </div>

          <div class="universe-grid">
            @for (tile of universeTiles; track tile.type) {
              <button
                type="button"
                (click)="goToBooking(tile.type)"
                [attr.aria-label]="tile.ariaLabel"
                class="universe-card"
              >
                <span class="universe-card__icon" [style.background]="tile.color">
                  <ion-icon [name]="tile.icon"></ion-icon>
                </span>
                <span class="universe-card__title">{{ tile.title }}</span>
                <span class="universe-card__desc" [style.color]="tile.textColor" [style.background]="tile.tintColor">
                  {{ tile.description }}
                </span>
              </button>
            }
          </div>
        </div>
      </div>
    </ion-content>

    <app-customer-bottom-nav></app-customer-bottom-nav>

    @if (activeBooking(); as booking) {
      <button
        type="button"
        (click)="continueActiveBooking(booking.id)"
        class="fixed left-3 right-3 bottom-[92px] z-30 max-w-2xl mx-auto rounded-2xl bg-slate-950 text-white shadow-2xl shadow-slate-950/30 px-4 py-3.5 flex items-center gap-3 active:scale-[0.99] transition-all"
      >
        <div class="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
          <ion-icon [name]="getServiceIcon(booking)" class="text-xl"></ion-icon>
        </div>
        <div class="min-w-0 flex-1 text-left">
          <p class="text-[10px] font-black uppercase tracking-widest text-emerald-400">Live &middot; {{ getServiceName(booking) }}</p>
          <p class="text-sm font-black truncate">{{ activeJobStatusLabel(booking) }}</p>
        </div>
        <ion-icon name="arrow-forward" class="text-lg shrink-0"></ion-icon>
      </button>
    }
  `,
    styles: [`
    .home-toolbar {
      --min-height: 64px;
      --padding-start: 16px;
      --padding-end: 16px;
      --padding-top: 8px;
      --padding-bottom: 8px;
    }
    .home-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      min-height: 48px;
    }
    .wallet-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 40px;
      padding: 0 12px;
      border-radius: 999px;
      background: #eef2ff;
      color: #4338ca;
      font-size: 12px;
      font-weight: 800;
      white-space: nowrap;
    }
    .wallet-pill:active {
      transform: scale(0.96);
    }

    .service-tabs {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      width: 100%;
    }
    .service-tab {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      min-height: 48px;
      min-width: 44px;
      padding-block: 8px;
      padding-inline: clamp(4px, 2vw, 12px);
      border-radius: 16px;
      background: #f1f5f9;
      color: #64748b;
      font-weight: 700;
      transition: background-color 0.2s ease, color 0.2s ease, transform 0.15s ease;
    }
    .service-tab:active {
      transform: scale(0.97);
    }
    .service-tab__icon {
      font-size: clamp(16px, 4vw, 20px);
    }
    .service-tab__label {
      font-size: clamp(11px, 3.2vw, 13px);
      font-weight: 800;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .service-tab--selected {
      background: #f97316;
      color: #fff;
      box-shadow: 0 6px 16px -4px rgba(249, 115, 22, 0.35);
    }
    .service-tab--selected .service-tab__label {
      font-weight: 900;
    }

    .universe-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .universe-card {
      min-height: 168px;
      padding: 16px 12px;
      border-radius: 24px;
      background: #fff;
      border: 1px solid #f1f5f9;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .universe-card:active {
      transform: scale(0.98);
    }
    .universe-card__icon {
      width: 58px;
      height: 58px;
      border-radius: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 26px;
      flex-shrink: 0;
    }
    .universe-card__title {
      font-family: var(--font-display, inherit);
      font-weight: 800;
      font-size: 20px;
      color: #0f172a;
      line-height: 1.1;
    }
    .universe-card__desc {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-align: center;
      font-size: 11px;
      font-weight: 800;
      border-radius: 999px;
      padding: 8px 12px;
      line-height: 1.25;
      max-width: 100%;
    }
  `]
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
    activeMode = signal<HomeServiceMode>('ride');

    readonly topTabs: TopModeTab[] = [
        { id: 'ride', label: 'Ride', icon: 'car', placeholder: 'Where are you going?' },
        { id: 'errand', label: 'Shop', icon: 'cart', placeholder: 'What do you need?' },
        { id: 'delivery', label: 'Deliver', icon: 'cube', placeholder: 'What are you sending?' },
        { id: 'van-moving', label: 'Move', icon: 'bus', placeholder: 'What are you moving?' }
    ];

    readonly universeTiles: UniverseTile[] = [
        { type: 'ride', title: 'Ride', description: 'Everyday trips', icon: 'car', color: '#2563eb', tintColor: '#eff6ff', textColor: '#1d4ed8', ariaLabel: 'Book a Ride' },
        { type: 'errand', title: 'Shop', description: 'Shopping and errands', icon: 'cart', color: '#059669', tintColor: '#ecfdf5', textColor: '#047857', ariaLabel: 'Open Shop services' },
        { type: 'delivery', title: 'Deliver', description: 'Parcels and local delivery', icon: 'cube', color: '#d97706', tintColor: '#fffbeb', textColor: '#b45309', ariaLabel: 'Open Delivery services' },
        { type: 'van-moving', title: 'Move', description: 'Van and moving services', icon: 'bus', color: '#4f46e5', tintColor: '#eef2ff', textColor: '#4338ca', ariaLabel: 'Open Move services' }
    ];

    readonly forYouShortcuts: ForYouShortcut[] = [
        { label: 'Ride', icon: 'car', tone: 'blue', type: 'ride' },
        { label: 'Quick Buy', icon: 'cart-outline', tone: 'emerald', badge: 'New', type: 'errand', mode: 'quick_buy' },
        { label: 'Collect & Deliver', icon: 'swap-horizontal-outline', tone: 'emerald', type: 'errand', mode: 'collect_deliver' },
        { label: 'Shop & Deliver', icon: 'business-outline', tone: 'emerald', type: 'errand', mode: 'shop_deliver' },
        { label: 'Send Parcel', icon: 'cube-outline', tone: 'amber', type: 'delivery' },
        { label: 'Van Move', icon: 'bus', tone: 'indigo', type: 'van-moving' },
        { label: 'Scheduled', icon: 'calendar-clear-outline', tone: 'slate', badge: 'Soon', type: 'ride' },
        { label: 'Airport', icon: 'airplane-outline', tone: 'slate', badge: 'Soon', type: 'ride' }
    ];

    activeModePlaceholder = computed(() => {
        return this.topTabs.find(tab => tab.id === this.activeMode())?.placeholder || 'Where are you going?';
    });

    pendingMarketplaceBookings = computed(() => this.bookingService.pendingMarketplaceBookings());
    activeBooking = computed(() => this.bookingService.bookingHistory().find(
        booking => this.isDirectlyActiveBooking(booking)
    ) || null);

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
            settingsOutline,
            searchOutline,
            calendarClearOutline,
            locateOutline,
            swapHorizontalOutline,
            businessOutline,
            cubeOutline,
            airplaneOutline,
            arrowForward,
            personCircleOutline
        });
    }

    async ngOnInit(): Promise<void> {
        void this.walletService.fetchWallet();
        await this.bookingService.getHistory();
        this.subscribeToCustomerJobs();
        this.tour.startIfNeeded('customer');

        const userId = this.auth.currentUser()?.id;
        if (userId && !this.auth.profileService.profile()) {
            void this.auth.profileService.fetchProfile(userId);
        }
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

    continuePendingMarketplaceBooking(booking: any): void {
        void this.router.navigate(['/customer/marketplace-fare', booking.id]);
    }

    async onScheduleTap(): Promise<void> {
        const toast = await this.toastCtrl.create({
            message: 'Scheduled bookings are coming soon. Book now for immediate service.',
            duration: 2500,
            color: 'dark'
        });
        await toast.present();
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
        const profile = this.auth.profileService.profile();
        const profileName = String(profile?.first_name || profile?.full_name || '').trim();
        if (profileName) return profileName;

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
        if (raw.includes('errand')) return 'Shop';
        if (raw.includes('delivery') || raw.includes('package')) return 'Deliver';
        if (raw.includes('van') || raw.includes('moving')) return 'Move';
        return 'Booking';
    }

    getServiceIcon(booking: any): string {
        const name = this.getServiceName(booking);
        if (name === 'Shop') return 'cart';
        if (name === 'Move') return 'bus';
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

    async onShortcutTap(shortcut: ForYouShortcut): Promise<void> {
        if (shortcut.badge === 'Soon') {
            const toast = await this.toastCtrl.create({
                message: `${shortcut.label} is coming soon.`,
                duration: 2000,
                color: 'dark'
            });
            await toast.present();
            return;
        }

        this.goToBooking(shortcut.type, shortcut.mode);
    }

    goToBooking(type: HomeServiceMode, mode?: string): void {
        void this.router.navigate(['/customer/request'], {
            queryParams: mode ? { type, mode } : { type }
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
