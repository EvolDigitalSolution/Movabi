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
        const { data: profiles } = await this.supabase
            .from('profiles')
            .select('id, role');

        const { data: jobs } = await this.supabase
            .from('jobs')
            .select('id, status, price');

        const totalUsers = (profiles || []).filter((p: any) => p.role === 'customer').length;
        const totalDrivers = (profiles || []).filter((p: any) => p.role === 'driver').length;
        const totalJobs = (jobs || []).length;

        const totalRevenue = (jobs || [])
            .filter((j: any) => j.status === 'completed')
            .reduce((sum: number, j: any) => sum + (j.price || 0), 0);

        const activeJobs = (jobs || []).filter((j: any) =>
            ['accepted', 'arrived', 'in_progress'].includes(j.status)
        ).length;

        this.stats.set({
            totalUsers,
            totalDrivers,
            totalJobs,
            totalRevenue,
            activeJobs
        });
    }

    async getOperationalMetrics() {
        const { data, error } = await this.supabase
            .from('operations_metrics_v3')
            .select('*')
            .maybeSingle();

        if (error) {
            console.error('getOperationalMetrics error:', error);
            return {
                online_drivers_count: 0,
                revenue_today: 0,
                active_jobs_count: 0,
                platform_earnings_today: 0,
                driver_payouts_today: 0,
                pro_jobs_count: 0,
                starter_jobs_count: 0,
                total_pro_drivers: 0
            };
        }

        return data || {
            online_drivers_count: 0,
            revenue_today: 0,
            active_jobs_count: 0,
            platform_earnings_today: 0,
            driver_payouts_today: 0,
            pro_jobs_count: 0,
            starter_jobs_count: 0,
            total_pro_drivers: 0
        };
    }

    async getEvents(limit = 50) {
        const { data, error } = await this.supabase
            .from('events')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('getEvents error:', error);
            return [];
        }

        return data || [];
    }

    async getRevenueStats() {
        try {
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            const { data, error } = await this.supabase
                .from('jobs')
                .select('price, created_at') // ✅ FIXED (see next section)
                .eq('status', 'completed')
                .gte('created_at', sevenDaysAgo.toISOString())
                .order('created_at', { ascending: true });

            if (error) {
                console.error('getRevenueStats error:', error);
                return [];
            }

            if (!data || data.length === 0) return [];

            const stats: Record<string, number> = {};
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                stats[days[d.getDay()]] = 0;
            }

            data.forEach(job => {
                const day = days[new Date(job.created_at).getDay()];
                stats[day] += job.price || 0;
            });

            return Object.entries(stats).map(([day, value]) => ({ day, value }));
        } catch (e) {
            console.error('getRevenueStats crash:', e);
            return [];
        }
    }

    private emptyRevenueStats() {
        return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => ({
            day,
            value: 0
        }));
    }

    async getUsers() {
        const { data, error } = await this.supabase
            .from('profiles')
            .select('*')
            .eq('role', 'customer')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('getUsers error:', error);
            return [];
        }

        return data as Profile[];
    }

    async getDrivers() {
        const { data: drivers, error: driversError } = await this.supabase
            .from('profiles')
            .select('*')
            .eq('role', 'driver')
            .order('created_at', { ascending: false });

        if (driversError) {
            console.error('getDrivers error:', driversError);
            return [];
        }

        const driverIds = (drivers || []).map((d: any) => d.id);

        if (!driverIds.length) {
            return [] as (DriverProfile & { vehicles: Vehicle[] })[];
        }

        const { data: vehicles } = await this.supabase
            .from('vehicles')
            .select('*')
            .in('user_id', driverIds);

        const vehiclesByUser = new Map<string, Vehicle[]>();

        (vehicles || []).forEach((vehicle: any) => {
            if (!vehiclesByUser.has(vehicle.user_id)) {
                vehiclesByUser.set(vehicle.user_id, []);
            }

            vehiclesByUser.get(vehicle.user_id)?.push(vehicle as Vehicle);
        });

        return (drivers || []).map((driver: any) => ({
            ...(driver as DriverProfile),
            vehicles: vehiclesByUser.get(driver.id) || []
        }));
    }

    async verifyDriver(driverId: string, isVerified: boolean) {
        const { error } = await this.supabase
            .from('profiles')
            .update({
                verification_status: isVerified ? 'approved' : 'action_required',
                verified_at: isVerified ? new Date().toISOString() : null
            })
            .eq('id', driverId);

        if (error) throw error;
    }

    async getJobs(filters?: { status?: string, payment_status?: string, service_type_id?: string }) {
        let query = this.supabase
            .from('jobs')
            .select('*')
            .order('created_at', { ascending: false });

        if (filters?.status) query = query.eq('status', filters.status);
        if (filters?.payment_status) query = query.eq('payment_status', filters.payment_status);
        if (filters?.service_type_id) query = query.eq('service_type_id', filters.service_type_id);

        const { data, error } = await query;

        if (error) {
            console.error('getJobs error:', error);
            return [];
        }

        return this.enrichJobs(data || []);
    }

    async getStuckJobs() {
        const fiveMinutesAgo = new Date();
        fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 5);

        const { data, error } = await this.supabase
            .from('jobs')
            .select('*')
            .or(`and(status.eq.searching,created_at.lte.${fiveMinutesAgo.toISOString()}),and(payment_status.eq.paid,status.eq.requested)`);

        if (error) {
            console.error('getStuckJobs error:', error);
            return [];
        }

        return this.enrichJobs(data || []);
    }

    private async enrichJobs(jobs: any[]) {
        if (!jobs.length) return [];

        const profileIds = Array.from(new Set(
            jobs.flatMap(job => [job.customer_id, job.driver_id]).filter(Boolean)
        ));

        const serviceTypeIds = Array.from(new Set(
            jobs.map(job => job.service_type_id).filter(Boolean)
        ));

        const jobIds = jobs.map(job => job.id).filter(Boolean);

        const { data: profiles } = profileIds.length
            ? await this.supabase.from('profiles').select('*').in('id', profileIds)
            : { data: [] };

        const { data: serviceTypes } = serviceTypeIds.length
            ? await this.supabase.from('service_types').select('*').in('id', serviceTypeIds)
            : { data: [] };

        const { data: errandDetails } = jobIds.length
            ? await this.supabase.from('errand_details').select('*').in('job_id', jobIds)
            : { data: [] };

        const { data: errandFunding } = jobIds.length
            ? await this.supabase.from('errand_funding').select('*').in('job_id', jobIds)
            : { data: [] };

        const profilesById = new Map((profiles || []).map((p: any) => [p.id, p]));
        const serviceTypesById = new Map((serviceTypes || []).map((s: any) => [s.id, s]));
        const errandDetailsByJobId = new Map((errandDetails || []).map((d: any) => [d.job_id, d]));
        const errandFundingByJobId = new Map((errandFunding || []).map((f: any) => [f.job_id, f]));

        return jobs.map(job => {
            const enrichedJob = {
                ...job,
                customer: job.customer_id ? profilesById.get(job.customer_id) || null : null,
                driver: job.driver_id ? profilesById.get(job.driver_id) || null : null,
                service_type: job.service_type_id ? serviceTypesById.get(job.service_type_id) || null : null,
                errand_details: errandDetailsByJobId.get(job.id) || null,
                errand_funding: errandFundingByJobId.get(job.id) || null
            };

            try {
                return this.bookingService.mapJobToBooking(enrichedJob);
            } catch {
                return enrichedJob;
            }
        });
    }

    async updateAccountStatus(userId: string, status: string, reason: string, adminId: string) {
        const { error } = await this.supabase
            .from('profiles')
            .update({
                account_status: status,
                moderation_reason: reason,
                moderated_at: new Date().toISOString()
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

    //async updateServiceType(id: string, updates: Partial<ServiceType>) {
    //    const { error } = await this.supabase
    //        .from('service_types')
    //        .update(updates)
    //        .eq('id', id);

    //    if (error) throw error;
    //}

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
        const { data: subscriptions, error } = await this.supabase
            .from('driver_subscriptions')
            .select('*');

        if (error) {
            console.error('getDriverSubscriptions error:', error);
            return [] as (DriverSubscription & { driver: Profile })[];
        }

        const rows = subscriptions || [];
        const driverIds = Array.from(
            new Set(rows.map((item: any) => item.driver_id).filter(Boolean))
        );

        let drivers: Profile[] = [];

        if (driverIds.length) {
            const { data: driverProfiles, error: driversError } = await this.supabase
                .from('profiles')
                .select('*')
                .in('id', driverIds);

            if (driversError) {
                console.error('getDriverSubscriptions drivers error:', driversError);
            }

            drivers = (driverProfiles || []) as Profile[];
        }

        const driversById = new Map<string, Profile>();
        drivers.forEach(driver => driversById.set(driver.id, driver));

        return rows.map((subscription: any) => ({
            ...(subscription as DriverSubscription),
            driver: driversById.get(subscription.driver_id) || ({} as Profile)
        })) as (DriverSubscription & { driver: Profile })[];
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
            .select('*');

        if (error) {
            console.error('getSubscriptions error:', error);
            return [];
        }

        return data;
    }

    async getSubscriptionPlans() {
        const { data, error } = await this.supabase
            .from('subscription_plans')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('[AdminService] getSubscriptionPlans error:', error);
            throw new Error(error.message);
        }

        return data || [];
    }

    async getHeatmapData() {
        try {
            return await firstValueFrom(
                this.http.get<{ zones: { lat: number; lng: number; demand: number; drivers: number }[] }>(
                    this.apiUrlService.getApiUrl('/api/admin/heatmap')
                )
            );
        } catch {
            return { zones: [] };
        }
    }

    async getPlatformMetrics() {
        return firstValueFrom(
            this.http.get<Record<string, number>>(this.apiUrlService.getApiUrl('/api/admin/metrics'))
        );
    }

    async getFailedBookings() {
        try {
            return await firstValueFrom(
                this.http.get<FailedBooking[]>(this.apiUrlService.getApiUrl('/api/admin/failures'))
            );
        } catch {
            return [];
        }
    }

    async getRecentPayments() {
        try {
            return await firstValueFrom(
                this.http.get<WalletTransaction[]>(this.apiUrlService.getApiUrl('/api/admin/payments'))
            );
        } catch {
            return [];
        }
    }

    async getDriverDocumentSignedUrl(path: string): Promise<string> {
        if (!path) throw new Error('Missing document path');
        if (path.startsWith('http')) return path;

        const { data, error } = await this.supabase.storage
            .from('documents')
            .createSignedUrl(path, 60 * 10);

        if (error || !data?.signedUrl) {
            console.error('Error creating signed URL:', error);
            throw new Error('Could not create document link');
        }

        return data.signedUrl;
    }

    async preVerifyDriver(driverId: string) {
        const response = await fetch(`${this.apiUrlService.getBaseUrl() }/api/verification/drivers/${driverId}/preverify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result?.error || 'Driver pre-verification failed');
        }

        return result;
    }


    async manualApproveDriver(driverId: string, notes = 'Approved manually for testing') {
        const response = await fetch(`${this.apiUrlService.getBaseUrl() }/api/verification/drivers/${driverId}/manual-approve`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                testingOverride: true,
                notes
            })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result?.error || 'Manual driver approval failed');
        }

        return result;
    }

    async createServiceType(payload: any) {
        const { data, error } = await this.supabase
            .from('service_types')
            .insert(payload)
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    async updateServiceType(id: string, payload: any) {
        const { data, error } = await this.supabase
            .from('service_types')
            .update(payload)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    async deleteServiceType(id: string) {
        const { error } = await this.supabase
            .from('service_types')
            .delete()
            .eq('id', id);

        if (error) throw error;
    }

    async createSubscriptionPlan(payload: any) {
        const cleanPayload = {
            name: payload.name,
            description: payload.description || '',
            price: Number(payload.price || 0),
            interval: payload.interval || 'month',
            features: Array.isArray(payload.features) ? payload.features : [],
            currency_code: payload.currency_code || 'GBP',
            currency_symbol: payload.currency_symbol || '£',
            is_active: payload.is_active === true,
            updated_at: new Date().toISOString(),
            ...(payload.stripe_price_id ? { stripe_price_id: payload.stripe_price_id } : {})
        };

        const { data, error } = await this.supabase
            .from('subscription_plans')
            .insert(cleanPayload)
            .select('*')
            .single();

        if (error) {
            console.error('[AdminService] createSubscriptionPlan error:', error);
            throw new Error(error.message);
        }

        return data;
    }

    async updateSubscriptionPlan(id: string, payload: any) {
        const cleanPayload = {
            ...payload,
            updated_at: new Date().toISOString()
        };

        const { data, error } = await this.supabase
            .from('subscription_plans')
            .update(cleanPayload)
            .eq('id', id)
            .select('*')
            .single();

        if (error) {
            console.error('[AdminService] updateSubscriptionPlan error:', error);
            throw new Error(error.message);
        }

        return data;
    }

    async deleteSubscriptionPlan(id: string) {
        const { error } = await this.supabase
            .from('subscription_plans')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('[AdminService] deleteSubscriptionPlan error:', error);
            throw new Error(error.message);
        }
    }

}