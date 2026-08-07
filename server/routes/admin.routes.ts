import { Router, NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { dispatchService } from '../services/dispatch.service';
import { AuditService } from '../services/audit.service';
import { stripe } from '../services/stripe.service';
import { PayoutService } from '../services/payout.service';
import { NotificationService } from '../services/notification.service';
import { AppVersionService, normaliseAppVersionConfig } from '../services/app-version.service';
import { MarketplaceConfigService } from '../services/marketplace-config.service';
import { LocalPlaceSearchService, ProviderBrandService } from '../services/local-place-search.service';

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

  (req as any).adminUserId = authData.user.id;
  return next();
};

function cleanLocalServiceCountry(value: unknown): string | null {
  const country = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

function canonicalLocalServiceSlug(value: unknown): string {
  const slug = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['shop', 'shopping', 'errands'].includes(slug)) return 'errand';
  if (['quick-buy', 'quickbuy'].includes(slug)) return 'quick-buy';
  if (['collect-deliver', 'collectdeliver'].includes(slug)) return 'collect-deliver';
  if (['deliver', 'package'].includes(slug)) return 'delivery';
  if (['van', 'move', 'van-moving'].includes(slug)) return 'van-moving';
  return slug;
}

function slugifyLocalService(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseKeywordArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function requireHttpsUrl(value: unknown, field: string): string | null {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!/^https:\/\/.+/i.test(text)) {
    throw new Error(`${field} must be an HTTPS URL.`);
  }
  return text;
}

function appVersionBodyToConfig(body: any, adminId?: string | null) {
  return normaliseAppVersionConfig({
    currentWebVersion: body?.currentWebVersion,
    minimumWebVersion: body?.minimumWebVersion,
    currentAndroidVersion: body?.currentAndroidVersion,
    minimumAndroidVersion: body?.minimumAndroidVersion,
    currentIosVersion: body?.currentIosVersion,
    minimumIosVersion: body?.minimumIosVersion,
    updateRequired: body?.updateRequired,
    updateSeverity: body?.updateSeverity,
    updateTitle: body?.updateTitle,
    updateMessage: body?.updateMessage,
    releaseNotes: body?.releaseNotes,
    androidUpdateUrl: body?.androidUpdateUrl,
    iosUpdateUrl: body?.iosUpdateUrl,
    webReloadRequired: body?.webReloadRequired,
    admin_set_by: adminId || null
  });
}

async function notifyUsersOfRequiredUpdate(title: string, body: string): Promise<void> {
  try {
    const { data: users, error } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .in('role', ['customer', 'driver', 'admin'])
      .limit(10000);

    if (error) {
      console.warn('[AppVersion] update notification user lookup failed:', error.message);
      return;
    }

    await Promise.all((users || []).map((user: any) => NotificationService.sendNotification({
      userId: user.id,
      title,
      body,
      type: 'system_alert',
      data: {
        route: '/',
        type: 'app_update_required',
        action: 'app_update_required'
      }
    })));
  } catch (error: any) {
    console.warn('[AppVersion] update notification failed:', error?.message || error);
  }
}

router.get('/app-version', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const config = await AppVersionService.getConfig();
    res.json({ ok: true, config });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || 'Unable to load app version settings.' });
  }
});

router.post('/app-version', requireAdmin, async (req: Request, res: Response) => {
  try {
    const adminId = (req as any).adminUserId || null;
    const previous = await AppVersionService.getConfig();
    const config = appVersionBodyToConfig(req.body || {}, adminId);
    const saved = await AppVersionService.saveConfig(config);

    await AuditService.log({
      userId: adminId || undefined,
      action: 'admin_app_version_updated',
      entityType: 'system_config',
      metadata: { key: 'app_version_config', previous, saved }
    });

    const shouldNotify =
      (saved.update_required || saved.update_severity === 'required' || saved.update_severity === 'critical') &&
      (req.body?.sendNotification === true || previous.update_required !== saved.update_required || previous.update_severity !== saved.update_severity);

    if (shouldNotify) {
      void notifyUsersOfRequiredUpdate(
        'Movabi update required',
        saved.update_message || 'A new Movabi update is required to continue.'
      );
    }

    res.json({ ok: true, config: saved });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || 'Unable to save app version settings.' });
  }
});

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

router.get('/notifications/diagnostics/:userId', requireAdmin, async (req: Request, res: Response) => {
  try {
    const userId = String(req.params.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ ok: false, error: 'User ID is required.' });
    }

    const { data, error } = await supabaseAdmin
      .from('device_push_tokens')
      .select('provider, platform, subscription_id, external_id, enabled, last_seen_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(5);

    if (error) throw error;

    res.json({
      ok: true,
      configured: Boolean(process.env.ONESIGNAL_REST_API_KEY),
      appId: process.env.ONESIGNAL_APP_ID || '952c6d19-656c-4dab-90f3-6e253e2c9151',
      tokens: (data || []).map((token) => ({
        ...token,
        tokenSaved: Boolean(token.subscription_id || token.external_id)
      }))
    });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || 'Unable to load push diagnostics.' });
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
    const {data:dobCorrectionRows}=driverIds.length?await supabaseAdmin.from('driver_onboarding_requests').select('id,driver_id,status,public_message,private_admin_note,sent_at,resolved_at,request_type,permission_consumed_at').in('driver_id',driverIds).eq('request_type','identity_correction').order('created_at',{ascending:false}):{data:[] as any[]};
    const dobCorrectionsByDriver=new Map<string,any>();for(const request of dobCorrectionRows||[]){if(!dobCorrectionsByDriver.has(request.driver_id))dobCorrectionsByDriver.set(request.driver_id,request);}
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
        dob_correction_request:dobCorrectionsByDriver.get(driver.id)||null,
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

/**
 * Test Push Notification
 */
router.post('/test-push', async (req: Request, res: Response) => {
  try {
    const { userId, title, body } = req.body || {};
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

    if (!token) {
      return res.status(401).json({ ok: false, error: 'Authentication required.' });
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !authData.user?.id) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired session.' });
    }

    if (!userId) {
      return res.status(400).json({ ok: false, error: 'userId is required.' });
    }

    // Validate user has push subscription first
    const subscriptionValidation = await NotificationService.validateUserPushSubscription(userId);
    
    if (!subscriptionValidation.hasSubscription) {
      return res.json({
        ok: true,
        message: 'User has no active push subscriptions',
        validation: subscriptionValidation,
        oneSignalStatus: getOneSignalStatus()
      });
    }

    // Send test push
    const result = await NotificationService.sendNotification({
      userId,
      title: title || 'Test Push Notification',
      body: body || 'This is a test push notification from Movabi admin.',
      type: 'system_alert',
      data: { 
        test: true, 
        sentBy: authData.user.id,
        sentAt: new Date().toISOString()
      }
    });

    res.json({
      ok: true,
      message: 'Test push notification sent',
      result,
      validation: subscriptionValidation,
      oneSignalStatus: getOneSignalStatus()
    });

  } catch (error: any) {
    console.error('[Admin] Test push failed:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Validate User Push Subscription
 */
router.get('/validate-push-subscription/:userId', async (req: Request, res: Response) => {
  try {
    const rawUserId = req.params['userId'];
    const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

    if (!token) {
      return res.status(401).json({ ok: false, error: 'Authentication required.' });
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !authData.user?.id) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired session.' });
    }

    if (!userId) {
      return res.status(400).json({ ok: false, error: 'userId is required.' });
    }

    const validation = await NotificationService.validateUserPushSubscription(userId);

    res.json({
      ok: true,
      validation,
      oneSignalStatus: getOneSignalStatus()
    });

  } catch (error: any) {
    console.error('[Admin] Validate push subscription failed:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Marketplace Control Centre
 */
router.get('/marketplace/settings', requireAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = (req.query.tenantId as string | null) || null;
    const settings = await MarketplaceConfigService.getAllSettings(tenantId);
    res.json({ ok: true, settings });
  } catch (error: any) {
    console.error('[Admin] Load marketplace settings error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/marketplace/settings', requireAdmin, async (req: Request, res: Response) => {
  try {
    const adminId = (req as any).adminUserId || null;
    const tenantId = (req.body?.tenantId as string | null) || null;
    const updates = req.body?.settings || {};

    console.info('[AdminMarketplace] save request received');
    console.info('[AdminMarketplace] authenticated admin user', adminId);

    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({
        ok: false,
        error: 'Failed to save marketplace settings',
        details: 'settings must be a JSON object.'
      });
    }

    console.info('[AdminMarketplace] keys being saved', Object.keys(updates));

    await MarketplaceConfigService.setSettings(updates, tenantId, adminId);
    MarketplaceConfigService.clearCache();
    const fresh = await MarketplaceConfigService.getAllSettings(tenantId);

    res.json({ ok: true, settings: fresh, updatedAt: new Date().toISOString() });
  } catch (error: any) {
    console.error('[AdminMarketplace] save failed:', error?.message || error);
    res.status(500).json({
      ok: false,
      error: 'Failed to save marketplace settings',
      details: error?.message || 'Unknown marketplace settings save error.'
    });
  }
});

router.get('/marketplace/audit-logs', requireAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 1000);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const key = typeof req.query.key === 'string' ? req.query.key : null;
    const logs = await MarketplaceConfigService.getAuditLogs(limit, offset, key);
    res.json({ ok: true, logs });
  } catch (error: any) {
    console.error('[Admin] Marketplace audit logs error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/marketplace/reload', requireAdmin, async (_req: Request, res: Response) => {
  try {
    MarketplaceConfigService.clearCache();
    res.json({ ok: true, message: 'Marketplace cache cleared.' });
  } catch (error: any) {
    console.error('[Admin] Marketplace reload error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Global AI Pricing control plane. These endpoints intentionally expose only
 * admin-guarded configuration rows; live pricing remains disabled unless the
 * persisted market/service rows explicitly enable it.
 */
const globalPricingTables: Record<string, string> = {
  markets: 'pricing_markets',
  zones: 'pricing_zones',
  serviceRules: 'service_market_rules',
  waitingRules: 'pricing_waiting_rules',
  calendarEvents: 'pricing_calendar_events',
  audits: 'ai_pricing_audits'
};

router.get('/pricing/global-ai/:table', requireAdmin, async (req: Request, res: Response) => {
  try {
    const table = globalPricingTables[String(req.params.table || '')];
    if (!table) {
      return res.status(404).json({ ok: false, error: 'Unknown global pricing table.' });
    }

    const limit = Math.min(Number(req.query.limit || 100), 500);
    const countryCode = typeof req.query.countryCode === 'string'
      ? req.query.countryCode.toUpperCase()
      : null;

    let query = supabaseAdmin.from(table).select('*').limit(limit);
    if (countryCode && table !== 'ai_pricing_audits') {
      query = query.eq('country_code', countryCode);
    }
    if (table === 'ai_pricing_audits') {
      query = query.order('created_at', { ascending: false });
    }

    const { data, error } = await query;
    if (error) {
      return res.status(400).json({ ok: false, error: error.message, code: error.code });
    }

    return res.json({ ok: true, rows: data || [] });
  } catch (error: any) {
    console.error('[Admin] Global AI pricing load error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/pricing/global-ai/:table', requireAdmin, async (req: Request, res: Response) => {
  try {
    const tableKey = String(req.params.table || '');
    const table = globalPricingTables[tableKey];
    if (!table || table === 'ai_pricing_audits') {
      return res.status(404).json({ ok: false, error: 'Unknown or read-only global pricing table.' });
    }

    const row = req.body?.row;
    if (!row || typeof row !== 'object') {
      return res.status(400).json({ ok: false, error: 'row is required.' });
    }

    const { data, error } = await supabaseAdmin
      .from(table)
      .upsert({ ...row, updated_at: new Date().toISOString() })
      .select('*')
      .single();

    if (error) {
      return res.status(400).json({ ok: false, error: error.message, code: error.code });
    }

    return res.json({ ok: true, row: data });
  } catch (error: any) {
    console.error('[Admin] Global AI pricing save error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.delete('/pricing/global-ai/:table/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const tableKey = String(req.params.table || '');
    const table = globalPricingTables[tableKey];
    if (!table || table === 'ai_pricing_audits') {
      return res.status(404).json({ ok: false, error: 'Unknown or read-only global pricing table.' });
    }

    const id = decodeURIComponent(String(req.params.id || '')).trim();
    if (!id) {
      return res.status(400).json({ ok: false, error: 'Delete id is required.' });
    }

    const matchColumn = tableKey === 'markets' ? 'country_code' : 'id';
    const { error } = await supabaseAdmin
      .from(table)
      .delete()
      .eq(matchColumn, id);

    if (error) {
      return res.status(400).json({ ok: false, error: error.message, code: error.code });
    }

    return res.json({ ok: true });
  } catch (error: any) {
    console.error('[Admin] Global AI pricing delete error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/local-services/categories', requireAdmin, async (req: Request, res: Response) => {
  try {
    let query = supabaseAdmin
      .from('local_service_categories')
      .select('*')
      .order('country_code', { ascending: true })
      .order('service_slug', { ascending: true })
      .order('display_order', { ascending: true });

    const countryCode = cleanLocalServiceCountry(req.query.countryCode);
    const serviceSlug = canonicalLocalServiceSlug(req.query.serviceSlug || req.query.service);
    const enabled = String(req.query.enabled ?? '').trim();

    if (countryCode) query = query.eq('country_code', countryCode);
    if (serviceSlug) query = query.eq('service_slug', serviceSlug);
    if (enabled === 'true' || enabled === 'false') query = query.eq('enabled', enabled === 'true');

    const { data, error } = await query;
    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.json({ ok: true, categories: data || [] });
  } catch (error: any) {
    console.error('[AdminLocalServices] load categories failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Failed to load categories.' });
  }
});

router.post('/local-services/categories', requireAdmin, async (req: Request, res: Response) => {
  try {
    const countryCode = cleanLocalServiceCountry(req.body.country_code || req.body.countryCode);
    if (!countryCode) return res.status(400).json({ ok: false, error: 'Valid country code is required.' });

    const serviceSlug = canonicalLocalServiceSlug(req.body.service_slug || req.body.serviceSlug);
    if (!serviceSlug) return res.status(400).json({ ok: false, error: 'Service is required.' });

    const categoryName = String(req.body.category_name || req.body.categoryName || '').trim();
    const categorySlug = slugifyLocalService(req.body.category_slug || req.body.categorySlug || categoryName);
    if (!categoryName || !categorySlug) return res.status(400).json({ ok: false, error: 'Category name and slug are required.' });

    const payload = {
      country_code: countryCode,
      service_slug: serviceSlug,
      category_slug: categorySlug,
      category_name: categoryName,
      category_description: String(req.body.category_description || req.body.categoryDescription || '').trim() || null,
      icon: String(req.body.icon || '').trim() || null,
      search_keywords: parseKeywordArray(req.body.search_keywords || req.body.searchKeywords),
      provider_types: parseKeywordArray(req.body.provider_types || req.body.providerTypes),
      fallback_keywords: parseKeywordArray(req.body.fallback_keywords || req.body.fallbackKeywords),
      default_search_radius_km: Number(req.body.default_search_radius_km ?? req.body.searchRadiusKm ?? 10),
      allow_custom_provider: req.body.allow_custom_provider ?? req.body.allowCustomProvider ?? true,
      display_order: Number(req.body.display_order ?? req.body.displayOrder ?? 0),
      enabled: req.body.enabled !== false
    };

    const { data, error } = await supabaseAdmin
      .from('local_service_categories')
      .insert(payload)
      .select('*')
      .single();

    if (error) return res.status(400).json({ ok: false, error: error.message, code: error.code });
    return res.status(201).json({ ok: true, category: data });
  } catch (error: any) {
    console.error('[AdminLocalServices] create category failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Failed to create category.' });
  }
});

router.put('/local-services/categories/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '').trim();
    const payload: Record<string, unknown> = {
      category_name: String(req.body.category_name || req.body.categoryName || '').trim(),
      category_description: String(req.body.category_description || req.body.categoryDescription || '').trim() || null,
      icon: String(req.body.icon || '').trim() || null,
      search_keywords: parseKeywordArray(req.body.search_keywords || req.body.searchKeywords),
      provider_types: parseKeywordArray(req.body.provider_types || req.body.providerTypes),
      fallback_keywords: parseKeywordArray(req.body.fallback_keywords || req.body.fallbackKeywords),
      default_search_radius_km: Number(req.body.default_search_radius_km ?? req.body.searchRadiusKm ?? 10),
      allow_custom_provider: req.body.allow_custom_provider ?? req.body.allowCustomProvider ?? true,
      display_order: Number(req.body.display_order ?? req.body.displayOrder ?? 0),
      enabled: req.body.enabled !== false,
      updated_at: new Date().toISOString()
    };

    if (req.body.category_slug || req.body.categorySlug) {
      payload['category_slug'] = slugifyLocalService(req.body.category_slug || req.body.categorySlug);
    }

    if (!payload['category_name']) return res.status(400).json({ ok: false, error: 'Category name is required.' });

    const { data, error } = await supabaseAdmin
      .from('local_service_categories')
      .update(payload)
      .eq('id', id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ ok: false, error: error.message, code: error.code });
    return res.json({ ok: true, category: data });
  } catch (error: any) {
    console.error('[AdminLocalServices] update category failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Failed to update category.' });
  }
});

router.delete('/local-services/categories/:id', requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim();
  const { error } = await supabaseAdmin
    .from('local_service_categories')
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return res.status(400).json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

router.post('/local-services/search-external', requireAdmin, async (req: Request, res: Response) => {
  try {
    const countryCode = cleanLocalServiceCountry(req.body.country_code || req.body.countryCode);
    const serviceSlug = canonicalLocalServiceSlug(req.body.service_slug || req.body.serviceSlug || req.body.service);
    const categorySlug = slugifyLocalService(req.body.category_slug || req.body.categorySlug || req.body.category);
    const query = String(req.body.q || req.body.query || '').trim();
    const lat = Number(req.body.lat ?? req.body.latitude);
    const lng = Number(req.body.lng ?? req.body.longitude);

    if (!countryCode || !serviceSlug || !categorySlug) {
      return res.status(400).json({ ok: false, error: 'Country, service and category are required.' });
    }

    const providers = await LocalPlaceSearchService.search({
      countryCode,
      serviceSlug,
      categorySlug,
      searchText: query,
      latitude: Number.isFinite(lat) ? lat : undefined,
      longitude: Number.isFinite(lng) ? lng : undefined,
      radiusKm: Number(req.body.radiusKm || req.body.radius_km || 10),
      limit: Number(req.body.limit || 12)
    });

    return res.json({
      ok: true,
      providers: providers.map(provider => ({
        country_code: countryCode,
        category_id: String(req.body.category_id || req.body.categoryId || '').trim(),
        provider_name: provider.providerName,
        provider_slug: slugifyLocalService(provider.providerName),
        logo_url: provider.providerLogoUrl || null,
        official_website: provider.providerWebsite || null,
        search_keywords: [provider.providerName, query].filter(Boolean),
        address: provider.providerAddress || null,
        latitude: provider.providerLatitude ?? null,
        longitude: provider.providerLongitude ?? null,
        external_place_id: provider.externalPlaceId || null,
        source: provider.source || 'external',
        verified: provider.verified === true,
        enabled: true,
        display_order: 0
      }))
    });
  } catch (error: any) {
    console.error('[AdminLocalServices] external search failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'External provider search failed.' });
  }
});

router.get('/local-services/providers', requireAdmin, async (req: Request, res: Response) => {
  try {
    let query = supabaseAdmin
      .from('local_service_providers')
      .select('*, category:local_service_categories(*)')
      .order('country_code', { ascending: true })
      .order('display_order', { ascending: true });

    const countryCode = cleanLocalServiceCountry(req.query.countryCode);
    const categoryId = String(req.query.categoryId || '').trim();
    const enabled = String(req.query.enabled ?? '').trim();
    if (countryCode) query = query.eq('country_code', countryCode);
    if (categoryId) query = query.eq('category_id', categoryId);
    if (enabled === 'true' || enabled === 'false') query = query.eq('enabled', enabled === 'true');

    const { data, error } = await query;
    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.json({ ok: true, providers: data || [] });
  } catch (error: any) {
    console.error('[AdminLocalServices] load providers failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Failed to load providers.' });
  }
});

router.post('/local-services/import-provider', requireAdmin, async (req: Request, res: Response) => {
  try {
    const countryCode = cleanLocalServiceCountry(req.body.country_code || req.body.countryCode);
    const categoryId = String(req.body.category_id || req.body.categoryId || '').trim();
    const providerName = String(req.body.provider_name || req.body.providerName || req.body.name || '').trim();
    const providerSlug = slugifyLocalService(req.body.provider_slug || req.body.providerSlug || providerName);
    if (!countryCode || !categoryId || !providerName || !providerSlug) {
      return res.status(400).json({ ok: false, error: 'Country, category and provider name are required.' });
    }

    const brandLogo = await ProviderBrandService.resolveLogo({
      providerName,
      countryCode,
      officialWebsite: req.body.official_website || req.body.officialWebsite || req.body.providerWebsite,
      logoUrl: req.body.logo_url || req.body.logoUrl || req.body.providerLogoUrl
    });

    const payload = {
      country_code: countryCode,
      category_id: categoryId,
      provider_name: providerName,
      provider_slug: providerSlug,
      provider_description: String(req.body.provider_description || req.body.providerDescription || '').trim() || null,
      logo_url: brandLogo || null,
      official_website: requireHttpsUrl(req.body.official_website || req.body.officialWebsite || req.body.providerWebsite, 'Official website'),
      search_keywords: parseKeywordArray(req.body.search_keywords || req.body.searchKeywords || providerName),
      address: String(req.body.address || req.body.providerAddress || '').trim() || null,
      latitude: req.body.latitude === '' || req.body.latitude === undefined ? null : Number(req.body.latitude),
      longitude: req.body.longitude === '' || req.body.longitude === undefined ? null : Number(req.body.longitude),
      external_place_id: String(req.body.external_place_id || req.body.externalPlaceId || '').trim() || null,
      source: String(req.body.source || 'external').trim() || 'external',
      verified: req.body.verified === true,
      enabled: req.body.enabled !== false,
      display_order: Number(req.body.display_order ?? req.body.displayOrder ?? 0)
    };

    const { data, error } = await supabaseAdmin
      .from('local_service_providers')
      .insert(payload)
      .select('*, category:local_service_categories(*)')
      .single();

    if (error) return res.status(400).json({ ok: false, error: error.message, code: error.code });
    return res.status(201).json({ ok: true, provider: data });
  } catch (error: any) {
    console.error('[AdminLocalServices] import provider failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Failed to import provider.' });
  }
});

router.post('/local-services/providers', requireAdmin, async (req: Request, res: Response) => {
  try {
    const countryCode = cleanLocalServiceCountry(req.body.country_code || req.body.countryCode);
    const categoryId = String(req.body.category_id || req.body.categoryId || '').trim();
    const providerName = String(req.body.provider_name || req.body.providerName || '').trim();
    const providerSlug = slugifyLocalService(req.body.provider_slug || req.body.providerSlug || providerName);
    if (!countryCode || !categoryId || !providerName || !providerSlug) {
      return res.status(400).json({ ok: false, error: 'Country, category, provider name and slug are required.' });
    }

    const payload = {
      country_code: countryCode,
      category_id: categoryId,
      provider_name: providerName,
      provider_slug: providerSlug,
      provider_description: String(req.body.provider_description || req.body.providerDescription || '').trim() || null,
      logo_url: requireHttpsUrl(req.body.logo_url || req.body.logoUrl, 'Logo URL'),
      official_website: requireHttpsUrl(req.body.official_website || req.body.officialWebsite, 'Official website'),
      search_keywords: parseKeywordArray(req.body.search_keywords || req.body.searchKeywords),
      address: String(req.body.address || '').trim() || null,
      latitude: req.body.latitude === '' || req.body.latitude === undefined ? null : Number(req.body.latitude),
      longitude: req.body.longitude === '' || req.body.longitude === undefined ? null : Number(req.body.longitude),
      external_place_id: String(req.body.external_place_id || req.body.externalPlaceId || '').trim() || null,
      source: String(req.body.source || 'admin').trim() || 'admin',
      verified: req.body.verified === true,
      enabled: req.body.enabled !== false,
      display_order: Number(req.body.display_order ?? req.body.displayOrder ?? 0)
    };

    const { data, error } = await supabaseAdmin
      .from('local_service_providers')
      .insert(payload)
      .select('*')
      .single();

    if (error) return res.status(400).json({ ok: false, error: error.message, code: error.code });
    return res.status(201).json({ ok: true, provider: data });
  } catch (error: any) {
    console.error('[AdminLocalServices] create provider failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Failed to create provider.' });
  }
});

router.put('/local-services/providers/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '').trim();
    const providerName = String(req.body.provider_name || req.body.providerName || '').trim();
    if (!providerName) return res.status(400).json({ ok: false, error: 'Provider name is required.' });

    const payload: Record<string, unknown> = {
      provider_name: providerName,
      provider_description: String(req.body.provider_description || req.body.providerDescription || '').trim() || null,
      logo_url: requireHttpsUrl(req.body.logo_url || req.body.logoUrl, 'Logo URL'),
      official_website: requireHttpsUrl(req.body.official_website || req.body.officialWebsite, 'Official website'),
      search_keywords: parseKeywordArray(req.body.search_keywords || req.body.searchKeywords),
      address: String(req.body.address || '').trim() || null,
      latitude: req.body.latitude === '' || req.body.latitude === undefined ? null : Number(req.body.latitude),
      longitude: req.body.longitude === '' || req.body.longitude === undefined ? null : Number(req.body.longitude),
      external_place_id: String(req.body.external_place_id || req.body.externalPlaceId || '').trim() || null,
      source: String(req.body.source || 'admin').trim() || 'admin',
      verified: req.body.verified === true,
      enabled: req.body.enabled !== false,
      display_order: Number(req.body.display_order ?? req.body.displayOrder ?? 0),
      updated_at: new Date().toISOString()
    };

    if (req.body.provider_slug || req.body.providerSlug) {
      payload['provider_slug'] = slugifyLocalService(req.body.provider_slug || req.body.providerSlug);
    }
    if (req.body.category_id || req.body.categoryId) {
      payload['category_id'] = String(req.body.category_id || req.body.categoryId).trim();
    }

    const { data, error } = await supabaseAdmin
      .from('local_service_providers')
      .update(payload)
      .eq('id', id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ ok: false, error: error.message, code: error.code });
    return res.json({ ok: true, provider: data });
  } catch (error: any) {
    console.error('[AdminLocalServices] update provider failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Failed to update provider.' });
  }
});

router.post('/local-services/providers/:id/resolve-brand', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '').trim();
    const { data: provider, error: loadError } = await supabaseAdmin
      .from('local_service_providers')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (loadError) return res.status(400).json({ ok: false, error: loadError.message });
    if (!provider) return res.status(404).json({ ok: false, error: 'Provider not found.' });

    const logoUrl = await ProviderBrandService.resolveLogo({
      providerName: provider.provider_name,
      countryCode: provider.country_code,
      officialWebsite: provider.official_website,
      logoUrl: provider.logo_url
    });

    if (!logoUrl) return res.json({ ok: true, provider, logoUrl: null });

    const { data, error } = await supabaseAdmin
      .from('local_service_providers')
      .update({ logo_url: logoUrl, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*, category:local_service_categories(*)')
      .single();

    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.json({ ok: true, provider: data, logoUrl });
  } catch (error: any) {
    console.error('[AdminLocalServices] resolve brand failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Failed to resolve brand.' });
  }
});

router.post('/local-services/providers/:id/verify', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '').trim();
    const verified = req.body.verified !== false;
    const { data, error } = await supabaseAdmin
      .from('local_service_providers')
      .update({ verified, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*, category:local_service_categories(*)')
      .single();
    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.json({ ok: true, provider: data });
  } catch (error: any) {
    console.error('[AdminLocalServices] verify provider failed:', error);
    return res.status(500).json({ ok: false, error: error.message || 'Failed to verify provider.' });
  }
});

router.delete('/local-services/providers/:id', requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim();
  const { error } = await supabaseAdmin
    .from('local_service_providers')
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return res.status(400).json({ ok: false, error: error.message });
  return res.json({ ok: true });
});

export default router;
