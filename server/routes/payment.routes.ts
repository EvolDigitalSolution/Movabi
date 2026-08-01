import { Router, Request, Response } from 'express';
import { stripe } from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';
import { dispatchService } from '../services/dispatch.service';
import { PricingService } from '../services/pricing.service';
import { CityService } from '../services/city.service';
import { GlobalAiPricingService } from '../services/global-ai-pricing.service';

const router = Router();

async function getAuthUserId(req: Request): Promise<string | null> {
  const existing = (req as any).user?.id || (req as any).auth?.user?.id;
  if (existing) return String(existing);

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) {
    console.warn('[PaymentRoutes] auth token decode failed:', error?.message || 'No user on token');
    return null;
  }

  return data.user.id;
}

function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : 0;
}

function currency(value: unknown): string {
  const c = String(value || 'GBP').trim().toLowerCase();
  return c.length >= 3 ? c : 'gbp';
}

function currencyExponent(currencyCode: unknown): number {
  const zeroDecimal = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
  const threeDecimal = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);
  const code = String(currencyCode || '').toUpperCase();
  if (zeroDecimal.has(code)) return 0;
  if (threeDecimal.has(code)) return 3;
  return 2;
}

function minorToMajor(minor: number, currencyCode: unknown): number {
  return Number((Number(minor || 0) / Math.pow(10, currencyExponent(currencyCode))).toFixed(currencyExponent(currencyCode)));
}

function canonicalServiceSlug(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase();

  if (['shop', 'shopping', 'errands', 'errand'].includes(raw)) return 'errand';
  if (['courier', 'parcel', 'package', 'delivery'].includes(raw)) return 'delivery';
  if (['van', 'moving', 'move', 'van-moving', 'van moving', 'van_moving'].includes(raw)) return 'van-moving';
  if (['ride', 'rides'].includes(raw)) return 'ride';

  return raw;
}

function metadataObject(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, any>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function resolveJobServiceSlug(job: any, body: any): string {
  const serviceType = Array.isArray(job?.service_type) ? job.service_type[0] : job?.service_type;
  const metadata = metadataObject(job?.metadata);

  return canonicalServiceSlug(
    serviceType?.slug ||
    metadata.serviceSlug ||
    metadata.service_slug ||
    body?.serviceSlug ||
    body?.service_type
  );
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
      zoneId,
      driverTier,
      vehicleClass,
      requestedAt
    } = req.body;

    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }

    const city = await CityService.findCityForLocation(Number(lat), Number(lng));
    const stats = await dispatchService.getAreaStats(Number(lat), Number(lng));

    const pricingInput = {
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
      zoneId: zoneId || cityZone || null,
      driverTier: driverTier || null,
      vehicleClass: vehicleClass || null,
      demand: stats.demand,
      supply: stats.supply,
      requestedAt: requestedAt || new Date().toISOString()
    };
    const { legacyPricing: pricing, quote: globalAiPricing } = await GlobalAiPricingService.resolveQuote(pricingInput);
    const aiTotalPrice = globalAiPricing.ai.livePricingEnabled
      ? minorToMajor(globalAiPricing.ai.finalTotalMinor, globalAiPricing.market.currency)
      : pricing.totalPrice;

    return res.json({
      basePrice: pricing.basePrice,
      totalPrice: aiTotalPrice,
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
      marketplaceFlags: pricing.marketplaceFlags,
      globalAiPricing
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

    const authUserId = await getAuthUserId(req);
    if (!authUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { data: job, error } = await supabaseAdmin
      .from('jobs')
      .select('*, service_type:service_types(*)')
      .eq('id', jobId)
      .maybeSingle();

    if (error) {
      console.error('[PaymentRoutes] fetch job failed with service role:', {
        authUserId,
        jobId,
        serviceClient: 'supabaseAdmin',
        queryError: error
      });
      const statusCode = error.code === '22P02' || error.code === '42703' ? 400 : 500;
      return res.status(statusCode).json({
        error: 'Failed to fetch job with service role',
        details: error.message,
        code: error.code
      });
    }

    if (!job) {
      console.warn('[PaymentRoutes] create-intent job not found:', {
        authUserId,
        jobId,
        serviceClient: 'supabaseAdmin',
        queryError: null
      });
      return res.status(404).json({ error: 'Job not found' });
    }

    if (String(job.customer_id || '') !== authUserId) {
      return res.status(403).json({ error: 'Only the customer can pay for this job' });
    }

    console.log('[PaymentRoutes] create-intent auth/job', {
      authUserId,
      jobId,
      jobCustomerId: job.customer_id,
      serviceClient: 'supabaseAdmin',
      queryError: null
    });

    const status = String(job.status || '').toLowerCase();

    if (['completed', 'cancelled', 'canceled', 'settled'].includes(status)) {
      return res.status(400).json({ error: `Cannot pay job with status ${job.status}` });
    }

    const paymentStatus = String(job.payment_status || '').toLowerCase();
    const alreadyPaid = ['authorized', 'requires_capture', 'succeeded', 'captured', 'paid', 'wallet_funded'].includes(paymentStatus);
    const alreadyDispatched = ['searching', 'broadcasting', 'waiting', 'assigned', 'accepted', 'arrived', 'heading_to_pickup', 'driver_en_route', 'driver_arrived', 'picked_up', 'in_progress', 'arrived_at_store', 'shopping_in_progress', 'collected', 'en_route_to_customer', 'delivered', 'paid', 'paid_ready_for_dispatch'].includes(status);

    if (alreadyPaid || alreadyDispatched) {
      return res.status(400).json({ error: 'Payment has already been handled for this job' });
    }

    if (job.payment_intent_id) {
      try {
        const existing = await stripe.paymentIntents.retrieve(job.payment_intent_id);

        return res.json({
          clientSecret: existing.client_secret,
          paymentIntentId: existing.id,
          status: existing.status,
          reused: true
        });
      } catch (retrieveError: any) {
        console.warn('[PaymentRoutes] existing payment intent could not be reused:', {
          jobId,
          paymentIntentId: job.payment_intent_id,
          message: retrieveError?.message
        });
        return res.status(400).json({
          error: 'Existing payment could not be reused',
          details: 'Please refresh the booking and try payment again.'
        });
      }
    }

    const serviceSlug = resolveJobServiceSlug(job, req.body);
    const isErrandLike = serviceSlug === 'errand';

    const serviceFare =
      money(job.agreed_fare) ||
      money(job.total_price) ||
      money(job.estimated_price) ||
      money(job.price) ||
      money(req.body.amount);

    let itemBudget = 0;
    if (isErrandLike) {
      const [{ data: errandDetails }, { data: errandFunding }] = await Promise.all([
        supabaseAdmin.from('errand_details').select('estimated_budget').eq('job_id', jobId).maybeSingle(),
        supabaseAdmin.from('errand_funding').select('amount_reserved').eq('job_id', jobId).maybeSingle()
      ]);
      itemBudget = money(errandFunding?.amount_reserved) || money(errandDetails?.estimated_budget) || 0;
    }

    const totalAuthorisation = serviceFare + itemBudget;

    console.log('[PaymentRoutes] create-intent amount', {
      jobId,
      service_type_slug: (Array.isArray(job.service_type) ? job.service_type[0] : job.service_type)?.slug || null,
      resolved_service_slug: serviceSlug,
      agreed_fare: job.agreed_fare,
      price: job.price,
      total_price: job.total_price,
      estimated_price: job.estimated_price,
      requestAmount: req.body.amount,
      itemBudget,
      finalAmount: totalAuthorisation
    });

    if (!Number.isFinite(totalAuthorisation) || totalAuthorisation <= 0) {
      return res.status(400).json({
        error: 'Invalid job amount',
        details: 'The job does not have a valid fare to authorise.'
      });
    }

    let pi;
    try {
      pi = await stripe.paymentIntents.create({
        amount: Math.round(totalAuthorisation * 100),
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
    } catch (stripeError: any) {
      console.error('[PaymentRoutes] Stripe payment intent create failed:', {
        jobId,
        service_type_slug: (Array.isArray(job.service_type) ? job.service_type[0] : job.service_type)?.slug || null,
        resolved_service_slug: serviceSlug,
        finalAmount: totalAuthorisation,
        message: stripeError?.message,
        type: stripeError?.type
      });
      return res.status(400).json({
        error: stripeError?.message || 'Failed to create card payment',
        details: 'Stripe could not create a payment for this booking amount.'
      });
    }

    const essentialUpdatePayload: Record<string, unknown> = {
      payment_intent_id: pi.id,
      payment_status: 'pending',
      payment_method: 'card'
    };

    const optionalUpdatePayload: Record<string, unknown> = {
      surge_multiplier: Number(surgeMultiplier || 1)
    };

    // The job's price/total_price remains the agreed service fare; the payment intent
    // authorises serviceFare + itemBudget. Shopping budget is reserved separately in errand_funding.

    if (fareBreakdown && typeof fareBreakdown === 'object') {
      optionalUpdatePayload.fare_breakdown = fareBreakdown;
      optionalUpdatePayload.commission_rate_used = (fareBreakdown as any)?.commissionPercent ?? null;
      optionalUpdatePayload.dynamic_pricing_multiplier = (fareBreakdown as any)?.multiplier ?? 1;
    }

    if (marketplaceFlags && typeof marketplaceFlags === 'object') {
      optionalUpdatePayload.marketplace_flags = marketplaceFlags;
      optionalUpdatePayload.negotiation_mode_enabled = (marketplaceFlags as any)?.negotiationEnabled ?? false;
      optionalUpdatePayload.bid_mode_enabled = (marketplaceFlags as any)?.biddingEnabled ?? false;
    }

    const { error: updateError } = await supabaseAdmin
      .from('jobs')
      .update({ ...essentialUpdatePayload, ...optionalUpdatePayload })
      .eq('id', jobId);

    if (updateError) {
      console.warn('[PaymentRoutes] full payment update failed, retrying essential fields only:', {
        jobId,
        message: updateError.message
      });

      const { error: essentialUpdateError } = await supabaseAdmin
        .from('jobs')
        .update(essentialUpdatePayload)
        .eq('id', jobId);

      if (essentialUpdateError) {
        console.error('[PaymentRoutes] essential payment update failed:', essentialUpdateError);
        return res.status(400).json({
          error: 'Failed to update job payment',
          details: essentialUpdateError.message
        });
      }
    }

    if (isErrandLike && itemBudget > 0) {
      const { error: fundingError } = await supabaseAdmin
        .from('errand_funding')
        .upsert({
          job_id: jobId,
          customer_id: job.customer_id,
          amount_reserved: itemBudget,
          status: 'reserved',
          over_budget_status: 'none',
          over_budget_amount: 0,
          metadata: { source: 'card_authorisation', service_fare: serviceFare }
        }, { onConflict: 'job_id' });

      if (fundingError) {
        console.warn('[PaymentRoutes] errand_funding upsert failed:', fundingError);
      }
    }

    return res.json({
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      amount: totalAuthorisation,
      serviceFare,
      itemBudget,
      currency: currency(job.currency_code || req.body.currency || 'GBP').toUpperCase()
    });
  } catch (error: any) {
    console.error('[PaymentRoutes] create-intent failed:', error);
    const message = String(error?.message || '');
    const statusCode = message.includes('service_slug') || message.includes('amount') ? 400 : 500;
    return res.status(statusCode).json({ error: message || 'Failed to create payment intent' });
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
