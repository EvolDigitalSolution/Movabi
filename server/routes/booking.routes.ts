import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { FraudService } from '../services/fraud.service';
import { NotificationService } from '../services/notification.service';
import { LogisticsService } from '../services/logistics.service';
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

function requiredVehicleClass(job: any): 'bike' | 'standard' | 'xl' | 'car' | 'van' {
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
    if (raw.includes('van')) return 'van';
    if (raw.includes('xl') || raw.includes('7')) return 'xl';
    if (raw.includes('standard')) return 'standard';
    if (raw.includes('car')) return 'car';
    if (serviceSlug.includes('van') || serviceSlug.includes('moving')) return 'van';
    if (serviceSlug.includes('delivery') || serviceSlug.includes('errand')) return 'car';
    return 'standard';
}

function driverCapabilities(vehicle: any): string[] {
    if (!vehicle) return [];

    const combined = normalise(`${vehicle.type || ''} ${vehicle.capacity || ''} ${vehicle.service_class || ''}`);

    if (combined.includes('bike') || combined.includes('motorcycle') || combined.includes('scooter')) return ['bike'];
    if (combined.includes('van')) return ['standard', 'xl', 'car', 'van'];
    if (combined.includes('xl') || combined.includes('7')) return ['standard', 'xl', 'car'];
    return ['standard', 'car'];
}

function vehicleLabel(value: string): string {
    switch (value) {
        case 'bike':
            return 'Bike';
        case 'xl':
            return 'XL car';
        case 'van':
            return 'Van';
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
            return res.status(400).json({
                error: 'Failed to cancel job. It may have already been completed or cancelled.'
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

        if (job.status !== 'completed') {
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

        return res.json({ success: true, rating: result.data });
    } catch (error: any) {
        console.error('Rate booking error:', error);
        return res.status(500).json({ error: error.message || 'Failed to rate booking' });
    }
});

export default router;
