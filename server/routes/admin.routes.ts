import { demandZones } from '../services/admin-demand-map.service';
import { AdminIssuingTerminalService } from '../services/admin-issuing-terminal.service';
import { rateLimit } from 'express-rate-limit';
import { AdminFinanceService, reportBounds, dayInZone } from '../services/admin-finance.service';
import { Router, NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { dispatchService } from '../services/dispatch.service';
import { AuditService } from '../services/audit.service';
import { stripe } from '../services/stripe.service';
import { isDefinitiveStripeRejection } from '../services/stripe-errors';
import { PayoutService } from '../services/payout.service';
import { NotificationService } from '../services/notification.service';
import { AppVersionService, normaliseAppVersionConfig } from '../services/app-version.service';
import { MarketplaceConfigService } from '../services/marketplace-config.service';
import { LocalPlaceSearchService, ProviderBrandService } from '../services/local-place-search.service';
import { isTestAccountPurgeEnabled, purgeTestAccount, previewPurge, isResetAllTestDataEnabled, createResetChallenge, consumeResetChallenge, resetPreview, resetAllTestData, RESET_ALL_CONFIRMATION } from '../services/test-account-purge.service';

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

router.get('/issuing-test-terminal', requireAdmin, async (_req: Request,res: Response) => {
  res.setHeader('Cache-Control','no-store');
  try { return res.json(await AdminIssuingTerminalService.context()); }
  catch { return res.status(503).json({error:'Stripe mode or test cards could not be verified. Try again shortly.'}); }
});
router.post('/issuing-test-terminal/purchase', requireAdmin,
  rateLimit({windowMs:60000,limit:10,standardHeaders:true,legacyHeaders:false}), async (req: Request,res: Response) => {
  try { return res.json(await AdminIssuingTerminalService.purchase((req as any).adminUserId, req.body || {})); }
  catch(error) { return res.status(400).json({error:error instanceof Error ? error.message : 'Test purchase failed'}); }
});

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
        'Vaydu update required',
        saved.update_message || 'A new Vaydu update is required to continue.'
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
    const title = String(req.body?.title || 'Vaydu test notification').trim();
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

    const countryCodes=[...new Set((drivers||[]).map((d:any)=>String(d.country_code||'').toUpperCase()).filter((c:string)=>/^[A-Z]{2}$/.test(c)))];
    const {data:marketRows}=countryCodes.length?await supabaseAdmin.from('pricing_config').select('country_code,currency_code').in('country_code',countryCodes).eq('is_active',true):{data:[] as any[]};
    const currencyByCountry=new Map<string,string>();for(const r of marketRows||[]){const c=String(r.country_code||'').toUpperCase();if(!currencyByCountry.has(c))currencyByCountry.set(c,String(r.currency_code||'').toUpperCase());}
    const result = (drivers || []).map((driver: any) => {
      const authEmail = authEmails.get(driver.id) || null;
      const driverWithVerificationItems = {
        ...parseVerificationItems(driver.verification_items),
        ...driver
      };
      const storedCountry=String(driver.country_code||'').toUpperCase()||'UNKNOWN';
      const storedCurrency=String(driver.currency_code||'').toUpperCase()||'UNKNOWN';
      const marketCurrency=currencyByCountry.get(String(driver.country_code||'').toUpperCase())||'UNKNOWN';
      const marketMismatch=storedCountry!=='UNKNOWN'&&storedCurrency!=='UNKNOWN'&&marketCurrency!=='UNKNOWN'&&storedCurrency!==marketCurrency;
      return {
        ...driver,
        market_country:storedCountry,market_currency:storedCurrency,market_mismatch:marketMismatch,
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
        current_address: firstValue(driverWithVerificationItems, ['current_address','residential_address','home_address','address']),
        private_hire_insurance_url: firstValue(driverWithVerificationItems, ['private_hire_insurance_url','privateHireInsuranceUrl','private_hire_insurance_document_url','passenger_insurance_url']),
        private_hire_insurance_status: firstValue(driverWithVerificationItems, ['private_hire_insurance_status','privateHireInsuranceStatus']),
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
// Customer messages are informational and use the same inbox as driver messages.

router.get('/finance/daily', requireAdmin, async (req: Request, res: Response) => {
  const timezone = String(req.query.timezone || 'Europe/London');
  let date: string;
  try {
    date = String(req.query.date || dayInZone(new Date().toISOString(), timezone));
    reportBounds(date, timezone);
  } catch {
    return res.status(400).json({ error: 'Use a valid report date and IANA timezone' });
  }
  try {
    res.setHeader('Cache-Control', 'no-store');
    return res.json(await AdminFinanceService.report(date, timezone));
  } catch (error) {
    console.error('[AdminFinance] daily report failed', error);
    return res.status(500).json({ error: 'Financial report could not be loaded. Totals are unavailable.' });
  }
});

router.get('/users', requireAdmin, async (req: Request, res: Response) => {
  try {

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('role', 'customer')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const users = data || [];
    const countryCodes=[...new Set(users.map((u:any)=>String(u.country_code||'').toUpperCase()).filter((c:string)=>/^[A-Z]{2}$/.test(c)))];
    const {data:marketRows}=countryCodes.length?await supabaseAdmin.from('pricing_config').select('country_code,currency_code').in('country_code',countryCodes).eq('is_active',true):{data:[] as any[]};
    const currencyByCountry=new Map<string,string>();for(const r of marketRows||[]){const c=String(r.country_code||'').toUpperCase();if(!currencyByCountry.has(c))currencyByCountry.set(c,String(r.currency_code||'').toUpperCase());}
    for(const u of users){
      const sc=String(u.country_code||'').toUpperCase()||'UNKNOWN';
      const scu=String(u.currency_code||'').toUpperCase()||'UNKNOWN';
      const mc=currencyByCountry.get(String(u.country_code||'').toUpperCase())||'UNKNOWN';
      u.market_country=sc;u.market_currency=scu;
      u.market_mismatch=sc!=='UNKNOWN'&&scu!=='UNKNOWN'&&mc!=='UNKNOWN'&&scu!==mc;
    }
    for (let offset = 0; offset < users.length; offset += 10) {
      await Promise.all(users.slice(offset, offset + 10).map(async (user: any) => {
        if (String(user.email || '').trim()) return;
        const { data: auth, error: authError } =
          await supabaseAdmin.auth.admin.getUserById(user.id);
        if (authError) throw authError;
        user.email = auth?.user?.email || null;
      }));
    }

    return res.json(users);
  } catch (error: any) {
    console.error('[admin-users] lookup failed:', error?.message);
    return res.status(500).json({ error: 'Failed to load customer accounts' });
  }
});

router.post('/users/:userId/message', requireAdmin, async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message || message.length > 2000) return res.status(422).json({error:'Enter a message of 1â€“2000 characters.'});
    const userId = String(req.params.userId);
    const {data:user,error:userError}=await supabaseAdmin.from('profiles').select('id,role').eq('id',userId).single();
    if(userError || !user || !['customer','user'].includes(String(user.role))) return res.status(404).json({error:'Customer not found.'});
    const {data,error}=await supabaseAdmin.from('notifications').insert({
      user_id:userId,title:'Message from Vaydu',body:message,type:'system_alert',is_read:false,route:'/account/messages',
      data:{action:'admin_message',admin_sender_id:(req as any).adminUserId,route:'/account/messages'},metadata:{action:'admin_message',admin_sender_id:(req as any).adminUserId,route:'/account/messages'}
    }).select('id').single();
    if(error || !data) throw error || new Error('Message was not saved.');
    await NotificationService.pushSavedAdminMessage(userId,data.id,'customer').catch(error=>console.warn('[AdminCustomerMessage] push failed:',error?.message));
    return res.status(201).json({sent:true,messageId:data.id});
  }catch(error){console.error('[AdminCustomerMessage] save failed',error);return res.status(500).json({error:'Could not save the customer message.'});}
});

router.get('/heatmap', requireAdmin, async (req: Request, res: Response) => {
  try {
    const owner=await supabaseAdmin.from('profiles').select('tenant_id').eq('id',(req as any).adminUserId).single();
    if(owner.error||!owner.data)throw Error('Admin tenant could not be resolved');
    const tenant=owner.data.tenant_id;
    const scoped=(query:any)=>tenant===null?query.is('tenant_id',null):query.eq('tenant_id',tenant);
    const read=async(table:string,fields:string,filter:(q:any)=>any)=>{
      const rows:any[]=[];
      for(let offset=0;;offset+=500){const {data,error}=await filter(scoped(supabaseAdmin.from(table).select(fields))).order('id').range(offset,offset+499).abortSignal(AbortSignal.timeout(8000));if(error)throw error;rows.push(...(data||[]));if((data||[]).length<500)break;}
      return rows;
    };
    const cutoff=new Date(Date.now()-120000).toISOString();
    const [jobs,drivers]=await Promise.all([
      read('jobs','id,pickup_lat,pickup_lng',q=>q.eq('status','searching')),
      read('profiles','id,lat,lng,is_available,last_active_at',q=>q.eq('role','driver').eq('is_online',true))
    ]);
    const live:any[]=[];
    for(let offset=0;offset<drivers.length;offset+=100){
      const group=drivers.slice(offset,offset+100),ids=group.map(d=>d.id);
      const [presence,locations]=await Promise.all([
        supabaseAdmin.from('app_presence_sessions').select('user_id').in('user_id',ids).gt('seen_at',cutoff).abortSignal(AbortSignal.timeout(8000)),
        scoped(supabaseAdmin.from('driver_locations').select('driver_id,lat,lng,updated_at')).in('driver_id',ids).gt('updated_at',cutoff).order('updated_at',{ascending:false}).abortSignal(AbortSignal.timeout(8000))
      ]);
      if(presence.error||locations.error)throw presence.error||locations.error;
      const active=new Set((presence.data||[]).map(p=>p.user_id));
      for(const driver of group){if(!active.has(driver.id))continue;const location=(locations.data||[]).find(p=>p.driver_id===driver.id);if(location)live.push({...driver,lat:location.lat,lng:location.lng});else if(driver.last_active_at&&driver.last_active_at>cutoff)live.push(driver);}
    }
    res.setHeader('Cache-Control','no-store');
    return res.json({zones:demandZones(jobs,live),checkedAt:new Date().toISOString(),searchingRequests:jobs.length,locatedDrivers:live.length});
  } catch {
    return res.status(503).json({error:'Live demand map is temporarily unavailable.'});
  }
});

/**
 * Get platform metrics
 */
router.get('/metrics', requireAdmin, async (req: Request, res: Response) => {
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
router.get('/failures', requireAdmin, async (req: Request, res: Response) => {
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
router.get('/payments', requireAdmin, async (req: Request, res: Response) => {
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
router.get('/ops-health', requireAdmin, async (req: Request, res: Response) => {
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
router.get('/accounting-export', requireAdmin, async (req: Request, res: Response) => {
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
router.get('/payment/:id/timeline', requireAdmin, async (req: Request, res: Response) => {
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
router.post('/dispute', requireAdmin, async (req: Request, res: Response) => {
  const { bookingId, amount, reason, adminId } = req.body;
  
  try {
    const { data: job } = await supabaseAdmin
      .from('jobs')
      .select('*')
      .eq('id', bookingId)
      .single();

    if (!job) return res.status(404).json({ error: 'Booking not found' });
    if (!job.payment_intent_id) return res.status(400).json({ error: 'No payment intent found for this booking' });
    if (job.payment_status === 'refunded') return res.status(409).json({ error: 'Booking already refunded', refundId: job.metadata?.refund_id });

    const amountMinor = amount ? Math.round(amount * 100) : Math.round(Number(job.total_price || job.price || 0) * 100);
    const totalMinor = Math.round(Number(job.total_price || job.price || 0) * 100);
    const idempotencyKey = `admin-dispute-${bookingId}-${amountMinor}`;
    // Standard booking: the full fare is the service component (budget=0 for
    // non-errand jobs); the RPC enforces cumulative limits atomically.
    const reserved = await supabaseAdmin.rpc('reserve_refund_operation', {
      p_job_id: bookingId, p_amount_minor: amountMinor,
      p_captured_minor: totalMinor, p_service_fare_minor: totalMinor,
      p_idempotency_key: idempotencyKey, p_purpose: 'admin_dispute'
    });
    if (reserved.error || !reserved.data) {
      return res.status(409).json({ error: 'A refund operation is already reserved or in progress for this booking.', code: 'REFUND_RESERVED' });
    }
    const opId = reserved.data.id;

    // Refund outcome may be uncertain â€” reserve first, then mark executed
    // only on a definitive success. Never mark on timeout/unknown.
    try {
      const refund = await stripe.refunds.create(
        { payment_intent: job.payment_intent_id, amount: amountMinor, reason: 'requested_by_customer', metadata: { bookingId, reason, adminId, opId } },
        { idempotencyKey });
      const { error: markErr } = await supabaseAdmin.rpc('mark_refund_operation', { p_operation_id: opId, p_provider_id: refund.id, p_status: 'executed' });
      if (markErr) console.error('[DisputeRefund] mark_refund_operation failed:', markErr);
      const fullRefund = amountMinor >= totalMinor;
      // A partial refund must never mark payment_status='refunded'.
      const { error: updateErr } = await supabaseAdmin
        .from('jobs')
        .update({
          payment_status: fullRefund ? 'refunded' : 'requires_review',
          status: 'cancelled',
          metadata: { ...job.metadata, refund_id: refund.id, refund_reason: reason, partial_refund: !fullRefund }
        })
        .eq('id', bookingId);
      if (updateErr) {
        // Provider refund executed but local state write failed â€” the op stays
        // 'executed' (truthful); surface the inconsistency, never claim success.
        console.error('[DisputeRefund] local state write failed after provider refund:', updateErr);
        return res.status(500).json({ error: 'Refund executed but local state update failed. Reconciliation required.', code: 'LOCAL_STATE_WRITE_FAILED', refundId: refund.id, operationId: opId });
      }
      await AuditService.logAdminAction(adminId, 'refund_issued', 'booking', bookingId, { refundId: refund.id, amount, reason, operationId: opId, partial: !fullRefund });
      res.json({ success: true, refundId: refund.id, partial: !fullRefund });
    } catch (refundError: any) {
      // Preserve the reservation for unknown/timeout outcomes; release only
      // on a definitive Stripe rejection. charge_already_refunded means the
      // refund DID execute â€” mark executed, never release.
      if (refundError?.code === 'charge_already_refunded') {
        // The charge is refunded, but not necessarily by THIS operation or for
        // the expected amount â€” reconcile against Stripe's refund records
        // before recording completion.
        try {
          const list = await stripe.refunds.list({ payment_intent: job.payment_intent_id, limit: 20 });
          const matched = (list?.data || []).find((r: any) =>
            (r.metadata?.opId === opId || r.metadata?.bookingId === bookingId) &&
            (!amountMinor || Number(r.amount) === amountMinor));
          await supabaseAdmin.rpc('mark_refund_operation', {
            p_operation_id: opId, p_provider_id: matched?.id || null,
            p_status: matched ? 'executed' : 'unknown',
            p_error: matched ? null : 'charge_already_refunded_without_matching_operation'
          });
        } catch (reconcileError: any) {
          await supabaseAdmin.rpc('mark_refund_operation', { p_operation_id: opId, p_provider_id: null, p_status: 'unknown', p_error: 'reconciliation_unavailable' });
        }
      } else if (isDefinitiveStripeRejection(refundError)) {
        await supabaseAdmin.rpc('release_refund_operation', { p_operation_id: opId });
      } else {
        await supabaseAdmin.rpc('mark_refund_operation', { p_operation_id: opId, p_provider_id: null, p_status: 'unknown', p_error: String(refundError?.message || '').slice(0, 200) });
      }
      throw refundError;
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Account moderation â€” narrowly scoped to the existing account-status action.
 * Runs through the trusted Admin boundary (service_role) so the Admin UI never
 * performs a direct authenticated cross-row profile write. The acting admin is
 * derived server-side from the verified admin session, never from the body.
 */
router.post('/account-status', requireAdmin, async (req: Request, res: Response) => {
  const adminUserId = (req as any).adminUserId as string;
  const targetUserId = String(req.body?.userId || '').trim();
  const status = String(req.body?.status || '').trim();

  const allowedStatuses = ['active', 'closure_requested', 'closed', 'reinstated', 'suspended', 'banned', 'disabled'];
  if (!targetUserId) return res.status(400).json({ error: 'Target user is required.' });
  if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Invalid account status.' });

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    account_status: status,
    moderation_reason: String(req.body?.reason || '').trim(),
    moderated_at: now,
    moderated_by: adminUserId
  };

  if (status === 'closure_requested') {
    update.closure_requested_at = now;
    update.account_closure_requested_at = now;
    update.closure_notes = String(req.body?.reason || '').trim();
  }
  if (status === 'closed') {
    update.closed_at = now;
    update.closure_notes = String(req.body?.reason || '').trim();
    update.is_online = false;
    update.is_available = false;
  }
  if (['suspended', 'banned', 'disabled', 'closed'].includes(status)) {
    // Session revocation: ban_duration blocks token refresh so the session
    // cannot be extended; live access tokens still expire normally (â‰¤1h).
    // Combined with requireAuthenticatedUser's per-call status check, a
    // suspended account loses API access immediately.
    try {
      await supabaseAdmin.auth.admin.updateUserById(targetUserId, { ban_duration: '876000h' });
    } catch (e) {
      console.warn('[Admin] session revocation failed for suspended account:', (e as Error)?.message);
    }
    update.is_online = false;
    update.is_available = false;
  }
  if (status === 'active' || status === 'reinstated') {
    try {
      await supabaseAdmin.auth.admin.updateUserById(targetUserId, { ban_duration: 'none' });
    } catch (e) {
      console.warn('[Admin] session unban failed:', (e as Error)?.message);
    }
  }
  if (status === 'active') {
    update.reinstated_at = now;
    update.reinstated_by = adminUserId;
    update.reinstatement_notes = String(req.body?.reason || '').trim();
  }

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update(update)
    .eq('id', targetUserId)
    .select('id, account_status')
    .maybeSingle();

  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'User not found.' });

  return res.json({ ok: true, userId: targetUserId, account_status: data.account_status });
});

/**
 * Read-only purge preview (what would be removed vs retained). Fails closed.
 * Never mutates. Used by the admin UI before the destructive call.
 */
router.post('/test-account/purge/preview', requireAdmin, async (req: Request, res: Response) => {
  if (!isTestAccountPurgeEnabled()) {
    return res.status(403).json({ error: 'Test account purge is not enabled.', code: 'TEST_ACCOUNT_PURGE_DISABLED' });
  }
  const targetUserId = String(req.body?.userId || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetUserId)) {
    return res.status(400).json({ error: 'A valid user ID is required.', code: 'INVALID_USER_ID' });
  }
  const preview = await previewPurge(targetUserId);
  if (!preview) return res.status(404).json({ error: 'User not found.', code: 'USER_NOT_FOUND' });
  return res.json({ ok: true, preview });
});

/**
 * Permanently purge an UNUSED test account (pre-launch testing only).
 * Fails closed unless ALLOW_ADMIN_TEST_ACCOUNT_PURGE=true. Never accepts table
 * names/filters/instructions; only a target user id. Admin identity is derived
 * server-side from the verified admin session.
 */
router.post('/test-account/purge', requireAdmin, async (req: Request, res: Response) => {
  if (!isTestAccountPurgeEnabled()) {
    return res.status(403).json({ error: 'Test account purge is not enabled.', code: 'TEST_ACCOUNT_PURGE_DISABLED' });
  }

  const adminUserId = (req as any).adminUserId as string;
  const targetUserId = String(req.body?.userId || '').trim();

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetUserId)) {
    return res.status(400).json({ error: 'A valid user ID is required.', code: 'INVALID_USER_ID' });
  }

  // Explicit financial override must be a real boolean, never implicit.
  const allowFinancial = req.body?.allowFinancial === true;
  const outcome = await purgeTestAccount(adminUserId, targetUserId, { allowFinancial });

  switch (outcome.status) {
    case 'purged':
      return res.json({ ok: true, purged: true, recovered: outcome.recovered, removedJobs: outcome.removedJobs });
    case 'not_found':
      return res.status(404).json({ error: 'User not found.', code: 'USER_NOT_FOUND' });
    case 'blocked':
      return res.status(409).json({ error: outcome.reason, code: outcome.code });
    case 'error':
      return res.status(500).json({ error: outcome.message, code: 'PURGE_FAILED', removedJobs: outcome.removedJobs ?? 0, stage: outcome.stage ?? null });
  }
});

/**
 * Reset All Test Data â€” pre-launch development utility.
 * Two-phase: prepare (read-only preview + challenge) then execute.
 */
router.post('/test-data/reset/prepare', requireAdmin, async (req: Request, res: Response) => {
  if (!isTestAccountPurgeEnabled() || !isResetAllTestDataEnabled()) {
    return res.status(403).json({ error: 'Reset all test data is not enabled.', code: 'RESET_ALL_TEST_DATA_DISABLED' });
  }
  const adminUserId = (req as any).adminUserId as string;
  const preview = await resetPreview();
  const challenge = createResetChallenge(adminUserId);
  return res.json({ ...challenge, summary: preview });
});

router.post('/test-data/reset/execute', requireAdmin, async (req: Request, res: Response) => {
  if (!isTestAccountPurgeEnabled() || !isResetAllTestDataEnabled()) {
    return res.status(403).json({ error: 'Reset all test data is not enabled.', code: 'RESET_ALL_TEST_DATA_DISABLED' });
  }
  const adminUserId = (req as any).adminUserId as string;
  const challengeId = String(req.body?.challengeId || '').trim();
  const confirmation = String(req.body?.confirmation || '').trim();

  if (confirmation !== RESET_ALL_CONFIRMATION) {
    return res.status(400).json({ error: 'Confirmation phrase is incorrect.', code: 'INVALID_CONFIRMATION' });
  }
  if (!consumeResetChallenge(challengeId, adminUserId)) {
    return res.status(400).json({ error: 'Reset challenge is missing, expired, or already used.', code: 'INVALID_CHALLENGE' });
  }

  const result = await resetAllTestData();
  await AuditService.log({
    userId: adminUserId,
    action: 'admin_reset_all_test_data',
    entityType: 'test_data',
    metadata: {
      accountsRemoved: result.accountsRemoved,
      jobsRemoved: result.jobsRemoved,
      authDeletionFailures: result.authDeletionFailures,
      storageFailures: result.storageFailures
    }
  });
  return res.json({ ok: true, ...result });
});

/**
 * SLA Monitoring
 */
router.get('/sla', requireAdmin, async (req: Request, res: Response) => {
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
router.post('/process-payouts', requireAdmin, async (req: Request, res: Response) => {
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
router.post('/test-push', requireAdmin, async (req: Request, res: Response) => {
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
      body: body || 'This is a test push notification from Vaydu admin.',
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
router.get('/validate-push-subscription/:userId', requireAdmin, async (req: Request, res: Response) => {
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

async function adminTenantId(adminId: string | null | undefined): Promise<string | null> {
    if (!adminId) return null;
    const { data } = await supabaseAdmin.from('profiles').select('tenant_id').eq('id', adminId).maybeSingle();
    return (data as any)?.tenant_id || null;
}

export default router;

/** List inspection photos pending admin review. */
router.get('/inspection-photos', requireAdmin, async (req: Request, res: Response) => {
    const adminId = (req as any).adminId || (req as any).adminUserId || (req as any).user?.id || null;
    const tenant = await adminTenantId(adminId);
    if (!tenant) return res.status(403).json({ error: 'Admin tenant not resolved.' });
    const { data, error } = await supabaseAdmin
        .from('driver_vehicle_inspection_photos')
        .select('id,driver_id,slot,storage_path,status,byte_size,content_type,created_at')
        .eq('status', 'under_review')
        .eq('tenant_id', tenant)
        .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: 'Could not list inspection photos.' });
    // Issue short-lived signed URLs for private review â€” never public paths.
    const rows = await Promise.all((data || []).map(async (r: any) => {
        const { data: signed } = await supabaseAdmin.storage.from('driver-docs').createSignedUrl(r.storage_path, 300);
        return { ...r, review_url: signed?.signedUrl || null };
    }));
    return res.json({ photos: rows });
});

/** Approve or reject an inspection photo (audited). */
router.post('/inspection-photos/:id/review', requireAdmin, async (req: Request, res: Response) => {
    const adminId = (req as any).adminId || (req as any).adminUserId || (req as any).user?.id;
    const { status, reason } = req.body || {};
    if (!['approved', 'rejected'].includes(String(status))) return res.status(400).json({ error: 'status must be approved or rejected' });
    if (status === 'rejected' && !String(reason || '').trim()) return res.status(422).json({ error: 'A rejection reason is required.' });
    const tenant = await adminTenantId(adminId);
    if (!tenant) return res.status(403).json({ error: 'Admin tenant not resolved.' });
    const { data, error } = await supabaseAdmin
        .from('driver_vehicle_inspection_photos')
        .update({ status, reviewed_by: adminId, reviewed_at: new Date().toISOString(), rejection_reason: status === 'rejected' ? reason : null })
        .eq('id', req.params.id)
        .eq('status', 'under_review')
        .eq('tenant_id', tenant)
        .select('id,driver_id,slot')
        .maybeSingle();
    if (error) return res.status(500).json({ error: 'Could not update the photo review.' });
    if (!data) return res.status(409).json({ error: 'Photo is not pending review.', code: 'INSPECTION_NOT_PENDING' });
    await AuditService.logAdminAction(adminId, `inspection_${status}`, 'driver', data.driver_id, { photoId: data.id, slot: data.slot, reason: reason || null });
    return res.json({ success: true, photo: data });
});

/** Read/set a driver's completion PIN policy (audited; beats market setting). */
router.get('/drivers/:driverId/pin-policy', requireAdmin, async (req: Request, res: Response) => {
    const { data, error } = await supabaseAdmin
        .from('driver_pin_policies')
        .select('policy,set_by,set_at,reason')
        .eq('driver_id', req.params.driverId)
        .order('set_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Could not read the PIN policy.' });
    return res.json({ policies: data || [] });
});

router.post('/drivers/:driverId/pin-policy', requireAdmin, async (req: Request, res: Response) => {
    const adminId = (req as any).adminId || (req as any).adminUserId || (req as any).user?.id;
    const { policy, tenantId, reason } = req.body || {};
    if (!['required', 'optional', 'disabled'].includes(String(policy))) return res.status(400).json({ error: 'policy must be required, optional or disabled' });
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
    const { data, error } = await supabaseAdmin
        .from('driver_pin_policies')
        .upsert({ driver_id: req.params.driverId, tenant_id: tenantId, policy, set_by: adminId, set_at: new Date().toISOString(), reason: reason || null }, { onConflict: 'driver_id,tenant_id' })
        .select('driver_id,tenant_id,policy')
        .single();
    if (error) return res.status(500).json({ error: 'Could not save the PIN policy.' });
    await AuditService.logAdminAction(adminId, 'pin_policy_changed', 'driver', String(req.params.driverId), { policy: String(policy), tenantId: String(tenantId), reason: reason ? String(reason) : null });
    return res.json({ success: true, policy: data });
});

/** List + resolve customer receivables (waive/mark-paid/write-off after verification). */
router.get('/receivables', requireAdmin, async (req: Request, res: Response) => {
    const status: string = ['open','disputed','paid','waived','written_off'].includes(String(req.query.status)) ? String(req.query.status) : 'open';
    const { data, error } = await supabaseAdmin
        .from('customer_receivables')
        .select('id,customer_id,job_id,currency_code,amount_minor,reason,status,policy_version,dispute_reason,created_at')
        .eq('status', status === 'open' ? 'open' : status)
        .order('created_at', { ascending: false })
        .limit(200);
    if (error) return res.status(500).json({ error: 'Could not list receivables.' });
    return res.json({ receivables: data || [] });
});

router.post('/receivables/:id/resolve', requireAdmin, async (req: Request, res: Response) => {
    const adminId = (req as any).adminId || (req as any).adminUserId || (req as any).user?.id;
    const { status, reason, paymentReference, paymentProvider, merchantAccountRef } = req.body || {};
    if (!['paid','waived','written_off'].includes(String(status))) return res.status(400).json({ error: 'status must be paid, waived or written_off' });
    const ref = String(paymentReference || '').trim();
    const provider = String(paymentProvider || '').trim();
    const merchant = String(merchantAccountRef || '').trim();
    if (status === 'paid' && !ref) return res.status(422).json({ error: 'A verified payment reference is required to mark paid â€” never fabricate payment success.' });
    // The canonical binding is (provider, merchant_account_ref, reference) â€”
    // same scoping as job_payment_bindings. Without it, a reference cannot be
    // allocated to a merchant account and must be rejected.
    if (status === 'paid' && (!provider || !merchant)) return res.status(422).json({ error: 'paymentProvider and merchantAccountRef are required to bind the payment reference.', code: 'BINDING_INCOMPLETE' });
    if (status !== 'paid' && (ref || provider || merchant)) return res.status(400).json({ error: 'A payment reference is only valid when marking the receivable paid.', code: 'REFERENCE_ON_NON_PAYMENT' });

    // Read the receivable first: verification needs its owner/currency/amount.
    const { data: debt, error: readErr } = await supabaseAdmin
        .from('customer_receivables')
        .select('id,customer_id,tenant_id,currency_code,amount_minor,status')
        .eq('id', req.params.id)
        .maybeSingle();
    if (readErr || !debt) return res.status(404).json({ error: 'Receivable not found.' });
    if (!['open','disputed'].includes(debt.status)) return res.status(409).json({ error: 'Receivable is not open.', code: 'RECEIVABLE_NOT_OPEN' });

    // 'paid' requires provider-side verification: a typed-in reference is not
    // evidence. Retrieve the payment intent and check owner, currency, amount,
    // status and unique allocation before recording anything.
    if (status === 'paid') {
        const { stripe } = await import('../services/stripe.service');
        let intent: any;
        try {
            intent = await stripe.paymentIntents.retrieve(ref);
        } catch {
            return res.status(422).json({ error: 'Payment reference could not be verified with the provider.', code: 'REFERENCE_NOT_FOUND' });
        }
        const meta = intent?.metadata || {};
        const amountOk = Number(intent?.amount_received ?? intent?.amount) === Number(debt.amount_minor);
        const currencyOk = String(intent?.currency || '').toUpperCase() === String(debt.currency_code).toUpperCase();
        const ownerOk = !meta.customer_id || String(meta.customer_id) === String(debt.customer_id);
        if (intent?.status !== 'succeeded' || !amountOk || !currencyOk || !ownerOk) {
            return res.status(422).json({
                error: 'The provider payment does not match this receivable (status, owner, currency or amount).',
                code: 'REFERENCE_MISMATCH'
            });
        }
        // Unique allocation scoped by the canonical triple â€” the same
        // provider+merchant+reference cannot satisfy two receivables.
        const { data: existing } = await supabaseAdmin
            .from('customer_receivables')
            .select('id')
            .eq('payment_provider', provider)
            .eq('merchant_account_ref', merchant)
            .eq('payment_reference', ref)
            .neq('id', req.params.id)
            .maybeSingle();
        if (existing) return res.status(409).json({ error: 'This payment reference is already allocated to another receivable.', code: 'REFERENCE_REUSED' });
    }

    const { data, error } = await supabaseAdmin
        .from('customer_receivables')
        .update({ status, resolved_at: new Date().toISOString(), resolved_by: adminId, payment_reference: status === 'paid' ? ref : null, payment_provider: status === 'paid' ? provider : null, merchant_account_ref: status === 'paid' ? merchant : null })
        .eq('id', req.params.id)
        .in('status', ['open','disputed'])
        .select('id,customer_id,amount_minor,reason')
        .maybeSingle();
    if (error) {
        // 23505 + the specific constraint name â€” the payment_reference unique
        // index rejected a concurrent double-allocation. Any OTHER constraint
        // violation is a different failure and must stay a 500.
        const errAny = error as any;
        const isReferenceConflict = String(error.code || '') === '23505'
            && (String(errAny.constraint || '').includes('customer_receivables_ref_binding_uniq')
                || String(errAny.details || error.message || '').includes('customer_receivables_ref_binding_uniq'));
        if (isReferenceConflict) {
            return res.status(409).json({ error: 'This payment reference is already allocated to another receivable.', code: 'REFERENCE_REUSED' });
        }
        return res.status(500).json({ error: 'Could not resolve the receivable.' });
    }
    if (!data) return res.status(409).json({ error: 'Receivable is not open.', code: 'RECEIVABLE_NOT_OPEN' });
    await AuditService.logAdminAction(adminId, `receivable_${status}`, 'receivable', String(req.params.id), { customerId: data.customer_id, amountMinor: data.amount_minor, reason: reason || null, paymentReference: status === 'paid' ? ref : null });
    return res.json({ success: true, receivable: data });
});

/** Audit history for one receivable â€” admin only. */
router.get('/receivables/:id/audit', requireAdmin, async (req: Request, res: Response) => {
    const { data, error } = await supabaseAdmin
        .from('audit_logs')
        .select('id,action,entity_type,entity_id,metadata,created_at')
        .eq('entity_type', 'receivable')
        .eq('entity_id', String(req.params.id))
        .order('created_at', { ascending: false })
        .limit(50);
    if (error) return res.status(500).json({ error: 'Could not read the audit history.' });
    return res.json({ audit: data || [] });
});

/** Campaign CRUD â€” all fields required by policy; disabled by default. */
router.get('/campaigns', requireAdmin, async (req: Request, res: Response) => {
    const scope = await adminTenant(req);
    if (scope.error) return res.status(500).json({ error: scope.error });
    let query = supabaseAdmin
        .from('campaigns')
        .select('id,code,kind,market_code,currency_code,service_slug,audience,enabled,paused,version,valid_from,valid_until,budget_minor,spent_minor,funding_party,per_user_cap,usage_limit,stacking,value_type,value,referral_reward_bps,qualification,created_at,published_at,published_by')
        .order('created_at', { ascending: false });
    // Global admins may filter by tenant; tenant-scoped admins are pinned to theirs.
    query = scope.tenant !== null ? query.eq('tenant_id', scope.tenant) : query.eq('tenant_id', String(req.query.tenantId || ''));
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Could not list campaigns.' });
    return res.json({ campaigns: data || [] });
});

/** Campaign audit history (create/edit/status transitions). Tenant-scoped
 *  admins see only their own tenant's campaign audit trail. */
router.get('/campaigns/audit', requireAdmin, async (req: Request, res: Response) => {
    const scope = await adminTenant(req);
    if (scope.error) return res.status(500).json({ error: scope.error });
    let query = supabaseAdmin
        .from('audit_logs')
        .select('id,action,entity_id,metadata,created_at')
        .eq('entity_type', 'campaign')
        .order('created_at', { ascending: false })
        .limit(100);
    if (scope.tenant !== null) {
        query = query.eq('metadata->>tenant_id', scope.tenant);
    }
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Could not load the campaign audit.' });
    return res.json({ audit: data || [] });
});

const CAMPAIGN_KINDS = ['customer_discount', 'driver_incentive', 'referral'];
const CAMPAIGN_AUDIENCES = ['customer', 'driver', 'both'];
const CAMPAIGN_FUNDERS = ['platform', 'merchant', 'partner'];
const CAMPAIGN_VALUE_TYPES = ['percent', 'fixed_minor'];
const CAMPAIGN_STATES = ['enabled', 'paused', 'disabled'];

/**
 * Server-side campaign validation + defaults. Returns { row } on success or
 * { error } with a 400 message. Defaults: customer discounts are 5% percent,
 * referral rewards 500 bps (5%); nothing is ever enabled by omission.
 */
function campaignConfigFromBody(b: any, adminId: string): { row?: Record<string, unknown>; error?: string } {
    const code = String(b?.code || '').trim();
    if (!code || !/^[A-Za-z0-9_-]{1,64}$/.test(code)) return { error: 'code must be 1-64 alphanumeric/underscore/hyphen' };
    if (!CAMPAIGN_KINDS.includes(String(b?.kind))) return { error: 'invalid kind' };
    const market = String(b?.market_code || '').trim().toUpperCase();
    if (!/^[A-Z]{2,3}$/.test(market)) return { error: 'invalid market_code' };
    const currency = String(b?.currency_code || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return { error: 'invalid currency_code' };
    const service = String(b?.service_slug || '').trim();
    if (!service) return { error: 'service_slug is required' };
    if (!b?.tenant_id) return { error: 'tenant_id is required' };

    const audience = String(b?.audience || 'customer');
    if (!CAMPAIGN_AUDIENCES.includes(audience)) return { error: 'invalid audience' };
    const funding = String(b?.funding_party || 'platform');
    if (!CAMPAIGN_FUNDERS.includes(funding)) return { error: 'invalid funding_party' };
    const stacking = String(b?.stacking || 'exclusive');
    if (!['exclusive', 'stackable'].includes(stacking)) return { error: 'invalid stacking' };

    const valueType = b?.value_type ?? null;
    if (valueType != null && !CAMPAIGN_VALUE_TYPES.includes(String(valueType))) return { error: 'invalid value_type' };
    let value = b?.value != null ? Number(b.value) : null;
    if (value != null && (!Number.isFinite(value) || value < 0)) return { error: 'value must be >= 0' };
    if (valueType === 'percent') {
        if (value == null) value = 5; // approved default: 5% customer promotion
        if (value > 100) return { error: 'percent value must be <= 100' };
    }
    if (valueType === 'fixed_minor' && value != null && !Number.isInteger(value)) return { error: 'fixed_minor value must be an integer' };

    const referralBps = b?.referral_reward_bps != null ? Math.round(Number(b.referral_reward_bps)) : 500;
    if (!Number.isInteger(referralBps) || referralBps < 0 || referralBps > 10000) return { error: 'referral_reward_bps must be 0-10000' };

    const validFrom = b?.valid_from ? new Date(b.valid_from) : null;
    const validUntil = b?.valid_until ? new Date(b.valid_until) : null;
    if (validFrom && isNaN(validFrom.getTime())) return { error: 'invalid valid_from' };
    if (validUntil && isNaN(validUntil.getTime())) return { error: 'invalid valid_until' };
    if (validFrom && validUntil && validFrom > validUntil) return { error: 'valid_from must be <= valid_until' };

    const budgetMinor = Math.max(0, Number(b?.budget_minor || 0));
    if (!Number.isFinite(budgetMinor)) return { error: 'invalid budget_minor' };
    const perUserCap = Math.max(1, Number(b?.per_user_cap || 1));
    if (!Number.isInteger(perUserCap)) return { error: 'invalid per_user_cap' };
    const usageLimit = b?.usage_limit != null ? Number(b.usage_limit) : null;
    if (usageLimit != null && (!Number.isInteger(usageLimit) || usageLimit <= 0)) return { error: 'invalid usage_limit' };

    const qualification = b?.qualification && typeof b.qualification === 'object' ? b.qualification : {};
    for (const k of ['min_qualifying_fare_minor', 'max_discount_minor']) {
        if (qualification[k] != null && (!Number.isInteger(Number(qualification[k])) || Number(qualification[k]) < 0)) {
            return { error: `${k} must be a non-negative integer` };
        }
    }
    if (qualification.firstBookingOnly != null && typeof qualification.firstBookingOnly !== 'boolean') {
        return { error: 'firstBookingOnly must be boolean' };
    }
    if (qualification.max_rewards_per_month != null && (!Number.isInteger(Number(qualification.max_rewards_per_month)) || Number(qualification.max_rewards_per_month) <= 0)) {
        return { error: 'max_rewards_per_month must be a positive integer' };
    }

    const row: Record<string, unknown> = {
        tenant_id: b.tenant_id, code, kind: String(b.kind),
        market_code: market, currency_code: currency, service_slug: service,
        audience, enabled: b.enabled === true, paused: b.paused === true,
        valid_from: validFrom ? validFrom.toISOString() : null,
        valid_until: validUntil ? validUntil.toISOString() : null,
        budget_minor: budgetMinor, funding_party: funding,
        qualification, per_user_cap: perUserCap, usage_limit: usageLimit,
        stacking, value_type: valueType, value,
        referral_reward_bps: referralBps, version: 1, created_by: adminId
    };
    return { row };
}

/** Resolve the admin's tenant scope. null = global/super admin (no scope). */
async function adminTenant(req: Request): Promise<{ tenant: string | null; error?: string }> {
    const { data, error } = await supabaseAdmin.from('profiles').select('tenant_id').eq('id', (req as any).adminUserId).single();
    if (error || !data) return { tenant: null, error: 'Admin tenant could not be resolved' };
    return { tenant: data.tenant_id ?? null };
}

router.post('/campaigns', requireAdmin, async (req: Request, res: Response) => {
    const adminId = (req as any).adminUserId || (req as any).adminId || (req as any).user?.id;
    const parsed = campaignConfigFromBody(req.body || {}, adminId);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const scope = await adminTenant(req);
    if (scope.error) return res.status(500).json({ error: scope.error });
    // Tenant-scoped admins can never create for another tenant.
    if (scope.tenant !== null && String(parsed.row!.tenant_id) !== scope.tenant) {
        return res.status(403).json({ error: "You cannot manage another tenant's campaigns." });
    }
    if (scope.tenant !== null) parsed.row!.tenant_id = scope.tenant;
    const { data, error } = await supabaseAdmin.from('campaigns').insert(parsed.row).select('id,code,kind,enabled,version').single();
    if (error) return res.status(500).json({ error: 'Could not create the campaign.' });
    await AuditService.logAdminAction(adminId, 'campaign_created', 'campaign', data.id, parsed.row);
    return res.status(201).json({ campaign: data });
});

/** Edit campaign configuration -> new policy version. Existing applications
 *  and referrals keep their frozen rate/qualification; only NEW applications
 *  use the new version. */
router.post('/campaigns/:id', requireAdmin, async (req: Request, res: Response) => {
    const adminId = (req as any).adminUserId || (req as any).adminId || (req as any).user?.id;
    const parsed = campaignConfigFromBody(req.body || {}, adminId);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const scope = await adminTenant(req);
    if (scope.error) return res.status(500).json({ error: scope.error });
    const { data: existing, error: fetchErr } = await supabaseAdmin.from('campaigns').select('id,tenant_id,version').eq('id', req.params.id).maybeSingle();
    if (fetchErr) return res.status(500).json({ error: 'Could not load campaign.' });
    if (!existing) return res.status(404).json({ error: 'Campaign not found.' });
    if (scope.tenant !== null && existing.tenant_id !== scope.tenant) {
        return res.status(403).json({ error: "You cannot manage another tenant's campaigns." });
    }
    // Identity fields are immutable; config edits bump the version.
    const { tenant_id: _t, code: _c, kind: _k, enabled: _e, paused: _p, version: _v, created_by: _cb, ...editable } = parsed.row as Record<string, unknown>;
    const update: Record<string, unknown> = {
        ...editable,
        version: Number(existing.version) + 1,
        published_at: new Date().toISOString(),
        published_by: adminId
    };
    const { data, error } = await supabaseAdmin.from('campaigns').update(update).eq('id', req.params.id).select('id,code,version,value,referral_reward_bps').single();
    if (error) return res.status(500).json({ error: 'Could not update the campaign.' });
    await AuditService.logAdminAction(adminId, 'campaign_edited', 'campaign', String(req.params.id), { version: data.version, value: data.value, referral_reward_bps: data.referral_reward_bps, tenant_id: existing.tenant_id });
    return res.json({ campaign: data });
});

/** Tri-state lifecycle: enabled / paused / disabled. Pausing stops NEW
 *  applications only; it never erases accepted discounts, spent budget or
 *  earned/pending rewards. Each transition bumps the version and audits it. */
router.post('/campaigns/:id/status', requireAdmin, async (req: Request, res: Response) => {
    const adminId = (req as any).adminUserId || (req as any).adminId || (req as any).user?.id;
    const state = String(req.body?.state || '');
    if (!CAMPAIGN_STATES.includes(state)) return res.status(400).json({ error: 'state must be enabled, paused or disabled' });
    const scope = await adminTenant(req);
    if (scope.error) return res.status(500).json({ error: scope.error });
    const { data: existing, error: fetchErr } = await supabaseAdmin.from('campaigns').select('id,tenant_id,version').eq('id', req.params.id).maybeSingle();
    if (fetchErr) return res.status(500).json({ error: 'Could not load campaign.' });
    if (!existing) return res.status(404).json({ error: 'Campaign not found.' });
    if (scope.tenant !== null && existing.tenant_id !== scope.tenant) {
        return res.status(403).json({ error: "You cannot manage another tenant's campaigns." });
    }
    const update: Record<string, unknown> = {
        enabled: state === 'enabled' || state === 'paused',
        paused: state === 'paused',
        version: Number(existing.version) + 1,
        published_at: new Date().toISOString(),
        published_by: adminId
    };
    const { data, error } = await supabaseAdmin
        .from('campaigns')
        .update(update)
        .eq('id', req.params.id)
        .select('id,code,enabled,paused,version')
        .single();
    if (error) return res.status(500).json({ error: 'Could not update the campaign.' });
    await AuditService.logAdminAction(adminId, `campaign_${state}`, 'campaign', String(req.params.id), { state, version: data.version, tenant_id: existing.tenant_id });
    return res.json({ campaign: data });
});

/** Referral management: list + adjudicate (release/reverse/reject). */
router.get('/referrals', requireAdmin, async (req: Request, res: Response) => {
    const { data, error } = await supabaseAdmin
        .from('referrals')
        .select('id,campaign_id,referrer_id,referee_id,status,qualifying_job_id,reward_minor,created_at')
        .eq('tenant_id', String(req.query.tenantId || ''))
        .order('created_at', { ascending: false })
        .limit(500);
    if (error) return res.status(500).json({ error: 'Could not list referrals.' });
    return res.json({ referrals: data || [] });
});

router.post('/referrals/:id/adjudicate', requireAdmin, async (req: Request, res: Response) => {
    const adminId = (req as any).adminUserId || (req as any).adminId || (req as any).user?.id;
    const { status } = req.body || {};
    if (!['released','reversed','rejected'].includes(String(status))) return res.status(400).json({ error: 'status must be released, reversed or rejected' });

    // Reversal must also reverse the linked reward credit — atomic RPC, not a
    // bare status write. Non-reversible states (rejected/reversed) return unchanged.
    if (status === 'reversed') {
        const { data: referral, error: rpcError } = await supabaseAdmin.rpc('reverse_referral_reward', { p_referral: req.params.id });
        if (rpcError) return res.status(500).json({ error: 'Could not reverse the referral.' });
        const row = (Array.isArray(referral) ? referral[0] : referral) as any;
        if (!row || row.status !== 'reversed') {
            return res.status(409).json({ error: 'Referral is not in a transitionable state.', code: 'REFERRAL_STATE' });
        }
        await AuditService.logAdminAction(adminId, 'referral_reversed', 'referral', String(req.params.id), {});
        return res.json({ success: true, referral: row });
    }

    const { data, error } = await supabaseAdmin
        .from('referrals')
        .update({ status, resolved_at: new Date().toISOString(), resolved_by: adminId })
        .eq('id', req.params.id)
        .in('status', status === 'released' ? ['earned'] : ['pending','earned','released'])
        .select('id,referrer_id,status')
        .maybeSingle();
    if (error) return res.status(500).json({ error: 'Could not adjudicate the referral.' });
    if (!data) return res.status(409).json({ error: 'Referral is not in a transitionable state.', code: 'REFERRAL_STATE' });
    await AuditService.logAdminAction(adminId, `referral_${status}`, 'referral', String(req.params.id), {});
    return res.json({ success: true, referral: data });
});

/** Cash reassignment: atomic release old hold + transfer + reserve for the
 *  replacement driver. Failure preserves the original assignment/hold â€”
 *  the RPC raises and nothing is written. Audited operator action. */
router.post('/cash-jobs/:jobId/reassign', requireAdmin, async (req: Request, res: Response) => {
    const adminId = (req as any).adminId || (req as any).adminUserId || (req as any).user?.id;
    const newDriver = String(req.body?.newDriverId || '').trim();
    if (!newDriver) return res.status(400).json({ error: 'newDriverId is required' });
    const { data, error } = await supabaseAdmin.rpc('reassign_cash_job_credit_v1f', {
        p_job: String(req.params.jobId), p_new_driver: newDriver
    });
    if (error) {
        const msg = String(error.message || '');
        const sqlState = String((error as any).code || '');
        const code = (sqlState === 'CE004' || msg.includes('CE004') || /Top up driver cash credit/i.test(msg)) ? 'INSUFFICIENT_CREDIT'
          : (sqlState === 'CE005' || msg.includes('CE005') || /Cash already collected/i.test(msg)) ? 'CASH_COLLECTED'
          : (sqlState === 'CE006' || msg.includes('CE006') || /only before service starts|No held cash credit/i.test(msg)) ? 'NOT_REASSIGNABLE'
          : 'REASSIGN_REJECTED';
        return res.status(409).json({ error: msg, code });
    }
    await AuditService.logAdminAction(adminId, 'cash_reassign', 'job', String(req.params.jobId), { newDriverId: newDriver, holdId: data });
    return res.json({ success: true, holdId: data });
});

/** Cash early-stop: flag the disputed amount for operator review. The hold
 *  stays 'held'; review_due_at targets 24h; escalation is a flag â€” never
 *  an automatic release. Audited operator action. */
router.post('/cash-jobs/:jobId/review', requireAdmin, async (req: Request, res: Response) => {
    const adminId = (req as any).adminId || (req as any).adminUserId || (req as any).user?.id;
    const disputedMinor = Number(req.body?.disputedMinor);
    if (!Number.isFinite(disputedMinor) || disputedMinor <= 0) {
        return res.status(400).json({ error: 'disputedMinor is required' });
    }
    const { data, error } = await supabaseAdmin.rpc('flag_cash_hold_review_v1f', {
        p_job: String(req.params.jobId), p_disputed_minor: Math.round(disputedMinor)
    });
    if (error) {
        const msg = String(error.message || '');
        const code = msg.includes('CE006') ? 'NO_ACTIVE_HOLD' : 'REVIEW_REJECTED';
        return res.status(409).json({ error: msg, code });
    }
    await AuditService.logAdminAction(adminId, 'cash_review_flag', 'job', String(req.params.jobId), { disputedMinor });
    return res.json({ success: true, hold: data });
});

/** Publish a versioned cancellation policy: computes and persists
 *  debt_threshold_minor = reference_fare_minor * bps / 10000 at publish so
 *  later fare changes never silently alter the version. */
router.post('/policies/cancellation/publish', requireAdmin, async (req: Request, res: Response) => {
    const adminId = (req as any).adminId || (req as any).adminUserId || (req as any).user?.id;
    const { tenantId, market, referenceFareMinor, debtThresholdBps, graceSeconds, feeMinor, feeCapMinor, compensationPercent } = req.body || {};
    if (!tenantId || !market || !Number.isFinite(Number(referenceFareMinor)) || !Number.isFinite(Number(debtThresholdBps))) {
        return res.status(400).json({ error: 'tenantId, market, referenceFareMinor and debtThresholdBps are required' });
    }
    const { data, error } = await supabaseAdmin.rpc('publish_cancellation_policy', {
        p_tenant: String(tenantId), p_market: String(market),
        p_reference_fare_minor: Math.round(Number(referenceFareMinor)),
        p_debt_threshold_bps: Math.round(Number(debtThresholdBps)),
        p_grace_seconds: Math.round(Number(graceSeconds ?? 300)),
        p_fee_minor: Math.round(Number(feeMinor ?? 0)),
        p_fee_cap_minor: feeCapMinor == null ? null : Math.round(Number(feeCapMinor)),
        p_compensation_percent: Number(compensationPercent ?? 80),
        p_created_by: adminId
    });
    if (error) return res.status(500).json({ error: 'Could not publish the policy.' });
    await AuditService.logAdminAction(adminId, 'policy_publish', 'cancellation_policy', String(data?.id || ''), { market: String(market), version: data?.version, referenceFareMinor, debtThresholdBps });
    return res.json({ success: true, policy: data });
});

/** Versioned policy list + audit history for the publish UI. */
router.get('/policies/cancellation', requireAdmin, async (req: Request, res: Response) => {
    const { data, error } = await supabaseAdmin
        .from('cancellation_policies')
        .select('id,tenant_id,market,version,reference_fare_minor,debt_threshold_minor,grace_seconds,cancellation_fee_minor,fee_cap_minor,driver_compensation_percent,compensation_funding,enabled,created_at')
        .eq('tenant_id', String(req.query.tenantId || ''))
        .eq('market', String(req.query.market || ''))
        .order('version', { ascending: false })
        .limit(20);
    if (error) return res.status(500).json({ error: 'Could not list policies.' });
    return res.json({ policies: data || [] });
});

router.get('/policies/audit', requireAdmin, async (req: Request, res: Response) => {
    const { data, error } = await supabaseAdmin
        .from('audit_logs')
        .select('id,action,entity_id,metadata,created_at')
        .eq('entity_type', 'cancellation_policy')
        .order('created_at', { ascending: false })
        .limit(50);
    if (error) return res.status(500).json({ error: 'Could not load the audit history.' });
    return res.json({ audit: data || [] });
});

/** Margin preview: Vaydu net after platform-funded discount, referral
 *  liability and payment processing. Read-only â€” never activates anything. */
router.post('/policies/margin-preview', requireAdmin, async (req: Request, res: Response) => {
    const { fareSnapshot, discountMinor, referralLiabilityMinor, processingMinor } = req.body || {};
    if (!fareSnapshot || typeof fareSnapshot !== 'object') {
        return res.status(400).json({ error: 'fareSnapshot is required' });
    }
    const { data, error } = await supabaseAdmin.rpc('preview_vaydu_margin', {
        p_fare_snapshot: fareSnapshot,
        p_discount_minor: Math.round(Number(discountMinor ?? 0)),
        p_referral_liability_minor: Math.round(Number(referralLiabilityMinor ?? 0)),
        p_processing_minor: Math.round(Number(processingMinor ?? 0))
    });
    if (error) return res.status(500).json({ error: 'Could not compute the margin preview.' });
    return res.json({ preview: data });
});

/** Market-readiness report: validates pricing/currency/drivers/payment before
 *  any capability is enabled. Read-only â€” enables nothing. */
router.get('/market-readiness', requireAdmin, async (req: Request, res: Response) => {
    const tenantId = String(req.query.tenantId || '');
    const market = String(req.query.market || '');
    const service = String(req.query.service || 'ride');
    if (!tenantId || !market) return res.status(400).json({ error: 'tenantId and market are required' });
    try {
        const { reportMarketReadiness } = await import('../services/market-readiness.service');
        return res.json(await reportMarketReadiness(tenantId, market, service));
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Could not evaluate market readiness.' });
    }
});

