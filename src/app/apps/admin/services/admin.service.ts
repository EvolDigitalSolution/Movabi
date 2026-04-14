import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SupabaseService } from '@core/services/supabase/supabase.service';
import { Profile, DriverProfile, Vehicle, ServiceType, DriverSubscription, BookingStatus } from '@shared/models/booking.model';
import { BookingService } from '@core/services/booking/booking.service';
import { ApiUrlService } from '@core/services/api-url.service';

export interface FailedBooking {
  id: string;
  customer?: {
    first_name: string;
    last_name: string;
  };
  status: string;
  cancellation_reason?: string;
  created_at: string;
}

export interface WalletTransaction {
  id: string;
  user?: {
    first_name: string;
  };
  type: 'credit' | 'debit';
  description: string;
  amount: number;
  created_at: string;
}

@Injectable({
  providedIn: 'root'
})
export class AdminService {
  private supabase = inject(SupabaseService);
  private bookingService = inject(BookingService);
  private http = inject(HttpClient);
  private apiUrlService = inject(ApiUrlService);

  stats = signal({
    totalUsers: 0,
    totalDrivers: 0,
    totalJobs: 0,
    totalRevenue: 0,
    activeJobs: 0
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

    const { count: jobsCount } = await this.supabase
      .from('jobs')
      .select('*', { count: 'exact', head: true });

    const { data: revenueData } = await this.supabase
      .from('jobs')
      .select('price')
      .eq('status', 'completed');

    const totalRevenue = revenueData?.reduce((sum, b) => sum + (b.price || 0), 0) || 0;

    const { count: activeJobs } = await this.supabase
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .in('status', ['accepted', 'arrived', 'in_progress']);

    this.stats.set({
      totalUsers: usersCount || 0,
      totalDrivers: driversCount || 0,
      totalJobs: jobsCount || 0,
      totalRevenue,
      activeJobs: activeJobs || 0
    });
  }

  async getOperationalMetrics() {
    const { data, error } = await this.supabase
      .from('operations_metrics_v3')
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
      .from('jobs')
      .select('price, completed_at')
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

    data?.forEach(job => {
      const day = days[new Date(job.completed_at).getDay()];
      if (stats[day] !== undefined) {
        stats[day] += job.price || 0;
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

  async getJobs(filters?: { status?: string, payment_status?: string, service_type_id?: string }) {
    let query = this.supabase
      .from('jobs')
      .select('*, customer:profiles(*), driver:profiles(*), service_type:service_types(*), errand_details(*), errand_funding(*)')
      .order('created_at', { ascending: false });

    if (filters?.status) query = query.eq('status', filters.status);
    if (filters?.payment_status) query = query.eq('payment_status', filters.payment_status);
    if (filters?.service_type_id) query = query.eq('service_type_id', filters.service_type_id);

    const { data, error } = await query;
    if (error) throw error;
    const bookings = (data || []).map(job => this.bookingService.mapJobToBooking(job));
    return bookings;
  }

  async getStuckJobs() {
    const fiveMinutesAgo = new Date();
    fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 5);

    const { data, error } = await this.supabase
      .from('jobs')
      .select('*, customer:profiles(*), service_type:service_types(*)')
      .or(`and(status.eq.searching,created_at.lte.${fiveMinutesAgo.toISOString()}),and(payment_status.eq.paid,status.eq.requested)`);

    if (error) throw error;
    const bookings = (data || []).map(job => this.bookingService.mapJobToBooking(job));
    return bookings;
  }

  async updateAccountStatus(userId: string, status: string, reason: string, adminId: string) {
    const { error } = await this.supabase
      .from('profiles')
      .update({
        account_status: status,
        moderation_reason: reason,
        moderated_at: new Date().toISOString(),
        moderated_by: adminId
      })
      .eq('id', userId);
    
    if (error) throw error;
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

  async updateSubscriptionPlan(id: string, updates: Record<string, unknown>) {
    const { error } = await this.supabase
      .from('subscription_plans')
      .update(updates)
      .eq('id', id);
    if (error) throw error;
  }

  async getHeatmapData() {
    return firstValueFrom(
      this.http.get<{ zones: { lat: number; lng: number; demand: number; drivers: number }[] }>(this.apiUrlService.getApiUrl('/api/admin/heatmap'))
    );
  }

  async getPlatformMetrics() {
    return firstValueFrom(
      this.http.get<Record<string, number>>(this.apiUrlService.getApiUrl('/api/admin/metrics'))
    );
  }

  async getFailedBookings() {
    return firstValueFrom(
      this.http.get<FailedBooking[]>(this.apiUrlService.getApiUrl('/api/admin/failures'))
    );
  }

  async getRecentPayments() {
    return firstValueFrom(
      this.http.get<WalletTransaction[]>(this.apiUrlService.getApiUrl('/api/admin/payments'))
    );
  }
}
