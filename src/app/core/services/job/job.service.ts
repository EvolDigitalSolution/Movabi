import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import {
    Job,
    JobStatus,
    JobEstimate,
    DispatchCandidate,
    City,
    JobEventType
} from '@shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';
import { JobEventService } from './job-event.service';
import { ApiUrlService } from '../api-url.service';

@Injectable({
    providedIn: 'root'
})
export class JobService {
    private supabase = inject(SupabaseService);
    private eventService = inject(JobEventService);
    private apiUrlService = inject(ApiUrlService);

    async calculatePrice(
        pickup: { lat: number; lng: number },
        dropoff: { lat: number; lng: number }
    ): Promise<JobEstimate> {
        const url = this.apiUrlService.getApiUrl('/api/logistics/calculate-price');

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pickup, dropoff })
        });

        if (!response.ok) {
            throw new Error('Failed to calculate price');
        }

        return await response.json() as JobEstimate;
    }

    async suggestDrivers(
        lat: number,
        lng: number,
        tenantId: string
    ): Promise<DispatchCandidate[]> {
        const url = this.apiUrlService.getApiUrl('/api/logistics/suggest-drivers');

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lng, tenant_id: tenantId })
        });

        if (!response.ok) {
            throw new Error('Failed to suggest drivers');
        }

        return await response.json() as DispatchCandidate[];
    }

    async createJob(job: Partial<Job>): Promise<Job> {
        const safeJob = this.toJobsPayload({
            ...job,
            scheduled_time: job.scheduled_time || new Date().toISOString()
        });

        const { data, error } = await this.supabase
            .from('jobs')
            .insert(safeJob)
            .select('*')
            .single();

        if (error) {
            console.error('Error creating job:', error);
            throw error;
        }

        return data as Job;
    }
    async getAvailableJobs(): Promise<Job[]> {
        const { data, error } = await this.supabase
            .from('jobs')
            .select('*')
            .is('driver_id', null)
            .in('status', ['pending', 'requested', 'searching'])
            .in('payment_status', ['pending', 'authorized', 'wallet_funded', 'paid'])
            .order('created_at', { ascending: false });

        if (error) {
            console.error('[JobService] getAvailableJobs failed:', error);
            throw error;
        }

        console.log('[JobService] available jobs:', data);

        return data as Job[];
    }

    async getDriverJobs(driverId: string): Promise<Job[]> {
        const { data, error } = await this.supabase
            .from('jobs')
            .select('*')
            .eq('driver_id', driverId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        return await this.attachProfiles(data || []);
    }

    async acceptJob(jobId: string, driverId: string): Promise<Job> {
        const { data, error } = await this.supabase
            .from('jobs')
            .update({
                status: 'accepted',
                driver_id: driverId
            })
            .eq('id', jobId)
            .in('status', ['pending', 'searching', 'requested'])
            .select('*')
            .single();

        if (error) throw error;

        await this.eventService.logEvent(
            jobId,
            'driver_accepted',
            'Job accepted by driver'
        );

        const [job] = await this.attachProfiles([data]);
        return job;
    }

    async updateJobStatus(jobId: string, status: JobStatus): Promise<Job> {
        const { data, error } = await this.supabase
            .from('jobs')
            .update({ status })
            .eq('id', jobId)
            .select('*')
            .single();

        if (error) throw error;

        const eventTypeMap: Partial<Record<JobStatus, JobEventType>> = {
            arrived: 'driver_arrived',
            in_progress: 'job_started',
            completed: 'job_completed',
            cancelled: 'job_cancelled'
        };

        const eventType = eventTypeMap[status];

        if (eventType) {
            await this.eventService.logEvent(
                jobId,
                eventType,
                `Status updated to ${status}`
            );
        }

        const [job] = await this.attachProfiles([data]);
        return job;
    }

    async getJobById(jobId: string): Promise<Job> {
        const { data, error } = await this.supabase
            .from('jobs')
            .select('*')
            .eq('id', jobId)
            .single();

        if (error) throw error;

        const [job] = await this.attachProfiles([data]);
        return job;
    }

    async getAllJobs(): Promise<Job[]> {
        const { data, error } = await this.supabase
            .from('jobs')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        return await this.attachProfiles(data || []);
    }

    async getCities(): Promise<City[]> {
        const { data, error } = await this.supabase
            .from('cities')
            .select('*')
            .order('name', { ascending: true });

        if (error) throw error;

        return data as City[];
    }

    async enqueueJob(
        jobId: string,
        tenantId: string,
        cityId?: string
    ): Promise<unknown> {
        const url = this.apiUrlService.getApiUrl('/api/logistics/enqueue');

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId, tenantId, cityId })
        });

        if (!response.ok) {
            throw new Error('Failed to enqueue job');
        }

        await this.eventService.logEvent(
            jobId,
            'driver_assigned',
            'Job enqueued for dispatching'
        );

        return await response.json();
    }

    subscribeToJobs(
        callback: (payload: { new?: Job; old?: Job; eventType?: string }) => void
    ): RealtimeChannel {
        return this.supabase
            .channel('jobs-changes')
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'jobs'
                },
                payload =>
                    callback(payload as unknown as {
                        new?: Job;
                        old?: Job;
                        eventType?: string;
                    })
            )
            .subscribe();
    }

    async retryDispatch(jobId: string, tenantId: string): Promise<unknown> {
        const { data: job, error } = await this.supabase
            .from('jobs')
            .select('status, payment_status')
            .eq('id', jobId)
            .single();

        if (error) throw error;

        const paymentStatus = String(job?.payment_status || '').toLowerCase();

        if (!['authorized', 'wallet_funded', 'paid'].includes(paymentStatus)) {
            throw new Error('Cannot dispatch unpaid job');
        }

        await this.updateJobStatus(jobId, 'searching');
        await this.eventService.logEvent(
            jobId,
            'admin_action',
            'Manual dispatch retry initiated by admin'
        );

        return this.enqueueJob(jobId, tenantId);
    }

    async markForReview(jobId: string, notes: string): Promise<void> {
        await this.eventService.logEvent(
            jobId,
            'admin_action',
            `Marked for manual review: ${notes}`
        );
    }

    async forceCancel(jobId: string, reason: string): Promise<Job> {
        const { data, error } = await this.supabase
            .from('jobs')
            .update({ status: 'cancelled' })
            .eq('id', jobId)
            .select('*')
            .single();

        if (error) throw error;

        await this.eventService.logEvent(
            jobId,
            'job_cancelled',
            `Force cancelled by admin: ${reason}`
        );

        const [job] = await this.attachProfiles([data]);
        return job;
    }

    async updateLocation(
        jobId: string,
        driverId: string,
        lat: number,
        lng: number
    ): Promise<void> {
        const { error } = await this.supabase
            .from('job_locations')
            .insert({
                job_id: jobId,
                driver_id: driverId,
                lat,
                lng
            });

        if (error) throw error;
    }

    subscribeToJobLocations(
        jobId: string,
        callback: (payload: Record<string, unknown>) => void
    ): RealtimeChannel {
        return this.supabase.client
            .channel(`job_locations_${jobId}`)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'job_locations',
                    filter: `job_id=eq.${jobId}`
                },
                callback
            )
            .subscribe();
    }

    private async attachProfiles(jobs: any[]): Promise<Job[]> {
        if (!jobs.length) return [];

        const customerIds = jobs
            .map(job => job.customer_id)
            .filter(Boolean);

        const driverIds = jobs
            .map(job => job.driver_id)
            .filter(Boolean);

        const profileIds = Array.from(new Set([...customerIds, ...driverIds]));

        if (!profileIds.length) {
            return jobs as Job[];
        }

        const { data: profiles, error } = await this.supabase
            .from('profiles')
            .select('*')
            .in('id', profileIds);

        if (error) {
            console.warn('[JobService] Failed to attach profiles:', error);
            return jobs as Job[];
        }

        const profilesById = (profiles || []).reduce(
            (acc: Record<string, any>, profile: any) => {
                acc[profile.id] = profile;
                return acc;
            },
            {}
        );

        return jobs.map(job => ({
            ...job,
            customer: job.customer_id ? profilesById[job.customer_id] || null : null,
            driver: job.driver_id ? profilesById[job.driver_id] || null : null
        })) as Job[];
    }

    private toJobsPayload(job: Partial<Job> & Record<string, any>): Record<string, any> {
        const {
            total_price,
            customer,
            driver,
            service_type,
            errand_details,
            errand_funding,
            ...rest
        } = job;

        const price = Number(
            job.price ??
            job.estimated_price ??
            total_price ??
            0
        );

        return {
            ...rest,
            price: Number.isFinite(price) ? price : 0,
            estimated_price: Number.isFinite(price) ? price : 0,
            metadata: {
                ...(job.metadata || {}),
                frontend_total_price: total_price ?? price
            }
        };
    }
}