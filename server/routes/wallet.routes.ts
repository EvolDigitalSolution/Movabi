import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { MarketAvailabilityError, MarketAvailabilityService } from '../services/market-availability.service';

const router = Router();

async function getAuthUserId(req: Request): Promise<string | null> {
  const existing = (req as any).user?.id || (req as any).auth?.user?.id;
  if (existing) return String(existing);
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

/**
 * Get wallet transactions for a user
 */
router.get('/transactions', async (req: Request, res: Response) => {
  try {
    const { userId } = req.query;

    const authUserId = await getAuthUserId(req);
    if (!authUserId) return res.status(401).json({ error: 'Authentication required' });
    if (String(userId || '') !== authUserId) return res.status(403).json({ error: 'Cannot access another user wallet' });

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

    const authUserId = await getAuthUserId(req);
    if (!authUserId) return res.status(401).json({ error: 'Authentication required' });
    if (String(userId || '') !== authUserId) return res.status(403).json({ error: 'Cannot access another user wallet' });

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
    const { userId, jobId, currency, tenantId } = req.body || {};

    const authUserId = await getAuthUserId(req);
    if (!authUserId) return res.status(401).json({ error: 'Authentication required' });
    if (String(userId || '') !== authUserId) return res.status(403).json({ error: 'Cannot pay from another user wallet' });

    if (!userId || !jobId) {
      return res.status(400).json({ error: 'userId and jobId are required' });
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from('jobs')
      .select('customer_id, tenant_id, country_code, market_city, zone_id, currency_code, agreed_fare, total_price, estimated_price, price, fare_breakdown, metadata')
      .eq('id', jobId)
      .maybeSingle();
    if (jobError || !job) return res.status(404).json({ error: 'Job not found' });
    if (String(job.customer_id || '') !== String(userId)) return res.status(403).json({ error: 'Only the customer can pay for this job' });
    const breakdown = (job.fare_breakdown && typeof job.fare_breakdown === 'object') ? job.fare_breakdown as Record<string, unknown> : {};
    const metadata = (job.metadata && typeof job.metadata === 'object') ? job.metadata as Record<string, unknown> : {};
    try {
      await MarketAvailabilityService.requireCapability({ countryCode: job.country_code || metadata['country_code'], marketCity: job.market_city || metadata['market_city'] || metadata['pickup_city'],
        zoneId: job.zone_id || metadata['zone_id'], capability: 'payment', endpoint: '/api/wallet/pay-job' });
    } catch (availabilityError) {
      if (availabilityError instanceof MarketAvailabilityError) return res.status(availabilityError.httpStatus).json({ error: availabilityError.message, code: availabilityError.code, market: availabilityError.market });
      throw availabilityError;
    }
    const quoteReference = String((job as any).quote_id || metadata['quote_id'] || breakdown['quoteId'] || '').trim();
    const quoteExpiresAt = String(metadata['quote_expires_at'] || breakdown['quoteExpiresAt'] || '').trim();
    const quoteVersion = String(breakdown['calculationVersion'] || breakdown['marketPricingVersion'] || '').trim();
    if (!job.agreed_fare && (!quoteReference || !quoteVersion || !quoteExpiresAt || Date.parse(quoteExpiresAt) <= Date.now())) {
      return res.status(409).json({ error: 'Fare quote is missing or expired', code: 'QUOTE_EXPIRED' });
    }
    const paymentAmount = Number(
      job.agreed_fare ?? breakdown['totalAuthorisation'] ?? job.total_price ?? job.estimated_price ?? job.price ?? 0
    );
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) return res.status(400).json({ error: 'Job has no valid quoted amount' });

    const { data, error } = await supabaseAdmin.rpc('pay_job_from_wallet', {
      p_job_id: jobId,
      p_customer_id: userId,
      p_amount: Math.round((paymentAmount + Number.EPSILON) * 100) / 100,
      p_currency_code: String(job.currency_code || breakdown['currencyCode'] || currency || 'GBP').toUpperCase(),
      p_tenant_id: job.tenant_id || tenantId || null
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
