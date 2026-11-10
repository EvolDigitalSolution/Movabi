import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonIcon
} from '@ionic/angular/standalone';
import { Router } from '@angular/router';
import { addIcons } from 'ionicons';
import {
    car,
    calendarClearOutline,
    airplaneOutline,
    cartOutline,
    swapHorizontalOutline,
    businessOutline,
    cubeOutline,
    documentTextOutline,
    fastFoodOutline,
    briefcaseOutline,
    busOutline,
    homeOutline,
    constructOutline
} from 'ionicons/icons';

import { CustomerBottomNavComponent } from '../../../../../shared/components/customer-shell/customer-bottom-nav.component';

type BookingType = 'ride' | 'errand' | 'delivery' | 'van-moving';

interface ServiceCard {
    label: string;
    description: string;
    icon: string;
    tone: 'blue' | 'emerald' | 'amber' | 'indigo';
    type: BookingType;
    mode?: string;
    badge?: 'Soon';
}

interface ServiceGroup {
    title: string;
    items: ServiceCard[];
}

@Component({
    selector: 'app-customer-services',
    standalone: true,
    imports: [CommonModule, IonHeader, IonToolbar, IonTitle, IonContent, IonIcon, CustomerBottomNavComponent],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-6 bg-slate-50">
        <ion-title class="font-display font-black text-2xl tracking-tighter text-slate-900">
          Services
        </ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="movabi-page">
      <div class="max-w-2xl mx-auto p-3 sm:p-5 space-y-6 native-safe-bottom">
        @for (group of serviceGroups; track group.title) {
          <div class="space-y-3">
            <h3 class="movabi-section-title">{{ group.title }}</h3>

            <div class="grid grid-cols-2 gap-2.5">
              @for (item of group.items; track item.label) {
                <button
                  type="button"
                  (click)="goToBooking(item)"
                  class="min-h-[92px] text-left rounded-2xl bg-white border border-slate-100 shadow-sm p-3.5 flex flex-col gap-2 active:scale-95 transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500"
                >
                  <span class="relative w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                    [class.bg-blue-50]="item.tone === 'blue'"
                    [class.text-blue-600]="item.tone === 'blue'"
                    [class.bg-emerald-50]="item.tone === 'emerald'"
                    [class.text-emerald-600]="item.tone === 'emerald'"
                    [class.bg-amber-50]="item.tone === 'amber'"
                    [class.text-amber-600]="item.tone === 'amber'"
                    [class.bg-indigo-50]="item.tone === 'indigo'"
                    [class.text-indigo-600]="item.tone === 'indigo'"
                  >
                    <ion-icon [name]="item.icon" class="text-lg"></ion-icon>
                    @if (item.badge) {
                      <span class="absolute -top-1.5 -right-1.5 text-[7px] font-black uppercase tracking-wide px-1.5 py-0.5 rounded-full text-white bg-slate-400">
                        {{ item.badge }}
                      </span>
                    }
                  </span>
                  <span class="min-w-0">
                    <span class="block text-sm font-black text-slate-950 leading-tight">{{ item.label }}</span>
                    <span class="block text-[10px] font-semibold text-slate-400 leading-snug mt-0.5">{{ item.description }}</span>
                  </span>
                </button>
              }
            </div>
          </div>
        }
      </div>
    </ion-content>

    <app-customer-bottom-nav></app-customer-bottom-nav>
  `
})
export class ServicesPage {
    private router = inject(Router);

    readonly serviceGroups: ServiceGroup[] = [
        {
            title: 'Everyday',
            items: [
                { label: 'Ride', description: 'Everyday trips', icon: 'car', tone: 'blue', type: 'ride' },
                { label: 'Scheduled Ride', description: 'Book ahead', icon: 'calendar-clear-outline', tone: 'blue', type: 'ride', badge: 'Soon' },
                { label: 'Airport Ride', description: 'Flight pickups', icon: 'airplane-outline', tone: 'blue', type: 'ride', badge: 'Soon' }
            ]
        },
        {
            title: 'Shop',
            items: [
                { label: 'Quick Buy', description: 'We shop for you', icon: 'cart-outline', tone: 'emerald', type: 'errand', mode: 'quick_buy' },
                { label: 'Collect & Deliver', description: 'Pickup and drop off', icon: 'swap-horizontal-outline', tone: 'emerald', type: 'errand', mode: 'collect_deliver' },
                { label: 'Shop & Deliver', description: 'Popular shops', icon: 'business-outline', tone: 'emerald', type: 'errand', mode: 'shop_deliver' }
            ]
        },
        {
            title: 'Deliver',
            items: [
                { label: 'Parcel', description: 'Send an item', icon: 'cube-outline', tone: 'amber', type: 'delivery' },
                { label: 'Documents', description: 'Papers & envelopes', icon: 'document-text-outline', tone: 'amber', type: 'delivery' },
                { label: 'Food', description: 'Hot food delivery', icon: 'fast-food-outline', tone: 'amber', type: 'delivery' },
                { label: 'Business Delivery', description: 'Bulk & recurring', icon: 'briefcase-outline', tone: 'amber', type: 'delivery' }
            ]
        },
        {
            title: 'Move',
            items: [
                { label: 'Van', description: 'Small van jobs', icon: 'bus-outline', tone: 'indigo', type: 'van-moving' },
                { label: 'Furniture', description: 'Bulky items', icon: 'construct-outline', tone: 'indigo', type: 'van-moving' },
                { label: 'House Move', description: 'Full house moves', icon: 'home-outline', tone: 'indigo', type: 'van-moving' },
                { label: 'Appliances', description: 'Fridges & more', icon: 'cube-outline', tone: 'indigo', type: 'van-moving' }
            ]
        }
    ];

    constructor() {
        addIcons({
            car,
            calendarClearOutline,
            airplaneOutline,
            cartOutline,
            swapHorizontalOutline,
            businessOutline,
            cubeOutline,
            documentTextOutline,
            fastFoodOutline,
            briefcaseOutline,
            busOutline,
            homeOutline,
            constructOutline
        });
    }

    goToBooking(item: ServiceCard): void {
        void this.router.navigate(['/customer/request'], {
            queryParams: item.mode ? { type: item.type, mode: item.mode } : { type: item.type }
        });
    }
}
