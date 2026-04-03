import { Router, Request, Response } from 'express';
import { 
  createConnectAccount, 
  createOnboardingLink, 
  createLoginLink 
} from '../services/stripe.service';
import { getSupabaseAdmin } from '../services/supabase.service';
import { EventService } from '../services/event.service';

const router = Router();
const supabase = getSupabaseAdmin();

/**
 * Create a Stripe Connect account for a driver
 */
router.post('/create-account', async (req: Request, res: Response) => {
  try {
    const { userId, email, tenantId } = req.body;
    if (!userId || !email || !tenantId) {
      return res.status(400).json({ error: 'userId, email, and tenantId required' });
    }

    // Check if account already exists
    const { data: existingAccount } = await supabase
      .from('driver_accounts')
      .select('stripe_account_id')
      .eq('user_id', userId)
      .single();

    if (existingAccount) {
      return res.json({ stripe_account_id: existingAccount.stripe_account_id });
    }

    const account = await createConnectAccount(userId, email);
    
    const { error } = await supabase
      .from('driver_accounts')
      .insert({
        user_id: userId,
        tenant_id: tenantId,
        stripe_account_id: account.id
      });

    if (error) throw error;

    await EventService.logEvent('connect_account_created', { userId, accountId: account.id }, tenantId, userId);

    res.json({ stripe_account_id: account.id });
  } catch (error: any) {
    console.error('Create Connect Account Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get onboarding link
 */
router.post('/onboarding-link', async (req: Request, res: Response) => {
  try {
    const { accountId, returnUrl, refreshUrl } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    const link = await createOnboardingLink(accountId, returnUrl, refreshUrl);
    res.json(link);
  } catch (error: any) {
    console.error('Onboarding Link Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get dashboard link
 */
router.post('/dashboard-link', async (req: Request, res: Response) => {
  try {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });

    const link = await createLoginLink(accountId);
    res.json(link);
  } catch (error: any) {
    console.error('Dashboard Link Error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
