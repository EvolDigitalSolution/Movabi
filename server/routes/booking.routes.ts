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

export default router;