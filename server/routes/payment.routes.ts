import { Router, Request, Response } from 'express';
import { stripe } from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';
import { dispatchService } from '../services/dispatch.service';
import { PricingService } from '../services/pricing.service';
import { CityService } from '../services/city.service';

const router = Router();

function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : 0;
}

function currency(value: unknown): string {
  const c = String(value || 'GBP').trim().toLowerCase();
  return c.length >= 3 ? c : 'gbp';
}

router.post('/calculate-price', async (req: Request, res: Response) => {
  try {
    const {
      lat,
      lng,
      basePrice,
      distanceKm,
      durationMinutes,
      durationSeconds,
      serviceType,
      serviceSlug,
      countryCode,
      currencyCode,
      pricingPlan,
      tenantId,
      cityZone,
      driverTier,
      requestedAt
    } = req.body;

    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }

    const city = await CityService.findCityForLocation(Number(lat), Number(lng));
    const stats = await dispatchService.getAreaStats(Number(lat), Number(lng));

    const pricing = await PricingService.resolvePrice({
      lat: Number(lat),
      lng: Number(lng),
      basePrice: basePrice !== undefined ? Number(basePrice) : undefined,
      distanceKm: distanceKm !== undefined ? Number(distanceKm) : undefined,
      durationMinutes: durationMinutes !== undefined
        ? Number(durationMinutes)
        : (durationSeconds !== undefined ? Number(durationSeconds) / 60 : undefined),
      serviceSlug: serviceSlug || serviceType || 'ride',
      countryCode: countryCode || (city as any)?.country_code || (city as any)?.country || 'GB',
      currencyCode,
      pricingPlan: pricingPlan || 'starter',
      city,
      tenantId: tenantId || null,
      cityZone: cityZone || city?.name || null,
      driverTier: driverTier || null,
      demand: stats.demand,
      supply: stats.supply,
      requestedAt: requestedAt || new Date().toISOString()
    });

    return res.json({
      basePrice: pricing.basePrice,
      totalPrice: pricing.totalPrice,
      surgeMultiplier: pricing.surgeMultiplier,
      dynamicPricingMultiplier: pricing.dynamicPricingMultiplier,
      demand: stats.demand,
      supply: stats.supply,
      city: city?.name || 'Unknown',
      pricingSource: pricing.source,
      countryCode: pricing.countryCode,
      currencyCode: pricing.currencyCode,
      currencySymbol: pricing.currencySymbol,
      pricingPlanUsed: pricing.pricingPlanUsed,
      regionalPricingRuleId: pricing.regionalPricingRuleId,
      taxAmount: pricing.taxAmount,
      platformFee: pricing.platformFee,
      commissionFee: pricing.commissionFee,
      driverPayout: pricing.driverPayout,
      commissionRateUsed: pricing.commissionRateUsed,
      baseFareUsed: pricing.baseFareUsed,
      pricePerKmUsed: pricing.pricePerKmUsed,
      fareBreakdown: pricing.fareBreakdown,
      marketplaceFlags: pricing.marketplaceFlags
    });
  } catch (error: any) {
    console.error('[PaymentRoutes] calculate-price failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to calculate price' });
  }
});

router.post('/create-intent', async (req: Request, res: Response) => {
  try {
    const { jobId, tenantId, surgeMultiplier, fareBreakdown, marketplaceFlags } = req.body;

    if (!jobId) {
      return res.status(400).json({ error: 'jobId is required' });
    }

    const { data: job, error } = await supabaseAdmin
      .from('jobs')
      .select(`
        id,
        customer_id,
        tenant_id,
        status,
        payment_status,
        payment_intent_id,
        agreed_fare,
        price,
        total_price,
        estimated_price,
        currency_code,
        currency_symbol,
        country_code
      `)
      .eq('id', jobId)
      .maybeSingle();

    if (error) {
      console.error('[PaymentRoutes] fetch job failed:', error);
      return res.status(500).json({ error: 'Failed to fetch job', details: error.message });
    }

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const status = String(job.status || '').toLowerCase();

    if (['completed', 'cancelled', 'canceled', 'settled'].includes(status)) {
      return res.status(400).json({ error: `Cannot pay job with status ${job.status}` });
    }

    if (job.payment_intent_id) {
      const existing = await stripe.paymentIntents.retrieve(job.payment_intent_id);

      return res.json({
        clientSecret: existing.client_secret,
        paymentIntentId: existing.id,
        reused: true
      });
    }

    const amount =
      money(job.agreed_fare) ||
      money(job.total_price) ||
      money(job.estimated_price) ||
      money(job.price) ||
      money(req.body.amount);

    if (!amount) {
      return res.status(400).json({ error: 'Invalid job amount' });
    }

    const pi = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: currency(job.currency_code || req.body.currency || 'GBP'),
      payment_method_types: ['card'],
      capture_method: 'manual',
      metadata: {
        jobId: String(job.id),
        tenantId: String(tenantId || job.tenant_id || ''),
        purpose: 'job_payment',
        capturePolicy: 'capture_only_when_job_completed',
        surgeMultiplier: String(surgeMultiplier || 1),
        countryCode: String(job.country_code || ''),
        currencySymbol: String(job.currency_symbol || '')
      }
    });

    const updatePayload: Record<string, unknown> = {
      payment_intent_id: pi.id,
      payment_status: 'authorized',
      payment_method: 'card',
      surge_multiplier: Number(surgeMultiplier || 1),
      price: amount,
      total_price: amount,
      estimated_price: amount
    };

    if (fareBreakdown && typeof fareBreakdown === 'object') {
      updatePayload.fare_breakdown = fareBreakdown;
      updatePayload.commission_rate_used = (fareBreakdown as any)?.commissionPercent ?? null;
      updatePayload.dynamic_pricing_multiplier = (fareBreakdown as any)?.multiplier ?? 1;
    }

    if (marketplaceFlags && typeof marketplaceFlags === 'object') {
      updatePayload.marketplace_flags = marketplaceFlags;
      updatePayload.negotiation_mode_enabled = (marketplaceFlags as any)?.negotiationEnabled ?? false;
      updatePayload.bid_mode_enabled = (marketplaceFlags as any)?.biddingEnabled ?? false;
    }

    const { error: updateError } = await supabaseAdmin
      .from('jobs')
      .update(updatePayload)
      .eq('id', jobId);

    if (updateError) {
      console.error('[PaymentRoutes] update job failed:', updateError);
      return res.status(500).json({ error: 'Failed to update job payment', details: updateError.message });
    }

    return res.json({
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      amount,
      currency: currency(job.currency_code || req.body.currency || 'GBP').toUpperCase()
    });
  } catch (error: any) {
    console.error('[PaymentRoutes] create-intent failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to create payment intent' });
  }
});

router.post('/create-wallet-topup-intent', async (req: Request, res: Response) => {
  try {
    const { userId, amount, currency: cur, tenantId } = req.body;

    const topupAmount = money(amount);

    if (!userId || !topupAmount) {
      return res.status(400).json({ error: 'userId and positive amount are required' });
    }

    const pi = await stripe.paymentIntents.create({
      amount: Math.round(topupAmount * 100),
      currency: currency(cur || 'GBP'),
      payment_method_types: ['card'],
      metadata: {
        userId: String(userId),
        tenantId: String(tenantId || ''),
        type: 'wallet_topup'
      }
    });

    return res.json({
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id
    });
  } catch (error: any) {
    console.error('[PaymentRoutes] wallet topup failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to create wallet top-up intent' });
  }
});

router.post('/confirm-wallet-topup', async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, userId, amount } = req.body || {};
    const requestedAmount = money(amount);

    if (!paymentIntentId || !userId || !requestedAmount) {
      return res.status(400).json({ error: 'paymentIntentId, userId and positive amount are required' });
    }

    const pi = await stripe.paymentIntents.retrieve(String(paymentIntentId));
    const metadataUserId = String(pi.metadata?.userId || '');
    const metadataType = String(pi.metadata?.type || pi.metadata?.purpose || '');
    const stripeAmount = money((pi.amount_received || pi.amount) / 100);

    if (pi.status !== 'succeeded') {
      return res.status(402).json({ error: `Stripe payment is not complete. Current status: ${pi.status}` });
    }

    if (metadataType !== 'wallet_topup') {
      return res.status(400).json({ error: 'PaymentIntent is not a wallet top-up' });
    }

    if (metadataUserId !== String(userId)) {
      return res.status(403).json({ error: 'PaymentIntent does not belong to this user' });
    }

    if (stripeAmount < requestedAmount) {
      return res.status(400).json({ error: 'Stripe amount is lower than requested wallet top-up amount' });
    }

    const { data, error } = await supabaseAdmin.rpc('finalize_wallet_topup', {
      p_user_id: userId,
      p_amount: stripeAmount,
      p_payment_intent_id: pi.id,
      p_description: 'Wallet top-up (Stripe verified)'
    });

    if (error) {
      console.error('[PaymentRoutes] confirm-wallet-topup RPC failed:', error);
      return res.status(400).json({
        error: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
      });
    }

    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    return res.json({
      success: true,
      paymentIntentId: pi.id,
      amount: stripeAmount,
      wallet,
      processed: data
    });
  } catch (error: any) {
    console.error('[PaymentRoutes] confirm-wallet-topup failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to confirm wallet top-up' });
  }
});

router.post('/refund', async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, amount, jobId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'paymentIntentId is required' });
    }

    const params: any = { payment_intent: paymentIntentId };

    if (amount) {
      params.amount = Math.round(Number(amount) * 100);
    }

    const refund = await stripe.refunds.create(params);

    if (jobId) {
      await supabaseAdmin
        .from('jobs')
        .update({
          payment_status: 'refunded',
          refund_id: refund.id
        })
        .eq('id', jobId);
    }

    return res.json({ success: true, refundId: refund.id });
  } catch (error: any) {
    console.error('[PaymentRoutes] refund failed:', error);
    return res.status(500).json({ error: error.message || 'Refund failed' });
  }
});

export default router;
