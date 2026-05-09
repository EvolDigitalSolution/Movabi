import { Router, Request, Response } from 'express';
import { stripe } from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';

const router = Router();

async function getUserIdFromRequest(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!token) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data?.user?.id) {
    console.error('[Connect] auth failed:', error?.message);
    return null;
  }

  return data.user.id;
}

async function getStripeAccountId(userId: string): Promise<string | null> {
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

router.post('/dashboard-link', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);

    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const accountId = await getStripeAccountId(userId);

    if (!accountId) {
      return res.status(400).json({
        error: 'Stripe Connect account not found for this driver'
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

    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const accountId = await getStripeAccountId(userId);

    if (!accountId) {
      return res.status(400).json({
        error: 'Stripe Connect account not found for this driver'
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
