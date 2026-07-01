import { Router, NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { dispatchService } from '../services/dispatch.service';
import { AuditService } from '../services/audit.service';
import { stripe } from '../services/stripe.service';
import { PayoutService } from '../services/payout.service';
import { NotificationService } from '../services/notification.service';

const router = Router();

function getOneSignalStatus() {
  return {
    ok: true,
    configured: Boolean(process.env.ONESIGNAL_REST_API_KEY),
    appId: process.env.ONESIGNAL_APP_ID || '952c6d19-656c-4dab-90f3-6e253e2c9151',
    enabled: process.env.PUSH_NOTIFICATIONS_ENABLED === 'true'
  };
}

function isValidOneSignalAppId(appId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId.trim());
}

function firstValue(source: any, keys: string[]): string | null {
  for (const key of keys) {
    const value = source?.[key];
    if (String(value ?? '').trim()) return String(value).trim();
  }
  return null;
}

function parseVerificationItems(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (Array.isArray(value)) {
    return value.reduce<Record<string, unknown>>((items, entry) => {
      if (!entry || typeof entry !== 'object') return items;
      const record = entry as Record<string, unknown>;
      const key = String(record.key || record.name || record.field || '').trim();
      if (key) items[key] = record.value ?? record.label ?? '';
      return items;
    }, {});
  }
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      return parseVerificationItems(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return {};
}

const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    return res.status(401).json({ ok: false, error: 'Authentication required.' });
  }

  const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);

  if (authError || !authData.user?.id) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired session.' });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', authData.user.id)
    .maybeSingle();

  if (profileError || profile?.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Administrator access required.' });
  }

  return next();
};

router.get('/settings/secrets/onesignal/status', requireAdmin, (_req: Request, res: Response) => {
  res.json(getOneSignalStatus());
});

router.post('/settings/secrets/onesignal', requireAdmin, (req: Request, res: Response) => {
  const body = req.body || {};
  const appId = String(body.appId || process.env.ONESIGNAL_APP_ID || '').trim();
  const restApiKey = typeof body.restApiKey === 'string' ? body.restApiKey.trim() : '';

  if (!appId || !isValidOneSignalAppId(appId)) {
    return res.status(400).json({ ok: false, error: 'Valid OneSignal App ID is required.' });
  }

  if (restApiKey && !process.env.ONESIGNAL_REST_API_KEY) {
    console.warn('[OneSignal] REST API key was submitted, but secure settings storage is not configured. Set ONESIGNAL_REST_API_KEY in server env.');
  }

  const configuredFromEnv = Boolean(process.env.ONESIGNAL_REST_API_KEY);

  res.json({
    ok: true,
    configured: configuredFromEnv,
    appId: process.env.ONESIGNAL_APP_ID || appId,
    enabled: body.enabled === true || process.env.PUSH_NOTIFICATIONS_ENABLED === 'true',
    message: configuredFromEnv
      ? 'Using server environment OneSignal configuration'
      : 'OneSignal REST API key must be configured in the server environment'
  });
});

router.post('/notifications/test', requireAdmin, async (req: Request, res: Response) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    const title = String(req.body?.title || 'Movabi test notification').trim();
    const body = String(req.body?.body || 'Push notifications are working.').trim();

    if (!userId) {
      return res.status(400).json({ ok: false, error: 'User ID is required.' });
    }

    const result = await NotificationService.sendNotification({
      userId,
      title,
      body,
      type: 'system_alert',
      data: { route: '/driver', source: 'admin_test_notification' }
    });

    res.json({ ok: true, pushAttempted: Boolean(process.env.ONESIGNAL_REST_API_KEY), result });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || 'Test notification failed.' });
  }
});

router.get('/drivers', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const { data: drivers, error: driversError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('role', 'driver')
      .order('created_at', { ascending: false });

    if (driversError) {
      return res.status(500).json({ ok: false, error: driversError.message });
    }

    const driverIds = (drivers || []).map((driver: any) => driver.id).filter(Boolean);
    const { data: vehicles } = driverIds.length
      ? await supabaseAdmin
        .from('vehicles')
        .select('*')
        .in('user_id', driverIds)
      : { data: [] as any[] };

    const vehiclesByUser = new Map<string, any[]>();

    (vehicles || []).forEach((vehicle: any) => {
      const ownerId = vehicle.user_id || vehicle.driver_id;
      if (!ownerId) return;
      if (!vehiclesByUser.has(ownerId)) vehiclesByUser.set(ownerId, []);
      vehiclesByUser.get(ownerId)?.push(vehicle);
    });

    const authEmails = new Map<string, string>();
    await Promise.all(driverIds.map(async (driverId: string) => {
      try {
        const { data } = await supabaseAdmin.auth.admin.getUserById(driverId);
        if (data?.user?.email) authEmails.set(driverId, data.user.email);
      } catch (error: any) {
        console.warn('[admin-drivers] auth email lookup failed:', driverId, error?.message || error);
      }
    }));

    const result = (drivers || []).map((driver: any) => {
      const authEmail = authEmails.get(driver.id) || null;
      const driverWithVerificationItems = {
        ...parseVerificationItems(driver.verification_items),
        ...driver
      };
      return {
        ...driver,
        email: driver.email || authEmail,
        auth_email: authEmail,
        date_of_birth: driver.date_of_birth || null,
        phone: driver.phone || driver.phone_number || driver.mobile || null,
        council_name: firstValue(driverWithVerificationItems, ['council_name', 'councilName', 'licensing_authority', 'private_hire_authority', 'council_license_authority']),
        council_license_number: firstValue(driverWithVerificationItems, ['council_license_number', 'councilLicenceNumber', 'council_licence_number', 'private_hire_license_number', 'private_hire_licence_number', 'taxi_licence_number']),
        taxi_badge_number: firstValue(driverWithVerificationItems, ['taxi_badge_number', 'taxiBadgeNumber', 'badge_number', 'driver_badge_number']),
        taxi_license_expiry: firstValue(driverWithVerificationItems, ['taxi_license_expiry', 'taxiLicenceExpiry', 'taxi_licence_expiry', 'private_hire_license_expiry', 'private_hire_licence_expiry', 'private_hire_expiry', 'council_license_expiry']),
        private_hire_vehicle_license_url: firstValue(driverWithVerificationItems, ['private_hire_vehicle_license_url', 'privateHireVehicleLicenseUrl', 'phv_license_url', 'vehicle_license_url', 'private_hire_vehicle_licence_url', 'phv_licence_url']),
        vehicles: vehiclesByUser.get(driver.id) || []
      };
    });

    res.json({ ok: true, drivers: result });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || 'Failed to load drivers.' });
  }
});

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
