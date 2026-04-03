import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { BookingService } from '../../../../../core/services/booking/booking.service';

@Component({
  selector: 'app-activity',
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/customer"></ion-back-button>
        </ion-buttons>
        <ion-title>My Activity</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      @if (history().length === 0) {
        <div class="text-center mt-20">
          <ion-icon name="calendar-outline" class="text-6xl text-gray-300"></ion-icon>
          <p class="text-gray-500 mt-4">No bookings yet.</p>
        </div>
      }

      <ion-list lines="none">
        @for (booking of history(); track booking.id) {
          <ion-item class="mb-4 bg-white rounded-2xl shadow-sm border border-gray-100">
            <ion-label>
              <div class="flex justify-between items-center mb-2">
                <span class="text-xs font-bold uppercase text-gray-400">{{ booking.service_type?.name }}</span>
                <span class="text-xs font-bold px-2 py-1 rounded bg-gray-100">{{ booking.status }}</span>
              </div>
              <h3 class="font-bold">{{ booking.pickup_address }}</h3>
              <p class="text-sm text-gray-500">{{ booking.created_at | date:'medium' }}</p>
              <div class="mt-2 flex justify-between items-center">
                <span class="font-bold text-blue-600">{{ '$' }}{{ booking.total_price }}</span>
                @if (booking.driver) {
                  <span class="text-xs text-gray-400">Driver: {{ booking.driver.first_name }}</span>
                }
              </div>
            </ion-label>
          </ion-item>
        }
      </ion-list>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule]
})
export class ActivityPage implements OnInit {
  private bookingService = inject(BookingService);
  history = this.bookingService.bookingHistory;

  ngOnInit() {
    this.bookingService.getHistory();
  }
}
