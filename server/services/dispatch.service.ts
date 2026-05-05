import { getSupabaseAdmin } from './supabase.service';
import { Job, DispatchResult } from '../../src/app/shared/models/booking.model';
import { EventService } from './event.service';
import { NotificationService } from './notification.service';

type NearbyDriver = {
    id: string;
    lat?: number | null;
    lng?: number | null;
    is_available?: boolean | null;
    is_online?: boolean | null;
    last_active_at?: string | null;
};

const SEARCH_WINDOW_SECONDS = 300;
const MAX_DISPATCH_ATTEMPTS = 3;
const BASE_RADIUS_DEGREES = 0.05;
const RADIUS_STEP_DEGREES = 0.05;
const MAX_NOTIFY_DRIVERS = 20;

function nowIso(): string {
    return new Date().toISOString();
}

function expiresAt(seconds = SEARCH_WINDOW_SECONDS): string {
    return new Date(Date.now() + seconds * 1000).toISOString();
}

function distanceScore(job: Job, driver: NearbyDriver): number {
    const pickupLat = Number((job as any).pickup_lat);
    const pickupLng = Number((job as any).pickup_lng);
    const driverLat = Number(driver.lat);
    const driverLng = Number(driver.lng);

    if (
        !Number.isFinite(pickupLat) ||
        !Number.isFinite(pickupLng) ||
        !Number.isFinite(driverLat) ||
        !Number.isFinite(driverLng)
    ) {
        return Number.MAX_SAFE_INTEGER;
    }

    return Math.abs(pickupLat - driverLat) + Math.abs(pickupLng - driverLng);
}

export class DispatchService {
    private get supabase() {
        return getSupabaseAdmin();
    }

    async runDispatchEngine() {
        try {
            await this.cleanupExpiredSearchingJobs();
            await this.refreshWaitingQueueItems();
        } catch (error) {
            console.error('[DispatchService] Engine error:', error);
        }
    }

    private async cleanupExpiredSearchingJobs() {
        const { data: jobs, error } = await this.supabase
            .from('jobs')
            .select('id, tenant_id, city_id, status, dispatch_attempts, driver_search_expires_at')
            .eq('status', 'searching')
            .is('driver_id', null)
            .not('driver_search_expires_at', 'is', null)
            .lt('driver_search_expires_at', nowIso())
            .limit(100);

        if (error) {
            console.error('[DispatchService] Failed to fetch expired searching jobs:', error);
            return;
        }

        for (const job of jobs || []) {
            const attempts = Number(job.dispatch_attempts || 0);

            if (attempts < MAX_DISPATCH_ATTEMPTS) {
                await this.retryDispatchWindow(job.id, job.tenant_id, job.city_id, attempts + 1);
            } else {
                await this.markNoDriverFound(job.id, job.tenant_id);
            }
        }
    }

    private async refreshWaitingQueueItems() {
        const { data: queueItems, error } = await this.supabase
            .from('job_queue')
            .select(`
        *,
        job:job_id (*)
      `)
            .eq('status', 'waiting')
            .gt('expires_at', nowIso())
            .order('created_at', { ascending: true })
            .limit(100);

        if (error) {
            console.error('[DispatchService] Failed to fetch waiting queue:', error);
            return;
        }

        for (const item of queueItems || []) {
            await this.dispatchJob(item);
        }

        await this.expireOldQueueItems();
    }

    private async expireOldQueueItems() {
        const { data: expiredItems } = await this.supabase
            .from('job_queue')
            .select('id, job_id, tenant_id')
            .eq('status', 'waiting')
            .lt('expires_at', nowIso())
            .limit(100);

        for (const item of expiredItems || []) {
            await this.supabase
                .from('job_queue')
                .update({
                    status: 'expired',
                    updated_at: nowIso()
                })
                .eq('id', item.id);

            await EventService.logEvent(
                'job_queue_expired',
                { jobId: item.job_id },
                item.tenant_id
            );
        }
    }

    private async retryDispatchWindow(
        jobId: string,
        tenantId?: string | null,
        cityId?: string | null,
        nextAttempt = 1
    ) {
        const { data: job, error } = await this.supabase
            .from('jobs')
            .update({
                status: 'searching',
                driver_id: null,
                accepted_driver_id: null,
                accepted_at: null,
                dispatch_attempts: nextAttempt,
                driver_search_expires_at: expiresAt(),
                last_dispatch_check_at: nowIso(),
                no_driver_reason: null,
                updated_at: nowIso()
            })
            .eq('id', jobId)
            .eq('status', 'searching')
            .is('driver_id', null)
            .select('*')
            .maybeSingle();

        if (error) {
            console.error(`[DispatchService] Retry failed for job ${jobId}:`, error);
            return;
        }

        if (job) {
            await EventService.logEvent(
                'dispatch_retry',
                { jobId, attempt: nextAttempt },
                tenantId || job.tenant_id
            );

            await this.notifyNearbyDrivers(job as Job, tenantId || job.tenant_id, cityId || job.city_id);
        }
    }

    private async markNoDriverFound(jobId: string, tenantId?: string | null) {
        const { data: job, error } = await this.supabase
            .from('jobs')
            .update({
                status: 'no_driver_found',
                no_driver_reason: 'No available driver after dispatch attempts',
                last_dispatch_check_at: nowIso(),
                updated_at: nowIso()
            })
            .eq('id', jobId)
            .eq('status', 'searching')
            .is('driver_id', null)
            .select('id, customer_id, tenant_id')
            .maybeSingle();

        if (error) {
            console.error(`[DispatchService] Failed setting no_driver_found for ${jobId}:`, error);
            return;
        }

        if (!job) return;

        await EventService.logEvent(
            'no_driver_found',
            { jobId },
            tenantId || job.tenant_id
        );

        await NotificationService.notifyJobStatusUpdate(
            job.customer_id,
            job.id,
            'no_driver_found'
        );
    }

    private async dispatchJob(item: any): Promise<DispatchResult> {
        const job = item.job as Job;

        if (!job?.id) {
            return { success: false, job_id: item.job_id, message: 'Missing job' };
        }

        try {
            if (job.status === 'accepted' || job.status === 'assigned' || job.driver_id) {
                await this.supabase
                    .from('job_queue')
                    .update({
                        status: 'assigned',
                        updated_at: nowIso()
                    })
                    .eq('id', item.id);

                return {
                    success: true,
                    job_id: job.id,
                    driver_id: job.driver_id
                };
            }

            if (!['pending', 'requested', 'searching', 'no_driver_found'].includes(String(job.status))) {
                await this.supabase
                    .from('job_queue')
                    .update({
                        status: 'ignored',
                        updated_at: nowIso()
                    })
                    .eq('id', item.id);

                return {
                    success: false,
                    job_id: job.id,
                    message: `Ignored status ${job.status}`
                };
            }

            const attempt = Math.max(1, Number((job as any).dispatch_attempts || 0) || 1);

            const { data: updatedJob, error: updateError } = await this.supabase
                .from('jobs')
                .update({
                    status: 'searching',
                    driver_id: null,
                    accepted_driver_id: null,
                    accepted_at: null,
                    dispatch_started_at: (job as any).dispatch_started_at || nowIso(),
                    driver_search_expires_at: (job as any).driver_search_expires_at || expiresAt(),
                    dispatch_attempts: attempt,
                    no_driver_reason: null,
                    updated_at: nowIso()
                })
                .eq('id', job.id)
                .in('status', ['pending', 'requested', 'searching', 'no_driver_found'])
                .select('*')
                .maybeSingle();

            if (updateError) throw updateError;
            if (!updatedJob) {
                return {
                    success: false,
                    job_id: job.id,
                    message: 'Job could not be moved to searching'
                };
            }

            await this.supabase
                .from('job_queue')
                .update({
                    status: 'broadcasting',
                    updated_at: nowIso()
                })
                .eq('id', item.id);

            await EventService.logEvent(
                'dispatch_broadcast',
                {
                    jobId: job.id,
                    attempt,
                    expiresAt: updatedJob.driver_search_expires_at
                },
                item.tenant_id || updatedJob.tenant_id
            );

            await this.notifyNearbyDrivers(updatedJob as Job, item.tenant_id || updatedJob.tenant_id, item.city_id || updatedJob.city_id);

            return {
                success: true,
                job_id: job.id,
                message: 'Job broadcast to nearby drivers'
            };
        } catch (error) {
            console.error(`[DispatchService] Error dispatching job ${job.id}:`, error);

            return {
                success: false,
                job_id: job.id,
                message: String(error)
            };
        }
    }

    async enqueueJob(jobId: string, tenantId: string, cityId?: string, timeoutSeconds = SEARCH_WINDOW_SECONDS) {
        const expires = expiresAt(timeoutSeconds);

        const { data: job, error: jobError } = await this.supabase
            .from('jobs')
            .update({
                status: 'searching',
                driver_id: null,
                accepted_driver_id: null,
                accepted_at: null,
                dispatch_started_at: nowIso(),
                driver_search_expires_at: expires,
                dispatch_attempts: 1,
                no_driver_reason: null,
                updated_at: nowIso()
            })
            .eq('id', jobId)
            .in('status', ['pending', 'requested', 'searching', 'no_driver_found'])
            .select('*')
            .maybeSingle();

        if (jobError) {
            console.error(`[DispatchService] Failed to start dispatch for ${jobId}:`, jobError);
            return { data: null, error: jobError };
        }

        const result = await this.supabase
            .from('job_queue')
            .upsert(
                {
                    job_id: jobId,
                    tenant_id: tenantId,
                    city_id: cityId || job?.city_id || null,
                    status: 'broadcasting',
                    expires_at: expires,
                    updated_at: nowIso()
                },
                {
                    onConflict: 'job_id'
                }
            )
            .select('*')
            .maybeSingle();

        if (!result.error && job) {
            await EventService.logEvent(
                'job_enqueued',
                { jobId, cityId: cityId || job.city_id, tenantId },
                tenantId
            );

            await this.notifyNearbyDrivers(job as Job, tenantId, cityId || job.city_id);
        }

        return result;
    }

    private async notifyNearbyDrivers(job: Job, tenantId?: string | null, cityId?: string | null) {
        const drivers = await this.findNearbyDrivers(job, tenantId, cityId);

        if (!drivers.length) {
            await EventService.logEvent(
                'dispatch_no_nearby_drivers',
                { jobId: job.id },
                tenantId || (job as any).tenant_id
            );
            return;
        }

        for (const driver of drivers.slice(0, MAX_NOTIFY_DRIVERS)) {
            try {
                await NotificationService.notifyNewJob(driver.id, job.id);

                await this.supabase
                    .from('dispatch_logs')
                    .insert({
                        job_id: job.id,
                        driver_id: driver.id,
                        accepted: false,
                        distance: (job as any).estimated_distance || null
                    });
            } catch (error) {
                console.warn(`[DispatchService] Failed notifying driver ${driver.id}:`, error);
            }
        }
    }

    private async findNearbyDrivers(job: Job, tenantId?: string | null, cityId?: string | null): Promise<NearbyDriver[]> {
        const pickupLat = Number((job as any).pickup_lat);
        const pickupLng = Number((job as any).pickup_lng);
        const attempts = Math.max(1, Number((job as any).dispatch_attempts || 1));
        const radius = BASE_RADIUS_DEGREES + (attempts - 1) * RADIUS_STEP_DEGREES;

        let query = this.supabase
            .from('profiles')
            .select('id, lat, lng, is_available, is_online, last_active_at')
            .eq('role', 'driver')
            .eq('is_available', true)
            .eq('is_online', true)
            .limit(MAX_NOTIFY_DRIVERS);

        if (tenantId) {
            query = query.eq('tenant_id', tenantId);
        }

        if (cityId) {
            query = query.or(`city_id.eq.${cityId},city_id.is.null`);
        }

        if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
            query = query
                .gte('lat', pickupLat - radius)
                .lte('lat', pickupLat + radius)
                .gte('lng', pickupLng - radius)
                .lte('lng', pickupLng + radius);
        }

        const { data, error } = await query;

        if (error) {
            console.error('[DispatchService] Failed finding nearby drivers:', error);
            return [];
        }

        return ((data || []) as NearbyDriver[]).sort((a, b) => {
            const scoreA = distanceScore(job, a);
            const scoreB = distanceScore(job, b);

            if (scoreA !== scoreB) return scoreA - scoreB;

            const activeA = a.last_active_at ? new Date(a.last_active_at).getTime() : 0;
            const activeB = b.last_active_at ? new Date(b.last_active_at).getTime() : 0;

            return activeB - activeA;
        });
    }

    async getAreaStats(lat: number, lng: number, radius = 0.05) {
        const { count: demand } = await this.supabase
            .from('jobs')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'searching')
            .gte('pickup_lat', lat - radius)
            .lte('pickup_lat', lat + radius)
            .gte('pickup_lng', lng - radius)
            .lte('pickup_lng', lng + radius);

        const { count: supply } = await this.supabase
            .from('profiles')
            .select('*', { count: 'exact', head: true })
            .eq('role', 'driver')
            .eq('is_available', true)
            .eq('is_online', true)
            .gte('lat', lat - radius)
            .lte('lat', lat + radius)
            .gte('lng', lng - radius)
            .lte('lng', lng + radius);

        return { demand: demand || 0, supply: supply || 0 };
    }
}

export const dispatchService = new DispatchService();