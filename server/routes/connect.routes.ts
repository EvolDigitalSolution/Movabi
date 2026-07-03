import { Router, Request, Response } from 'express';
import { stripe } from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';

const router = Router();

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

  return {
    refreshUrl: `${WEB_DRIVER_URL}?stripe=refresh`,
    returnUrl: `${WEB_DRIVER_URL}?stripe=success`
  };
}

async function getUserIdFromRequest(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (token) {
    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (!error && data?.user?.id) {
      return data.user.id;
    }

    console.warn('[Connect] bearer auth failed:', error?.message);
  }

  return String(req.body?.userId || '').trim() || null;
}

async function getStripeAccountId(req: Request, userId: string | null): Promise<string | null> {
  const bodyAccountId = String(req.body?.accountId || '').trim();

  if (bodyAccountId) {
    return bodyAccountId;
  }

  if (!userId) return null;

  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.error('[Connect] profile lookup failed:', error.message);
    return null;
  }

  return (
    profile?.stripe_account_id ||
    profile?.stripe_connect_account_id ||
    profile?.stripe_connected_account_id ||
    profile?.stripe_connect_id ||
    null
  );
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

    const account = await stripe.accounts.retrieve(accountId);
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
    const email = String(req.body?.email || '').trim();
    const tenantId = String(req.body?.tenantId || '').trim() || null;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const existingAccountId = await getStripeAccountId(req, userId);

    if (existingAccountId) {
      const account = await stripe.accounts.retrieve(existingAccountId);
      const mapped = mapStripeStatus(account);
      await updateProfileStripeStatus(userId, existingAccountId, mapped);

      return res.json({
        stripe_account_id: existingAccountId,
        status: mapped
      });
    }

    const account = await stripe.accounts.create({
      type: 'express',
      country: 'GB',
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
    const accountId = String(req.params.accountId || '').trim();

    if (!accountId) {
      return res.status(400).json({ error: 'Stripe account not found' });
    }

    const account = await stripe.accounts.retrieve(accountId);
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

    const account = await stripe.accounts.retrieve(accountId);
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
