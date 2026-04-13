import { Router, Request, Response } from 'express';
import { createStripeCheckoutSession, createStripePortalSession, verifyWebhookSignature, stripe } from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';
import { EventService } from '../services/event.service';
import Stripe from 'stripe';

const router = Router();

// Create checkout session
router.post('/create-checkout-session', async (req: Request, res: Response) => {
  try {
    const { userId, tenantId, userEmail, priceId, countryCode, currencyCode } = req.body;

    if (!userId || !tenantId || !userEmail || !priceId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const session = await createStripeCheckoutSession(userId, tenantId, userEmail, priceId, countryCode, currencyCode);
    res.json({ sessionId: session.id, url: session.url });
  } catch (error: any) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create portal session
router.post('/create-portal-session', async (req: Request, res: Response) => {
  try {
    const { stripeCustomerId, returnUrl } = req.body;

    if (!stripeCustomerId || !returnUrl) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const session = await createStripePortalSession(stripeCustomerId, returnUrl);
    res.json({ url: session.url });
  } catch (error: any) {
    console.error('Error creating portal session:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stripe Webhook
router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;

  try {
    event = verifyWebhookSignature(req.body, sig);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id;
      const tenantId = session.metadata?.tenantId;
      const countryCode = session.metadata?.countryCode;
      const currencyCode = session.metadata?.currencyCode;
      const stripeCustomerId = session.customer as string;
      const stripeSubscriptionId = session.subscription as string;

      if (userId && tenantId && stripeSubscriptionId) {
        const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
        const price = stripeSub.items.data[0].price;

        // Update Supabase
        const { error: subError } = await supabaseAdmin
          .from('subscriptions')
          .upsert({
            tenant_id: tenantId,
            user_id: userId,
            stripe_customer_id: stripeCustomerId,
            stripe_subscription_id: stripeSubscriptionId,
            stripe_price_id: price.id,
            status: stripeSub.status,
            current_period_start: new Date(stripeSub.current_period_start * 1000).toISOString(),
            current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString(),
            cancel_at_period_end: stripeSub.cancel_at_period_end,
            billing_country_code: countryCode || 'GB',
            billing_currency_code: currencyCode || price.currency.toUpperCase(),
            billing_interval: price.recurring?.interval || 'month',
            billing_amount_display: `${(price.unit_amount || 0) / 100} ${price.currency.toUpperCase()}/${price.recurring?.interval || 'month'}`
          }, { onConflict: 'stripe_subscription_id' });

        if (subError) {
          console.error('Error upserting subscription:', subError);
        } else {
          // Update profile status and plan
          const { error: profileError } = await supabaseAdmin
            .from('profiles')
            .update({ 
              subscription_status: 'active',
              pricing_plan: 'pro',
              stripe_customer_id: stripeCustomerId
            })
            .eq('id', userId);

          if (profileError) {
            console.error('Error updating profile status:', profileError);
          }
        }
      }
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const stripeSub = event.data.object as Stripe.Subscription;
      const stripeSubscriptionId = stripeSub.id;

      // Update Supabase
      const { error } = await supabaseAdmin
        .from('subscriptions')
        .update({ 
          status: stripeSub.status,
          current_period_start: new Date(stripeSub.current_period_start * 1000).toISOString(),
          current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString(),
          cancel_at_period_end: stripeSub.cancel_at_period_end
        })
        .eq('stripe_subscription_id', stripeSubscriptionId);

      if (error) {
        console.error('Error updating subscription status:', error);
      }

      // If deleted, update profile
      if (event.type === 'customer.subscription.deleted') {
        const { data: subData } = await supabaseAdmin
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_subscription_id', stripeSubscriptionId)
          .single();
        
        if (subData) {
          await supabaseAdmin
            .from('profiles')
            .update({ 
              subscription_status: 'inactive',
              pricing_plan: 'starter'
            })
            .eq('id', subData.user_id);
        }
      }
      break;
    }
    case 'account.updated': {
      const account = event.data.object as Stripe.Account;
      const stripeAccountId = account.id;

      // Update driver_accounts table
      const { error } = await supabaseAdmin
        .from('driver_accounts')
        .update({
          charges_enabled: account.charges_enabled,
          payouts_enabled: account.payouts_enabled
        })
        .eq('stripe_account_id', stripeAccountId);

      if (error) {
        console.error('Error updating driver account status:', error);
      }

      await EventService.logEvent('connect_account_updated', { 
        accountId: stripeAccountId, 
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled
      });
      break;
    }
    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      const jobId = paymentIntent.metadata?.jobId;
      const userId = paymentIntent.metadata?.userId;
      const purpose = paymentIntent.metadata?.purpose;
      const tenantId = paymentIntent.metadata?.tenantId;

      if (purpose === 'wallet_topup' && userId) {
        const amount = paymentIntent.amount / 100;

        // 1. Ensure wallet exists and increment balance
        const { data: wallet, error: walletError } = await supabaseAdmin
          .from('wallets')
          .upsert({ 
            user_id: userId,
            updated_at: new Date().toISOString()
          }, { onConflict: 'user_id' })
          .select()
          .single();

        if (walletError) {
          console.error('Error ensuring wallet exists for top-up:', walletError);
        } else {
          // 2. Atomic increment using RPC or direct update (since we are server-side and it's a top-up)
          // We'll use a direct update here for simplicity, but in a high-concurrency app, an RPC is better.
          const { error: updateError } = await supabaseAdmin.rpc('increment_wallet_balance', {
            p_user_id: userId,
            p_amount: amount
          });

          if (updateError) {
            console.error('Error incrementing wallet balance:', updateError);
          } else {
            // 3. Log transaction with idempotency check (handled by unique index on stripe_payment_intent_id)
            const { error: transError } = await supabaseAdmin
              .from('wallet_transactions')
              .insert({
                user_id: userId,
                amount: amount,
                type: 'topup',
                description: `Wallet top-up via Stripe`,
                stripe_payment_intent_id: paymentIntent.id,
                metadata: {
                  stripe_payment_intent_id: paymentIntent.id,
                  currency: paymentIntent.currency
                }
              });

            if (transError) {
              // If it's a duplicate key error, it means we already processed this top-up
              if (transError.code === '23505') {
                console.log(`Duplicate top-up detected for PaymentIntent ${paymentIntent.id}, skipping.`);
              } else {
                console.error('Error logging wallet transaction:', transError);
              }
            } else {
              await EventService.logEvent('wallet_topped_up', { 
                userId, 
                amount,
                paymentIntentId: paymentIntent.id
              }, tenantId, userId);
            }
          }
        }
      } else if (jobId) {
        // Update job payment status
        const { error: jobError } = await supabaseAdmin
          .from('jobs')
          .update({
            payment_status: 'paid',
            payment_intent_id: paymentIntent.id
          })
          .eq('id', jobId);

        if (jobError) {
          console.error('Error updating job payment status:', jobError);
        }

        // Log earning for driver
        const { data: jobData } = await supabaseAdmin
          .from('jobs')
          .select('driver_id, driver_payout')
          .eq('id', jobId)
          .single();

        if (jobData && jobData.driver_id && jobData.driver_payout) {
          await supabaseAdmin
            .from('driver_earnings')
            .upsert({
              driver_id: jobData.driver_id,
              job_id: jobId,
              amount: jobData.driver_payout,
              status: 'paid'
            }, { onConflict: 'job_id' });
        }

        await EventService.logEvent('payment_completed', { 
          jobId, 
          paymentIntentId: paymentIntent.id,
          amount: paymentIntent.amount / 100
        }, tenantId);
      }
      break;
    }
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

/**
 * Manually switch pricing plan (for admins or internal use)
 */
router.post('/switch-plan', async (req: Request, res: Response) => {
  try {
    const { userId, plan } = req.body;
    if (!userId || !plan || !['starter', 'pro'].includes(plan)) {
      return res.status(400).json({ error: 'userId and valid plan required' });
    }

    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ pricing_plan: plan })
      .eq('id', userId);

    if (error) throw error;

    await EventService.logEvent('plan_switched', { userId, plan }, undefined, userId);
    res.json({ success: true, plan });
  } catch (error: any) {
    console.error('Error switching plan:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
