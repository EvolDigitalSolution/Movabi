import { Injectable, inject, signal } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { Booking, ServiceType, ServiceTypeEnum, BookingStatus } from '@shared/models/booking.model';
import { AuthService } from '../auth/auth.service';
import { BookingStatusManager } from './booking-status.manager';
import { NotificationService } from '../notification.service';

@Injectable({
  providedIn: 'root'
})
export class BookingService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);
  private statusManager = inject(BookingStatusManager);
  private notificationService = inject(NotificationService);

  activeBooking = signal<Booking | null>(null);
  bookingHistory = signal<Booking[]>([]);

  async getServiceTypes(): Promise<ServiceType[]> {
    const { data, error } = await this.supabase
      .from('service_types')
      .select('*')
      .eq('is_active', true);
    
    if (error) throw error;
    return data || [];
  }

  async createBooking(
    bookingData: Partial<Booking>, 
    details: Record<string, unknown>, 
    serviceCode: ServiceTypeEnum
  ) {
    const user = this.auth.currentUser();
    if (!user) throw new Error('Not authenticated');

    this.validateDetails(serviceCode, details);

    const { data: booking, error: bError } = await this.supabase
      .from('bookings')
      .insert({
        ...bookingData,
        customer_id: user.id,
        service_code: serviceCode,
        status: 'searching'
      })
      .select()
      .single();

    if (bError) throw bError;

    const detailsTable = this.getDetailsTable(serviceCode);
    const { error: dError } = await this.supabase
      .from(detailsTable)
      .insert({
        ...details,
        booking_id: booking.id
      });

    if (dError) throw dError;

    await this.logStatusHistory(booking.id, 'searching', 'Booking created by customer');

    this.activeBooking.set(booking);
    return booking;
  }

  private validateDetails(serviceCode: ServiceTypeEnum, details: Record<string, unknown>) {
    switch (serviceCode) {
      case ServiceTypeEnum.RIDE:
        if (!details['passenger_count']) throw new Error('Passenger count is required for rides');
        break;
      case ServiceTypeEnum.ERRAND:
        if (!details['items_list'] || (details['items_list'] as unknown[]).length === 0) {
          throw new Error('Items list is required for errands');
        }
        break;
      case ServiceTypeEnum.DELIVERY:
        if (!details['recipient_name'] || !details['recipient_phone']) {
          throw new Error('Recipient name and phone are required for deliveries');
        }
        break;
      case ServiceTypeEnum.VAN:
        if (details['helper_count'] === undefined) throw new Error('Helper count is required for van service');
        break;
    }
  }

  private getDetailsTable(serviceCode: ServiceTypeEnum): string {
    switch (serviceCode) {
      case ServiceTypeEnum.RIDE: return 'ride_details';
      case ServiceTypeEnum.ERRAND: return 'errand_details';
      case ServiceTypeEnum.DELIVERY: return 'delivery_details';
      case ServiceTypeEnum.VAN: return 'van_details';
      default: throw new Error(`Unsupported service type: ${serviceCode}`);
    }
  }

  async updateBookingStatus(
    bookingId: string, 
    nextStatus: BookingStatus, 
    notes?: string, 
    additionalData: Partial<Booking> = {},
    currentStatus?: BookingStatus,
    isAdmin = false
  ) {
    let statusToValidate = currentStatus;
    
    if (!statusToValidate) {
      const active = this.activeBooking();
      if (active && active.id === bookingId) {
        statusToValidate = active.status;
      } else {
        const { data, error } = await this.supabase
          .from('bookings')
          .select('status')
          .eq('id', bookingId)
          .single();
        if (error) throw error;
        statusToValidate = data.status;
      }
    }

    if (!statusToValidate || !this.statusManager.canTransition(statusToValidate, nextStatus, isAdmin)) {
      throw new Error(`Invalid status transition from ${statusToValidate || 'unknown'} to ${nextStatus}`);
    }

    const updatePayload: Partial<Booking> = { ...additionalData, status: nextStatus };
    
    if (nextStatus === 'completed' && !updatePayload.completed_at) {
      updatePayload.completed_at = new Date().toISOString();
    }

    const query = this.supabase
      .from('bookings')
      .update(updatePayload)
      .eq('id', bookingId);

    if (statusToValidate && !isAdmin) {
      query.eq('status', statusToValidate);
    }

    const { data, error } = await query.select().single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new Error('Booking status has changed or booking not found. Please refresh.');
      }
      throw error;
    }

    await this.logStatusHistory(bookingId, nextStatus, notes);

    // Notify customer and driver
    await this.notifyStatusChange(data);

    if (this.activeBooking()?.id === bookingId) {
      this.activeBooking.set(data);
    }
    
    return data;
  }

  private async notifyStatusChange(booking: Booking) {
    const statusMessages: Record<BookingStatus, { title: string, body: string }> = {
      requested: { title: 'Booking Requested', body: 'Your booking has been received.' },
      searching: { title: 'Searching for Driver', body: 'We are looking for a driver for your request.' },
      assigned: { title: 'Driver Assigned', body: 'A driver has been assigned to your booking.' },
      accepted: { title: 'Driver Accepted', body: 'Your driver is on the way!' },
      arrived: { title: 'Driver Arrived', body: 'Your driver has arrived at the pickup location.' },
      in_progress: { title: 'Trip Started', body: 'Your trip is now in progress.' },
      completed: { title: 'Trip Completed', body: 'Thank you for choosing Movabi!' },
      cancelled: { title: 'Booking Cancelled', body: 'Your booking has been cancelled.' }
    };

    const msg = statusMessages[booking.status];
    if (msg) {
      // Notify customer
      await this.notificationService.notify(booking.customer_id, msg.title, msg.body, 'booking', { bookingId: booking.id });
      
      // Notify driver if assigned
      if (booking.driver_id) {
        await this.notificationService.notify(booking.driver_id, msg.title, msg.body, 'booking', { bookingId: booking.id });
      }
    }
  }

  async getBooking(bookingId: string): Promise<Booking> {
    const { data, error } = await this.supabase
      .from('bookings')
      .select('*, customer:profiles(*), driver:profiles(*), service_type:service_types(*)')
      .eq('id', bookingId)
      .single();

    if (error) throw error;
    return data as Booking;
  }

  private async logStatusHistory(bookingId: string, status: BookingStatus, notes?: string) {
    const user = this.auth.currentUser();
    await this.supabase
      .from('booking_status_history')
      .insert({
        booking_id: bookingId,
        status,
        changed_by: user?.id,
        notes
      });
  }

  async getBookingDetails(bookingId: string, serviceCode: ServiceTypeEnum): Promise<unknown> {
    const table = this.getDetailsTable(serviceCode);
    const { data, error } = await this.supabase
      .from(table)
      .select('*')
      .eq('booking_id', bookingId)
      .single();

    if (error) throw error;
    return data;
  }

  async getHistory() {
    const user = this.auth.currentUser();
    if (!user) return;

    const { data, error } = await this.supabase
      .from('bookings')
      .select('*, service_type:service_types(*), driver:profiles(*)')
      .eq('customer_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    this.bookingHistory.set(data || []);
  }

  async rateBooking(bookingId: string, score: number, comment: string) {
    const { error } = await this.supabase
      .from('ratings')
      .insert({
        booking_id: bookingId,
        customer_id: this.auth.currentUser()?.id,
        score,
        comment
      });
    
    if (error) throw error;
  }

  async cancelBooking(bookingId: string, reason: string) {
    const { data: booking } = await this.supabase
      .from('bookings')
      .select('driver_id')
      .eq('id', bookingId)
      .single();
    
    const result = await this.updateBookingStatus(bookingId, 'cancelled', `Cancelled by user: ${reason}`);
    
    if (booking?.driver_id) {
      this.notificationService.notify(
        booking.driver_id, 
        'Booking Cancelled', 
        'A customer has cancelled their booking.', 
        'booking', 
        { bookingId }
      );
    }
    
    return result;
  }

  subscribeToBooking(bookingId: string) {
    this.supabase
      .channel(`booking-${bookingId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'bookings',
        filter: `id=eq.${bookingId}`
      }, payload => {
        this.activeBooking.set(payload.new as Booking);
      })
      .subscribe();
  }
}
