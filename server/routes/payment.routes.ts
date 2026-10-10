import { Router, Request, Response } from 'express';
import { stripe } from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';
import { dispatchService } from '../services/dispatch.service';
import { PricingService } from '../services/pricing.service';
import { CityService } from '../services/city.service';
import { GlobalAiPricingService } from '../services/global-ai-pricing.service';
import { MarketAvailabilityError, MarketAvailabilityService } from '../services/market-availability.service';
import { PaymentAuthorityService } from '../services/payment-authority.service';
import { TransferReversalService } from '../services/transfer-reversal.service';
import { FareSplitService } from '../services/fare-split.service';
import { isDefinitiveStripeRejection } from '../services/stripe-errors';
import { randomUUID } from 'node:crypto';

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
    const { jobId, tenantId, surgeMultiplier } = req.body;

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
    try {
      const locationMetadata = metadataObject(job.metadata);
      await MarketAvailabilityService.requireCapability({ countryCode: job.country_code || locationMetadata.country_code,
        marketCity: job.market_city || locationMetadata.market_city || locationMetadata.pickup_city,
        zoneId: job.zone_id || locationMetadata.zone_id, capability: 'payment', endpoint: '/api/payment/create-intent' });
    } catch (availabilityError) {
      if (availabilityError instanceof MarketAvailabilityError) return res.status(availabilityError.httpStatus).json({ error: availabilityError.message, code: availabilityError.code, market: availabilityError.market });
      throw availabilityError;
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

    // ---------------------------------------------------------------------
    // NEGOTIATED AGREEMENT DEADLINE (server authority).
    //
    // A fare agreed through negotiation is payable ONLY until the persisted
    // payment window closes. The browser is never trusted for this: a stale or
    // tampered client must not be able to authorise payment after the deadline,
    // and a superseded/released/cancelled agreement must never be payable.
    // Checked BEFORE PaymentIntent reuse so an expired agreement cannot even
    // resume an existing intent.
    // ---------------------------------------------------------------------
    const agreedFareMajor = Number(job.agreed_fare);
    if (Number.isFinite(agreedFareMajor) && agreedFareMajor > 0) {
      const { data: agreedSession } = await supabaseAdmin
        .from('marketplace_negotiation_sessions')
        .select('id,status,agreed_fare,active_driver_id,payment_deadline,expires_at')
        .eq('job_id', jobId)
        .maybeSingle();

      if (agreedSession) {
        const agreementStatus = String((agreedSession as any).status || '').toLowerCase();
        const deadlineRaw = String(
          (agreedSession as any).payment_deadline || (agreedSession as any).expires_at || ''
        ).trim();
        const deadlineMs = deadlineRaw ? Date.parse(deadlineRaw) : NaN;
        const deadlinePassed = Number.isFinite(deadlineMs) && deadlineMs <= Date.now();

        if (agreementStatus !== 'fare_agreed') {
          return res.status(409).json({
            error: 'This fare agreement is no longer valid. Start the negotiation again.',
            code: 'AGREEMENT_NOT_ACTIVE'
          });
        }

        if (deadlinePassed) {
          // PERSIST the authoritative expiry transition HERE, at the payment
          // boundary. Never merely report the expiry while leaving the session
          // fare_agreed, the driver attached and the deadline stale — that state
          // would otherwise only converge if some driver happened to open Driver
          // Hub. The helper is idempotent, locked and paid-guarded.
          const { error: expireError } = await supabaseAdmin.rpc('expire_unpaid_fare_agreement', {
            p_session_id: (agreedSession as any).id
          });

          if (expireError) {
            console.error('[PaymentRoutes] authoritative agreement expiry failed:', {
              jobId,
              sessionId: (agreedSession as any).id,
              code: (expireError as any)?.code,
              message: expireError.message
            });
          }

          return res.status(409).json({
            error: 'Payment time expired. This fare agreement is no longer valid.',
            code: 'AGREEMENT_EXPIRED'
          });
        }
      }
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
    const jobMetadata = metadataObject(job.metadata);
    const storedBreakdown = metadataObject(job.fare_breakdown);
    const quoteReference = String(job.quote_id || jobMetadata.quote_id || storedBreakdown.quoteId || '').trim();
    const quoteExpiresAt = String(jobMetadata.quote_expires_at || storedBreakdown.quoteExpiresAt || '').trim();
    const quoteVersion = String(storedBreakdown.calculationVersion || storedBreakdown.marketPricingVersion || '').trim();
    if (!job.agreed_fare && (!quoteReference || !quoteVersion || !quoteExpiresAt || Date.parse(quoteExpiresAt) <= Date.now())) {
      return res.status(409).json({
        error: 'Fare quote is missing or expired',
        code: 'QUOTE_EXPIRED',
        details: 'Refresh the versioned booking quote before authorising payment.'
      });
    }

    // C2: one shared server-derived payable amount; the client body amount is
    // never authoritative and is not accepted as a fallback.
    const payable = await PaymentAuthorityService.resolve(job);
    const serviceFare = payable.serviceFareMajor;
    const itemBudget = payable.itemBudgetMajor;
    const totalAuthorisation = payable.totalAuthorisationMajor;

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
      }, { idempotencyKey: `job-quote-${String(job.id)}-${quoteReference}-${quoteVersion}`.slice(0, 255) });
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

    // C2: the client is not authoritative for commission, multipliers, marketplace
    // flags or negotiation mode. Those were snapshotted at booking create from the
    // verified quote and must not be re-written by a later payment call.
    const optionalUpdatePayload: Record<string, unknown> = {};

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
          item_budget: itemBudget,
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

// New wallet funding is retired. Keep confirmation for payments already made.
router.post('/create-wallet-topup-intent', (_req: Request, res: Response) => {
  return res.status(410).json({
    code: 'WALLET_TOPUPS_DISABLED',
    error: 'Wallet top-ups are no longer available. Pay directly when booking.'
  });
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

/**
 * COMPENSATION for an external Stripe success whose DB finalization LOST.
 *
 * The job must NEVER be reactivated. Under the EXISTING manual-capture lifecycle
 * (`capture_method: 'manual'` at create time) a successful authorization is
 * `requires_capture` — money is authorized but NOT captured — so releasing it with
 * `paymentIntents.cancel` is the correct, already-supported lifecycle action. That
 * is NOT a refund, which is why no refund is issued here.
 *
 * A CAPTURED intent (`succeeded`) is deliberately NOT auto-refunded: refunds move
 * money and must go through the reviewed admin `/refund` path. It is logged loudly
 * for manual reconciliation instead, so no refund behaviour is invented.
 */
async function compensateUnauthorizedIntent(job: any, reason: string) {
  const intentId = job?.payment_intent_id ? String(job.payment_intent_id) : '';

  if (!intentId) {
    return { attempted: false, action: 'no_intent' };
  }

  try {
    const pi = await stripe.paymentIntents.retrieve(intentId);

    if (['requires_capture', 'requires_confirmation', 'requires_payment_method'].includes(pi.status)) {
      const cancelled = await stripe.paymentIntents.cancel(intentId);
      console.warn('[PaymentRoutes] released in-flight authorization after finalization lost:', {
        jobId: job?.id, intentId, reason, stripeStatus: cancelled.status
      });
      return { attempted: true, action: 'authorization_cancelled', stripeStatus: cancelled.status };
    }

    if (pi.status === 'succeeded') {
      console.error('[PaymentRoutes] CAPTURED Stripe payment for a non-finalizable agreement — manual reconciliation required:', {
        jobId: job?.id, intentId, reason, amountMinor: pi.amount, currency: pi.currency
      });
      return { attempted: true, action: 'captured_requires_manual_reconciliation', stripeStatus: pi.status };
    }

    return { attempted: true, action: 'no_action_needed', stripeStatus: pi.status };
  } catch (error: any) {
    console.error('[PaymentRoutes] compensation failed:', {
      jobId: job?.id, intentId, reason, message: error?.message
    });
    return { attempted: true, action: 'compensation_failed', error: error?.message };
  }
}

router.post('/confirm', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.body;
    if (!jobId) {
      return res.status(400).json({ error: 'jobId is required' });
    }

    // C2A.1: server-owned payment confirmation. The client supplies only the job
    // id; every authority value (amount, currency, intent, ownership, state) is
    // derived server-side and verified against Stripe / the wallet reservation.
    const authUserId = await getAuthUserId(req);
    if (!authUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { data: job, error } = await supabaseAdmin
      .from('jobs')
      .select('*, service_type:service_types(*)')
      .eq('id', jobId)
      .maybeSingle();

    if (error || !job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (String(job.customer_id || '') !== authUserId) {
      return res.status(403).json({ error: 'Only the customer can confirm this payment' });
    }

    if (['cancelled', 'canceled', 'expired', 'failed', 'no_driver_found', 'completed', 'settled', 'delivered'].includes(String(job.status))) {
      return res.status(409).json({ error: 'This booking is no longer payable', code: 'JOB_TERMINAL' });
    }
    const walletPaid = String(job.payment_status || '').toLowerCase() === 'wallet_funded';
    if (walletPaid) {
      // Wallet reservation and activation are now committed by one DB function.
      // A historical funded-but-unactivated row must never be reported as success.
      if (job.payment_method !== 'wallet' || !['requested', 'searching', 'assigned', 'accepted', 'heading_to_pickup', 'driver_en_route', 'arrived', 'in_progress', 'shopping_in_progress', 'collected', 'en_route_to_customer'].includes(String(job.status))) {
        return res.status(409).json({ error: 'Wallet reservation needs reconciliation. You can cancel to release unused funds.', code: 'WALLET_ACTIVATION_INCOMPLETE' });
      }
      return res.json({ success: true, alreadyConfirmed: true, booking: job });
    }
    const payable = await PaymentAuthorityService.resolve(job);

    // Captured for the ATOMIC FINALIZATION AUTHORITY below: the intent's real
    // amount/currency are proven against the persisted negotiation authority.
    let intentAmountMinor: number | null = null;
    let intentCurrency: string | null = null;

    if (!walletPaid) {
      if (!job.payment_intent_id) {
        return res.status(400).json({ error: 'Job has no card payment intent' });
      }

      const pi = await stripe.paymentIntents.retrieve(String(job.payment_intent_id));

      if (pi.metadata?.jobId !== String(job.id)) {
        return res.status(409).json({ error: 'PaymentIntent does not belong to this job', code: 'PAYMENT_INTENT_MISMATCH' });
      }

      if (String(pi.currency || '').toLowerCase() !== currency(job.currency_code)) {
        return res.status(409).json({ error: 'PaymentIntent currency does not match the job', code: 'CURRENCY_MISMATCH' });
      }

      // C2: one shared server-derived payable amount (computed above).
      const expectedMinor = PaymentAuthorityService.minorUnits(payable.totalAuthorisationMajor);
      if (pi.amount !== expectedMinor) {
        return res.status(409).json({ error: 'PaymentIntent amount does not match the job', code: 'AMOUNT_MISMATCH' });
      }

      intentAmountMinor = pi.amount;
      intentCurrency = String(pi.currency || '').toLowerCase();

      // Manual capture: successful authorization is `requires_capture` (card
      // authorized, capture deferred to completion). `succeeded` is also accepted.
      if (pi.status !== 'requires_capture' && pi.status !== 'succeeded') {
        return res.status(402).json({ error: `Payment is not authorized. Current Stripe status: ${pi.status}`, code: 'PAYMENT_NOT_AUTHORIZED' });
      }
    }

    const hasLockedDriver = !!job.driver_id;
    // Release closure: a scheduled booking must NOT enter active searching/
    // dispatch before its scheduled_time. It stays 'requested' (paid) and the
    // scheduled worker activates it exactly once at the due time.
    const scheduledInFuture = !!(job.scheduled_time && new Date(job.scheduled_time).getTime() > Date.now());
    const deferred = scheduledInFuture && !hasLockedDriver;
    const nextStatus = hasLockedDriver ? 'assigned' : (scheduledInFuture ? 'requested' : 'searching');
    const nextPaymentStatus = walletPaid ? 'wallet_funded' : 'authorized';

    // ATOMIC FINALIZATION AUTHORITY (migration 360).
    //
    // The ENTIRE check-and-write happens in one DB transaction with the job and its
    // negotiation session locked (deterministic order: job, then session). An
    // agreement released/expired/cancelled while Stripe was in flight can therefore
    // no longer be resurrected as a paid booking — the previous guard
    // (payment_status='pending') matched that state because the expiry/cancel
    // transitions deliberately leave payment_status untouched.
    const { data: finalizeResult, error: finalizeError } = await supabaseAdmin.rpc('finalize_job_payment', {
      p_job_id: jobId,
      p_payment_intent_id: job.payment_intent_id ? String(job.payment_intent_id) : null,
      p_payment_status: nextPaymentStatus,
      p_job_status: nextStatus,
      p_expected_service_fare: payable.serviceFareMajor,
      p_require_unowned: false,
      p_dispatch_started_at: (hasLockedDriver || deferred) ? null : new Date().toISOString(),
      p_driver_search_expires_at: (hasLockedDriver || deferred) ? null : new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      p_dispatch_attempts: (hasLockedDriver || deferred) ? 0 : 1,
      p_intent_amount_minor: intentAmountMinor,
      p_currency: intentCurrency
    });

    if (finalizeError) {
      throw finalizeError;
    }

    if (finalizeResult !== 'finalized') {
      // Idempotent repeat of an already-successful confirm.
      if (finalizeResult === 'already_finalized') {
        const { data: current } = await supabaseAdmin
          .from('jobs')
          .select('*, service_type:service_types(*)')
          .eq('id', jobId)
          .maybeSingle();
        return res.json({ success: true, alreadyConfirmed: true, booking: current });
      }

      // The agreement lost the race (or was already terminal). NEVER reactivate it.
      const compensation = await compensateUnauthorizedIntent(job, String(finalizeResult));

      return res.status(409).json({
        error: 'This fare agreement is no longer valid. The payment was not activated.',
        code: 'AGREEMENT_LOST',
        reason: finalizeResult,
        compensation
      });
    }

    const { data: updated } = await supabaseAdmin
      .from('jobs')
      .select('*, service_type:service_types(*)')
      .eq('id', jobId)
      .single();

    // Payment is already committed. Notification failure must not turn a
    // successful wallet reservation into a failed payment response.
    if (updated?.status === 'searching' && !updated.driver_id) {
      try {
        await dispatchService.notifyNearbyDrivers(updated, updated.tenant_id, updated.city_id);
      } catch (dispatchError) {
        console.error('[PaymentRoutes] initial driver notification failed:', dispatchError);
        // The background dispatch retries retain the persisted search deadline.
      }
    }

    return res.json({ success: true, booking: updated });
  } catch (error: any) {
    console.error('[PaymentRoutes] confirm failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to confirm payment' });
  }
});

export async function refundHandler(req: Request, res: Response) {
  try {
    const { jobId } = req.body;

    if (!jobId) {
      return res.status(400).json({ error: 'jobId is required' });
    }

    // C2: refunds move money. The actor must be authenticated AND an admin, and the
    // intent + amount are derived server-side from the job/Stripe — never from the body.
    const authUserId = await getAuthUserId(req);
    if (!authUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', authUserId)
      .maybeSingle();

    if (profileError || profile?.role !== 'admin') {
      return res.status(403).json({ error: 'Administrator access required' });
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from('jobs')
      .select('payment_intent_id,payment_status,refund_id,reversal_id,total_refunded_minor,total_reversed_minor,stripe_transfer_id,stripe_transfer_status,driver_payout,currency_code,metadata,fare_breakdown')
      .eq('id', jobId)
      .maybeSingle();

    if (jobError || !job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (!job.payment_intent_id) {
      return res.status(400).json({ error: 'Job has no card payment intent' });
    }

    const pi = await stripe.paymentIntents.retrieve(String(job.payment_intent_id));

    if (pi.status === 'succeeded' && (pi.amount_received || 0) > 0) {
      const currency = String(job.currency_code || 'gbp');
      const capturedMinor = Number(pi.amount_received);
      const breakdown = (job.fare_breakdown && typeof job.fare_breakdown === 'object') ? job.fare_breakdown : {};
      const customerChargeMajor = Number(breakdown.customerCharge ?? (Number(job.driver_payout || 0) + Number(breakdown.platformFeeAmount ?? 0)));
      const serviceFareMinor = FareSplitService.toMinor(customerChargeMajor, currency);

      // Partial refund (optional body amount in major units) — default full remaining.
      const requestedMinor = req.body?.amount === undefined
        ? Math.max(0, capturedMinor - Number(job.total_refunded_minor || 0))
        : FareSplitService.toMinor(Number(req.body.amount), currency);

      // Durable per-operation idempotency key. The caller SUPPLIES a stable
      // request identity for retries; when absent, a unique key is generated so
      // distinct partial refunds of the SAME amount are never deduplicated.
      const refundIdemKey = String(req.body?.idempotencyKey || `refund-${jobId}-${randomUUID()}`);

      // ATOMIC reservation with budget-first-then-service allocation + cumulative
      // component limits. Returns the immutable operation record.
      const { data: reservedOp, error: reserveError } = await supabaseAdmin.rpc('reserve_refund_operation', {
        p_job_id: jobId,
        p_amount_minor: requestedMinor,
        p_captured_minor: capturedMinor,
        p_service_fare_minor: serviceFareMinor,
        p_idempotency_key: refundIdemKey,
        p_purpose: 'customer_refund'
      });

      if (reserveError) throw reserveError;
      const op = (Array.isArray(reservedOp) ? reservedOp[0] : reservedOp) as Record<string, any>;
      if (!op) {
        return res.status(400).json({
          error: 'Refund amount exceeds the remaining refundable amount.',
          code: 'REFUND_AMOUNT_INVALID',
          remaining: Math.max(0, capturedMinor - Number(job.total_refunded_minor || 0))
        });
      }

      // An already-EXECUTED operation returns its recorded result with NO further
      // Stripe call. An UNKNOWN operation is reconciled against the provider
      // (never blindly re-issued after the idempotency window).
      if (op.status === 'executed') {
        return res.json({ success: true, refundId: op.provider_id, operationId: op.id, amount: FareSplitService.fromMinor(requestedMinor, currency) });
      }

      // Unknown outcome: reconcile against the provider by payment_intent + amount
      // (never blindly re-issue after the idempotency window).
      if (op.status === 'unknown') {
        const listed = await stripe.refunds.list({ payment_intent: String(job.payment_intent_id), limit: 100 });
        const match = (listed?.data || []).find(r => (r as any).amount === requestedMinor);
        if (match) {
          await supabaseAdmin.rpc('mark_refund_operation', {
            p_operation_id: op.id, p_provider_id: match.id, p_status: 'executed'
          });
          return res.json({ success: true, refundId: match.id, operationId: op.id, amount: FareSplitService.fromMinor(requestedMinor, currency) });
        }
        return res.status(409).json({ success: false, pending: true, status: 'unknown', operationId: op.id });
      }

      let refund: { id: string };
      try {
        refund = await stripe.refunds.create(
          { payment_intent: String(job.payment_intent_id), amount: requestedMinor },
          { idempotencyKey: refundIdemKey }
        );
        const { error: refundMarkError } = await supabaseAdmin.rpc('mark_refund_operation', {
          p_operation_id: op.id, p_provider_id: refund.id, p_status: 'executed'
        });
        if (refundMarkError) throw refundMarkError;
      } catch (refundError: any) {
        if (isDefinitiveStripeRejection(refundError)) {
          // Documented terminal rejection: non-execution established — release.
          await supabaseAdmin.rpc('mark_refund_operation', {
            p_operation_id: op.id, p_provider_id: null, p_status: 'failed',
            p_error: String(refundError?.message || 'Refund rejected')
          });
          await supabaseAdmin.rpc('release_refund_operation', { p_operation_id: op.id });
        } else {
          // Uncertain/conflicting (timeout/network/5xx/idempotency conflict):
          // reservation RETAINED and the operation blocks duplicate execution.
          await supabaseAdmin.rpc('mark_refund_operation', {
            p_operation_id: op.id, p_provider_id: null, p_status: 'unknown',
            p_error: String(refundError?.message || 'Refund outcome unknown')
          });
        }
        console.error('[PaymentRoutes] refund failed:', refundError);
        throw refundError;
      }

      await supabaseAdmin
        .from('jobs')
        .update({
          payment_status: requestedMinor >= capturedMinor ? 'refunded' : 'paid',
          refund_id: refund.id
        })
        .eq('id', jobId);

      // Driver-share reversal applies only to the SERVICE-FARE component persisted
      // on THIS operation (errand budget component is refunded without reversal).
      let reversalId: string | null = null;
      let reversalWarning: string | null = null;
      const transferStatus = String(job.stripe_transfer_status || '').toLowerCase();
      const serviceComponentMinor = Number(op.service_component_minor || 0);

      if (job.stripe_transfer_id && transferStatus !== 'reversed' && transferStatus !== 'reversal_failed'
          && serviceComponentMinor > 0 && serviceFareMinor > 0) {
        const transferMinor = FareSplitService.toMinor(Number(job.driver_payout || 0), currency);
        const reversalMinor = Math.round(serviceComponentMinor * (transferMinor / serviceFareMinor));
        const reversalIdemKey = `reversal-${jobId}-${reversalMinor}-${op.id}`;

        if (reversalMinor > 0) {
          const { data: reversalOp, error: revReserveError } = await supabaseAdmin.rpc('reserve_reversal_operation', {
            p_job_id: jobId,
            p_amount_minor: reversalMinor,
            p_transfer_minor: transferMinor,
            p_idempotency_key: reversalIdemKey,
            p_purpose: 'refund_reversal'
          });

          if (!revReserveError && reversalOp) {
            const rOp = (Array.isArray(reversalOp) ? reversalOp[0] : reversalOp) as Record<string, any>;
            try {
              const reversal = await TransferReversalService.reverseDriverTransfer({
                transferId: String(job.stripe_transfer_id),
                amountMajor: FareSplitService.fromMinor(reversalMinor, currency),
                currency,
                jobId: String(jobId),
                partialIndex: Number(job.total_reversed_minor || 0) > 0 ? Number(job.total_reversed_minor) : undefined
              });
              reversalId = reversal.id;
              const { error: reversalMarkError } = await supabaseAdmin.rpc('mark_reversal_operation', {
                p_operation_id: rOp.id, p_provider_id: reversal.id, p_status: 'executed'
              });
              if (reversalMarkError) throw reversalMarkError;
              const fullyReversed = (Number(job.total_reversed_minor || 0) + reversalMinor) >= transferMinor;
              await supabaseAdmin
                .from('jobs')
                .update({
                  stripe_transfer_status: fullyReversed ? 'reversed' : 'partially_reversed',
                  settlement_status: fullyReversed ? 'reversed' : 'transferred',
                  reversal_id: reversal.id
                })
                .eq('id', jobId);
            } catch (reversalError: any) {
              if (isDefinitiveStripeRejection(reversalError)) {
                await supabaseAdmin.rpc('mark_reversal_operation', {
                  p_operation_id: rOp.id, p_provider_id: null, p_status: 'failed',
                  p_error: String(reversalError?.message || 'Reversal rejected')
                });
                await supabaseAdmin.rpc('release_reversal_operation', { p_operation_id: rOp.id });
              } else {
                await supabaseAdmin.rpc('mark_reversal_operation', {
                  p_operation_id: rOp.id, p_provider_id: null, p_status: 'unknown',
                  p_error: String(reversalError?.message || 'Reversal outcome unknown')
                });
              }
              reversalWarning = String(reversalError?.message || 'Transfer reversal failed');
              console.error('[PaymentRoutes] transfer reversal failed:', reversalError);
              await supabaseAdmin
                .from('jobs')
                .update({
                  stripe_transfer_status: 'reversal_failed',
                  metadata: { ...(job.metadata || {}), reversal_error: reversalWarning },
                  updated_at: new Date().toISOString()
                })
                .eq('id', jobId);
            }
          }
        }
      }

      // If the reversal failed, Movabi has refunded the customer out of platform
      // balance while the driver still holds the transferred funds. That exposure
      // is surfaced explicitly (platformFundedRefund) — never concealed.
      return res.json({
        success: true,
        refundId: refund.id,
        operationId: op.id,
        amount: FareSplitService.fromMinor(requestedMinor, currency),
        reversalId,
        reversalWarning,
        platformFundedRefund: !!reversalWarning
      });
    }

    if (pi.status === 'requires_capture') {
      // Not yet captured: release the authorization instead of refunding.
      await stripe.paymentIntents.cancel(String(job.payment_intent_id));
      await supabaseAdmin
        .from('jobs')
        .update({ payment_status: 'cancelled' })
        .eq('id', jobId);
      return res.json({ success: true, cancelled: true });
    }

    return res.status(400).json({ error: `No refundable amount in Stripe status: ${pi.status}` });
  } catch (error: any) {
    console.error('[PaymentRoutes] refund failed:', error);
    return res.status(500).json({ error: error.message || 'Refund failed' });
  }
}

router.post('/refund', refundHandler);

export default router;
