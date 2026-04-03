import { Injectable, inject, signal } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { Booking, DriverStatus, Earning, Vehicle, DriverProfile, BookingStatus } from '@shared/models/booking.model';
import { AuthService } from '../auth/auth.service';
import { BookingService } from '../booking/booking.service';

import { NotificationService } from '../notification.service';

@Injectable({
  providedIn: 'root'
})
export class DriverService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);
  private bookingService = inject(BookingService);
  private notificationService = inject(NotificationService);

  onlineStatus = signal<DriverStatus>('offline');
  availableJobs = signal<Booking[]>([]);
  activeJob = signal<Booking | null>(null);
  earnings = signal<Earning[]>([]);
  vehicle = signal<Vehicle | null>(null);

  async toggleOnline(status: DriverStatus) {
    const user = this.auth.currentUser();
    if (!user) return;

    if (status === 'online') {
      const profile = await this.fetchProfile();
      if (profile.subscription_status !== 'active') {
        throw new Error('Active subscription required to go online');
      }
    }

    const { error } = await this.supabase
      .from('profiles')
      .update({ status })
      .eq('id', user.id);

    if (error) throw error;
    this.onlineStatus.set(status);

    if (status === 'online') {
      this.subscribeToJobs();
    } else {
      this.supabase.channel('available-jobs').unsubscribe();
    }
  }

  private async fetchProfile(): Promise<DriverProfile> {
    const user = this.auth.currentUser();
    const { data, error } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', user?.id)
      .single();
    if (error) throw error;
    return data as DriverProfile;
  }

  private subscribeToJobs() {
    this.supabase
      .channel('available-jobs')
      .on('postgres_changes', { 
        event: 'INSERT', 
        schema: 'public', 
        table: 'bookings',
        filter: 'status=eq.searching'
      }, async payload => {
        const newJob = payload.new as Booking;
        this.availableJobs.update(jobs => [newJob, ...jobs]);
        
        // Notify driver of new job
        const user = this.auth.currentUser();
        if (user) {
          await this.notificationService.notify(
            user.id, 
            'New Job Available', 
            `A new ${newJob.service_code} request is available near you.`,
            'booking',
            { bookingId: newJob.id }
          );
        }
      })
      .subscribe();
    
    this.fetchAvailableJobs();
  }

  async fetchAvailableJobs() {
    const { data, error } = await this.supabase
      .from('bookings')
      .select('*, service_type:service_types(*)')
      .eq('status', 'searching')
      .order('created_at', { ascending: false });

    if (error) throw error;
    this.availableJobs.set(data || []);
  }

  async acceptJob(bookingId: string) {
    const user = this.auth.currentUser();
    if (!user) throw new Error('Not authenticated');

    const profile = await this.fetchProfile();
    if (profile.subscription_status !== 'active') {
      throw new Error('Active subscription required to accept jobs');
    }

    const data = await this.bookingService.updateBookingStatus(
      bookingId, 
      'accepted', 
      'Job accepted by driver',
      { driver_id: user.id },
      'searching'
    );

    // Fetch full booking with customer info
    const fullBooking = await this.bookingService.getBooking(bookingId);

    this.activeJob.set(fullBooking);
    this.availableJobs.update(jobs => jobs.filter(j => j.id !== bookingId));
    return fullBooking;
  }

  async updateJobStatus(bookingId: string, status: BookingStatus) {
    return this.bookingService.updateBookingStatus(bookingId, status, `Status updated by driver to ${status}`);
  }

  async fetchEarnings() {
    const user = this.auth.currentUser();
    if (!user) return;

    const { data, error } = await this.supabase
      .from('earnings')
      .select('*')
      .eq('driver_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    this.earnings.set(data || []);
  }

  async updateVehicle(vehicleData: Partial<Vehicle>) {
    const user = this.auth.currentUser();
    if (!user) return;

    const { data, error } = await this.supabase
      .from('vehicles')
      .upsert({ ...vehicleData, driver_id: user.id })
      .select()
      .single();

    if (error) throw error;
    this.vehicle.set(data);
  }

  async uploadDocument(file: File, type: string) {
    const user = this.auth.currentUser();
    if (!user) return;

    const path = `drivers/${user.id}/${type}_${Date.now()}`;
    const { data, error } = await this.supabase.storage
      .from('documents')
      .upload(path, file);

    if (error) throw error;
    return data.path;
  }
}
