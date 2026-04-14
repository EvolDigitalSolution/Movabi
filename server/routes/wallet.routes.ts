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
      .select('balance')
      .eq('user_id', userId)
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    console.error('Error fetching wallet balance:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
