import { Component, computed, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
    chevronBackOutline,
    calendarClearOutline,
    car,
    cart,
    bus,
    map,
    cubeOutline,
    timeOutline,
    checkmarkCircle
} from 'ionicons/icons';
import { Router } from '@angular/router';
import { Booking } from '../../../../../shared/models/booking.model';
import { BookingService } from '../../../../../core/services/booking/booking.service';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';

import { CardComponent, BadgeComponent } from '../../../../../shared/ui';
import { CustomerBottomNavComponent } from '../../../../../shared/components/customer-shell/customer-bottom-nav.component';

@Component({
    selector: 'app-activity',
    standalone: true,
    imports: [IonicModule, CommonModule, CardComponent, BadgeComponent, CustomerBottomNavComponent],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-6 bg-slate-50">
        <ion-title class="font-display font-black text-2xl tracking-tighter text-slate-900">
          Activity
        </ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50" [fullscreen]="true">
      <div class="max-w-xl mx-auto p-5 space-y-8 native-safe-bottom">

        @if (activeBookings().length === 0 && pendingMarketplace().length === 0 && pastBookings().length === 0) {
          <button
            type="button"
            (click)="router.navigate(['/customer/request'])"
            class="w-full bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-3 text-left active:scale-[0.99] transition-all"
          >
            <div class="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 flex items-center justify-center shrink-0">
              <ion-icon name="calendar-clear-outline" class="text-xl"></ion-icon>
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-black text-slate-900">No bookings yet</p>
              <p class="text-xs font-semibold text-slate-500 truncate">Ride, errand, delivery, and moving history will appear here.</p>
            </div>
          </button>
        }

        @if (activeBookings().length > 0) {
          <div class="space-y-3">
            <div class="flex items-center gap-3 px-1">
              <div class="w-1.5 h-6 bg-emerald-500 rounded-full shadow-lg shadow-emerald-500/20"></div>
              <h3 class="text-sm font-black text-slate-700">Active</h3>
            </div>

            <div class="space-y-3">
              @for (booking of activeBookings(); track booking.id) {
                <button
                  type="button"
                  (click)="continueActive(booking)"
                  class="w-full bg-white rounded-2xl border border-emerald-200 shadow-sm p-4 flex items-center gap-3 text-left active:scale-[0.99] transition-all"
                >
                  <div
                    class="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                    [class.bg-blue-50]="getServiceSlug(booking) === 'ride'"
                    [class.text-blue-600]="getServiceSlug(booking) === 'ride'"
                    [class.bg-emerald-50]="getServiceSlug(booking) === 'errand'"
                    [class.text-emerald-600]="getServiceSlug(booking) === 'errand'"
                    [class.bg-amber-50]="getServiceSlug(booking) === 'delivery'"
                    [class.text-amber-600]="getServiceSlug(booking) === 'delivery'"
                    [class.bg-indigo-50]="getServiceSlug(booking) === 'van-moving'"
                    [class.text-indigo-600]="getServiceSlug(booking) === 'van-moving'"
                  >
                    <ion-icon [name]="getServiceIcon(booking)" class="text-xl"></ion-icon>
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-black text-slate-900 truncate">{{ getServiceName(booking) }}</p>
                    <p class="text-xs font-semibold text-emerald-700 truncate">{{ activeStatusLabel(booking) }}</p>
                  </div>
                  <div class="text-right shrink-0">
                    <p class="text-sm font-black text-slate-900">{{ formatPrice(booking.total_price || booking.price || 0) }}</p>
                    <span class="text-[9px] font-black uppercase tracking-widest text-blue-600">Continue</span>
                  </div>
                </button>
              }
            </div>
          </div>
        }

        @if (pendingMarketplace().length > 0) {
          <div class="space-y-3">
            <div class="flex items-center gap-3 px-1">
              <div class="w-1.5 h-6 bg-amber-500 rounded-full shadow-lg shadow-amber-500/20"></div>
              <h3 class="text-sm font-black text-slate-700">Pending Marketplace</h3>
            </div>

            <div class="space-y-3">
              @for (booking of pendingMarketplace(); track booking.id) {
                <button
                  type="button"
                  (click)="continueMarketplace(booking)"
                  class="w-full bg-white rounded-2xl border border-amber-200 shadow-sm p-4 flex items-center gap-3 text-left active:scale-[0.99] transition-all"
                >
                  <div class="w-11 h-11 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center shrink-0">
                    <ion-icon [name]="getServiceIcon(booking)" class="text-xl"></ion-icon>
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-black text-slate-900 truncate">{{ getServiceName(booking) }}</p>
                    <p class="text-xs font-semibold text-amber-700 truncate">{{ marketplaceStatusLabel(booking) }}</p>
                  </div>
                  <div class="text-right shrink-0">
                    <p class="text-sm font-black text-slate-900">{{ formatPrice(booking.negotiated_fare || booking.agreed_fare || booking.total_price || 0) }}</p>
                    <span class="text-[9px] font-black uppercase tracking-widest text-amber-600">Review</span>
                  </div>
                </button>
              }
            </div>
          </div>
        }

        @if (pastBookings().length > 0) {
          <div class="space-y-3">
            <div class="flex items-center gap-3 px-1">
              <div class="w-1.5 h-6 bg-slate-300 rounded-full"></div>
              <h3 class="text-sm font-black text-slate-700">Past</h3>
            </div>

            <div class="space-y-3">
              @for (booking of pastBookings(); track booking.id) {
                <app-card [hoverable]="false" class="group overflow-hidden">
                  <div class="flex justify-between items-start gap-4">
                    <div class="flex items-center gap-3 min-w-0">
                      <div
                        class="w-11 h-11 rounded-xl flex items-center justify-center border shrink-0"
                        [class.bg-blue-50]="getServiceSlug(booking) === 'ride'"
                        [class.text-blue-600]="getServiceSlug(booking) === 'ride'"
                        [class.border-blue-100]="getServiceSlug(booking) === 'ride'"
                        [class.bg-emerald-50]="getServiceSlug(booking) === 'errand'"
                        [class.text-emerald-600]="getServiceSlug(booking) === 'errand'"
                        [class.border-emerald-100]="getServiceSlug(booking) === 'errand'"
                        [class.bg-amber-50]="getServiceSlug(booking) === 'delivery'"
                        [class.text-amber-600]="getServiceSlug(booking) === 'delivery'"
                        [class.border-amber-100]="getServiceSlug(booking) === 'delivery'"
                        [class.bg-indigo-50]="getServiceSlug(booking) === 'van-moving'"
                        [class.text-indigo-600]="getServiceSlug(booking) === 'van-moving'"
                        [class.border-indigo-100]="getServiceSlug(booking) === 'van-moving'"
                      >
                        <ion-icon [name]="getServiceIcon(booking)" class="text-lg"></ion-icon>
                      </div>

                      <div class="min-w-0">
                        <p class="text-sm font-black text-slate-900 truncate">{{ getServiceName(booking) }}</p>
                        <p class="text-[11px] text-slate-400 font-bold">
                          {{ booking.created_at | date:'mediumDate' }}
                        </p>
                      </div>
                    </div>

                    <div class="text-right shrink-0">
                      <app-badge [variant]="getStatusVariant(booking.status)">
                        {{ formatStatus(booking.status) }}
                      </app-badge>
                      <p class="text-sm font-black text-slate-900 mt-1.5">
                        {{ formatPrice(booking.total_price || booking.price || 0) }}
                      </p>
                    </div>
                  </div>
                </app-card>
              }
            </div>
          </div>
        }
      </div>
    </ion-content>

    <app-customer-bottom-nav></app-customer-bottom-nav>
  `
})
export class ActivityPage implements OnInit {
    private bookingService = inject(BookingService);
    private config = inject(AppConfigService);
    public router = inject(Router);

    private readonly activeStatuses = new Set([
        'pending',
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

    private readonly pastStatuses = new Set([
        'completed',
        'cancelled',
        'no_driver_found',
        'settled'
    ]);

    private readonly marketplaceStatuses = new Set([
        'negotiating',
        'pending_fare_confirmation',
        'fare_agreed'
    ]);

    history = this.bookingService.bookingHistory;

    pendingMarketplace = computed(() => this.bookingService.pendingMarketplaceBookings());

    activeBookings = computed(() => {
        const marketplaceIds = new Set(this.pendingMarketplace().map(b => b.id));
        return this.history().filter(booking =>
            !marketplaceIds.has(booking.id) &&
            this.activeStatuses.has(String(booking.status || '').toLowerCase())
        );
    });

    pastBookings = computed(() => {
        const marketplaceIds = new Set(this.pendingMarketplace().map(b => b.id));
        return this.history().filter(booking =>
            !marketplaceIds.has(booking.id) &&
            this.pastStatuses.has(String(booking.status || '').toLowerCase())
        );
    });

    constructor() {
        addIcons({
            chevronBackOutline,
            calendarClearOutline,
            car,
            cart,
            bus,
            map,
            cubeOutline,
            timeOutline,
            checkmarkCircle
        });
    }

    ngOnInit() {
        void this.bookingService.getHistory();
    }

    continueActive(booking: Booking): void {
        void this.router.navigate(['/customer/tracking', booking.id]);
    }

    continueMarketplace(booking: Booking): void {
        void this.router.navigate(['/customer/marketplace-fare', booking.id]);
    }

    activeStatusLabel(booking: Booking): string {
        const status = String(booking?.status || 'requested').toLowerCase();
        const labels: Record<string, string> = {
            pending: 'Request received',
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
            delivered: 'Delivery arrived'
        };

        return labels[status] || this.formatStatus(status);
    }

    marketplaceStatusLabel(booking: Booking): string {
        const status = String(booking?.status || '').toLowerCase();
        const labels: Record<string, string> = {
            negotiating: 'Negotiating fare',
            pending_fare_confirmation: 'Fare offer received',
            fare_agreed: 'Fare agreed — payment needed'
        };

        return labels[status] || 'Continue negotiation';
    }

    getServiceSlug(booking: any): 'ride' | 'errand' | 'delivery' | 'van-moving' | 'other' {
        const raw = String(
            booking?.service_slug ||
            booking?.service_type?.slug ||
            booking?.service_type?.name ||
            booking?.type ||
            ''
        ).toLowerCase();

        if (raw.includes('ride') || raw.includes('taxi')) return 'ride';
        if (raw.includes('errand') || raw.includes('shopping')) return 'errand';
        if (raw.includes('delivery') || raw.includes('courier') || raw.includes('parcel') || raw.includes('package')) return 'delivery';
        if (raw.includes('van') || raw.includes('moving')) return 'van-moving';

        return 'other';
    }

    getServiceName(booking: any): string {
        const slug = this.getServiceSlug(booking);

        switch (slug) {
            case 'ride':
                return 'Ride';
            case 'errand':
                return 'Shop';
            case 'delivery':
                return 'Deliver';
            case 'van-moving':
                return 'Move';
            default:
                return booking?.service_type?.name || 'Booking';
        }
    }

    getServiceIcon(booking: any): string {
        const slug = this.getServiceSlug(booking);

        switch (slug) {
            case 'ride':
                return 'car';
            case 'errand':
                return 'cart';
            case 'delivery':
                return 'cube-outline';
            case 'van-moving':
                return 'bus';
            default:
                return 'map';
        }
    }

    getStatusVariant(status: string): 'success' | 'error' | 'warning' | 'info' | 'primary' {
        switch (String(status || '').toLowerCase()) {
            case 'completed':
            case 'paid':
            case 'settled':
                return 'success';
            case 'cancelled':
            case 'failed':
            case 'no_driver_found':
                return 'error';
            case 'pending':
            case 'searching':
                return 'warning';
            case 'accepted':
            case 'arrived':
            case 'in_progress':
            case 'arrived_at_store':
            case 'shopping_in_progress':
            case 'collected':
            case 'en_route_to_customer':
            case 'delivered':
                return 'info';
            default:
                return 'primary';
        }
    }

    formatStatus(status: string): string {
        return String(status || 'pending')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, char => char.toUpperCase());
    }

    formatPrice(amount: number | null | undefined) {
        return this.config.formatCurrency(Number(amount || 0));
    }
}
