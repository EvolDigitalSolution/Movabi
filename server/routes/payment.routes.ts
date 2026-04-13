import { Router, Request, Response } from 'express';
import { stripe } from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';

const router = Router();

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
      .select('*, customer:profiles(*)')
      .eq('id', jobId)
      .single();

    if (jobError || !job) throw new Error('Job not found');
    
    if (job.customer?.account_status && job.customer.account_status !== 'active') {
      return res.status(403).json({ error: `Account is ${job.customer.account_status}. Payment not allowed.` });
    }

    // 2. Create the PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: currency.toLowerCase(),
      payment_method_types: ['card'],
      metadata: {
        jobId,
        tenantId: tenantId || ''
      }
    });

    // Update job with payment intent ID
    await supabaseAdmin
      .from('jobs')
      .update({ payment_intent_id: paymentIntent.id })
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

    // 2. Create the PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: currency.toLowerCase(),
      payment_method_types: ['card'],
      metadata: {
        userId,
        tenantId: tenantId || '',
        purpose: 'wallet_topup'
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

export default router;
