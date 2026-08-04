import { getSupabaseAdmin } from './supabase.service';
import { MarketAvailabilityService } from './market-availability.service';
import { Job, DispatchResult } from '../../src/app/shared/models/booking.model';
import { EventService } from './event.service';
import { NotificationService } from './notification.service';
import { stripe } from './stripe.service';

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
            await this.cleanupStaleOpenSearchingJobs();
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

    private async cleanupStaleOpenSearchingJobs() {
        const staleBefore = new Date(Date.now() - SEARCH_WINDOW_SECONDS * 1000).toISOString();

        const { data: jobs, error } = await this.supabase
            .from('jobs')
            .select('id, tenant_id, city_id, status, created_at, updated_at')
            .eq('status', 'searching')
            .is('driver_id', null)
            .is('driver_search_expires_at', null)
            .lt('created_at', staleBefore)
            .limit(100);

        if (error) {
            console.error('[DispatchService] Failed to fetch stale open searching jobs:', error);
            return;
        }

        for (const job of jobs || []) {
            await this.markNoDriverFound(job.id, job.tenant_id);
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
            .select('id, customer_id, tenant_id, payment_method, payment_status, payment_intent_id')
            .maybeSingle();

        if (error) {
            console.error(`[DispatchService] Failed setting no_driver_found for ${jobId}:`, error);
            return;
        }

        if (!job) return;

        await this.releaseNoDriverPayment(job as Job);

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

    private async releaseNoDriverPayment(job: Job) {
        const paymentMethod = String((job as any).payment_method || '').toLowerCase();
        const paymentStatus = String((job as any).payment_status || '').toLowerCase();
        const paymentIntentId = String((job as any).payment_intent_id || '').trim();

        if (paymentMethod === 'wallet' || paymentStatus === 'wallet_funded') {
            const { error } = await this.supabase.rpc('release_job_wallet_reservation', {
                p_job_id: job.id,
                p_reason: 'No driver found before completion'
            });

            if (error) {
                console.error(`[DispatchService] Wallet release failed for ${job.id}:`, error);
                await this.markPaymentRequiresReview(job.id);
            }

            return;
        }

        if (paymentMethod === 'card' && paymentIntentId) {
            try {
                const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

                if (['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture'].includes(pi.status)) {
                    await stripe.paymentIntents.cancel(paymentIntentId);
                }

                await this.supabase
                    .from('jobs')
                    .update({ payment_status: 'cancelled', updated_at: nowIso() })
                    .eq('id', job.id);
            } catch (error) {
                console.error(`[DispatchService] Card authorisation release failed for ${job.id}:`, error);
                await this.markPaymentRequiresReview(job.id);
            }
        }
    }

    private async markPaymentRequiresReview(jobId: string) {
        await this.supabase
            .from('jobs')
            .update({
                payment_status: 'requires_review',
                updated_at: nowIso()
            })
            .eq('id', jobId);
    }

    private async dispatchJob(item: any): Promise<DispatchResult> {
        const job = item.job as Job;

        if (!job?.id) {
            return { success: false, job_id: item.job_id, message: 'Missing job' };
        }

        try {
            const metadata = (job as any).metadata && typeof (job as any).metadata === 'object' ? (job as any).metadata : {};
            const availability = await MarketAvailabilityService.checkCapability({ countryCode: (job as any).country_code || metadata.country_code,
                marketCity: (job as any).market_city || metadata.market_city || metadata.pickup_city, zoneId: (job as any).zone_id || metadata.zone_id,
                capability: 'driver_online', endpoint: 'dispatch-engine' });
            if (!availability.allowed) {
                await this.supabase.from('job_queue').update({ status: 'blocked', updated_at: nowIso() }).eq('id', item.id);
                return { success: false, job_id: job.id, message: availability.code || 'Market dispatch disabled' };
            }
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

        let dispatchJob = job as Job | null;

        if (!dispatchJob) {
            const { data: existingJob, error: fetchError } = await this.supabase
                .from('jobs')
                .select('*')
                .eq('id', jobId)
                .maybeSingle();

            if (fetchError) {
                console.error(`[DispatchService] Failed to reload job ${jobId} for dispatch:`, fetchError);
                return { data: null, error: fetchError };
            }

            dispatchJob = existingJob as Job | null;
        }

        if (!dispatchJob) {
            return {
                data: null,
                error: {
                    message: 'Job not found or is no longer dispatchable.',
                    code: 'JOB_NOT_DISPATCHABLE'
                }
            };
        }

        const result = await this.supabase
            .from('job_queue')
            .upsert(
                {
                    job_id: jobId,
                    tenant_id: tenantId,
                    city_id: cityId || (dispatchJob as any).city_id || null,
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

        if (result.error) {
            console.warn(`[DispatchService] Queue insert failed for ${jobId}; continuing with live search.`, result.error);

            try {
                await this.notifyNearbyDrivers(dispatchJob, tenantId, cityId || (dispatchJob as any).city_id);
            } catch (notifyError) {
                console.warn(`[DispatchService] Driver notification fallback failed for ${jobId}:`, notifyError);
            }

            return {
                data: {
                    job_id: jobId,
                    queued: false,
                    warning: result.error.message || 'Dispatch queue unavailable; job remains searchable.'
                },
                error: null
            };
        }

        try {
            await EventService.logEvent(
                'job_enqueued',
                { jobId, cityId: cityId || (dispatchJob as any).city_id, tenantId },
                tenantId
            );
        } catch (eventError) {
            console.warn(`[DispatchService] Failed to log enqueue event for ${jobId}:`, eventError);
        }

        try {
            await this.notifyNearbyDrivers(dispatchJob, tenantId, cityId || (dispatchJob as any).city_id);
        } catch (notifyError) {
            console.warn(`[DispatchService] Failed notifying nearby drivers for ${jobId}:`, notifyError);
        }

        return result;
    }

    async notifyNearbyDrivers(job: Job, tenantId?: string | null, cityId?: string | null) {
        const drivers = await this.findNearbyDrivers(job, tenantId, cityId);

        if (!drivers.length) {
            await EventService.logEvent(
                'dispatch_no_nearby_drivers',
                { jobId: job.id },
                tenantId || (job as any).tenant_id
            );
            return;
        }

        const { data: declined } = await this.supabase
            .from('driver_job_declines')
            .select('driver_id')
            .eq('job_id', job.id);

        const declinedIds = new Set((declined || []).map((d: any) => d.driver_id));
        const eligibleDrivers = drivers.filter(d => !declinedIds.has(d.id));

        if (!eligibleDrivers.length) {
            await EventService.logEvent(
                'dispatch_all_drivers_declined',
                { jobId: job.id },
                tenantId || (job as any).tenant_id
            );
            return;
        }

        for (const driver of eligibleDrivers.slice(0, MAX_NOTIFY_DRIVERS)) {
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

        let profileQuery = this.supabase
            .from('profiles')
            .select('id, lat, lng, is_available, is_online, last_active_at, stripe_connect_status, charges_enabled, payouts_enabled')
            .eq('role', 'driver')
            .eq('is_available', true)
            .eq('is_online', true)
            .eq('charges_enabled', true)
            .eq('payouts_enabled', true)
            .limit(MAX_NOTIFY_DRIVERS * 2);

        if (tenantId) {
            profileQuery = profileQuery.eq('tenant_id', tenantId);
        }

        if (cityId) {
            profileQuery = profileQuery.or(`city_id.eq.${cityId},city_id.is.null`);
        }

        if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
            profileQuery = profileQuery
                .gte('lat', pickupLat - radius)
                .lte('lat', pickupLat + radius)
                .gte('lng', pickupLng - radius)
                .lte('lng', pickupLng + radius);
        }

        const { data: profiles, error: profilesError } = await profileQuery;

        if (profilesError) {
            console.error('[DispatchService] Failed finding nearby drivers:', profilesError);
            return [];
        }

        const drivers = (profiles || []) as any[];
        if (drivers.length === 0) {
            return [];
        }

        const driverIds = drivers.map(d => d.id).filter(Boolean);

        const { data: vehicles, error: vehiclesError } = driverIds.length
            ? await this.supabase
                .from('vehicles')
                .select('user_id, vehicle_class')
                .in('user_id', driverIds)
            : { data: [] as any[], error: null };

        if (vehiclesError) {
            console.error('[DispatchService] Failed fetching driver vehicles:', vehiclesError);
            return [];
        }

        const vehiclesByUser = new Map<string, string[]>();
        (vehicles || []).forEach((vehicle: any) => {
            const userId = vehicle.user_id as string;
            const vehicleClass = vehicle.vehicle_class as string;
            if (!userId || !vehicleClass) return;
            const classes = vehiclesByUser.get(userId) || [];
            classes.push(vehicleClass);
            vehiclesByUser.set(userId, classes);
        });

        // Filter drivers by vehicle compatibility
        const compatibleDrivers = drivers.filter(driver => {
            const vehicleClasses = vehiclesByUser.get(driver.id) || [];
            const serviceType = job.service_slug;

            return vehicleClasses.some(vehicleClass => this.isVehicleCompatible(vehicleClass, serviceType));
        });

        console.log(`[DispatchService] Vehicle compatibility filter: ${drivers.length} total drivers -> ${compatibleDrivers.length} compatible drivers for service ${job.service_slug}`);

        return (compatibleDrivers as NearbyDriver[]).sort((a, b) => {
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
            .eq('charges_enabled', true)
            .eq('payouts_enabled', true)
            .gte('lat', lat - radius)
            .lte('lat', lat + radius)
            .gte('lng', lng - radius)
            .lte('lng', lng + radius);

        return { demand: demand || 0, supply: supply || 0 };
    }

    private isVehicleCompatible(vehicleClass: string | null | undefined, serviceType: string | null | undefined): boolean {
        if (!vehicleClass || !serviceType) return false;

        const normalizedService = String(serviceType).toLowerCase().replace(/[-_]/g, '');
        const isVanService = normalizedService.includes('van') || normalizedService.includes('moving');
        const isDelivery = normalizedService.includes('delivery');
        const isErrand = normalizedService.includes('errand');
        const isRide = normalizedService.includes('ride');

        // Bike drivers can receive bike and small delivery/errand jobs
        if (vehicleClass === 'bike') {
            return isDelivery || isErrand;
        }

        // Car drivers can receive rides and car-compatible delivery/errand jobs
        if (vehicleClass === 'car' || vehicleClass === 'standard') {
            return isRide || isDelivery || isErrand;
        }

        // Van drivers can receive moving and large delivery jobs
        if (vehicleClass === 'van' || vehicleClass === 'large_van') {
            return isVanService || isDelivery;
        }

        // Default to compatible for unknown vehicle classes
        return true;
    }
}

export const dispatchService = new DispatchService();
