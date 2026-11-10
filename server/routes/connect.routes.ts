import { Router, Request, Response } from 'express';
import { stripe } from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';
import { DriverOnboardingNotificationService } from '../services/driver-onboarding-notification.service';
import { PayoutEligibilityService, SUPPORTED_PAYOUT_COUNTRIES } from '../services/payout-eligibility.service';

const router = Router();
// All Connect routes are owner-bound, including status and dashboard reads.
router.use(async(req:Request,res:Response,next)=>{
 res.setHeader('Cache-Control','private, no-store');
 try{
  const id=await getUserIdFromRequest(req);if(!id)return res.status(401).json({error:'Authentication required'});
  const {data:profile,error}=await supabaseAdmin.from('profiles').select('*').eq('id',id).maybeSingle();
  if(error)throw error;
  const country=String(profile?.registration_country_code||profile?.country_code||'').toUpperCase();
  if(!profile||profile.role!=='driver'||!profile.registration_activated_at||!PayoutEligibilityService.isSupportedCountry(country))
   return res.status(403).json({error:'Payout setup is not activated for this driver market.',code:'PAYOUT_MARKET_UNAVAILABLE'});
  const accountId=String(profile.stripe_account_id||profile.stripe_connect_account_id||profile.stripe_connected_account_id||profile.stripe_connect_id||'');
  const supplied=String(req.body?.accountId||req.params?.accountId||(req.path.startsWith('/account-status/')?req.path.split('/')[2]:'')).trim();
  if(supplied&&supplied!==accountId)return res.status(403).json({error:'Payout account unavailable.',code:'PAYOUT_ACCOUNT_MISMATCH'});
  if(req.body?.userId&&String(req.body.userId)!==id)return res.status(403).json({error:'Driver identity mismatch.'});
  (req as any).connectOwnerId=id;(req as any).connectOwnerProfile=profile;
  if(accountId){
   const account=await stripe.accounts.retrieve(accountId);
   if(account.metadata?.user_id && String(account.metadata.user_id)!==id)return res.status(403).json({error:'Payout account owner does not match this driver.',code:'PAYOUT_ACCOUNT_OWNER_MISMATCH'});
   if(!PayoutEligibilityService.isSupportedCountry(account.country)||String(account.country).toUpperCase()!==country)
    return res.status(403).json({error:'Payout account country does not match your driver market.',code:'PAYOUT_ACCOUNT_COUNTRY_MISMATCH'});
   (req as any).connectVerifiedAccount=account;
  }
  return next();
 }catch{return res.status(503).json({error:'Payout account could not be verified. Please retry.'});}
});

type ConnectPlatform = 'web' | 'android' | 'ios' | 'native';

const WEB_DRIVER_URL = 'https://movabi.apps.evolsolution.com/driver';
const NATIVE_DRIVER_URL = 'com.movabi.app://driver';

function normalizePlatform(platform: unknown): ConnectPlatform {
  const value = String(platform || 'web').trim().toLowerCase();

  if (value === 'android' || value === 'ios' || value === 'native') {
    return value;
  }

  return 'web';
}

function buildConnectReturnUrls(req: Request) {
  const platform = normalizePlatform(req.body?.platform);
  const isNative = platform === 'android' || platform === 'ios' || platform === 'native';

  if (isNative) {
    return {
      refreshUrl: `${NATIVE_DRIVER_URL}?stripe=refresh`,
      returnUrl: `${NATIVE_DRIVER_URL}?stripe=success`
    };
  }

  const appUrl = new URL(String(process.env.APP_URL || WEB_DRIVER_URL));
  const allowedOrigins = new Set([appUrl.origin]);
  const testMode = String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_');

  if (testMode) {
    allowedOrigins.add('https://movabi-develop.apps.evolsolution.com');
    allowedOrigins.add('http://localhost:3000');
    allowedOrigins.add('http://localhost:4200');
    allowedOrigins.add('http://localhost:8100');
  }

  const requestedOrigin = String(req.headers.origin || appUrl.origin);
  if (!allowedOrigins.has(requestedOrigin)) {
    throw new Error('Stripe onboarding return origin is not allowed');
  }

  return {
    refreshUrl: `${requestedOrigin}/driver?stripe=refresh`,
    returnUrl: `${requestedOrigin}/driver?stripe=success`
  };
}

async function getUserIdFromRequest(req: Request): Promise<string | null> {
  if((req as any).connectOwnerId)return (req as any).connectOwnerId;
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (token) {
    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (!error && data?.user?.id) {
      return data.user.id;
    }

    console.warn('[Connect] bearer auth failed:', error?.message);
  }

  return null;
}

async function getStripeAccountId(req: Request, userId: string | null): Promise<string | null> {
  if(!userId || userId!==(req as any).connectOwnerId)throw new Error('Payout owner could not be verified');
  const profile=(req as any).connectOwnerProfile;
  const own=String(profile?.stripe_account_id||profile?.stripe_connect_account_id||profile?.stripe_connected_account_id||profile?.stripe_connect_id||'');
  const supplied=String(req.body?.accountId||req.params?.accountId||'').trim();
  if(supplied && supplied!==own)throw new Error('Payout account mismatch');
  return own||null;
}

function mapStripeStatus(account: any) {
  const chargesEnabled = Boolean(account.charges_enabled);
  const payoutsEnabled = Boolean(account.payouts_enabled);
  const detailsSubmitted = Boolean(account.details_submitted);

  let status: 'not_started' | 'pending' | 'restricted' | 'enabled' | 'connected' = 'pending';

  if (chargesEnabled && payoutsEnabled) {
    status = 'connected';
  } else if (
    account.requirements?.currently_due?.length ||
    account.requirements?.past_due?.length ||
    account.requirements?.disabled_reason
  ) {
    status = 'restricted';
  } else if (detailsSubmitted || chargesEnabled || payoutsEnabled) {
    status = 'pending';
  } else {
    status = 'not_started';
  }

  return {
    stripe_account_id: account.id,
    onboarding_complete: chargesEnabled && payoutsEnabled,
    payouts_enabled: payoutsEnabled,
    charges_enabled: chargesEnabled,
    details_submitted: detailsSubmitted,
    status,
    requirements: account.requirements || null
  };
}

function listRequirementsDue(account: any): string[] {
  const requirements = account?.requirements || {};
  const values = [
    ...(Array.isArray(requirements.currently_due) ? requirements.currently_due : []),
    ...(Array.isArray(requirements.past_due) ? requirements.past_due : []),
    ...(Array.isArray(requirements.pending_verification) ? requirements.pending_verification : [])
  ];

  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean)));
}

async function updateProfileStripeStatus(userId: string, accountId: string, mapped: ReturnType<typeof mapStripeStatus>) {
  const { data: previous } = await supabaseAdmin.from('profiles').select('stripe_connect_status').eq('id', userId).maybeSingle();
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({
      stripe_account_id: accountId,
      stripe_connect_status: mapped.status,
      charges_enabled: mapped.charges_enabled,
      payouts_enabled: mapped.payouts_enabled,
      updated_at: new Date().toISOString()
    })
    .eq('id', userId);

  if (error) {
    console.error('[Connect] profile Stripe status update failed:', error.message);
  } else if (mapped.status === 'connected' && previous?.stripe_connect_status !== 'connected') {
    DriverOnboardingNotificationService.enqueue(userId, {
      eventKey: `stripe:${userId}:${accountId}:connected`, eventType: 'driver_stripe_connected',
      affectedItem: 'stripe_connect', previousStatus: previous?.stripe_connect_status || 'not_started', newStatus: 'connected'
    }).catch(notificationError => console.warn('[Connect] Stripe onboarding notification enqueue failed:', notificationError));
  }
}

router.get('/payout-settings', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const accountId = await getStripeAccountId(req, userId);

    console.log('[Connect] payout-settings route hit', {
      userId,
      accountIdPresent: Boolean(accountId)
    });

    if (!accountId) {
      return res.json({
        ok: true,
        stripeAccountId: null,
        connectStatus: 'not_started',
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        requirementsCurrentlyDue: []
      });
    }

    const account = (req as any).connectVerifiedAccount || await stripe.accounts.retrieve(accountId);
    const mapped = mapStripeStatus(account);

    await updateProfileStripeStatus(userId, accountId, mapped);

    console.log('[Connect] payout-settings stripe state', {
      userId,
      accountIdPresent: true,
      chargesEnabled: mapped.charges_enabled,
      payoutsEnabled: mapped.payouts_enabled,
      detailsSubmitted: mapped.details_submitted,
      status: mapped.status
    });

    return res.json({
      ok: true,
      stripeAccountId: accountId,
      connectStatus: mapped.status,
      chargesEnabled: mapped.charges_enabled,
      payoutsEnabled: mapped.payouts_enabled,
      detailsSubmitted: mapped.details_submitted,
      requirementsCurrentlyDue: listRequirementsDue(account)
    });
  } catch (error: any) {
    console.error('[Connect] payout-settings failed:', error);
    return res.status(500).json({
      error: error?.message || 'Failed to load payout settings'
    });
  }
});

router.post('/create-account', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    const email = String((req as any).connectOwnerProfile?.email || '').trim();
    const tenantId = String((req as any).connectOwnerProfile?.tenant_id || '').trim() || null;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // UK-only payout scope: verify role, registration activation and the driver's
    // authoritative country BEFORE onboarding. Fails closed. A fresh driver with
    // no connected account yet (NO_STRIPE_ACCOUNT) is allowed through to create.
    const eligibility = await PayoutEligibilityService.evaluateDriver(userId, null);
    if (!eligibility.eligible && !['NO_STRIPE_ACCOUNT','ACCOUNT_NOT_READY'].includes(String(eligibility.code))) {
      return res.status(403).json({ error: eligibility.reason || 'Driver is not eligible for payouts.', code: eligibility.code });
    }

    const existingAccountId = await getStripeAccountId(req, userId);

    if (existingAccountId) {
      const account = (req as any).connectVerifiedAccount || await stripe.accounts.retrieve(existingAccountId);
      // Never trust a hard-coded or locally-mirrored country: verify the ACTUAL
      // connected account country before reusing the account.
      if (!PayoutEligibilityService.isSupportedCountry(account.country)) {
        return res.status(403).json({ error: 'Connected account country is not supported in this release.', code: 'PAYOUT_COUNTRY_UNSUPPORTED' });
      }
      const mapped = mapStripeStatus(account);
      await updateProfileStripeStatus(userId, existingAccountId, mapped);

      return res.json({
        stripe_account_id: existingAccountId,
        status: mapped
      });
    }

    const account = await stripe.accounts.create({
      type: 'express',
      country: String((req as any).connectOwnerProfile.registration_country_code || (req as any).connectOwnerProfile.country_code).toUpperCase(),
      email: email || undefined,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      },
      business_type: 'individual',
      metadata: {
        user_id: userId,
        tenant_id: tenantId || ''
      }
    });

    const mapped = mapStripeStatus(account);
    await updateProfileStripeStatus(userId, account.id, mapped);

    return res.json({
      stripe_account_id: account.id,
      status: mapped
    });
  } catch (error: any) {
    console.error('[Connect] create-account failed:', error);
    return res.status(500).json({
      error: error?.message || 'Failed to create Stripe Connect account'
    });
  }
});

router.post('/onboarding-link', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    const accountId = await getStripeAccountId(req, userId);
    const { returnUrl, refreshUrl } = buildConnectReturnUrls(req);

    if (!accountId) {
      return res.status(400).json({ error: 'Stripe Connect account not found' });
    }

    if (!returnUrl || !refreshUrl) {
      return res.status(400).json({ error: 'Stripe onboarding return and refresh URLs are required' });
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding'
    });

    return res.json({ url: accountLink.url });
  } catch (error: any) {
    console.error('[Connect] onboarding-link failed:', error);
    return res.status(500).json({
      error: error?.message || 'Failed to create Stripe onboarding link'
    });
  }
});

router.get('/account-status/:accountId', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    const accountId = await getStripeAccountId(req, userId);

    if (!accountId) {
      return res.status(400).json({ error: 'Stripe account not found' });
    }

    const account = (req as any).connectVerifiedAccount || await stripe.accounts.retrieve(accountId);
    const mapped = mapStripeStatus(account);

    if (userId) {
      await updateProfileStripeStatus(userId, accountId, mapped);
    }

    return res.json(mapped);
  } catch (error: any) {
    console.error('[Connect] account-status failed:', error);
    return res.status(500).json({
      error: error?.message || 'Failed to read Stripe account status'
    });
  }
});

router.post('/refresh-account-status', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    const accountId = await getStripeAccountId(req, userId);

    if (!accountId) {
      return res.status(400).json({
        error: 'Stripe account not found'
      });
    }

    const account = (req as any).connectVerifiedAccount || await stripe.accounts.retrieve(accountId);
    const mapped = mapStripeStatus(account);

    if (userId) {
      await updateProfileStripeStatus(userId, accountId, mapped);
    }

    return res.json(mapped);
  } catch (error: any) {
    console.error('[Connect] refresh-account-status failed:', error);
    return res.status(500).json({
      error: error?.message || 'Failed to refresh Stripe account status'
    });
  }
});

router.post('/dashboard-link', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    const accountId = await getStripeAccountId(req, userId);

    if (!accountId) {
      return res.status(400).json({
        error: 'Stripe Connect account not found'
      });
    }

    const loginLink = await stripe.accounts.createLoginLink(accountId);
    return res.json({ url: loginLink.url });
  } catch (error: any) {
    console.error('[Connect] dashboard-link failed:', error);
    return res.status(500).json({
      error: error?.message || 'Failed to create Stripe dashboard link'
    });
  }
});

router.post('/login-link', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    const accountId = await getStripeAccountId(req, userId);

    if (!accountId) {
      return res.status(400).json({
        error: 'Stripe Connect account not found'
      });
    }

    const loginLink = await stripe.accounts.createLoginLink(accountId);
    return res.json({ url: loginLink.url });
  } catch (error: any) {
    console.error('[Connect] login-link failed:', error);
    return res.status(500).json({
      error: error?.message || 'Failed to create Stripe login link'
    });
  }
});

export default router;
