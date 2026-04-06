import { Component, inject, OnInit, signal } from '@angular/core';
import { AdminService } from '../../services/admin.service';
import { Booking, ServiceTypeEnum, BookingStatus, DriverProfile, Vehicle } from '../../../../shared/models/booking.model';
import { BookingService } from '../../../../core/services/booking/booking.service';
import { CommonModule } from '@angular/common';
import { IonicModule, AlertController, ToastController } from '@ionic/angular';
import { BadgeComponent } from '../../../../shared/ui/badge';
import { ButtonComponent } from '../../../../shared/ui/button';
import { CardComponent } from '../../../../shared/ui/card';

@Component({
  selector: 'app-booking-list',
  template: `
    <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-2xl shadow-slate-200/40 overflow-hidden">
      <div class="p-10 border-b border-slate-50 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h3 class="text-2xl font-display font-bold text-slate-900">Live Bookings</h3>
          <p class="text-slate-500 font-medium mt-1">Monitor all active and past bookings in real-time.</p>
        </div>
        <div class="flex flex-col sm:flex-row items-center gap-4">
          <div class="relative w-full sm:w-72 group">
            <ion-icon name="search-outline" class="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-600 transition-colors"></ion-icon>
            <input type="text" placeholder="Search bookings..." 
                   class="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-12 pr-5 py-3 text-sm font-medium text-slate-600 focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/50 transition-all">
          </div>
          <app-button variant="secondary" size="md" [fullWidth]="false" class="px-8 h-12 rounded-2xl">
            <ion-icon name="download-outline" slot="start" class="mr-2"></ion-icon>
            Export CSV
          </app-button>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-slate-50/50">
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Booking ID</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Customer</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Driver</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Price</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Status</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-50">
            @for (booking of bookings(); track booking.id) {
              <tr class="hover:bg-slate-50/80 transition-all group">
                <td class="px-10 py-6">
                  <span class="text-sm font-bold text-slate-900 block mb-1">#{{ booking.id.slice(0, 8) }}</span>
                  <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{{ booking.created_at | date:'short' }}</span>
                </td>
                <td class="px-10 py-6">
                  <div class="flex items-center gap-4">
                    <div class="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 font-bold text-xs border border-blue-100">
                      {{ booking.customer?.first_name?.[0] || 'C' }}
                    </div>
                    <div class="min-w-0">
                      <h4 class="text-sm font-bold text-slate-900 truncate">{{ booking.customer?.first_name }}</h4>
                      <p class="text-[10px] text-slate-400 truncate w-40 font-medium">{{ booking.pickup_address }}</p>
                    </div>
                  </div>
                </td>
                <td class="px-10 py-6">
                  @if (booking.driver) {
                    <div class="flex items-center gap-4">
                      <div class="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center text-amber-600 font-bold text-xs border border-amber-100">
                        {{ booking.driver.first_name[0] || 'D' }}
                      </div>
                      <div class="min-w-0">
                        <h4 class="text-sm font-bold text-slate-900 truncate">{{ booking.driver.first_name }}</h4>
                        <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">ID: {{ booking.driver.id.slice(0, 8) }}</p>
                      </div>
                    </div>
                  } @else {
                    <app-badge variant="warning" class="animate-pulse">SEARCHING...</app-badge>
                  }
                </td>
                <td class="px-10 py-6">
                  <span class="text-sm font-display font-bold text-slate-900">£{{ booking.total_price }}</span>
                </td>
                <td class="px-10 py-6">
                  <app-badge [variant]="getBadgeVariant(booking.status)">
                    {{ booking.status.replace('_', ' ') }}
                  </app-badge>
                </td>
                <td class="px-10 py-6 text-right">
                  <button (click)="viewDetails(booking)" class="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 hover:bg-blue-600 hover:text-white hover:shadow-lg hover:shadow-blue-600/20 transition-all flex items-center justify-center mx-auto sm:ml-auto">
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
    <ion-modal [isOpen]="isModalOpen" (didDismiss)="closeModal()" class="admin-modal">
      <ng-template>
        <div class="flex flex-col h-full bg-slate-50">
          <div class="p-8 bg-white border-b border-slate-100 flex items-center justify-between">
            <div>
              <h2 class="text-2xl font-display font-bold text-slate-900">Booking Details</h2>
              <p class="text-slate-500 font-medium text-sm mt-1">ID: #{{ selectedBooking?.id }}</p>
            </div>
            <app-button variant="secondary" size="sm" [fullWidth]="false" (click)="closeModal()" class="h-10 w-10 rounded-xl">
              <ion-icon name="close-outline" slot="icon-only" class="text-xl"></ion-icon>
            </app-button>
          </div>

          <div class="flex-1 overflow-y-auto p-8 space-y-8">
            @if (selectedBooking) {
              <!-- Status Banner -->
              <div class="p-8 rounded-[2rem] text-center bg-white border border-slate-100 shadow-xl shadow-slate-200/20">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-3">Current Status</p>
                <app-badge [variant]="getBadgeVariant(selectedBooking.status)" class="text-lg px-6 py-2">
                  {{ selectedBooking.status.replace('_', ' ') }}
                </app-badge>
              </div>

              <!-- Route Info -->
              <app-card class="p-8">
                <h3 class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-8">Route Information</h3>
                <div class="relative pl-8 space-y-8">
                  <div class="absolute left-[9px] top-2 bottom-2 w-0.5 bg-slate-100"></div>
                  <div class="relative">
                    <div class="absolute -left-[27px] top-1 w-4 h-4 rounded-full bg-white border-4 border-blue-600 shadow-sm z-10"></div>
                    <div>
                      <p class="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1">Pickup</p>
                      <p class="font-bold text-slate-900 leading-snug">{{ selectedBooking.pickup_address }}</p>
                    </div>
                  </div>
                  <div class="relative">
                    <div class="absolute -left-[27px] top-1 w-4 h-4 rounded-full bg-white border-4 border-emerald-600 shadow-sm z-10"></div>
                    <div>
                      <p class="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1">Destination</p>
                      <p class="font-bold text-slate-900 leading-snug">{{ selectedBooking.dropoff_address || 'N/A' }}</p>
                    </div>
                  </div>
                </div>
              </app-card>

              <!-- Customer & Driver -->
              <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
                <app-card class="p-8">
                  <h3 class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-6">Customer</h3>
                  <div class="flex items-center gap-5">
                    <div class="w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 font-bold border border-blue-100">
                      {{ selectedBooking.customer?.first_name?.[0] }}
                    </div>
                    <div class="min-w-0">
                      <h4 class="text-lg font-bold text-slate-900 truncate">{{ selectedBooking.customer?.first_name }}</h4>
                      <p class="text-sm text-slate-500 font-medium truncate">{{ selectedBooking.customer?.email }}</p>
                    </div>
                  </div>
                </app-card>

                <app-card class="p-8">
                  <h3 class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-6">Driver</h3>
                  @if (selectedBooking.driver) {
                    <div class="flex items-center gap-5">
                      <div class="w-14 h-14 rounded-2xl bg-amber-50 flex items-center justify-center text-amber-600 font-bold border border-amber-100">
                        {{ selectedBooking.driver.first_name[0] }}
                      </div>
                      <div class="min-w-0">
                        <h4 class="text-lg font-bold text-slate-900 truncate">{{ selectedBooking.driver.first_name }}</h4>
                        <p class="text-sm text-slate-500 font-medium truncate">ID: {{ selectedBooking.driver.id.slice(0, 8) }}</p>
                      </div>
                    </div>
                  } @else {
                    <div class="flex items-center gap-4 text-slate-400 italic py-2">
                      <ion-icon name="help-circle-outline" class="text-2xl"></ion-icon>
                      <span class="text-sm font-medium">No driver assigned</span>
                    </div>
                  }
                </app-card>
              </div>

              <!-- Admin Override -->
              <div class="bg-slate-900 rounded-[2.5rem] p-10 text-white shadow-2xl space-y-10">
                <div>
                  <h3 class="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-6">Manual Driver Assignment</h3>
                  <div class="flex flex-col sm:flex-row items-center gap-4">
                    <select #driverSelect class="w-full bg-white/10 border border-white/10 rounded-2xl px-6 py-3.5 text-sm font-medium text-white focus:outline-none focus:ring-4 focus:ring-blue-500/20 transition-all appearance-none">
                      <option value="" class="bg-slate-900">Select a driver...</option>
                      @for (driver of drivers(); track driver.id) {
                        <option [value]="driver.id" [selected]="driver.id === selectedBooking.driver_id" class="bg-slate-900">
                          {{ driver.first_name }} ({{ driver.status }})
                        </option>
                      }
                    </select>
                    <app-button variant="primary" size="md" [fullWidth]="false" (click)="assignDriver(selectedBooking.id, driverSelect.value)" 
                            [disabled]="!driverSelect.value" class="h-14 px-10 rounded-2xl shrink-0">
                      Assign Driver
                    </app-button>
                  </div>
                </div>

                <div class="pt-10 border-t border-white/5">
                  <h3 class="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] mb-6">Status Override</h3>
                  <div class="flex flex-col sm:flex-row items-center gap-4">
                    <select #statusSelect class="w-full bg-white/10 border border-white/10 rounded-2xl px-6 py-3.5 text-sm font-medium text-white focus:outline-none focus:ring-4 focus:ring-red-500/20 transition-all appearance-none">
                      @for (status of allStatuses; track status) {
                        <option [value]="status" [selected]="status === selectedBooking.status" class="bg-slate-900">{{ status.replace('_', ' ') }}</option>
                      }
                    </select>
                    <app-button variant="error" size="md" [fullWidth]="false" (click)="forceUpdateStatus(selectedBooking.id, statusSelect.value)" 
                            class="h-14 px-10 rounded-2xl shrink-0">
                      Force Update
                    </app-button>
                  </div>
                  <p class="text-[10px] text-slate-500 italic mt-4 flex items-center">
                    <ion-icon name="information-circle-outline" class="mr-2 text-sm"></ion-icon>
                    Use this to fix stuck bookings. This bypasses standard transition rules.
                  </p>
                </div>
              </div>

              <!-- Pricing Footer -->
              <div class="bg-blue-600 rounded-[2.5rem] p-10 text-white flex items-center justify-between shadow-2xl shadow-blue-600/20">
                <div>
                  <p class="text-blue-100/80 text-[10px] font-bold uppercase tracking-widest mb-1">Total Price</p>
                  <p class="text-4xl font-display font-bold tracking-tight">£{{ selectedBooking.total_price }}</p>
                </div>
                <div class="text-right">
                  <p class="text-blue-100/80 text-[10px] font-bold uppercase tracking-widest mb-1">Service Type</p>
                  <app-badge variant="primary" class="bg-white/20 text-white border-white/30">{{ selectedBooking.service_type?.name || 'Standard' }}</app-badge>
                </div>
              </div>
            }
          </div>
        </div>
      </ng-template>
    </ion-modal>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule, BadgeComponent, ButtonComponent, CardComponent]
})
export class BookingListComponent implements OnInit {
  private adminService = inject(AdminService);
  private bookingService = inject(BookingService);
  private alertCtrl = inject(AlertController);
  private toastCtrl = inject(ToastController);

  ServiceTypeEnum = ServiceTypeEnum;
  bookings = signal<Booking[]>([]);
  drivers = signal<(DriverProfile & { vehicles: Vehicle[] })[]>([]);
  isModalOpen = false;
  selectedBooking: Booking | null = null;
  details = signal<Record<string, string | number | boolean | string[] | null | undefined> | null>(null);

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
      this.details.set(details as Record<string, string | number | boolean | string[] | null | undefined>);
    } catch (e) {
      console.error('Failed to load details', e);
      this.details.set(null);
    }
  }

  async forceUpdateStatus(bookingId: string, status: string) {
    const alert = await this.alertCtrl.create({
      header: 'Confirm Update',
      message: `Are you sure you want to force update this booking to ${status}?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Update',
          handler: async () => {
            try {
              await this.adminService.updateBookingStatus(bookingId, status as BookingStatus, 'Admin force update');
              await this.loadBookings();
              if (this.selectedBooking?.id === bookingId) {
                this.selectedBooking = { ...this.selectedBooking, status: status as BookingStatus };
              }
              const toast = await this.toastCtrl.create({
                message: 'Status updated successfully',
                duration: 2000,
                color: 'success'
              });
              await toast.present();
            } catch (e) {
              const toast = await this.toastCtrl.create({
                message: 'Failed to update status: ' + (e as Error).message,
                duration: 3000,
                color: 'danger'
              });
              await toast.present();
            }
          }
        }
      ]
    });
    await alert.present();
  }

  async assignDriver(bookingId: string, driverId: string) {
    const alert = await this.alertCtrl.create({
      header: 'Confirm Assignment',
      message: 'Are you sure you want to manually assign this driver?',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Assign',
          handler: async () => {
            try {
              await this.adminService.manualAssignDriver(bookingId, driverId);
              await this.loadBookings();
              if (this.selectedBooking?.id === bookingId) {
                const updated = await this.bookingService.getBooking(bookingId);
                this.selectedBooking = updated;
              }
              const toast = await this.toastCtrl.create({
                message: 'Driver assigned successfully',
                duration: 2000,
                color: 'success'
              });
              await toast.present();
            } catch (e) {
              const toast = await this.toastCtrl.create({
                message: 'Failed to assign driver: ' + (e as Error).message,
                duration: 3000,
                color: 'danger'
              });
              await toast.present();
            }
          }
        }
      ]
    });
    await alert.present();
  }

  closeModal() {
    this.isModalOpen = false;
    this.selectedBooking = null;
    this.details.set(null);
  }

  getBadgeVariant(status: string): 'success' | 'warning' | 'error' | 'primary' | 'secondary' | 'info' {
    switch (status) {
      case 'completed': return 'success';
      case 'cancelled': return 'error';
      case 'searching':
      case 'requested': return 'warning';
      case 'accepted':
      case 'assigned':
      case 'arrived': return 'primary';
      case 'in_progress': return 'info';
      default: return 'secondary';
    }
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
