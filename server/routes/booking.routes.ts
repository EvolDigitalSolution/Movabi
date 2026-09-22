import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { FraudService } from '../services/fraud.service';
import { NotificationService } from '../services/notification.service';
import { LogisticsService } from '../services/logistics.service';
import { IssuingService } from '../services/issuing.service';
import { PricingService } from '../services/pricing.service';
import { DispatchService } from '../services/dispatch.service';
import { stripe } from '../services/stripe.service';
import { rateLimit } from 'express-rate-limit';
import { MarketAvailabilityError, MarketAvailabilityService } from '../services/market-availability.service';
import { mapDriverAcquisitionError } from '../services/driver-eligibility.service';

const router = Router();

const capturedStatuses = ['paid', 'captured', 'succeeded'];
const cancellableStripeStatuses = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture'];
const bookingCreateLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

async function getAuthUserId(req: Request): Promise<string | null> {
    const existing = (req as any).user?.id || (req as any).auth?.user?.id;
    if (existing) return String(existing);

    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user?.id) {
        console.warn('[BookingRoutes] auth token decode failed:', error?.message || 'No user on token');
        return null;
    }

    return data.user.id;
}

/**
 * Batch 2C Phase B.1 — admin predicate for the booking mutation routes.
 * Fails closed: any lookup error means "not an admin".
 */
async function isAdminUser(userId: string | null): Promise<boolean> {
    if (!userId) return false;
    const { data, error } = await supabaseAdmin.from('profiles').select('role').eq('id', userId).maybeSingle();
    if (error) {
        console.error('[BookingRoutes] admin lookup failed:', error);
        return false;
    }
    return String(data?.role || '') === 'admin';
}

/**
 * Batch 2C Phase B.1 — true when the authenticated user is a participant in the
 * job: its customer, its assigned driver, or the driver who confirmed it.
 */
function isJobParticipant(job: any, userId: string): boolean {
    const id = String(userId || '');
    if (!id) return false;
    return String(job?.customer_id || '') === id
        || String(job?.driver_id || '') === id
        || String(job?.accepted_driver_id || '') === id;
}

/**
 * Batch 2C Phase B.1 — resolve the caller for a booking mutation route.
 *
 * Returns the authenticated id, or null after writing the response, so callers
 * can `if (!userId) return;`. Never trusts a client-supplied identity.
 */
async function requireAuthenticatedUser(req: Request, res: Response): Promise<string | null> {
    const userId = await getAuthUserId(req);
    if (!userId) {
        res.status(401).json({ error: 'Authentication required.', code: 'AUTHENTICATION_REQUIRED' });
        return null;
    }
    return userId;
}

/**
 * Batch 2C Phase B.1 — ownership fields a booking CREATE may never accept.
 *
 * A new booking belongs to its customer and to nobody else. Ownership is an
 * ACQUISITION performed later by a trusted server action or an ownership RPC, so
 * these keys are rejected outright (fail closed) rather than silently dropped.
 */
const BOOKING_OWNERSHIP_FIELDS = [
    'driver_id',
    'accepted_driver_id',
    'accepted_at',
    'assigned_at',
    'driver_assigned_at',
    'dispatch_started_at'
] as const;

/**
 * Batch 2C Phase B.1 — explicit allow-list of fields a client may create a
 * booking with.
 *
 * The route previously forwarded an arbitrary client object into `insert()`,
 * forcing only `customer_id`. Anything not listed here is dropped and logged, so
 * an unexpected key can never reach the insert statement. The list is the union
 * of the fields the shipping client sends
 * (`BookingService.createBooking` / `JobService.toJobsPayload`) and the fields
 * this route derives itself.
 */
const CREATABLE_BOOKING_FIELDS = new Set<string>([
    // identity / lifecycle (the route forces these itself)
    'customer_id', 'tenant_id', 'service_type_id', 'status', 'payment_status',
    'is_draft', 'expires_at', 'expired_at', 'expiry_reason', 'scheduled_time',
    'quote_id', 'agreed_fare', 'bid_mode_enabled', 'negotiation_mode_enabled',
    // geography
    'pickup_address', 'pickup_lat', 'pickup_lng',
    'dropoff_address', 'dropoff_lat', 'dropoff_lng',
    'country_code', 'currency_code', 'currency_symbol',
    // fare (the route overwrites these from the verified quote)
    'price', 'total_price', 'estimated_price', 'distance_km', 'estimated_distance_km',
    'distance_meters', 'duration_seconds', 'estimated_duration',
    'platform_fee', 'driver_payout', 'tax_amount',
    'surge_multiplier', 'dynamic_pricing_multiplier',
    'base_fare_used', 'price_per_km_used', 'commission_rate_used', 'pricing_plan_used',
    'regional_pricing_rule_id', 'fare_breakdown', 'marketplace_flags',
    // free-form
    'metadata'
]);

router.post('/create', bookingCreateLimiter, async (req: Request, res: Response) => {
    try {
        const userId = await getAuthUserId(req);
        if (!userId) return res.status(401).json({ error: 'Authentication required' });
        const payload = { ...(req.body?.booking || {}) } as Record<string, any>;
        if (payload.customer_id && String(payload.customer_id) !== userId) return res.status(403).json({ error: 'Cannot create a booking for another customer' });

        // Batch 2C Phase B.1: a create can never carry ownership. Presence of the
        // key is an attempt, even when the value is null or blank.
        const attemptedOwnership = BOOKING_OWNERSHIP_FIELDS.filter(field =>
            Object.prototype.hasOwnProperty.call(payload, field));
        if (attemptedOwnership.length) {
            console.warn('[BookingRoutes] booking create rejected ownership fields', { userId, fields: attemptedOwnership });
            return res.status(400).json({
                error: 'A new booking cannot be created with driver ownership fields.',
                code: 'OWNERSHIP_FIELD_NOT_ALLOWED',
                fields: attemptedOwnership
            });
        }
        const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
        const breakdown = payload.fare_breakdown && typeof payload.fare_breakdown === 'object' ? payload.fare_breakdown : {};
        const quoteReference = String(payload.quote_id || metadata.quote_id || breakdown.quoteId || '').trim();
        const quoteExpiresAt = String(metadata.quote_expires_at || breakdown.quoteExpiresAt || '').trim();
        const quoteVersion = String(breakdown.calculationVersion || breakdown.marketPricingVersion || '').trim();
        if (!quoteReference || !quoteVersion || !quoteExpiresAt || Date.parse(quoteExpiresAt) <= Date.now()) return res.status(409).json({ error: 'A current versioned backend quote is required', code: 'QUOTE_EXPIRED' });
        const { data: existing } = await supabaseAdmin.from('jobs').select('*, service_type:service_types(*)').eq('quote_id', quoteReference).eq('customer_id', userId).maybeSingle();
        if (existing) return res.status(200).json(existing);
        const { data: quoteAudit, error: quoteError } = await supabaseAdmin.from('quote_market_adjustments').select('quote_reference,country_code,market_city,zone_id,service_type,currency,returned_customer_fare,strategy_version').eq('quote_reference', quoteReference).maybeSingle();
        if (quoteError || !quoteAudit) return res.status(409).json({ error: 'Authoritative quote could not be verified', code: 'QUOTE_NOT_VERIFIED' });
        const requestedService = String(metadata.service_slug || metadata.service_type || '').trim().toLowerCase();
        const canonicalService = ['shop','shopping','errands'].includes(requestedService) ? 'errand' : ['deliver','courier','parcel'].includes(requestedService) ? 'delivery' : ['van','move','moving'].includes(requestedService) ? 'van-moving' : requestedService;
        if (canonicalService && canonicalService !== String(quoteAudit.service_type)) return res.status(409).json({ error: 'Quote service does not match booking', code: 'QUOTE_INPUT_CHANGED' });
        const quotedFare = Number(quoteAudit.returned_customer_fare);
        const submittedServiceFare = Number(breakdown.customerServiceTotal ?? payload.total_price ?? payload.price);
        if (!Number.isFinite(quotedFare) || !Number.isFinite(submittedServiceFare) || Math.abs(quotedFare - submittedServiceFare) > 0.01) return res.status(409).json({ error: 'Quoted fare changed; customer acceptance is required', code: 'QUOTE_INPUT_CHANGED' });
        payload.quote_id = quoteReference;
        payload.price = quotedFare; payload.total_price = quotedFare; payload.estimated_price = quotedFare;
        payload.country_code = quoteAudit.country_code || payload.country_code;
        payload.currency_code = quoteAudit.currency || payload.currency_code;
        await MarketAvailabilityService.requireCapability({ countryCode: payload.country_code || metadata.country_code,
            marketCity: payload.market_city || metadata.market_city || metadata.pickup_city, zoneId: payload.zone_id || metadata.zone_id,
            capability: 'booking', endpoint: '/api/booking/create' });
        payload.customer_id = userId;
        // Batch 2C Phase B.1: build the insert payload from the allow-list only,
        // so no unlisted client key can reach the insert statement.
        const insertPayload: Record<string, unknown> = {};
        const droppedFields: string[] = [];
        for (const [key, value] of Object.entries(payload)) {
            if (CREATABLE_BOOKING_FIELDS.has(key)) insertPayload[key] = value;
            else droppedFields.push(key);
        }
        if (droppedFields.length) {
            console.warn('[BookingRoutes] booking create dropped non-creatable fields', { userId, droppedFields });
        }
        insertPayload.customer_id = userId;
        const { data, error } = await supabaseAdmin.from('jobs').insert(insertPayload).select('*, service_type:service_types(*)').single();
        if (error) return res.status(400).json({ error: error.message, code: error.code });
        return res.status(201).json(data);
    } catch (error) {
        if (error instanceof MarketAvailabilityError) return res.status(error.httpStatus).json({ error: error.message, code: error.code, market: error.market });
        return res.status(500).json({ error: error instanceof Error ? error.message : 'Booking creation failed' });
    }
});

function normalise(value: unknown): string {
    return String(value || '').toLowerCase().trim();
}

async function getJob(jobId: string) {
    const { data, error } = await supabaseAdmin
        .from('jobs')
        .select('*')
        .eq('id', jobId)
        .single();

    if (error || !data) {
        throw new Error('Job not found');
    }

    return data;
}

async function refreshDriverRating(driverId: string | null | undefined) {
    if (!driverId) return null;

    const { data: ratings, error } = await supabaseAdmin
        .from('ratings')
        .select('score')
        .eq('driver_id', driverId);

    if (error) {
        console.error('[BookingRoutes] rating aggregate failed:', error);
        return null;
    }

    const scores = (ratings || [])
        .map((row: any) => Number(row.score))
        .filter((score: number) => Number.isFinite(score) && score >= 1 && score <= 5);

    if (!scores.length) return null;

    const average = Math.round((scores.reduce((sum: number, score: number) => sum + score, 0) / scores.length) * 10) / 10;
    const updatedAt = new Date().toISOString();
    const payloads: Record<string, unknown>[] = [
        { rating: average, driver_rating: average, review_count: scores.length, updated_at: updatedAt },
        { rating: average, driver_rating: average, updated_at: updatedAt },
        { rating: average, review_count: scores.length, updated_at: updatedAt },
        { rating: average, updated_at: updatedAt },
        { driver_rating: average, updated_at: updatedAt }
    ];

    for (const payload of payloads) {
        const { error: updateError } = await supabaseAdmin
            .from('profiles')
            .update(payload)
            .eq('id', driverId);

        if (!updateError) {
            return { average, count: scores.length };
        }

        if (updateError.code !== '42703') {
            console.error('[BookingRoutes] driver rating update failed:', updateError);
            return null;
        }
    }

    return null;
}

/**
 * Batch 2B (N12) — detect ONLY the single-active-job invariant violation.
 *
 * Deliberately narrow. `MB001` is the dedicated SQLSTATE raised by the
 * acquisition RPCs for "driver already has an active job", and it is used for
 * nothing else. A raw `23505` is accepted only when the message or details name
 * the invariant index, so an unrelated unique violation (or the Batch 2A
 * "job already owned by another driver" 23505) can never be reported as
 * "driver busy".
 */
function isDriverBusyViolation(error: unknown): boolean {
    const candidate = error as { code?: string; message?: string; details?: string } | null;

    if (!candidate) return false;
    if (candidate.code === 'MB001') return true;
    if (candidate.code !== '23505') return false;

    const text = `${candidate.message ?? ''} ${candidate.details ?? ''}`;
    return text.includes('idx_jobs_one_active_per_driver');
}

async function getDriverVehicle(driverId: string) {
    const { data, error } = await supabaseAdmin
        .from('vehicles')
        .select('*')
        .eq('user_id', driverId)
        .maybeSingle();

    if (error) {
        console.error('[BookingRoutes] vehicle lookup failed:', error);
        return null;
    }

    return data;
}

function parseMetadata(value: unknown): Record<string, any> {
    if (!value) return {};
    if (typeof value === 'object') return value as Record<string, any>;

    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    return {};
}

function requiredVehicleClass(job: any): 'bike' | 'standard' | 'xl' | 'car' | 'small_van' | 'large_van' | 'minibus' {
    const metadata = parseMetadata(job?.metadata);
    const serviceSlug = normalise(job?.service_slug || job?.service_type?.slug);
    const raw = normalise(
        metadata.service_vehicle_class ||
        metadata.vehicle_class ||
        metadata.vehicleClass ||
        metadata.ride_details?.vehicle_class ||
        metadata.delivery_details?.vehicleClass ||
        metadata.errand_details?.vehicleClass
    );

    if (raw.includes('bike') || raw.includes('motorcycle') || raw.includes('scooter')) return 'bike';
    if (raw.includes('minibus') || raw.includes('7 seater') || raw.includes('7-seater')) return 'minibus';
    if (raw.includes('xl') || raw.includes('7')) return 'xl';
    if (raw.includes('large_van') || raw.includes('large van') || raw.includes('luton')) return 'large_van';
    if (raw.includes('small_van') || raw.includes('small van') || raw.includes('van')) return 'small_van';
    if (raw.includes('standard')) return 'standard';
    if (raw.includes('car')) return 'car';
    if (serviceSlug.includes('van') || serviceSlug.includes('moving')) return 'small_van';
    if (serviceSlug.includes('delivery') || serviceSlug.includes('errand')) return 'car';
    return 'standard';
}

function driverCapabilities(vehicle: any): string[] {
    if (!vehicle) return [];

    const combined = normalise(`${vehicle.type || ''} ${vehicle.capacity || ''} ${vehicle.service_class || ''}`);

    if (combined.includes('bike') || combined.includes('motorcycle') || combined.includes('scooter')) return ['bike'];
    if (combined.includes('minibus') || combined.includes('7 seater') || combined.includes('7-seater') || combined.includes('xl') || combined.includes('7')) return ['standard', 'xl', 'minibus', 'car'];
    if (combined.includes('large_van') || combined.includes('large van') || combined.includes('luton')) return ['standard', 'xl', 'car', 'small_van', 'large_van'];
    if (combined.includes('small_van') || combined.includes('small van') || combined.includes('van')) return ['standard', 'car', 'small_van'];
    return ['standard', 'car'];
}

function vehicleLabel(value: string): string {
    switch (value) {
        case 'bike':
            return 'Bike';
        case 'xl':
            return 'XL car';
        case 'minibus':
            return '7 seater';
        case 'small_van':
            return 'Small van';
        case 'large_van':
            return 'Large van';
        case 'car':
        case 'standard':
            return 'Car';
        default:
            return 'Vehicle';
    }
}

async function captureJobPaymentOnlyWhenCompleted(jobId: string) {
    const job = await getJob(jobId);

    if (job.status !== 'completed') {
        throw new Error('Cannot capture payment: job not completed');
    }

    if (job.payment_method !== 'card' || !job.payment_intent_id) {
        await supabaseAdmin
            .from('jobs')
            .update({ payment_status: job.payment_status || 'paid' })
            .eq('id', jobId);

        return null;
    }

    if (capturedStatuses.includes(normalise(job.payment_status))) {
        return null;
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(job.payment_intent_id);

    if (paymentIntent.status === 'succeeded') {
        await supabaseAdmin
            .from('jobs')
            .update({ payment_status: 'paid' })
            .eq('id', jobId);

        return paymentIntent;
    }

    if (paymentIntent.status !== 'requires_capture') {
        throw new Error(`Cannot capture payment in Stripe status: ${paymentIntent.status}`);
    }

    const captured = await stripe.paymentIntents.capture(job.payment_intent_id);

    await supabaseAdmin
        .from('jobs')
        .update({ payment_status: 'paid' })
        .eq('id', jobId);

    return captured;
}

async function releaseWalletReservation(jobId: string, reason: string) {
    const { error } = await supabaseAdmin.rpc('release_job_wallet_reservation', {
        p_job_id: jobId,
        p_reason: reason
    });

    if (error) {
        console.error(`[BookingRoutes] Wallet release failed for ${jobId}:`, error);
        await supabaseAdmin
            .from('jobs')
            .update({ payment_status: 'requires_review' })
            .eq('id', jobId);
    }
}

async function hasProtectedErrandSpend(jobId: string): Promise<boolean> {
    const [{ data: details }, { data: spendControl }] = await Promise.all([
        supabaseAdmin
            .from('errand_details')
            .select('actual_spending, receipt_url')
            .eq('job_id', jobId)
            .maybeSingle(),
        supabaseAdmin
            .from('job_issuing_spend_controls')
            .select('amount_authorized, amount_captured, status')
            .eq('job_id', jobId)
            .maybeSingle()
    ]);

    return Number((details as any)?.actual_spending || 0) > 0 ||
        !!(details as any)?.receipt_url ||
        Number((spendControl as any)?.amount_authorized || 0) > 0 ||
        Number((spendControl as any)?.amount_captured || 0) > 0;
}

async function logJobEvent(jobId: string, eventType: string, actorId: string | null, notes: string, metadata: Record<string, unknown>) {
    const { error } = await supabaseAdmin
        .from('job_events')
        .insert({
            job_id: jobId,
            event_type: eventType,
            actor_id: actorId,
            actor_role: actorId ? 'driver' : 'system',
            notes,
            metadata
        });

    if (error) {
        console.warn('[BookingRoutes] failed to log job event:', error);
    }
}

/**
 * Accept/assign a job.
 * Payment is NOT captured here.
 *
 * Batch 2C Phase B (ownership hardening): this route used to take `driverId`
 * straight from the request body and perform NO authentication at all, so any
 * caller could assign an arbitrary driver — or themselves — to any acceptable
 * job. The driver is now derived from the authenticated session and the body can
 * no longer name one.
 */
router.post('/accept', async (req: Request, res: Response) => {
    try {
        const { jobId } = req.body;

        const driverId = await getAuthUserId(req);
        if (!driverId) {
            return res.status(401).json({ error: 'Authentication required.' });
        }

        if (!jobId) {
            return res.status(400).json({ error: 'jobId required' });
        }
        if (req.body?.driverId && String(req.body.driverId) !== driverId) {
            return res.status(403).json({
                error: 'A job can only be accepted for the authenticated driver.',
                code: 'DRIVER_IDENTITY_MISMATCH'
            });
        }

        const job = await getJob(jobId);
        const vehicle = await getDriverVehicle(driverId);
        const required = requiredVehicleClass(job);
        const capabilities = driverCapabilities(vehicle);

        if (!capabilities.includes(required)) {
            return res.status(400).json({
                error: `This request needs ${vehicleLabel(required)}. Please update your saved vehicle before accepting.`
            });
        }

        if (!LogisticsService.isValidBookingTransition(job.status, 'accepted')) {
            return res.status(400).json({
                error: `Invalid transition from ${job.status} to accepted`
            });
        }

        const { data: assigned, error: rpcError } = await supabaseAdmin.rpc('assign_driver_to_job', {
            p_job_id: jobId,
            p_driver_id: driverId
        });

        if (rpcError || !assigned) {
            // Batch 2C Phase B: MB002 (compliance) and MB001 (busy) are mapped
            // explicitly; everything else keeps the pre-existing generic failure
            // and is NEVER reported as a success.
            const acquisitionFailure = mapDriverAcquisitionError(rpcError);
            if (acquisitionFailure) {
                return res.status(acquisitionFailure.status).json({
                    error: acquisitionFailure.error,
                    code: acquisitionFailure.code,
                    ...(acquisitionFailure.blocking ? { blocking: acquisitionFailure.blocking } : {})
                });
            }
            return res.status(400).json({
                error: 'Failed to accept job. It may have been taken or cancelled.'
            });
        }

        let paymentStatus = job.payment_status || 'pending';

        if (job.payment_method === 'card' && job.payment_intent_id) {
            try {
                const pi = await stripe.paymentIntents.retrieve(job.payment_intent_id);
                paymentStatus = pi.status === 'requires_capture' ? 'authorized' : paymentStatus;
            } catch {
                paymentStatus = job.payment_status || 'pending';
            }
        }

        await supabaseAdmin
            .from('jobs')
            .update({ payment_status: paymentStatus })
            .eq('id', jobId);

        if (job.customer_id) {
            await NotificationService.notifyJobStatusUpdate(job.customer_id, jobId, 'assigned');
        }

        return res.json({
            success: true,
            message: 'Job assigned. Payment remains authorized until completion.'
        });
    } catch (error: any) {
        console.error('Accept job error:', error);
        return res.status(500).json({ error: error.message || 'Failed to accept job' });
    }
});

/**
 * Complete a job.
 * Status is marked completed first, then payment capture is allowed.
 */
router.post('/complete', async (req: Request, res: Response) => {
    try {
        const { jobId, completionPin } = req.body || {};

        if (!jobId) {
            return res.status(400).json({ error: 'jobId required' });
        }

        // Completion moves money. Authenticate first and derive the driver from
        // the token: driverId supplied in the request body is never trusted.
        const authUserId = await getAuthUserId(req);

        if (!authUserId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const job = await getJob(jobId);
        const assignedDriverId = job.driver_id || job.accepted_driver_id;

        if (!assignedDriverId || String(assignedDriverId) !== authUserId) {
            return res.status(403).json({ error: 'Only the assigned driver can complete this request' });
        }

        // Delegate to the canonical completion path so ownership, completion PIN,
        // Stripe capture, driver transfer and earnings stay in one place.
        const wasAlreadyCompleted = String(job.status || '').toLowerCase() === 'completed';
        const completed = await LogisticsService.completeJob(jobId, completionPin || null, authUserId);

        // Only announce the transition. An idempotent repeat of an already-completed
        // job (or a resume) must not re-notify the customer and driver.
        if (!wasAlreadyCompleted) {
            if (job.customer_id) {
                await NotificationService.notifyJobStatusUpdate(job.customer_id, jobId, 'completed');
            }

            await NotificationService.notifyJobStatusUpdate(String(assignedDriverId), jobId, 'completed');
        }

        return res.json({
            success: true,
            message: 'Job completed and payment captured.',
            data: completed
        });
    } catch (error: any) {
        console.error('Complete job error:', error);
        const message = String(error?.message || 'Failed to complete job');
        const status = /only the assigned driver/i.test(message)
            ? 403
            : /pin|required|incorrect/i.test(message)
                ? 400
                : /capture|transfer/i.test(message)
                    ? 402
                    : 500;
        return res.status(status).json({ error: message });
    }
});

/**
 * Cancel booking.
 * If payment has not been captured, cancel the authorization.
 * If driver was assigned and cancellation fee exists, capture only that fee.
 */
router.post('/cancel', async (req: Request, res: Response) => {
    try {
        // Batch 2C Phase B.1: this route was unauthenticated, so anyone who knew
        // a job id could cancel somebody else's booking.
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const { jobId, reason } = req.body;

        if (!jobId) {
            return res.status(400).json({ error: 'jobId required' });
        }

        const job = await getJob(jobId);

        // Only a participant (customer or assigned driver) or an admin may cancel.
        if (!isJobParticipant(job, userId) && !(await isAdminUser(userId))) {
            return res.status(403).json({ error: 'You cannot cancel this booking.', code: 'NOT_A_PARTICIPANT' });
        }
        if (req.body?.customerId && String(req.body.customerId) !== String(job.customer_id || '')) {
            return res.status(403).json({ error: 'Customer identity mismatch.', code: 'IDENTITY_MISMATCH' });
        }

        if (!LogisticsService.isValidBookingTransition(job.status, 'cancelled')) {
            return res.status(400).json({
                error: `Cannot cancel job in status: ${job.status}`
            });
        }

        const paymentStatus = normalise(job.payment_status);

        if (capturedStatuses.includes(paymentStatus)) {
            return res.status(409).json({
                error: 'This booking already has captured payment. Refund/admin review is required.'
            });
        }

        const { data: cancelled, error: rpcError } = await supabaseAdmin.rpc('cancel_job_safely', {
            p_job_id: jobId,
            p_reason: reason || 'User cancelled'
        });

        if (rpcError || !cancelled) {
            if (rpcError) {
                console.error('[BookingRoutes] cancel_job_safely failed:', rpcError);
            }

            return res.status(400).json({
                error: rpcError?.message || 'Failed to cancel job. It may have already been completed or cancelled.'
            });
        }

        if (job.customer_id) {
            await FraudService.trackCancellation(job.customer_id);
        }

        if (job.payment_method === 'card' && job.payment_intent_id) {
            try {
                const pi = await stripe.paymentIntents.retrieve(job.payment_intent_id);

                if (pi.status === 'succeeded') {
                    await supabaseAdmin
                        .from('jobs')
                        .update({ payment_status: 'requires_refund' })
                        .eq('id', jobId);
                } else if (pi.status === 'requires_capture') {
                    const driverAssigned = !!job.driver_id;
                    const cancellationFeeMajor = Number(job.cancellation_fee || 0);
                    const totalMajor = Number(job.price || job.total_price || 0);
                    const amountToCapture = Math.min(
                        Math.round(cancellationFeeMajor * 100),
                        Math.round(totalMajor * 100)
                    );

                    if (driverAssigned && amountToCapture > 0) {
                        await stripe.paymentIntents.capture(job.payment_intent_id, {
                            amount_to_capture: amountToCapture
                        });

                        await supabaseAdmin
                            .from('jobs')
                            .update({ payment_status: 'paid' })
                            .eq('id', jobId);
                    } else {
                        await stripe.paymentIntents.cancel(job.payment_intent_id);

                        await supabaseAdmin
                            .from('jobs')
                            .update({ payment_status: 'cancelled' })
                            .eq('id', jobId);
                    }
                } else if (cancellableStripeStatuses.includes(pi.status)) {
                    await stripe.paymentIntents.cancel(job.payment_intent_id);

                    await supabaseAdmin
                        .from('jobs')
                        .update({ payment_status: 'cancelled' })
                        .eq('id', jobId);
                } else {
                    await supabaseAdmin
                        .from('jobs')
                        .update({ payment_status: 'cancelled' })
                        .eq('id', jobId);
                }
            } catch (stripeError: any) {
                console.error('Stripe cancel/capture error:', stripeError);

                await supabaseAdmin
                    .from('jobs')
                    .update({ payment_status: 'requires_review' })
                    .eq('id', jobId);
            }
        } else if (job.payment_method === 'wallet' || job.payment_status === 'wallet_funded') {
            await releaseWalletReservation(jobId, reason || 'Booking cancelled before completion');
        } else {
            await supabaseAdmin
                .from('jobs')
                .update({ payment_status: 'cancelled' })
                .eq('id', jobId);
        }

        if (job.customer_id) {
            await NotificationService.notifyJobStatusUpdate(job.customer_id, jobId, 'cancelled');
        }

        if (job.driver_id) {
            await NotificationService.notifyJobStatusUpdate(job.driver_id, jobId, 'cancelled');
        }

        return res.json({ success: true });
    } catch (error: any) {
        console.error('Cancel booking error:', error);
        return res.status(500).json({ error: error.message || 'Failed to cancel booking' });
    }
});

/**
 * Driver cannot continue.
 * If no protected spend exists, put the job back into driver search without releasing customer funds.
 * If spend/card activity exists, keep the assignment trail and move it to review for admin handoff.
 */
router.post('/driver-unable', async (req: Request, res: Response) => {
    try {
        // Batch 2C Phase B.1: the caller identity was taken from the request body,
        // so anyone could force a handoff, freeze the assigned driver's issuing
        // card and release the job.
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const { jobId, driverId, reason } = req.body || {};

        if (!jobId) {
            return res.status(400).json({ error: 'jobId required' });
        }
        if (driverId && String(driverId) !== userId) {
            return res.status(403).json({ error: 'You can only hand off your own job.', code: 'DRIVER_IDENTITY_MISMATCH' });
        }

        const job = await getJob(jobId);

        // The authenticated caller must BE the assigned driver.
        if (String(job.driver_id || '') !== userId) {
            return res.status(403).json({ error: 'This driver is not assigned to the job', code: 'NOT_ASSIGNED_DRIVER' });
        }

        if (['completed', 'settled', 'cancelled'].includes(normalise(job.status))) {
            return res.status(400).json({ error: `Cannot hand off a job in status: ${job.status}` });
        }

        // The acting driver is the authenticated caller, never the request body.
        const actingDriverId = userId;

        const reasonText = String(reason || 'Driver cannot continue').trim().slice(0, 500);
        const hasSpend = await hasProtectedErrandSpend(jobId);
        const metadata = parseMetadata(job.metadata);
        const handoffHistory = Array.isArray(metadata.driver_handoff_history)
            ? metadata.driver_handoff_history
            : [];
        const handoffEntry = {
            driver_id: actingDriverId,
            reason: reasonText,
            previous_status: job.status,
            created_at: new Date().toISOString()
        };
        const nextMetadata = {
            ...metadata,
            driver_handoff_history: [handoffEntry, ...handoffHistory].slice(0, 10),
            last_driver_handoff: handoffEntry
        };

        try {
            await IssuingService.freezeDriverCard(actingDriverId, `Driver handoff: ${reasonText}`);
        } catch (freezeError) {
            console.warn('[BookingRoutes] failed to freeze issuing card during handoff:', freezeError);
        }

        if (hasSpend) {
            const { error } = await supabaseAdmin
                .from('jobs')
                .update({
                    status: 'requires_review',
                    no_driver_reason: `Driver cannot continue after spend/card activity: ${reasonText}`,
                    metadata: nextMetadata,
                    updated_at: new Date().toISOString()
                })
                .eq('id', jobId);

            if (error) throw error;

            await logJobEvent(jobId, 'driver_handoff_review_required', actingDriverId, reasonText, {
                previous_status: job.status,
                has_protected_spend: true
            });

            if (job.customer_id) {
                await NotificationService.notifyJobStatusUpdate(job.customer_id, jobId, 'requires_review');
            }

            return res.json({
                success: true,
                mode: 'review',
                message: 'This request has spend activity, so Movabi support will review and hand it off safely.'
            });
        }

        const { error } = await supabaseAdmin
            .from('jobs')
            .update({
                status: 'searching',
                driver_id: null,
                accepted_driver_id: null,
                accepted_at: null,
                dispatch_started_at: new Date().toISOString(),
                driver_search_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
                dispatch_attempts: Number(job.dispatch_attempts || 0) + 1,
                no_driver_reason: `Previous driver could not continue: ${reasonText}`,
                metadata: nextMetadata,
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId);

        if (error) throw error;

        await logJobEvent(jobId, 'driver_handoff_requeued', actingDriverId, reasonText, {
            previous_status: job.status,
            has_protected_spend: false
        });

        if (job.customer_id) {
            await NotificationService.notifyJobStatusUpdate(job.customer_id, jobId, 'searching');
        }

        return res.json({
            success: true,
            mode: 'requeued',
            message: 'The request has been returned to nearby drivers.'
        });
    } catch (error: any) {
        console.error('Driver unable handoff error:', error);
        return res.status(500).json({ error: error.message || 'Failed to hand off request' });
    }
});

router.post('/rate', async (req: Request, res: Response) => {
    try {
        const { jobId, customerId, score, comment } = req.body || {};
        const ratingScore = Number(score);

        if (!jobId || !customerId) {
            return res.status(400).json({ error: 'jobId and customerId required' });
        }

        if (!Number.isInteger(ratingScore) || ratingScore < 1 || ratingScore > 5) {
            return res.status(400).json({ error: 'score must be an integer between 1 and 5' });
        }

        const job = await getJob(jobId);

        if (job.customer_id !== customerId) {
            return res.status(403).json({ error: 'You can only rate your own completed booking' });
        }

        if (!['completed', 'settled'].includes(job.status)) {
            return res.status(400).json({ error: 'Only completed bookings can be rated' });
        }

        const basePayload = {
            customer_id: customerId,
            driver_id: job.driver_id || null,
            score: ratingScore,
            comment: String(comment || '').trim() || null
        };

        const saveRating = async (
            payload: Record<string, unknown>,
            keyColumn: 'job_id' | 'booking_id'
        ) => {
            const existing = await supabaseAdmin
                .from('ratings')
                .select('id')
                .eq(keyColumn, jobId)
                .eq('customer_id', customerId)
                .maybeSingle();

            if (existing.error && existing.error.code !== 'PGRST116') {
                return { data: null, error: existing.error };
            }

            if (existing.data?.id) {
                return await supabaseAdmin
                    .from('ratings')
                    .update(payload)
                    .eq('id', existing.data.id)
                    .select('*')
                    .single();
            }

            return await supabaseAdmin
                .from('ratings')
                .insert(payload)
                .select('*')
                .single();
        };

        let result = await saveRating({
            ...basePayload,
            job_id: jobId,
            booking_id: jobId
        }, 'job_id');

        if (result.error) {
            const message = String(result.error.message || '');

            if (result.error.code === '42703' && message.includes('booking_id')) {
                result = await saveRating({
                    ...basePayload,
                    job_id: jobId,
                }, 'job_id');
            } else if (result.error.code === '42703' && message.includes('job_id')) {
                result = await saveRating({
                    ...basePayload,
                    booking_id: jobId,
                }, 'booking_id');
            }
        }

        if (result.error) {
            console.error('[BookingRoutes] rate failed:', result.error);
            return res.status(400).json({
                error: result.error.message,
                code: result.error.code,
                details: result.error.details,
                hint: result.error.hint
            });
        }

        const driverRating = await refreshDriverRating(job.driver_id);

        return res.json({ success: true, rating: result.data, driverRating });
    } catch (error: any) {
        console.error('Rate booking error:', error);
        return res.status(500).json({ error: error.message || 'Failed to rate booking' });
    }
});

/**
 * Record that a driver has declined/passed on a job.
 * Dispatch will not re-notify the same driver for the same job.
 */
router.post('/decline-job', async (req: Request, res: Response) => {
    try {
        // Batch 2C Phase B.1: unauthenticated, and the declined driver id came
        // from the body, so anyone could suppress offers for any driver.
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const { driverId, jobId, reason } = req.body;

        if (!jobId) {
            return res.status(400).json({ error: 'jobId is required' });
        }
        if (driverId && String(driverId) !== userId) {
            return res.status(403).json({ error: 'You can only decline a job for yourself.', code: 'DRIVER_IDENTITY_MISMATCH' });
        }

        const { error: insertError } = await supabaseAdmin
            .from('driver_job_declines')
            .upsert({
                driver_id: userId,
                job_id: jobId,
                reason: reason || 'driver_declined',
                created_at: new Date().toISOString()
            }, { onConflict: 'driver_id,job_id' });

        if (insertError) {
            console.error('[BookingRoutes] decline-job failed:', insertError);
            return res.status(500).json({ error: insertError.message || 'Failed to record decline' });
        }

        return res.json({ success: true, declined: true });
    } catch (error: any) {
        console.error('[BookingRoutes] decline-job error:', error);
        return res.status(500).json({ error: error.message || 'Failed to decline job' });
    }
});

/**
 * Send a customer push notification for a job status change.
 * The job status itself is saved by the caller; this endpoint only triggers
 * the push via the existing notification service so it works when the app is
 * in the background.
 */
const NOTIFIABLE_JOB_STATUSES = new Set([
    'searching', 'requested', 'pending', 'pending_fare_confirmation', 'negotiating',
    'assigned', 'accepted', 'driver_arrived', 'arrived', 'in_progress', 'started',
    'picked_up', 'collected', 'delivered', 'completed', 'cancelled', 'requires_review',
    'no_driver_found', 'expired'
]);

router.post('/notify-status', async (req: Request, res: Response) => {
    try {
        // Batch 2C Phase B.1: unauthenticated, so anyone could push an arbitrary
        // status string to any job's customer.
        const userId = await requireAuthenticatedUser(req, res);
        if (!userId) return;
        const { jobId, status } = req.body;

        if (!jobId || !status) {
            return res.status(400).json({ error: 'jobId and status are required' });
        }
        // Only canonical statuses may be announced: no free text may reach a push.
        if (!NOTIFIABLE_JOB_STATUSES.has(normalise(status))) {
            return res.status(400).json({ error: 'Unknown job status.', code: 'UNKNOWN_JOB_STATUS' });
        }

        const { data: job, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select('customer_id,driver_id,accepted_driver_id')
            .eq('id', jobId)
            .single();

        if (jobError || !job?.customer_id) {
            console.warn('[BookingRoutes] notify-status: job or customer not found', jobError);
            return res.status(404).json({ error: 'Job or customer not found' });
        }

        if (!isJobParticipant(job, userId) && !(await isAdminUser(userId))) {
            return res.status(403).json({ error: 'You are not a participant in this booking.', code: 'NOT_A_PARTICIPANT' });
        }

        await NotificationService.notifyJobStatusUpdate(job.customer_id, jobId, status);

        return res.json({ success: true, notified: true });
    } catch (error: any) {
        console.error('[BookingRoutes] notify-status error:', error);
        return res.status(500).json({ error: error.message || 'Failed to send status notification' });
    }
});

/**
 * Create a fare negotiation for a job.
 */
router.post('/negotiation', async (req: Request, res: Response) => {
    try {
        const { jobId, amount, message, proposedByRole, counterToNegotiationId } = req.body;

        if (!jobId || !amount || isNaN(Number(amount))) {
            return res.status(400).json({ error: 'jobId and amount are required' });
        }

        const userId = await getAuthUserId(req);
        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const role = String(proposedByRole || 'customer');
        if (!['customer', 'driver'].includes(role)) {
            return res.status(400).json({ error: 'proposedByRole must be customer or driver' });
        }

        const { data: job, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select('customer_id, driver_id, status')
            .eq('id', jobId)
            .single();

        if (jobError || !job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const isParticipant =
            (role === 'customer' && job.customer_id === userId) ||
            (role === 'driver' && job.driver_id === userId);

        if (!isParticipant) {
            return res.status(403).json({ error: 'Only the customer or assigned driver can negotiate' });
        }

        const round = counterToNegotiationId ? 2 : 1;

        const { data: negotiation, error: insertError } = await supabaseAdmin
            .from('fare_negotiations')
            .insert({
                job_id: jobId,
                proposed_by: userId,
                proposed_by_role: role,
                amount: Number(amount),
                message: message || null,
                counter_to_negotiation_id: counterToNegotiationId || null,
                round_number: round,
                status: 'pending'
            })
            .select('*')
            .single();

        if (insertError) {
            console.error('[BookingRoutes] negotiation create failed:', insertError);
            return res.status(500).json({ error: insertError.message || 'Failed to create negotiation' });
        }

        await supabaseAdmin
            .from('jobs')
            .update({
                status: role === 'customer' ? 'negotiating' : 'pending_fare_confirmation',
                negotiated_fare: Number(amount),
                negotiation_deadline: new Date(Date.now() + 120000).toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId);

        return res.json({ success: true, negotiation });
    } catch (error: any) {
        console.error('[BookingRoutes] negotiation create error:', error);
        return res.status(500).json({ error: error.message || 'Failed to create negotiation' });
    }
});

/**
 * Accept a fare negotiation and lock the agreed fare.
 */
/**
 * Customer accepts a driver's fare offer (legacy negotiation accept).
 *
 * Batch 2C Phase B.1: this handler used to perform a bare `.update({status,
 * agreed_fare, driver_id})` with no status predicate, no ownership predicate, no
 * row lock and no transaction, so a customer participant could force
 * `fare_agreed` with `driver_id = NULL`, could reassign the job from driver A to
 * driver B, and was told `{ success: true }` either way.
 *
 * It is now a thin trusted wrapper around the atomic
 * `public.accept_driver_offer(uuid, uuid)`:
 *   * the server authorises the CALLER as a job participant,
 *   * the DRIVER is derived server-side from the negotiation row (never from the
 *     request body), so a NULL driver can no longer be written,
 *   * the RPC locks the job, validates the negotiation status and the ownership
 *     transition, refuses A -> B, and raises unless the row actually moved.
 * Post-commit pricing is secondary work: it can never turn a committed
 * acceptance into a reported failure.
 */
router.post('/negotiation/:id/accept', async (req: Request, res: Response) => {
    try {
        const negotiationId = req.params.id;
        const userId = await getAuthUserId(req);

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required', code: 'AUTHENTICATION_REQUIRED' });
        }

        const { data: negotiation, error: fetchError } = await supabaseAdmin
            .from('fare_negotiations')
            .select('*, job:jobs(id, customer_id, driver_id)')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found' });
        }

        const job = (negotiation as any).job;
        const isParticipant = job?.customer_id === userId || job?.driver_id === userId;
        if (!isParticipant) {
            return res.status(403).json({ error: 'Only participants can accept this negotiation', code: 'NOT_A_PARTICIPANT' });
        }

        const { data: fullJob, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select('*')
            .eq('id', negotiation.job_id)
            .single();

        if (jobError || !fullJob) {
            return res.status(404).json({ error: 'Job not found' });
        }
        const fullMetadata = fullJob.metadata && typeof fullJob.metadata === 'object' ? fullJob.metadata : {};
        await MarketAvailabilityService.requireCapability({ countryCode: fullJob.country_code || fullMetadata.country_code,
            marketCity: fullJob.market_city || fullMetadata.market_city || fullMetadata.pickup_city, zoneId: fullJob.zone_id || fullMetadata.zone_id,
            capability: 'booking', endpoint: '/api/booking/negotiation/accept' });

        // The accepted driver is derived SERVER-SIDE from the negotiation row.
        // A customer cannot accept an offer into a job with no driver.
        const acceptedDriverId = (negotiation as any).proposed_by_role === 'driver'
            ? String((negotiation as any).proposed_by || '')
            : String(fullJob.driver_id || '');

        if (!acceptedDriverId) {
            return res.status(409).json({
                error: 'There is no driver offer to accept for this job.',
                code: 'NO_DRIVER_OFFER_TO_ACCEPT'
            });
        }

        const { data: accepted, error: acceptError } = await supabaseAdmin.rpc('accept_driver_offer', {
            p_job_id: negotiation.job_id,
            p_driver_id: acceptedDriverId
        });

        if (acceptError) {
            const acquisitionFailure = mapDriverAcquisitionError(acceptError);
            if (acquisitionFailure) {
                return res.status(acquisitionFailure.status).json({
                    error: acquisitionFailure.error,
                    code: acquisitionFailure.code,
                    ...(acquisitionFailure.blocking ? { blocking: acquisitionFailure.blocking } : {})
                });
            }

            const sqlState = String(acceptError.code || '');
            if (sqlState === '23505') {
                return res.status(409).json({ error: 'This job is already owned by another driver.', code: 'JOB_ALREADY_OWNED' });
            }
            if (sqlState === '23514') {
                return res.status(409).json({ error: 'This offer is no longer available.', code: 'OFFER_NO_LONGER_AVAILABLE' });
            }
            if (sqlState === 'P0002') {
                return res.status(404).json({ error: 'No pending driver offer found', code: 'OFFER_NOT_FOUND' });
            }
            if (sqlState === '22023') {
                return res.status(400).json({ error: 'Offer amount is not valid', code: 'INVALID_OFFER_AMOUNT' });
            }
            if (sqlState === '42501') {
                return res.status(403).json({ error: 'You cannot accept this offer.', code: 'NOT_ALLOWED' });
            }

            console.error('[BookingRoutes] negotiation accept RPC failed:', acceptError);
            return res.status(500).json({ error: 'Failed to accept negotiation' });
        }

        // ------------------------------------------------------------------
        // OWNERSHIP IS COMMITTED AT THIS POINT. Everything below is SECONDARY:
        // a pricing or notification problem must never report the committed
        // acceptance as failed, and must never write ownership again.
        // ------------------------------------------------------------------
        const agreedFare = Number((accepted as any)?.agreed_fare ?? negotiation.amount);
        let pricingPending = false;
        try {
            const fareUpdate = PricingService.applyAgreedFare(fullJob, agreedFare);
            const { error: pricingError } = await supabaseAdmin
                .from('jobs')
                .update({ ...fareUpdate, updated_at: new Date().toISOString() })
                .eq('id', negotiation.job_id)
                .eq('driver_id', acceptedDriverId)
                .eq('status', 'fare_agreed');

            if (pricingError) {
                pricingPending = true;
                console.error('[BookingRoutes] negotiation accept pricing refresh failed (ownership already committed):', pricingError);
            }
        } catch (pricingException) {
            pricingPending = true;
            console.error('[BookingRoutes] negotiation accept pricing refresh threw (ownership already committed):', pricingException);
        }

        return res.json({
            success: true,
            ownershipCommitted: true,
            pricingPending,
            negotiation: { ...negotiation, status: 'accepted' }
        });
    } catch (error: any) {
        console.error('[BookingRoutes] negotiation accept error:', error);
        if (error instanceof MarketAvailabilityError) return res.status(error.httpStatus).json({ error: error.message, code: error.code, market: error.market });
        return res.status(500).json({ error: error.message || 'Failed to accept negotiation' });
    }
});

/**
 * Driver accepts the customer's current offer for a job.
 * Finds the latest pending customer negotiation, accepts it, assigns the
 * driver, and locks the agreed fare.
 */
router.post('/negotiation/:jobId/driver-accept', async (req: Request, res: Response) => {
    try {
        const jobId = req.params.jobId;
        const userId = await getAuthUserId(req);

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const { data: job, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select('*')
            .eq('id', jobId)
            .single();

        if (jobError || !job) {
            return res.status(404).json({ error: 'Job not found' });
        }
        const jobMetadata = job.metadata && typeof job.metadata === 'object' ? job.metadata : {};
        await MarketAvailabilityService.requireCapability({ countryCode: job.country_code || jobMetadata.country_code,
            marketCity: job.market_city || jobMetadata.market_city || jobMetadata.pickup_city, zoneId: job.zone_id || jobMetadata.zone_id,
            capability: 'booking', endpoint: '/api/booking/negotiation/driver-accept' });

        if (!job.negotiation_mode_enabled) {
            return res.status(400).json({ error: 'Job is not in negotiation mode' });
        }

        // ------------------------------------------------------------------
        // ATOMIC acceptance (N35).
        //
        // The previous implementation performed SELECT -> UPDATE
        // fare_negotiations -> UPDATE jobs with no transaction, no row lock and
        // no conditional predicate, so two concurrent drivers could both mark
        // the offer accepted and both overwrite jobs.driver_id while both
        // received { success: true }.
        //
        // accept_fare_negotiation now owns the whole ownership decision in one
        // transaction: it locks the job row FOR UPDATE (serialising racers),
        // locks the newest pending customer offer FOR UPDATE, guards on job
        // status and existing ownership, then writes both tables. Exactly one
        // caller can commit.
        //
        // Driver identity is the server-derived authenticated user. The request
        // body can never influence it.
        // ------------------------------------------------------------------
        const { data: acceptResult, error: acceptError } = await supabaseAdmin.rpc('accept_fare_negotiation', {
            p_job_id: jobId,
            p_driver_id: userId
        });

        if (acceptError) {
            // Map the RPC's deterministic SQLSTATEs without leaking SQL internals.
            const sqlState = String(acceptError.code || '');

            // Batch 2C Phase B — the acquisition error contract. COMPLIANCE (MB002)
            // is checked BEFORE busy (MB001): a driver who is both ineligible and
            // busy must be told the actionable compliance reason, matching the
            // precedence the acquisition RPCs themselves use.
            const acquisitionFailure = mapDriverAcquisitionError(acceptError);
            if (acquisitionFailure) {
                return res.status(acquisitionFailure.status).json({
                    error: acquisitionFailure.error,
                    code: acquisitionFailure.code,
                    ...(acquisitionFailure.blocking ? { blocking: acquisitionFailure.blocking } : {})
                });
            }

            if (sqlState === '23505') {
                // Lost race: a different driver already owns this job.
                return res.status(409).json({
                    error: 'This offer has already been accepted by another driver.',
                    code: 'OFFER_ALREADY_ACCEPTED'
                });
            }

            if (sqlState === '23514') {
                // Stale state: job moved on, or the offer stopped being pending.
                return res.status(409).json({
                    error: 'This offer is no longer available.',
                    code: 'OFFER_NO_LONGER_AVAILABLE'
                });
            }

            if (sqlState === 'P0002') {
                // Job or pending customer offer not found.
                return res.status(404).json({ error: 'No pending customer offer found' });
            }

            if (sqlState === '22023') {
                return res.status(400).json({ error: acceptError.message || 'Offer cannot be accepted' });
            }

            console.error('[BookingRoutes] driver-accept RPC failed:', acceptError);
            return res.status(500).json({ error: 'Failed to accept offer' });
        }

        // The RPC returns the negotiation row and the agreed fare. Ownership and
        // status are ALREADY COMMITTED at this point.
        const result = (acceptResult || {}) as {
            agreed_fare?: number | string;
            negotiation?: Record<string, unknown>;
        };

        const agreedFare = Number(result.agreed_fare ?? 0);

        // Batch 2C Phase B.1 — this used to be a hard 500.
        //
        // Ownership has already moved inside the RPC's transaction, so reporting
        // a failure here told the driver their acceptance had failed when it had
        // in fact succeeded. That is worse than the pricing gap it was guarding:
        // the driver retries, the retry is correctly refused as already-owned,
        // and the job is left in a state the driver believes they do not own.
        //
        // An unusable negotiated amount is therefore classified as SECONDARY
        // work: the response reports the committed ownership accurately, flags
        // that the derived pricing still needs to be completed, and never claims
        // the acceptance failed. The raw amount is never used to write pricing.
        const pricingPending = !Number.isFinite(agreedFare) || agreedFare <= 0;
        if (pricingPending) {
            console.error('[BookingRoutes] driver-accept committed ownership but returned no usable agreed fare; pricing deferred:', acceptResult);
        }

        const negotiation = result.negotiation || {
            job_id: jobId,
            amount: Number.isFinite(agreedFare) ? agreedFare : null,
            proposed_by_role: 'customer',
            status: 'accepted'
        };

        // ------------------------------------------------------------------
        // Derived pricing only. applyAgreedFare is the single source of truth for
        // the scaled fare breakdown and is intentionally NOT duplicated in SQL.
        //
        // The write is ownership-guarded so it can never undo the RPC: it only
        // matches when THIS driver owns the job and it is still fare_agreed. If
        // the guard matches nothing the atomic claim already succeeded, so the
        // pricing refresh is reported diagnostically rather than failing the
        // acceptance the driver has legitimately won.
        // ------------------------------------------------------------------
        let derivedPricingPending = pricingPending;
        try {
            if (pricingPending) {
                // No usable amount: skip the derived write entirely rather than
                // persisting a fabricated fare. Ownership stays committed.
                throw new Error('negotiated amount unavailable; derived pricing deferred');
            }
            const fareUpdate = PricingService.applyAgreedFare(job, agreedFare);

            const { error: pricingError } = await supabaseAdmin
                .from('jobs')
                .update({ ...fareUpdate, updated_at: new Date().toISOString() })
                .eq('id', jobId)
                .eq('driver_id', userId)
                .eq('status', 'fare_agreed');

            if (pricingError) {
                derivedPricingPending = true;
                console.error('[BookingRoutes] driver-accept pricing refresh failed (ownership already committed):', pricingError);
            }
        } catch (pricingException) {
            // Never convert a committed win into a client-visible failure.
            derivedPricingPending = true;
            console.error('[BookingRoutes] driver-accept pricing refresh threw (ownership already committed):', pricingException);
        }

        // Notify only after the atomic acquisition succeeded. The winner notifies;
        // a loser returned above and never reaches this line.
        try {
            await NotificationService.notifyJobStatusUpdate(String(job.customer_id), String(jobId), 'accepted');
        } catch (notifyError) {
            // Secondary work: a push failure must not repaint a committed win.
            console.error('[BookingRoutes] driver-accept notify failed (ownership already committed):', notifyError);
        }

        return res.json({
            success: true,
            ownershipCommitted: true,
            pricingPending: derivedPricingPending,
            negotiation: { ...negotiation, status: 'accepted' }
        });
    } catch (error: any) {
        console.error('[BookingRoutes] driver-accept negotiation error:', error);
        if (error instanceof MarketAvailabilityError) return res.status(error.httpStatus).json({ error: error.message, code: error.code, market: error.market });
        return res.status(500).json({ error: error.message || 'Failed to accept offer' });
    }
});

/**
 * Driver counters the customer's current offer with a new amount.
 */
router.post('/negotiation/:jobId/driver-counter', async (req: Request, res: Response) => {
    try {
        const jobId = req.params.jobId;
        const { amount, message } = req.body;
        const userId = await getAuthUserId(req);

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (!amount || isNaN(Number(amount))) {
            return res.status(400).json({ error: 'amount is required' });
        }

        const { data: job, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select('id, customer_id, status, negotiation_mode_enabled')
            .eq('id', jobId)
            .single();

        if (jobError || !job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        if (!job.negotiation_mode_enabled) {
            return res.status(400).json({ error: 'Job is not in negotiation mode' });
        }

        const { data: negotiations, error: fetchError } = await supabaseAdmin
            .from('fare_negotiations')
            .select('*')
            .eq('job_id', jobId)
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(1);

        if (fetchError) throw fetchError;

        const latestNegotiation = negotiations?.[0];

        const { data: counter, error: insertError } = await supabaseAdmin
            .from('fare_negotiations')
            .insert({
                job_id: jobId,
                proposed_by: userId,
                proposed_by_role: 'driver',
                amount: Number(amount),
                message: message || null,
                counter_to_negotiation_id: latestNegotiation?.id || null,
                round_number: (latestNegotiation?.round_number || 1) + 1,
                status: 'pending'
            })
            .select('*')
            .single();

        if (insertError) {
            console.error('[BookingRoutes] driver counter failed:', insertError);
            return res.status(500).json({ error: insertError.message || 'Failed to counter offer' });
        }

        if (latestNegotiation) {
            await supabaseAdmin
                .from('fare_negotiations')
                .update({ status: 'countered', updated_at: new Date().toISOString() })
                .eq('id', latestNegotiation.id);
        }

        await supabaseAdmin
            .from('jobs')
            .update({
                status: 'pending_fare_confirmation',
                negotiated_fare: Number(amount),
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId);

        // Notify customer about the counter offer
        await NotificationService.notifyNegotiationCounter(String(job.customer_id), String(jobId), Number(amount));

        return res.json({ success: true, negotiation: counter });
    } catch (error: any) {
        console.error('[BookingRoutes] driver counter error:', error);
        return res.status(500).json({ error: error.message || 'Failed to counter offer' });
    }
});

/**
 * Customer submits a new offer for a job in negotiation mode.
 */
router.post('/negotiation/:jobId/customer-offer', async (req: Request, res: Response) => {
    try {
        console.log('[BookingRoutes] customer-offer route hit', req.params.jobId);
        const jobId = req.params.jobId;
        const { amount, message } = req.body;
        const userId = await getAuthUserId(req);

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (!amount || isNaN(Number(amount))) {
            return res.status(400).json({ error: 'amount is required' });
        }

        const { data: job, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select('id, customer_id, status, negotiation_mode_enabled, tenant_id, city_id, pickup_lat, pickup_lng, service_slug, driver_id')
            .eq('id', jobId)
            .single();

        console.log('[BookingRoutes] customer-offer auth/job', {
            authUserId: userId,
            jobId,
            jobCustomerId: job?.customer_id,
            serviceClient: 'supabaseAdmin',
            queryError: null
        });

        if (jobError || !job) {
            console.warn('[BookingRoutes] customer-offer job fetch failed', {
                authUserId: userId,
                jobId,
                serviceClient: 'supabaseAdmin',
                queryError: jobError
            });
            return res.status(404).json({ error: 'Job not found' });
        }

        if (job.customer_id !== userId) {
            return res.status(403).json({ error: 'Only the customer can make an offer for this job' });
        }

        if (!job.negotiation_mode_enabled) {
            return res.status(400).json({ error: 'Job is not in negotiation mode' });
        }

        const status = String(job.status || '').toLowerCase();
        if (!['pending_fare_confirmation', 'negotiating'].includes(status)) {
            return res.status(400).json({ error: 'Job is not open for negotiation' });
        }

        const { data: negotiations, error: fetchError } = await supabaseAdmin
            .from('fare_negotiations')
            .select('*')
            .eq('job_id', jobId)
            .order('created_at', { ascending: false })
            .limit(1);

        if (fetchError) throw fetchError;

        const latestNegotiation = negotiations?.[0];

        const { data: negotiation, error: insertError } = await supabaseAdmin
            .from('fare_negotiations')
            .insert({
                job_id: jobId,
                proposed_by: userId,
                proposed_by_role: 'customer',
                amount: Number(amount),
                message: message || null,
                counter_to_negotiation_id: latestNegotiation?.id || null,
                round_number: (latestNegotiation?.round_number || 1) + 1,
                status: 'pending'
            })
            .select('*')
            .single();

        if (insertError) {
            console.error('[BookingRoutes] customer offer failed:', insertError);
            return res.status(500).json({ error: insertError.message || 'Failed to create offer' });
        }

        if (latestNegotiation?.status === 'pending') {
            await supabaseAdmin
                .from('fare_negotiations')
                .update({ status: 'countered', updated_at: new Date().toISOString() })
                .eq('id', latestNegotiation.id);
        }

        await supabaseAdmin
            .from('jobs')
            .update({
                status: 'negotiating',
                negotiated_fare: Number(amount),
                negotiation_deadline: new Date(Date.now() + 120000).toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId);

        // Alert nearby drivers so they can see the updated offer
        try {
            await new DispatchService().notifyNearbyDrivers({
                ...job,
                status: 'negotiating',
                negotiated_fare: Number(amount),
                negotiation_deadline: new Date(Date.now() + 120000).toISOString()
            } as any, job.tenant_id, job.city_id);
        } catch (notifyError) {
            console.warn('[BookingRoutes] customer offer driver notification failed:', notifyError);
        }

        return res.json({ success: true, negotiation });
    } catch (error: any) {
        console.error('[BookingRoutes] customer offer error:', error);
        return res.status(500).json({ error: error.message || 'Failed to create offer' });
    }
});

/**
 * Send a push notification for a hybrid marketplace event.
 * Used by the frontend hybrid service because some RPC flows run directly
 * against Supabase and cannot trigger server-side dispatch.
 */
router.post('/notify-hybrid', async (req: Request, res: Response) => {
    try {
        const userId = await getAuthUserId(req);
        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const { action, jobId, recipientUserId, title, body, type = 'booking_update', data } = req.body;

        if (!jobId) {
            return res.status(400).json({ error: 'jobId is required' });
        }

        if (action === 'notify_drivers') {
            const { data: job, error: jobError } = await supabaseAdmin
                .from('jobs')
                .select('*, service_type:service_types(*)')
                .eq('id', jobId)
                .single();

            if (jobError || !job) {
                return res.status(404).json({ error: 'Job not found' });
            }

            try {
                await new DispatchService().notifyNearbyDrivers(job, job.tenant_id, job.city_id);
            } catch (notifyError) {
                console.warn('[BookingRoutes] notify-hybrid driver dispatch failed:', notifyError);
            }

            return res.json({ success: true });
        }

        if (!recipientUserId || !title || !body) {
            return res.status(400).json({ error: 'recipientUserId, title and body are required' });
        }

        await NotificationService.sendNotification({
            userId: recipientUserId,
            title,
            body,
            type,
            data: { jobId, ...data }
        });

        return res.json({ success: true });
    } catch (error: any) {
        console.error('[BookingRoutes] notify-hybrid error:', error);
        return res.status(500).json({ error: error.message || 'Failed to send notification' });
    }
});

/**
 * Counter a fare negotiation with a new offer.
 */
router.post('/negotiation/:id/counter', async (req: Request, res: Response) => {
    try {
        const negotiationId = req.params.id;
        const { amount, message } = req.body;
        const userId = await getAuthUserId(req);

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (!amount || isNaN(Number(amount))) {
            return res.status(400).json({ error: 'amount is required' });
        }

        const { data: negotiation, error: fetchError } = await supabaseAdmin
            .from('fare_negotiations')
            .select('*, job:jobs(id, customer_id, driver_id)')
            .eq('id', negotiationId)
            .single();

        if (fetchError || !negotiation) {
            return res.status(404).json({ error: 'Negotiation not found' });
        }

        const job = (negotiation as any).job;
        const isParticipant = job.customer_id === userId || job.driver_id === userId;
        if (!isParticipant) {
            return res.status(403).json({ error: 'Only participants can counter this negotiation' });
        }

        const counterRole = job.customer_id === userId ? 'customer' : 'driver';

        const { data: counter, error: insertError } = await supabaseAdmin
            .from('fare_negotiations')
            .insert({
                job_id: negotiation.job_id,
                proposed_by: userId,
                proposed_by_role: counterRole,
                amount: Number(amount),
                message: message || null,
                counter_to_negotiation_id: negotiationId,
                round_number: (negotiation.round_number || 1) + 1,
                status: 'pending'
            })
            .select('*')
            .single();

        if (insertError) {
            console.error('[BookingRoutes] negotiation counter failed:', insertError);
            return res.status(500).json({ error: insertError.message || 'Failed to counter negotiation' });
        }

        await supabaseAdmin
            .from('fare_negotiations')
            .update({ status: 'countered', updated_at: new Date().toISOString() })
            .eq('id', negotiationId);

        await supabaseAdmin
            .from('jobs')
            .update({
                status: 'negotiating',
                negotiated_fare: Number(amount),
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiation.job_id);

        return res.json({ success: true, negotiation: counter });
    } catch (error: any) {
        console.error('[BookingRoutes] negotiation counter error:', error);
        return res.status(500).json({ error: error.message || 'Failed to counter negotiation' });
    }
});

export default router;
