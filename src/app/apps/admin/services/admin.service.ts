import { Injectable, inject, signal } from '@angular/core';
import { SupabaseService } from '@core/services/supabase/supabase.service';
import { Profile, Booking, DriverProfile, Vehicle, ServiceType, DriverSubscription, BookingStatus } from '@shared/models/booking.model';
import { BookingService } from '@core/services/booking/booking.service';

@Injectable({
  providedIn: 'root'
})
export class AdminService {
  private supabase = inject(SupabaseService);
  private bookingService = inject(BookingService);

  stats = signal({
    totalUsers: 0,
    totalDrivers: 0,
    totalBookings: 0,
    totalRevenue: 0,
    activeBookings: 0
  });

  async fetchStats() {
    const { count: usersCount } = await this.supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('role', 'customer');

    const { count: driversCount } = await this.supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('role', 'driver');

    const { count: bookingsCount } = await this.supabase
      .from('bookings')
      .select('*', { count: 'exact', head: true });

    const { data: revenueData } = await this.supabase
      .from('bookings')
      .select('total_price')
      .eq('status', 'completed');

    const totalRevenue = revenueData?.reduce((sum, b) => sum + (b.total_price || 0), 0) || 0;

    const { count: activeBookings } = await this.supabase
      .from('bookings')
      .select('*', { count: 'exact', head: true })
      .in('status', ['accepted', 'arrived', 'in_progress']);

    this.stats.set({
      totalUsers: usersCount || 0,
      totalDrivers: driversCount || 0,
      totalBookings: bookingsCount || 0,
      totalRevenue,
      activeBookings: activeBookings || 0
    });
  }

  async getOperationalMetrics() {
    const { data, error } = await this.supabase
      .from('operations_metrics')
      .select('*')
      .single();
    
    if (error) throw error;
    return data;
  }

  async getEvents(limit = 50) {
    const { data, error } = await this.supabase
      .from('events')
      .select('*, user:profiles(*)')
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (error) throw error;
    return data;
  }

  async getRevenueStats() {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { data, error } = await this.supabase
      .from('bookings')
      .select('total_price, completed_at')
      .eq('status', 'completed')
      .gte('completed_at', sevenDaysAgo.toISOString())
      .order('completed_at', { ascending: true });

    if (error) throw error;

    // Group by day
    const stats: Record<string, number> = {};
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    // Initialize last 7 days
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      stats[days[d.getDay()]] = 0;
    }

    data?.forEach(booking => {
      const day = days[new Date(booking.completed_at).getDay()];
      if (stats[day] !== undefined) {
        stats[day] += booking.total_price || 0;
      }
    });

    return Object.entries(stats).map(([day, value]) => ({ day, value }));
  }

  async getUsers() {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('role', 'customer')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as Profile[];
  }

  async getDrivers() {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('*, vehicles(*)')
      .eq('role', 'driver')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as (DriverProfile & { vehicles: Vehicle[] })[];
  }

  async verifyDriver(driverId: string, isVerified: boolean) {
    const { error } = await this.supabase
      .from('profiles')
      .update({ is_verified: isVerified })
      .eq('id', driverId);
    if (error) throw error;
  }

  async getLiveBookings() {
    const { data, error } = await this.supabase
      .from('bookings')
      .select('*, customer:profiles(*), driver:profiles(*), service_type:service_types(*)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as Booking[];
  }

  async getStuckBookings() {
    const fiveMinutesAgo = new Date();
    fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 5);

    const { data, error } = await this.supabase
      .from('bookings')
      .select('*, customer:profiles(*), service_type:service_types(*)')
      .eq('status', 'searching')
      .lte('created_at', fiveMinutesAgo.toISOString())
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data as Booking[];
  }

  async getServiceTypes() {
    const { data, error } = await this.supabase
      .from('service_types')
      .select('*');
    if (error) throw error;
    return data as ServiceType[];
  }

  async updateServiceType(id: string, updates: Partial<ServiceType>) {
    const { error } = await this.supabase
      .from('service_types')
      .update(updates)
      .eq('id', id);
    if (error) throw error;
  }

  async updateBookingStatus(bookingId: string, status: BookingStatus, notes: string) {
    return await this.bookingService.updateBookingStatus(bookingId, status, notes, {}, undefined, true);
  }

  async manualAssignDriver(bookingId: string, driverId: string) {
    return await this.bookingService.updateBookingStatus(
      bookingId, 
      'assigned', 
      'Admin manually assigned driver', 
      { driver_id: driverId }, 
      undefined, 
      true
    );
  }

  async getDriverSubscriptions() {
    const { data, error } = await this.supabase
      .from('driver_subscriptions')
      .select('*, driver:profiles(*)');
    if (error) throw error;
    return data as (DriverSubscription & { driver: Profile })[];
  }

  async updateSubscription(id: string, updates: Partial<DriverSubscription>) {
    const { error } = await this.supabase
      .from('driver_subscriptions')
      .update(updates)
      .eq('id', id);
    if (error) throw error;
  }

  async getSubscriptions() {
    const { data, error } = await this.supabase
      .from('subscriptions')
      .select('*, user:profiles(*)');
    if (error) throw error;
    return data;
  }

  async getSubscriptionPlans() {
    const { data, error } = await this.supabase
      .from('subscription_plans')
      .select('*')
      .order('price', { ascending: true });
    if (error) throw error;
    return data;
  }

  async updateSubscriptionPlan(id: string, updates: any) {
    const { error } = await this.supabase
      .from('subscription_plans')
      .update(updates)
      .eq('id', id);
    if (error) throw error;
  }
}
