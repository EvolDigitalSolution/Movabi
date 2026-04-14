import { Router, Request, Response } from 'express';
import { stripe } from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';
import { dispatchService } from '../services/dispatch.service';
import { PricingService } from '../services/pricing.service';
import { FraudService } from '../services/fraud.service';
import { CityService } from '../services/city.service';
import { EmailService } from '../services/email.service';

const router = Router();

/**
 * Calculate price with surge
 */
router.post('/calculate-price', async (req: Request, res: Response) => {
  try {
    const { lat, lng, basePrice } = req.body;

    if (lat === undefined || lng === undefined || basePrice === undefined) {
      return res.status(400).json({ error: 'lat, lng, and basePrice are required' });
    }

    const stats = await dispatchService.getAreaStats(lat, lng);
    const city = await CityService.findCityForLocation(lat, lng);
    
    let surge = PricingService.getSurgeMultiplier(stats.demand, stats.supply);
    
    // Apply city-specific base surge if applicable
    if (city && city.base_surge_multiplier > 1.0) {
      surge = Math.max(surge, Number(city.base_surge_multiplier));
    }

    const totalPrice = basePrice * surge;

    res.json({
      basePrice,
      surgeMultiplier: surge,
      totalPrice,
      demand: stats.demand,
      supply: stats.supply,
      city: city?.name || 'Unknown'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create a PaymentIntent for a job
 */
router.post('/create-intent', async (req: Request, res: Response) => {
  try {
    const { jobId, amount, currency, tenantId } = req.body;

    if (!jobId || amount === undefined || !currency) {
      return res.status(400).json({ error: 'jobId, amount, and currency are required' });
    }

    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: 'Stripe is not configured on the server' });
    }

    // 1. Check customer status
    const { data: job, error: jobError } = await supabaseAdmin
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobError || !job) throw new Error('Job not found');

    const { data: customer, error: customerError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', job.customer_id)
      .single();

    if (customerError || !customer) throw new Error('Customer profile not found');
    
    if (customer.account_status && customer.account_status !== 'active') {
      return res.status(403).json({ error: `Account is ${customer.account_status}. Payment not allowed.` });
    }

    // 1.5 Fraud Check
    const fraudCheck = await FraudService.checkCancellationAbuse(job.customer_id);
    if (fraudCheck.isAbusing) {
      return res.status(403).json({ error: `Booking restricted: ${fraudCheck.reason}` });
    }

    // 2. Create the PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: currency.toLowerCase(),
      payment_method_types: ['card'],
      capture_method: 'manual',
      metadata: {
        jobId,
        tenantId: tenantId || '',
        surgeMultiplier: req.body.surgeMultiplier || '1.0'
      }
    });

    // Update job with payment intent ID and surge multiplier
    await supabaseAdmin
      .from('jobs')
      .update({ 
        payment_intent_id: paymentIntent.id,
        surge_multiplier: req.body.surgeMultiplier || 1.0
      })
      .eq('id', jobId);

    res.json({
      clientSecret: paymentIntent.client_secret
    });
  } catch (error: any) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create a PaymentIntent for a wallet top-up
 */
router.post('/create-wallet-topup-intent', async (req: Request, res: Response) => {
  try {
    const { userId, amount, currency, tenantId } = req.body;

    if (!userId || amount === undefined || !currency) {
      return res.status(400).json({ error: 'userId, amount, and currency are required' });
    }

    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: 'Stripe is not configured on the server' });
    }

    // 1. Check customer status
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (profileError || !profile) throw new Error('User not found');
    
    if (profile.account_status && profile.account_status !== 'active') {
      return res.status(403).json({ error: `Account is ${profile.account_status}. Payment not allowed.` });
    }

    // 2. Fraud Check
    const fraudCheck = await FraudService.checkWalletAbuse(userId, amount);
    if (fraudCheck.isSuspicious) {
      return res.status(403).json({ error: `Suspicious activity: ${fraudCheck.reason}` });
    }

    // 3. Create the PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: currency.toLowerCase(),
      payment_method_types: ['card'],
      metadata: {
        userId,
        tenantId: tenantId || '',
        type: 'wallet_topup'
      }
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
  } catch (error: any) {
    console.error('Error creating wallet top-up intent:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Confirm a wallet top-up after Stripe success
 */
router.post('/confirm-wallet-topup', async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, userId, amount } = req.body;

    if (!paymentIntentId || !userId || !amount) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (pi.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not complete' });
    }

    // Use atomic RPC
    const { data: processed, error: rpcError } = await supabaseAdmin.rpc('finalize_wallet_topup', {
      p_user_id: userId,
      p_amount: amount,
      p_payment_intent_id: paymentIntentId,
      p_description: 'Wallet top-up'
    });

    if (rpcError) throw rpcError;

    if (processed) {
      // Send receipt
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('email')
        .eq('id', userId)
        .single();

      if (profile?.email) {
        await EmailService.sendReceipt(profile.email, {
          amount: amount,
          currency: pi.currency.toUpperCase(),
          transactionId: paymentIntentId,
          description: 'Wallet Top-up',
          date: new Date()
        });
      }
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error confirming wallet top-up:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Refund a payment
 */
router.post('/refund', async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, amount, reason } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'paymentIntentId is required' });
    }

    const refundParams: any = {
      payment_intent: paymentIntentId,
    };

    if (amount) {
      refundParams.amount = Math.round(amount * 100);
    }

    if (reason) {
      refundParams.reason = reason;
    }

    const refund = await stripe.refunds.create(refundParams);

    res.json({ success: true, refundId: refund.id });
  } catch (error: any) {
    console.error('Error processing refund:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
