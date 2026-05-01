import { Router } from 'express';
import {
  createConnectAccount,
  createLoginLink,
  createOnboardingLink,
  getConnectAccountStatus
} from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';

export const connectRouter = Router();

const isUuid = (value: unknown): value is string => {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
};

const cleanTenantId = (value: unknown): string | null => {
  return isUuid(value) ? value : null;
};

const safeProfileUpdate = async (
  userId: string,
  updates: Record<string, unknown>
) => {
  const cleanUpdates = Object.entries(updates).reduce<Record<string, unknown>>(
    (acc, [key, value]) => {
      if (value === undefined) return acc;
      if (value === null) return acc;
      if (key === 'status') return acc;
      if (key === '_status') return acc;
      acc[key] = value;
      return acc;
    },
    {}
  );

  if (!Object.keys(cleanUpdates).length) return;

  const { error } = await supabaseAdmin
    .from('profiles')
    .update(cleanUpdates)
    .eq('id', userId);

  if (!error) return;

  const message = error.message || '';
  const missingColumn = message.match(/column "([^"]+)"/i)?.[1];

  if (error.code === '42703' && missingColumn && cleanUpdates[missingColumn] !== undefined) {
    const retryUpdates = { ...cleanUpdates };
    delete retryUpdates[missingColumn];

    if (!Object.keys(retryUpdates).length) return;

    const retry = await supabaseAdmin
      .from('profiles')
      .update(retryUpdates)
      .eq('id', userId);

    if (retry.error) throw retry.error;
    return;
  }

  throw error;
};

const getProfile = async (userId: string) => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, tenant_id, stripe_account_id, stripe_connect_status')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
};

const findProfileByStripeAccountId = async (accountId: string) => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, tenant_id, stripe_account_id, stripe_connect_status')
    .eq('stripe_account_id', accountId)
    .maybeSingle();

  if (error) throw error;
  return data;
};

const syncStripeAccountToProfile = async (
  accountId: string,
  userId?: string
) => {
  const status = await getConnectAccountStatus(accountId);

  const connectStatus =
    status.charges_enabled && status.payouts_enabled
      ? 'connected'
      : status.status === 'restricted'
        ? 'restricted'
        : 'pending';

  let profileId = userId || '';

  if (!profileId) {
    const profile = await findProfileByStripeAccountId(accountId);
    profileId = profile?.id || '';
  }

  if (profileId) {
    await safeProfileUpdate(profileId, {
      stripe_account_id: accountId,
      stripe_connect_status: connectStatus,
      updated_at: new Date().toISOString()
    });
  }

  return {
    ...status,
    status: connectStatus
  };
};

connectRouter.post('/create-account', async (req, res) => {
  try {
    const { userId, email, tenantId } = req.body || {};

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const profile = await getProfile(userId);

    if (!profile) {
      return res.status(404).json({ error: 'Driver profile not found' });
    }

    if (profile.stripe_account_id) {
      const status = await syncStripeAccountToProfile(
        profile.stripe_account_id,
        userId
      );

      return res.json({
        stripe_account_id: profile.stripe_account_id,
        status
      });
    }

    const validTenantId =
      cleanTenantId(tenantId) ||
      cleanTenantId(profile.tenant_id);

    const account = await createConnectAccount(
      userId,
      email,
      validTenantId || undefined
    );

    await safeProfileUpdate(userId, {
      stripe_account_id: account.id,
      stripe_connect_status: 'pending',
      updated_at: new Date().toISOString()
    });

    return res.json({
      stripe_account_id: account.id
    });
  } catch (error: any) {
    console.error('Create Connect Account Error:', error);
    return res.status(500).json({
      error: error?.message || 'Failed to create Stripe Connect account'
    });
  }
});

connectRouter.post('/onboarding-link', async (req, res) => {
  try {
    const { accountId, returnUrl, refreshUrl } = req.body || {};

    if (!accountId) return res.status(400).json({ error: 'accountId is required' });
    if (!returnUrl) return res.status(400).json({ error: 'returnUrl is required' });
    if (!refreshUrl) return res.status(400).json({ error: 'refreshUrl is required' });

    const link = await createOnboardingLink(accountId, returnUrl, refreshUrl);

    return res.json({ url: link.url });
  } catch (error: any) {
    console.error('Create Onboarding Link Error:', error);
    return res.status(500).json({
      error: error?.message || 'Failed to create onboarding link'
    });
  }
});

connectRouter.post('/dashboard-link', async (req, res) => {
  try {
    const { accountId } = req.body || {};

    if (!accountId) return res.status(400).json({ error: 'accountId is required' });

    const link = await createLoginLink(accountId);

    return res.json({ url: link.url });
  } catch (error: any) {
    console.error('Create Dashboard Link Error:', error);
    return res.status(500).json({
      error: error?.message || 'Failed to create dashboard link'
    });
  }
});

connectRouter.get('/account-status/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;

    if (!accountId) return res.status(400).json({ error: 'accountId is required' });

    const status = await syncStripeAccountToProfile(accountId);

    return res.json(status);
  } catch (error: any) {
    console.error('Get Connect Account Status Error:', error);
    return res.status(500).json({
      error: error?.message || 'Failed to fetch Stripe account status'
    });
  }
});

connectRouter.post('/refresh-account-status', async (req, res) => {
  try {
    const { accountId, userId } = req.body || {};

    if (!accountId) return res.status(400).json({ error: 'accountId is required' });

    const status = await syncStripeAccountToProfile(accountId, userId);

    return res.json(status);
  } catch (error: any) {
    console.error('Refresh Connect Account Status Error:', error);
    return res.status(500).json({
      error: error?.message || 'Failed to refresh Stripe account status'
    });
  }
});

export default connectRouter;
