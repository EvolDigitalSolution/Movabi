import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { dispatchService } from '../services/dispatch.service';
import { AuditService } from '../services/audit.service';
import { stripe } from '../services/stripe.service';
import { PayoutService } from '../services/payout.service';

const router = Router();

/**
 * Get heatmap data (supply vs demand)
 */
router.get('/heatmap', async (req: Request, res: Response) => {
  try {
    // In a real city-scale app, we'd query active zones.
    // For now, we'll return a few sample zones based on active bookings/drivers.
    const { data: activeJobs } = await supabaseAdmin
      .from('jobs')
      .select('pickup_lat, pickup_lng')
      .eq('status', 'searching')
      .limit(100);

    const zones = await Promise.all((activeJobs || []).map(async (job) => {
      const stats = await dispatchService.getAreaStats(job.pickup_lat, job.pickup_lng);
      return {
        lat: job.pickup_lat,
        lng: job.pickup_lng,
        demand: stats.demand,
        drivers: stats.supply
      };
    }));

    res.json({ zones });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get platform metrics
 */
router.get('/metrics', async (req: Request, res: Response) => {
  try {
    const { count: totalBookings } = await supabaseAdmin
      .from('jobs')
      .select('*', { count: 'exact', head: true });

    const { count: failedBookings } = await supabaseAdmin
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .in('status', ['cancelled', 'no_driver_found']);

    const { data: revenueData } = await supabaseAdmin
      .from('jobs')
      .select('price')
      .eq('status', 'completed');

    const revenue = (revenueData || []).reduce((sum, job) => sum + (Number(job.price) || 0), 0);

    const { count: activeDrivers } = await supabaseAdmin
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('role', 'driver')
      .eq('is_available', true);

    res.json({
      totalBookings: totalBookings || 0,
      failedBookings: failedBookings || 0,
      revenue,
      activeDrivers: activeDrivers || 0
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get failed bookings
 */
router.get('/failures', async (req: Request, res: Response) => {
  try {
    const { data } = await supabaseAdmin
      .from('jobs')
      .select('*, customer:profiles!customer_id(*)')
      .in('status', ['cancelled', 'no_driver_found'])
      .order('created_at', { ascending: false })
      .limit(50);

    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get recent payments
 */
router.get('/payments', async (req: Request, res: Response) => {
  try {
    const { data } = await supabaseAdmin
      .from('wallet_transactions')
      .select('*, user:profiles!user_id(*)')
      .order('created_at', { ascending: false })
      .limit(50);

    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get ops health metrics
 */
router.get('/ops-health', async (req: Request, res: Response) => {
  try {
    const { data: stripeEvents } = await supabaseAdmin
      .from('stripe_events')
      .select('status');
    
    // Simple aggregation
    const eventStats = (stripeEvents || []).reduce((acc: any, curr: any) => {
      acc[curr.status] = (acc[curr.status] || 0) + 1;
      return acc;
    }, {});

    const { count: noDriverCount } = await supabaseAdmin
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'no_driver_found');

    const { count: failedPayments } = await supabaseAdmin
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('payment_status', 'failed');

    res.json({
      webhook_events: eventStats,
      no_driver_found_count: noDriverCount || 0,
      failed_payments_count: failedPayments || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Accounting Export
 */
router.get('/accounting-export', async (req: Request, res: Response) => {
  try {
    const [bookings, payments, refunds, wallet, earnings] = await Promise.all([
      supabaseAdmin.from('jobs').select('*').limit(1000),
      supabaseAdmin.from('wallet_transactions').select('*').eq('type', 'credit').limit(1000),
      supabaseAdmin.from('wallet_transactions').select('*').eq('type', 'refund').limit(1000),
      supabaseAdmin.from('wallets').select('*').limit(1000),
      supabaseAdmin.from('driver_earnings').select('*').limit(1000)
    ]);

    res.json({
      bookings: bookings.data,
      payments: payments.data,
      refunds: refunds.data,
      wallets: wallet.data,
      driver_earnings: earnings.data,
      exported_at: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Payment Timeline
 */
router.get('/payment/:id/timeline', async (req: Request, res: Response) => {
  try {
    
      const rawId = req.params.id;

const paymentIntentId =
  typeof rawId === 'string'
    ? rawId
    : Array.isArray(rawId)
      ? rawId[0]
      : '';

if (!paymentIntentId) {
  return res.status(400).json({ error: 'Invalid payment intent id' });
}

// 1. Fetch PaymentIntent from Stripe
const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

// Audit logs
const { data: logs } = await supabaseAdmin
  .from('audit_logs')
  .select('*')
  .eq('entity_id', paymentIntentId)
  .order('created_at', { ascending: true });

// Webhook events
const { data: events } = await supabaseAdmin
  .from('stripe_events')
  .select('*')
  .filter('id', 'ilike', `%${paymentIntentId}%`);

res.json({
  stripe_status: pi.status,
  amount: pi.amount,
  timeline: logs,
  webhook_events: events,
  raw_stripe: pi
});    


 
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Dispute / Refund Management
 */
router.post('/dispute', async (req: Request, res: Response) => {
  const { bookingId, amount, reason, adminId } = req.body;
  
  try {
    const { data: job } = await supabaseAdmin
      .from('jobs')
      .select('*')
      .eq('id', bookingId)
      .single();

    if (!job) return res.status(404).json({ error: 'Booking not found' });
    if (!job.payment_intent_id) return res.status(400).json({ error: 'No payment intent found for this booking' });

    // 1. Trigger Stripe Refund
    const refund = await stripe.refunds.create({
      payment_intent: job.payment_intent_id,
      amount: amount ? Math.round(amount * 100) : undefined,
      reason: 'requested_by_customer',
      metadata: { bookingId, reason, adminId }
    });

    // 2. Update local job status
    await supabaseAdmin
      .from('jobs')
      .update({ 
        payment_status: 'refunded',
        status: 'cancelled',
        metadata: { ...job.metadata, refund_id: refund.id, refund_reason: reason }
      })
      .eq('id', bookingId);

    // 3. Log Audit
    await AuditService.logAdminAction(adminId, 'refund_issued', 'booking', bookingId, { refundId: refund.id, amount, reason });

    res.json({ success: true, refundId: refund.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * SLA Monitoring
 */
router.get('/sla', async (req: Request, res: Response) => {
  try {
    const { data: jobs } = await supabaseAdmin
      .from('jobs')
      .select('created_at, accepted_at, status, payment_status')
      .limit(500);

    if (!jobs) return res.json({});

    const completed = jobs.filter(j => j.status === 'completed');
    const avgAssignmentTime = completed.reduce((acc, curr) => {
      if (curr.accepted_at && curr.created_at) {
        return acc + (new Date(curr.accepted_at).getTime() - new Date(curr.created_at).getTime());
      }
      return acc;
    }, 0) / (completed.length || 1);

    const paymentSuccessRate = (jobs.filter(j => j.payment_status === 'paid').length / jobs.length) * 100;
    const failureRate = (jobs.filter(j => ['cancelled', 'no_driver_found'].includes(j.status)).length / jobs.length) * 100;

    res.json({
      avg_assignment_time_ms: Math.round(avgAssignmentTime),
      payment_success_rate: Math.round(paymentSuccessRate * 100) / 100,
      failure_rate: Math.round(failureRate * 100) / 100,
      total_sample: jobs.length
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Trigger Payout Processing
 */
router.post('/process-payouts', async (req: Request, res: Response) => {
  try {
    const results = await PayoutService.processDriverPayouts();
    res.json(results);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
