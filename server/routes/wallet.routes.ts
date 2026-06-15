import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';

const router = Router();

/**
 * Get wallet transactions for a user
 */
router.get('/transactions', async (req: Request, res: Response) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const { data, error } = await supabaseAdmin
      .from('wallet_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    console.error('Error fetching wallet transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get wallet balance for a user
 */
router.get('/balance', async (req: Request, res: Response) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const { data, error } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    console.error('Error fetching wallet balance:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Reserve/pay a job from wallet balance through a trusted database function.
 */
router.post('/pay-job', async (req: Request, res: Response) => {
  try {
    const { userId, jobId, amount, currency, tenantId } = req.body || {};
    const paymentAmount = Number(amount);

    if (!userId || !jobId) {
      return res.status(400).json({ error: 'userId and jobId are required' });
    }

    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({ error: 'amount must be greater than zero' });
    }

    const { data, error } = await supabaseAdmin.rpc('pay_job_from_wallet', {
      p_job_id: jobId,
      p_customer_id: userId,
      p_amount: Math.round((paymentAmount + Number.EPSILON) * 100) / 100,
      p_currency_code: currency || 'GBP',
      p_tenant_id: tenantId || null
    });

    if (error) {
      console.error('[WalletRoutes] pay-job RPC failed:', error);
      const status = /insufficient/i.test(error.message) ? 402 : 400;
      return res.status(status).json({
        error: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
      });
    }

    res.json({
      success: true,
      paymentMethod: 'wallet',
      amount: paymentAmount,
      data
    });
  } catch (error: any) {
    console.error('Error paying job from wallet:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
