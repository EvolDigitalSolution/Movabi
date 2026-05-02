import { Component, inject, OnInit } from '@angular/core';
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
    cubeOutline
} from 'ionicons/icons';
import { Router } from '@angular/router';
import { BookingService } from '../../../../../core/services/booking/booking.service';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';

import { CardComponent, BadgeComponent, EmptyStateComponent } from '../../../../../shared/ui';

@Component({
    selector: 'app-activity',
    standalone: true,
    imports: [IonicModule, CommonModule, CardComponent, BadgeComponent, EmptyStateComponent],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-6 bg-slate-50">
        <ion-buttons slot="start">
          <button
            type="button"
            (click)="router.navigate(['/customer'])"
            class="w-12 h-12 rounded-2xl bg-white text-slate-900 flex items-center justify-center border border-slate-200 shadow-sm active:scale-95 transition-all"
          >
            <ion-icon name="chevron-back-outline" class="text-xl"></ion-icon>
          </button>
        </ion-buttons>

        <ion-title class="font-display font-black text-2xl tracking-tighter text-slate-900">
          Activity
        </ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="max-w-xl mx-auto p-5 space-y-8 pb-16">
        @if (history().length === 0) {
          <div class="bg-white rounded-[2.25rem] border border-slate-100 shadow-sm overflow-hidden py-12">
            <app-empty-state
              icon="calendar-clear-outline"
              title="No bookings yet"
              description="Your ride, errand, delivery, and moving history will appear here."
              actionLabel="Book a Service"
              (action)="router.navigate(['/customer/request'])"
            ></app-empty-state>
          </div>
        }

        <div class="space-y-5">
          @for (booking of history(); track booking.id) {
            <app-card [hoverable]="true" class="group overflow-hidden">
              <div class="flex justify-between items-start gap-4 mb-7">
                <div class="flex items-center gap-4 min-w-0">
                  <div
                    class="w-14 h-14 rounded-2xl flex items-center justify-center border transition-all duration-300 shrink-0"
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
                    <ion-icon [name]="getServiceIcon(booking)" class="text-2xl"></ion-icon>
                  </div>

                  <div class="min-w-0">
                    <span class="text-[10px] font-black uppercase text-slate-400 tracking-[0.18em] mb-1 block">
                      {{ getServiceName(booking) }}
                    </span>
                    <p class="text-xs text-slate-500 font-bold">
                      {{ booking.created_at | date:'mediumDate' }} • {{ booking.created_at | date:'shortTime' }}
                    </p>
                  </div>
                </div>

                <app-badge [variant]="getStatusVariant(booking.status)">
                  {{ formatStatus(booking.status) }}
                </app-badge>
              </div>

              <div class="relative pl-10 space-y-7 mb-8">
                <div class="absolute left-4 top-2 bottom-2 w-0.5 border-l-2 border-slate-200 border-dashed"></div>

                <div class="relative">
                  <div class="absolute -left-8 top-1 w-4 h-4 rounded-full bg-white border-4 border-blue-600 shadow-sm z-10"></div>
                  <p class="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1.5">Pickup</p>
                  <p class="font-bold text-slate-900 leading-relaxed text-sm truncate">
                    {{ booking.pickup_address || 'Pickup unavailable' }}
                  </p>
                </div>

                <div class="relative">
                  <div class="absolute -left-8 top-1 w-4 h-4 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                  <p class="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1.5">
                    {{ getServiceSlug(booking) === 'delivery' ? 'Delivery Address' : 'Destination' }}
                  </p>
                  <p class="font-bold text-slate-900 leading-relaxed text-sm truncate">
                    {{ booking.dropoff_address || 'Destination unavailable' }}
                  </p>
                </div>
              </div>

              <div class="flex justify-between items-center gap-4 pt-5 border-t border-slate-100">
                <span class="text-2xl font-display font-bold text-slate-900">
                  {{ formatPrice(booking.total_price || booking.price || 0) }}
                </span>

                @if (booking.driver) {
                  <div class="flex items-center gap-3 bg-slate-50 px-3 py-2 rounded-2xl border border-slate-100 min-w-0">
                    <div class="w-8 h-8 rounded-xl bg-white flex items-center justify-center text-xs font-black text-slate-900 border border-slate-200 shadow-sm shrink-0">
                      {{ getInitial(booking.driver?.first_name) }}
                    </div>

                    <div class="text-left min-w-0">
                      <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Driver</p>
                      <span class="text-xs font-bold text-slate-900 truncate block">
                        {{ booking.driver?.first_name || 'Driver' }}
                      </span>
                    </div>
                  </div>
                }
              </div>
            </app-card>
          }
        </div>
      </div>
    </ion-content>
  `
})
export class ActivityPage implements OnInit {
    private bookingService = inject(BookingService);
    private config = inject(AppConfigService);
    public router = inject(Router);

    history = this.bookingService.bookingHistory;

    constructor() {
        addIcons({
            chevronBackOutline,
            calendarClearOutline,
            car,
            cart,
            bus,
            map,
            cubeOutline
        });
    }

    ngOnInit() {
        void this.bookingService.getHistory();
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
                return 'Errand';
            case 'delivery':
                return 'Delivery';
            case 'van-moving':
                return 'Van Moving';
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
                return 'success';
            case 'cancelled':
            case 'failed':
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

    getInitial(value?: string | null): string {
        return String(value || 'D').trim().charAt(0).toUpperCase() || 'D';
    }

    formatPrice(amount: number | null | undefined) {
        return this.config.formatCurrency(Number(amount || 0));
    }
}