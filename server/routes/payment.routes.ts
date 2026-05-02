import { Router, Request, Response } from 'express';
import { stripe } from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';
import { dispatchService } from '../services/dispatch.service';
import { PricingService } from '../services/pricing.service';
import { FraudService } from '../services/fraud.service';
import { CityService } from '../services/city.service';
import { EmailService } from '../services/email.service';

const router = Router();

function money(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function currency(v: any): string {
  return String(v || 'GBP').toLowerCase();
}

router.post('/calculate-price', async (req: Request, res: Response) => {
  try {
    const {
      lat,
      lng,
      basePrice,
      distanceKm,
      serviceType,
      serviceSlug,
      countryCode,
      currencyCode,
      pricingPlan
    } = req.body;

    const city = await CityService.findCityForLocation(Number(lat), Number(lng));

    const pricing = await PricingService.resolvePrice({
      lat: Number(lat),
      lng: Number(lng),
      basePrice: Number(basePrice || 0),
      distanceKm: Number(distanceKm || 0),
      serviceSlug: serviceSlug || serviceType || 'ride',
      countryCode: countryCode || (city as any)?.country_code || (city as any)?.country || 'GB',
      currencyCode,
      pricingPlan: pricingPlan || 'starter',
      city
    });

    const stats = await dispatchService.getAreaStats(Number(lat), Number(lng));
    const surge = PricingService.getSurgeMultiplier(stats.demand, stats.supply);
    const totalPrice = Number((pricing.basePrice * surge).toFixed(2));

    return res.json({
      basePrice: pricing.basePrice,
      totalPrice,
      surgeMultiplier: surge,
      currencyCode: pricing.currencyCode,
      currencySymbol: pricing.currencySymbol,
      countryCode: pricing.countryCode,
      pricingSource: pricing.source
    });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed to calculate price' });
  }
});

router.post('/create-intent', async (req: Request, res: Response) => {
  try {
    const { jobId, tenantId, surgeMultiplier } = req.body;

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
        payment_method,
        payment_intent_id,
        price,
        estimated_price,
        currency_code,
        currency_symbol,
        country_code
      `)
      .eq('id', jobId)
      .maybeSingle();

    if (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to fetch job' });
    }

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
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
      money(job.price) ||
      money(job.estimated_price) ||
      money(req.body.amount);

    if (!amount) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const pi = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: currency(job.currency_code),
      payment_method_types: ['card'],
      capture_method: 'manual',
      metadata: {
        jobId: String(job.id),
        tenantId: String(tenantId || job.tenant_id || ''),
        surgeMultiplier: String(surgeMultiplier || 1)
      }
    });

    await supabaseAdmin
      .from('jobs')
      .update({
        payment_intent_id: pi.id,
        payment_status: 'authorized',
        payment_method: 'card',
        surge_multiplier: Number(surgeMultiplier || 1)
      })
      .eq('id', jobId);

    return res.json({
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      amount,
      currency: currency(job.currency_code).toUpperCase()
    });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Failed to create payment intent' });
  }
});

router.post('/create-wallet-topup-intent', async (req: Request, res: Response) => {
  try {
    const { amount, currency: cur, userId, tenantId } = req.body;

    const pi = await stripe.paymentIntents.create({
      amount: Math.round(Number(amount) * 100),
      currency: currency(cur),
      payment_method_types: ['card'],
      metadata: {
        userId: String(userId || ''),
        tenantId: String(tenantId || ''),
        type: 'wallet_topup'
      }
    });

    return res.json({
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id
    });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

router.post('/refund', async (req: Request, res: Response) => {
  try {
    const { paymentIntentId } = req.body;

    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId
    });

    return res.json({
      success: true,
      refundId: refund.id
    });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

export default router;
