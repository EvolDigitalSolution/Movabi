import { Component, inject, OnInit, signal } from '@angular/core';
import { AdminService } from '../../services/admin.service';
import { Booking, ServiceTypeEnum } from '../../../../shared/models/booking.model';
import { BookingService } from '../../../../core/services/booking/booking.service';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';

@Component({
  selector: 'app-booking-list',
  template: `
    <div class="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
      <div class="p-8 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 class="text-xl font-bold text-gray-900">Live Bookings</h3>
          <p class="text-sm text-gray-500 mt-1">Monitor all active and past bookings in real-time.</p>
        </div>
        <div class="flex items-center gap-4">
          <div class="relative">
            <ion-icon name="search-outline" class="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"></ion-icon>
            <input type="text" placeholder="Search bookings..." 
                   class="bg-gray-50 border border-gray-200 rounded-xl pl-11 pr-4 py-2 text-sm font-medium text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 w-64">
          </div>
          <button class="bg-blue-600 text-white px-6 py-2 rounded-xl font-bold text-sm hover:bg-blue-700 transition-all shadow-lg shadow-blue-600/20">
            Export CSV
          </button>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left">
          <thead>
            <tr class="bg-gray-50/50 border-b border-gray-100">
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Booking ID</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Customer</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Driver</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Price</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Status</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            @for (booking of bookings(); track booking.id) {
              <tr class="hover:bg-gray-50/50 transition-all group">
                <td class="px-8 py-4">
                  <span class="text-sm font-bold text-gray-900">#{{ booking.id.slice(0, 8) }}</span>
                  <p class="text-xs text-gray-400">{{ booking.created_at | date:'short' }}</p>
                </td>
                <td class="px-8 py-4">
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-xs">
                      {{ booking.customer?.first_name?.[0] || 'C' }}
                    </div>
                    <div>
                      <h4 class="text-sm font-bold text-gray-900">{{ booking.customer?.first_name }}</h4>
                      <p class="text-xs text-gray-400 truncate w-32">{{ booking.pickup_address }}</p>
                    </div>
                  </div>
                </td>
                <td class="px-8 py-4">
                  @if (booking.driver) {
                    <div class="flex items-center gap-3">
                      <div class="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center text-amber-600 font-bold text-xs">
                        {{ booking.driver.first_name[0] || 'D' }}
                      </div>
                      <div>
                        <h4 class="text-sm font-bold text-gray-900">{{ booking.driver.first_name }}</h4>
                        <p class="text-xs text-gray-400">ID: {{ booking.driver.id.slice(0, 8) }}</p>
                      </div>
                    </div>
                  } @else {
                    <span class="text-xs text-gray-400 font-bold uppercase tracking-widest">Searching...</span>
                  }
                </td>
                <td class="px-8 py-4 text-sm font-bold text-gray-900">
                  {{ '$' }}{{ booking.total_price }}
                </td>
                <td class="px-8 py-4">
                  <span [class]="'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-widest ' + getStatusClass(booking.status)">
                    {{ booking.status.replace('_', ' ') }}
                  </span>
                </td>
                <td class="px-8 py-4 text-right">
                  <button (click)="viewDetails(booking)" class="p-2 text-gray-400 hover:text-blue-600 transition-all">
                    <ion-icon name="eye-outline" class="text-xl"></ion-icon>
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    <!-- Booking Details Modal -->
    <ion-modal [isOpen]="isModalOpen" (didDismiss)="closeModal()">
      <ng-template>
        <ion-header class="ion-no-border">
          <ion-toolbar class="px-4 py-2">
            <ion-title class="text-lg font-bold">Booking Details</ion-title>
            <ion-buttons slot="end">
              <ion-button (click)="closeModal()">Close</ion-button>
            </ion-buttons>
          </ion-toolbar>
        </ion-header>

        <ion-content class="ion-padding bg-gray-50">
          @if (selectedBooking) {
            <div class="space-y-6">
              <!-- Status Banner -->
              <div [class]="'p-4 rounded-2xl text-center font-bold uppercase tracking-widest text-xs ' + getStatusClass(selectedBooking.status)">
                Status: {{ selectedBooking.status.replace('_', ' ') }}
              </div>

              <!-- Route Info -->
              <div class="bg-white p-6 rounded-3xl border border-gray-100 shadow-sm space-y-4">
                <div class="flex items-start gap-4">
                  <div class="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 shrink-0">
                    <ion-icon name="location-outline"></ion-icon>
                  </div>
                  <div>
                    <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Pickup</p>
                    <p class="text-sm font-bold text-gray-900">{{ selectedBooking.pickup_address }}</p>
                  </div>
                </div>
                <div class="flex items-start gap-4">
                  <div class="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center text-red-600 shrink-0">
                    <ion-icon name="flag-outline"></ion-icon>
                  </div>
                  <div>
                    <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Dropoff</p>
                    <p class="text-sm font-bold text-gray-900">{{ selectedBooking.dropoff_address || 'N/A' }}</p>
                  </div>
                </div>
              </div>

              <!-- Customer & Driver -->
              <div class="grid grid-cols-2 gap-4">
                <div class="bg-white p-6 rounded-3xl border border-gray-100 shadow-sm">
                  <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-4">Customer</p>
                  <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center text-blue-600 font-bold">
                      {{ selectedBooking.customer?.first_name?.[0] }}
                    </div>
                    <div>
                      <h4 class="text-sm font-bold text-gray-900">{{ selectedBooking.customer?.first_name }}</h4>
                      <p class="text-xs text-gray-500">{{ selectedBooking.customer?.email }}</p>
                    </div>
                  </div>
                </div>
                <div class="bg-white p-6 rounded-3xl border border-gray-100 shadow-sm">
                  <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-4">Driver</p>
                  @if (selectedBooking.driver) {
                    <div class="flex items-center gap-3">
                      <div class="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center text-amber-600 font-bold">
                        {{ selectedBooking.driver.first_name[0] }}
                      </div>
                      <div>
                        <h4 class="text-sm font-bold text-gray-900">{{ selectedBooking.driver.first_name }}</h4>
                        <p class="text-xs text-gray-500">ID: {{ selectedBooking.driver.id.slice(0, 8) }}</p>
                      </div>
                    </div>
                  } @else {
                    <p class="text-xs text-gray-400 italic">No driver assigned</p>
                  }
                </div>
              </div>

              <!-- Service Details -->
              @if (details()) {
                <div class="bg-white p-6 rounded-3xl border border-gray-100 shadow-sm">
                  <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-4">Service Details ({{ selectedBooking.service_code }})</p>
                  
                  @if (selectedBooking.service_code === ServiceTypeEnum.RIDE) {
                    <p class="text-sm"><span class="font-bold">Passengers:</span> {{ details().passenger_count }}</p>
                  }
                  @if (selectedBooking.service_code === ServiceTypeEnum.ERRAND) {
                    <p class="text-sm font-bold mb-2">Items:</p>
                    <ul class="list-disc ml-5 text-sm">
                      @for (item of details().items_list; track item) {
                        <li>{{ item }}</li>
                      }
                    </ul>
                  }
                  @if (selectedBooking.service_code === ServiceTypeEnum.DELIVERY) {
                    <p class="text-sm"><span class="font-bold">Recipient:</span> {{ details().recipient_name }}</p>
                  }
                  @if (selectedBooking.service_code === ServiceTypeEnum.VAN) {
                    <p class="text-sm"><span class="font-bold">Helpers:</span> {{ details().helper_count }}</p>
                  }
                </div>
              }

              <!-- Admin Override -->
              <div class="bg-red-50 p-6 rounded-3xl border border-red-100 shadow-sm space-y-6">
                <div>
                  <p class="text-[10px] font-bold text-red-400 uppercase tracking-widest mb-4">Manual Driver Assignment</p>
                  <div class="flex items-center gap-4">
                    <select #driverSelect class="flex-1 bg-white border border-red-200 rounded-xl px-4 py-2 text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500/20">
                      <option value="">Select a driver...</option>
                      @for (driver of drivers(); track driver.id) {
                        <option [value]="driver.id" [selected]="driver.id === selectedBooking.driver_id">
                          {{ driver.first_name }} ({{ driver.status }})
                        </option>
                      }
                    </select>
                    <button (click)="assignDriver(selectedBooking.id, driverSelect.value)" 
                            [disabled]="!driverSelect.value"
                            class="bg-blue-600 text-white px-6 py-2 rounded-xl font-bold text-sm hover:bg-blue-700 transition-all shadow-lg shadow-blue-600/20 disabled:opacity-50">
                      Assign
                    </button>
                  </div>
                </div>

                <div>
                  <p class="text-[10px] font-bold text-red-400 uppercase tracking-widest mb-4">Status Override</p>
                  <div class="flex items-center gap-4">
                    <select #statusSelect class="flex-1 bg-white border border-red-200 rounded-xl px-4 py-2 text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500/20">
                      @for (status of allStatuses; track status) {
                        <option [value]="status" [selected]="status === selectedBooking.status">{{ status.replace('_', ' ') }}</option>
                      }
                    </select>
                    <button (click)="forceUpdateStatus(selectedBooking.id, statusSelect.value)" 
                            class="bg-red-600 text-white px-6 py-2 rounded-xl font-bold text-sm hover:bg-red-700 transition-all shadow-lg shadow-red-600/20">
                      Force Update
                    </button>
                  </div>
                  <p class="text-[10px] text-red-400 italic mt-2">Use this to fix stuck bookings. This bypasses standard transition rules.</p>
                </div>
              </div>

              <!-- Pricing -->
              <div class="bg-white p-6 rounded-3xl border border-gray-100 shadow-sm">
                <div class="flex items-center justify-between">
                  <p class="text-sm font-bold text-gray-900">Total Price</p>
                  <p class="text-2xl font-bold text-blue-600">{{ '$' }}{{ selectedBooking.total_price }}</p>
                </div>
                <div class="mt-4 pt-4 border-t border-gray-50 flex items-center justify-between text-xs text-gray-500">
                  <span>Service Type</span>
                  <span class="font-bold uppercase tracking-widest">{{ selectedBooking.service_type?.name || 'Standard' }}</span>
                </div>
              </div>
            </div>
          }
        </ion-content>
      </ng-template>
    </ion-modal>
  `,
  imports: [CommonModule, IonicModule]
})
export class BookingListComponent implements OnInit {
  private adminService = inject(AdminService);
  private bookingService = inject(BookingService);

  ServiceTypeEnum = ServiceTypeEnum;
  bookings = signal<Booking[]>([]);
  drivers = signal<any[]>([]);
  isModalOpen = false;
  selectedBooking: Booking | null = null;
  details = signal<any>(null);

  allStatuses: string[] = ['requested', 'searching', 'assigned', 'accepted', 'arrived', 'in_progress', 'completed', 'cancelled'];

  async ngOnInit() {
    await Promise.all([
      this.loadBookings(),
      this.loadDrivers()
    ]);
  }

  async loadBookings() {
    const data = await this.adminService.getLiveBookings();
    this.bookings.set(data);
  }

  async loadDrivers() {
    const data = await this.adminService.getDrivers();
    this.drivers.set(data);
  }

  async viewDetails(booking: Booking) {
    this.selectedBooking = booking;
    this.isModalOpen = true;
    
    try {
      const details = await this.bookingService.getBookingDetails(booking.id, booking.service_code);
      this.details.set(details);
    } catch (e) {
      console.error('Failed to load details', e);
      this.details.set(null);
    }
  }

  async forceUpdateStatus(bookingId: string, status: any) {
    if (!confirm(`Are you sure you want to force update this booking to ${status}?`)) return;
    
    try {
      await this.adminService.updateBookingStatus(bookingId, status, 'Admin force update');
      await this.loadBookings();
      if (this.selectedBooking?.id === bookingId) {
        this.selectedBooking = { ...this.selectedBooking, status };
      }
    } catch (e) {
      alert('Failed to update status: ' + (e as Error).message);
    }
  }

  async assignDriver(bookingId: string, driverId: string) {
    if (!confirm('Are you sure you want to manually assign this driver?')) return;

    try {
      await this.adminService.manualAssignDriver(bookingId, driverId);
      await this.loadBookings();
      if (this.selectedBooking?.id === bookingId) {
        // Refresh selected booking to show new driver
        const updated = await this.bookingService.getBooking(bookingId);
        this.selectedBooking = updated;
      }
    } catch (e) {
      alert('Failed to assign driver: ' + (e as Error).message);
    }
  }

  closeModal() {
    this.isModalOpen = false;
    this.selectedBooking = null;
    this.details.set(null);
  }

  getStatusClass(status: string) {
    switch (status) {
      case 'completed': return 'bg-emerald-100 text-emerald-600';
      case 'cancelled': return 'bg-red-100 text-red-600';
      case 'searching': return 'bg-amber-100 text-amber-600';
      case 'accepted': return 'bg-blue-100 text-blue-600';
      case 'in_progress': return 'bg-indigo-100 text-indigo-600';
      default: return 'bg-gray-100 text-gray-600';
    }
  }
}
