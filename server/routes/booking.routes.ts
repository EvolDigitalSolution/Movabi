import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { FraudService } from '../services/fraud.service';
import { NotificationService } from '../services/notification.service';
import { LogisticsService } from '../services/logistics.service';
import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
});

const router = Router();

/**
 * Accept a job (Driver)
 * This captures the authorized payment
 */
router.post('/accept', async (req: Request, res: Response) => {
  try {
    const { jobId, driverId } = req.body;

    if (!jobId || !driverId) {
      return res.status(400).json({ error: 'jobId and driverId required' });
    }

    // 1. Get job details
    const { data: job, error: jobError } = await supabaseAdmin
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobError || !job) throw new Error('Job not found');

    // State Guard
    if (!LogisticsService.isValidBookingTransition(job.status, 'assigned')) {
      return res.status(400).json({ error: `Invalid transition from ${job.status} to assigned` });
    }

    // 2. Update job status in Supabase using atomic RPC
    const { data: assigned, error: rpcError } = await supabaseAdmin.rpc('assign_driver_to_job', {
      p_job_id: jobId,
      p_driver_id: driverId
    });

    if (rpcError || !assigned) {
      return res.status(400).json({ error: 'Failed to accept job. It may have been taken or cancelled.' });
    }

    // 2.5 Notify customer
    if (job.customer_id) {
      await NotificationService.notifyJobStatusUpdate(job.customer_id, jobId, 'assigned');
    }

    // 3. Capture Stripe payment if it's a card payment
    if (job.payment_method === 'card' && job.payment_intent_id) {
      try {
        await stripe.paymentIntents.capture(job.payment_intent_id);
        
        // Update payment status
        await supabaseAdmin.from('jobs').update({ payment_status: 'paid' }).eq('id', jobId);
      } catch (stripeError: any) {
        console.error('Stripe capture error:', stripeError);
      }
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('Accept job error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Cancel a booking
 */
router.post('/cancel', async (req: Request, res: Response) => {
  try {
    const { jobId, reason } = req.body;

    if (!jobId) {
      return res.status(400).json({ error: 'jobId required' });
    }

    // 1. Get job details
    const { data: job, error: jobError } = await supabaseAdmin
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobError || !job) throw new Error('Job not found');

    // State Guard
    if (!LogisticsService.isValidBookingTransition(job.status, 'cancelled')) {
      return res.status(400).json({ error: `Cannot cancel job in status: ${job.status}` });
    }

    const driverAssigned = !!job.driver_id;

    // 2. Update job status using atomic RPC
    const { data: cancelled, error: rpcError } = await supabaseAdmin.rpc('cancel_job_safely', {
      p_job_id: jobId,
      p_reason: reason || 'User cancelled'
    });

    if (rpcError || !cancelled) {
      return res.status(400).json({ error: 'Failed to cancel job. It may have already been completed or cancelled.' });
    }

    // 2.5 Track cancellation for fraud protection
    if (job.customer_id) {
      await FraudService.trackCancellation(job.customer_id);
    }

    // 3. Handle Stripe Payment
    if (job.payment_method === 'card' && job.payment_intent_id) {
      try {
        if (!driverAssigned) {
          // Cancel payment intent
          await stripe.paymentIntents.cancel(job.payment_intent_id);
        } else {
          // Capture cancellation fee
          const cancelFee = 500; // 5.00 in cents
          const amountToCapture = Math.min(cancelFee, Math.round(job.total_price * 100));
          
          await stripe.paymentIntents.capture(job.payment_intent_id, {
            amount_to_capture: amountToCapture
          });
        }
      } catch (stripeError: any) {
        console.error('Stripe cancel/capture error:', stripeError);
      }
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('Cancel booking error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
