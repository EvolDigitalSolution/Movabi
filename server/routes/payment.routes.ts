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

        // 1. Fetch job only
        const { data: job, error: jobError } = await supabaseAdmin
            .from('jobs')
            .select('id, customer_id, tenant_id, status, payment_status')
            .eq('id', jobId)
            .maybeSingle();

        if (jobError) {
            console.error('Error fetching job:', jobError);
            return res.status(500).json({ error: 'Failed to fetch job' });
        }

        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        // 2. Fetch customer profile separately
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('id, account_status')
            .eq('id', job.customer_id)
            .maybeSingle();

        if (profileError) {
            console.error('Error fetching customer profile:', profileError);
            return res.status(500).json({ error: 'Failed to fetch customer profile' });
        }

        if (profile?.account_status && profile.account_status !== 'active') {
            return res.status(403).json({
                error: `Account is ${profile.account_status}. Payment not allowed.`
            });
        }

        // 3. Create Stripe PaymentIntent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100),
            currency: String(currency).toLowerCase(),
            payment_method_types: ['card'],
            metadata: {
                jobId: String(jobId),
                tenantId: tenantId || '',
                purpose: 'job_payment'
            }
        });

        // 4. Save intent ID on job
        const { error: updateError } = await supabaseAdmin
            .from('jobs')
            .update({ payment_intent_id: paymentIntent.id })
            .eq('id', jobId);

        if (updateError) {
            console.error('Error updating job with payment intent:', updateError);
            return res.status(500).json({ error: 'Failed to save payment intent on job' });
        }

        return res.json({
            clientSecret: paymentIntent.client_secret
        });
    } catch (error: any) {
        console.error('Error creating payment intent:', error);
        return res.status(500).json({ error: error.message || 'Failed to create payment intent' });
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
