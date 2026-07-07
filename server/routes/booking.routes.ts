import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { FraudService } from '../services/fraud.service';
import { NotificationService } from '../services/notification.service';
import { LogisticsService } from '../services/logistics.service';
import { IssuingService } from '../services/issuing.service';
import { PricingService } from '../services/pricing.service';
import { stripe } from '../services/stripe.service';

const router = Router();

const capturedStatuses = ['paid', 'captured', 'succeeded'];
const cancellableStripeStatuses = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture'];

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
 */
router.post('/accept', async (req: Request, res: Response) => {
    try {
        const { jobId, driverId } = req.body;

        if (!jobId || !driverId) {
            return res.status(400).json({ error: 'jobId and driverId required' });
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

        if (!LogisticsService.isValidBookingTransition(job.status, 'assigned')) {
            return res.status(400).json({
                error: `Invalid transition from ${job.status} to assigned`
            });
        }

        const { data: assigned, error: rpcError } = await supabaseAdmin.rpc('assign_driver_to_job', {
            p_job_id: jobId,
            p_driver_id: driverId
        });

        if (rpcError || !assigned) {
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
        const { jobId, driverId } = req.body;

        if (!jobId) {
            return res.status(400).json({ error: 'jobId required' });
        }

        const job = await getJob(jobId);

        if (driverId && job.driver_id && job.driver_id !== driverId) {
            return res.status(403).json({ error: 'This driver is not assigned to the job' });
        }

        if (!LogisticsService.isValidBookingTransition(job.status, 'completed')) {
            return res.status(400).json({
                error: `Invalid transition from ${job.status} to completed`
            });
        }

        const { error: completeError } = await supabaseAdmin
            .from('jobs')
            .update({
                status: 'completed',
                payment_status: job.payment_method === 'card' ? 'capture_pending' : 'paid'
            })
            .eq('id', jobId);

        if (completeError) {
            throw completeError;
        }

        try {
            await captureJobPaymentOnlyWhenCompleted(jobId);
        } catch (captureError: any) {
            console.error('Stripe capture on completion failed:', captureError);

            await supabaseAdmin
                .from('jobs')
                .update({ payment_status: 'requires_review' })
                .eq('id', jobId);

            return res.status(402).json({
                error: captureError?.message || 'Payment capture failed. Job marked for review.'
            });
        }

        if (job.customer_id) {
            await NotificationService.notifyJobStatusUpdate(job.customer_id, jobId, 'completed');
        }

        if (job.driver_id) {
            await NotificationService.notifyJobStatusUpdate(job.driver_id, jobId, 'completed');
        }

        return res.json({
            success: true,
            message: 'Job completed and payment captured.'
        });
    } catch (error: any) {
        console.error('Complete job error:', error);
        return res.status(500).json({ error: error.message || 'Failed to complete job' });
    }
});

/**
 * Cancel booking.
 * If payment has not been captured, cancel the authorization.
 * If driver was assigned and cancellation fee exists, capture only that fee.
 */
router.post('/cancel', async (req: Request, res: Response) => {
    try {
        const { jobId, reason } = req.body;

        if (!jobId) {
            return res.status(400).json({ error: 'jobId required' });
        }

        const job = await getJob(jobId);

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
        const { jobId, driverId, reason } = req.body || {};

        if (!jobId || !driverId) {
            return res.status(400).json({ error: 'jobId and driverId required' });
        }

        const job = await getJob(jobId);

        if (job.driver_id !== driverId) {
            return res.status(403).json({ error: 'This driver is not assigned to the job' });
        }

        if (['completed', 'settled', 'cancelled'].includes(normalise(job.status))) {
            return res.status(400).json({ error: `Cannot hand off a job in status: ${job.status}` });
        }

        const reasonText = String(reason || 'Driver cannot continue').trim().slice(0, 500);
        const hasSpend = await hasProtectedErrandSpend(jobId);
        const metadata = parseMetadata(job.metadata);
        const handoffHistory = Array.isArray(metadata.driver_handoff_history)
            ? metadata.driver_handoff_history
            : [];
        const handoffEntry = {
            driver_id: driverId,
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
            await IssuingService.freezeDriverCard(driverId, `Driver handoff: ${reasonText}`);
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

            await logJobEvent(jobId, 'driver_handoff_review_required', driverId, reasonText, {
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

        await logJobEvent(jobId, 'driver_handoff_requeued', driverId, reasonText, {
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
        const { driverId, jobId, reason } = req.body;

        if (!driverId || !jobId) {
            return res.status(400).json({ error: 'driverId and jobId are required' });
        }

        const { error: insertError } = await supabaseAdmin
            .from('driver_job_declines')
            .upsert({
                driver_id: driverId,
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
router.post('/notify-status', async (req: Request, res: Response) => {
    try {
        const { jobId, status } = req.body;

        if (!jobId || !status) {
            return res.status(400).json({ error: 'jobId and status are required' });
        }

        const { data: job, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select('customer_id')
            .eq('id', jobId)
            .single();

        if (jobError || !job?.customer_id) {
            console.warn('[BookingRoutes] notify-status: job or customer not found', jobError);
            return res.status(404).json({ error: 'Job or customer not found' });
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

        const userId = (req as any).user?.id || (req as any).auth?.user?.id;
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
router.post('/negotiation/:id/accept', async (req: Request, res: Response) => {
    try {
        const negotiationId = req.params.id;
        const userId = (req as any).user?.id || (req as any).auth?.user?.id;

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
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
            return res.status(403).json({ error: 'Only participants can accept this negotiation' });
        }

        const { error: updateError } = await supabaseAdmin
            .from('fare_negotiations')
            .update({ status: 'accepted', updated_at: new Date().toISOString() })
            .eq('id', negotiationId);

        if (updateError) throw updateError;

        const { data: fullJob, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select('*')
            .eq('id', negotiation.job_id)
            .single();

        if (jobError || !fullJob) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const agreedFare = Number(negotiation.amount);
        const fareUpdate = PricingService.applyAgreedFare(fullJob, agreedFare);

        await supabaseAdmin
            .from('jobs')
            .update({
                status: 'fare_agreed',
                agreed_fare: agreedFare,
                ...fareUpdate,
                updated_at: new Date().toISOString()
            })
            .eq('id', negotiation.job_id);

        return res.json({ success: true, negotiation: { ...negotiation, status: 'accepted' } });
    } catch (error: any) {
        console.error('[BookingRoutes] negotiation accept error:', error);
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
        const userId = (req as any).user?.id || (req as any).auth?.user?.id;

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
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
            .eq('proposed_by_role', 'customer')
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(1);

        if (fetchError) throw fetchError;

        const negotiation = negotiations?.[0];
        if (!negotiation) {
            return res.status(404).json({ error: 'No pending customer offer found' });
        }

        await supabaseAdmin
            .from('fare_negotiations')
            .update({ status: 'accepted', updated_at: new Date().toISOString() })
            .eq('id', negotiation.id);

        const agreedFare = Number(negotiation.amount);
        const fareUpdate = PricingService.applyAgreedFare(job, agreedFare);

        await supabaseAdmin
            .from('jobs')
            .update({
                status: 'fare_agreed',
                driver_id: userId,
                agreed_fare: agreedFare,
                ...fareUpdate,
                updated_at: new Date().toISOString()
            })
            .eq('id', jobId);

        // Notify customer that driver accepted the offer
        await NotificationService.notifyJobStatusUpdate(String(job.customer_id), String(jobId), 'accepted');

        return res.json({ success: true, negotiation: { ...negotiation, status: 'accepted' } });
    } catch (error: any) {
        console.error('[BookingRoutes] driver-accept negotiation error:', error);
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
        const userId = (req as any).user?.id || (req as any).auth?.user?.id;

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
 * Counter a fare negotiation with a new offer.
 */
router.post('/negotiation/:id/counter', async (req: Request, res: Response) => {
    try {
        const negotiationId = req.params.id;
        const { amount, message } = req.body;
        const userId = (req as any).user?.id || (req as any).auth?.user?.id;

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
