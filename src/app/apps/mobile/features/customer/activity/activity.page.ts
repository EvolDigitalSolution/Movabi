import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController } from '@ionic/angular';
import { BookingService } from '../../../../../core/services/booking/booking.service';
import { AppConfigService } from '../../../../../core/services/config/app-config.service';

import { CardComponent, BadgeComponent, EmptyStateComponent } from '../../../../../shared/ui';

@Component({
  selector: 'app-activity',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-6 bg-slate-50">
        <ion-buttons slot="start">
          <button (click)="nav.back()" class="w-12 h-12 rounded-2xl bg-white text-slate-900 flex items-center justify-center border border-slate-200 shadow-sm active:scale-95 transition-all">
            <ion-icon name="chevron-back-outline" class="text-xl"></ion-icon>
          </button>
        </ion-buttons>
        <ion-title class="font-display font-black text-2xl tracking-tighter text-slate-900">Activity</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="max-w-xl mx-auto p-6 space-y-8 pb-12">
        @if (history().length === 0) {
          <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden py-12">
            <app-empty-state 
              icon="calendar-clear-outline"
              title="No bookings yet"
              description="Your journey history will appear here once you complete your first ride or errand."
              actionLabel="Book a Ride"
              (action)="nav.navigateForward('/customer/home')"
            ></app-empty-state>
          </div>
        }

        <div class="space-y-5">
          @for (booking of history(); track booking.id) {
            <app-card [hoverable]="true" class="group">
              <div class="flex justify-between items-start mb-8">
                <div class="flex items-center gap-4">
                  <div class="w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 border border-blue-100 group-hover:bg-blue-600 group-hover:text-white transition-all duration-500">
                    <ion-icon [name]="getServiceIcon(booking.service_type?.name)" class="text-2xl"></ion-icon>
                  </div>
                  <div>
                    <span class="text-[10px] font-black uppercase text-slate-400 tracking-[0.2em] mb-1 block">{{ booking.service_type?.name }}</span>
                    <p class="text-xs text-slate-500 font-bold">{{ booking.created_at | date:'mediumDate' }} • {{ booking.created_at | date:'shortTime' }}</p>
                  </div>
                </div>
                <app-badge [variant]="getStatusVariant(booking.status)">{{ booking.status }}</app-badge>
              </div>

              <div class="relative pl-10 space-y-8 mb-10">
                <!-- Vertical Line -->
                <div class="absolute left-4 top-2 bottom-2 w-0.5 bg-slate-100 dashed border-l-2 border-slate-200 border-dashed"></div>

                <div class="relative">
                  <div class="absolute -left-8 top-1 w-4 h-4 rounded-full bg-white border-4 border-blue-600 shadow-sm z-10"></div>
                  <div>
                    <p class="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1.5">Pickup</p>
                    <p class="font-bold text-slate-900 leading-relaxed text-sm truncate">{{ booking.pickup_address }}</p>
                  </div>
                </div>
                <div class="relative">
                  <div class="absolute -left-8 top-1 w-4 h-4 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                  <div>
                    <p class="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1.5">Destination</p>
                    <p class="font-bold text-slate-900 leading-relaxed text-sm truncate">{{ booking.dropoff_address }}</p>
                  </div>
                </div>
              </div>

              <div class="flex justify-between items-center pt-6 border-t border-slate-50">
                <div class="flex items-center gap-2">
                  <span class="text-2xl font-display font-bold text-slate-900">{{ formatPrice(booking.total_price) }}</span>
                </div>
                @if (booking.driver) {
                  <div class="flex items-center gap-3 bg-slate-50 px-4 py-2 rounded-2xl border border-slate-100">
                    <div class="w-8 h-8 rounded-xl bg-white flex items-center justify-center text-xs font-black text-slate-900 border border-slate-200 shadow-sm">
                      {{ booking.driver.first_name[0] }}
                    </div>
                    <div class="text-left">
                      <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Driver</p>
                      <span class="text-xs font-bold text-slate-900">{{ booking.driver.first_name }}</span>
                    </div>
                  </div>
                }
              </div>
            </app-card>
          }
        </div>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, CardComponent, BadgeComponent, EmptyStateComponent]
})
export class ActivityPage implements OnInit {
  private bookingService = inject(BookingService);
  private config = inject(AppConfigService);
  public nav = inject(NavController);
  history = this.bookingService.bookingHistory;

  ngOnInit() {
    this.bookingService.getHistory();
  }

  getServiceIcon(name: string | undefined): string {
    if (!name) return 'map';
    switch (name.toLowerCase()) {
      case 'ride': return 'car';
      case 'errand': return 'cart';
      case 'van moving': return 'bus';
      default: return 'map';
    }
  }

  getStatusVariant(status: string): 'success' | 'error' | 'warning' | 'info' | 'primary' {
    switch (status?.toLowerCase()) {
      case 'completed': return 'success';
      case 'cancelled': return 'error';
      case 'pending': return 'warning';
      case 'in_progress': return 'info';
      default: return 'primary';
    }
  }

  formatPrice(amount: number) {
    return this.config.formatCurrency(amount);
  }
}
