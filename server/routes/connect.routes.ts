import { Router, Request, Response } from 'express';
import { stripe } from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';

const router = Router();

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
      await supabaseAdmin
        .from('profiles')
        .update({
          stripe_account_id: accountId,
          stripe_connect_status: mapped.status,
          charges_enabled: mapped.charges_enabled,
          payouts_enabled: mapped.payouts_enabled,
          updated_at: new Date().toISOString()
        })
        .eq('id', userId);
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
