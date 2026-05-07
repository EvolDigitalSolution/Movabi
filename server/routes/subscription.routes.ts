import { Router, Request, Response } from 'express';
import {
  createStripeCheckoutSession,
  createStripePortalSession,
  verifyWebhookSignature,
  stripe
} from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';
import { EventService } from '../services/event.service';
import Stripe from 'stripe';

const router = Router();

// Create checkout session
router.post('/create-checkout-session', async (req: Request, res: Response) => {
  try {
    const { userId, tenantId, userEmail, priceId, countryCode, currencyCode, returnUrl } = req.body;

    const configuredPriceId = process.env.STRIPE_PRO_WEEKLY_PRICE_ID;
    const finalPriceId =
      configuredPriceId && configuredPriceId.startsWith('price_')
        ? configuredPriceId
        : priceId;

    if (!userId || !tenantId || !userEmail) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    if (!finalPriceId || !String(finalPriceId).startsWith('price_')) {
      return res.status(500).json({
        error: 'Stripe subscription price is not configured. Set STRIPE_PRO_WEEKLY_PRICE_ID.'
      });
    }

    console.log('[Subscriptions] Creating checkout session with price:', finalPriceId);

    const session = await createStripeCheckoutSession(
      userId,
      tenantId,
      userEmail,
      finalPriceId,
      countryCode || 'GB',
      currencyCode || 'GBP',
      returnUrl
    );

    return res.json({ sessionId: session.id, url: session.url });
  } catch (error: any) {
    console.error('Error creating checkout session:', error);
    return res.status(500).json({ error: error.message });
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
    return res.json({ url: session.url });
  } catch (error: any) {
    console.error('Error creating portal session:', error);
    return res.status(500).json({ error: error.message });
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

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as unknown as Stripe.Checkout.Session;
        const userId = session.client_reference_id;
        const tenantId = session.metadata?.tenantId;
        const countryCode = session.metadata?.countryCode;
        const currencyCode = session.metadata?.currencyCode;
        const stripeCustomerId = session.customer as string;
        const stripeSubscriptionId = session.subscription as string;

        if (userId && tenantId && stripeSubscriptionId) {
          const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
          const price = stripeSub.items.data[0]?.price;

          if (!price) {
            console.error('No Stripe price found on subscription:', stripeSubscriptionId);
            break;
          }

          const currentPeriodStart =
            'current_period_start' in stripeSub && stripeSub.current_period_start
              ? new Date((stripeSub.current_period_start as number) * 1000).toISOString()
              : null;

          const currentPeriodEnd =
            'current_period_end' in stripeSub && stripeSub.current_period_end
              ? new Date((stripeSub.current_period_end as number) * 1000).toISOString()
              : null;

          const { error: subError } = await supabaseAdmin
            .from('subscriptions')
            .upsert(
              {
                tenant_id: tenantId,
                user_id: userId,
                stripe_customer_id: stripeCustomerId,
                stripe_subscription_id: stripeSubscriptionId,
                stripe_price_id: price.id,
                status: stripeSub.status,
                current_period_start: currentPeriodStart,
                current_period_end: currentPeriodEnd,
                cancel_at_period_end: stripeSub.cancel_at_period_end,
                billing_country_code: countryCode || 'GB',
                billing_currency_code: currencyCode || price.currency.toUpperCase(),
                billing_interval: price.recurring?.interval || 'month',
                billing_amount_display: `${(price.unit_amount || 0) / 100} ${price.currency.toUpperCase()}/${price.recurring?.interval || 'month'}`
              },
              { onConflict: 'stripe_subscription_id' }
            );

          if (subError) {
            console.error('Error upserting subscription:', subError);
          } else {
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
        const stripeSub = event.data.object as unknown as Stripe.Subscription;
        const stripeSubscriptionId = stripeSub.id;

        const currentPeriodStart =
          'current_period_start' in stripeSub && stripeSub.current_period_start
            ? new Date((stripeSub.current_period_start as number) * 1000).toISOString()
            : null;

        const currentPeriodEnd =
          'current_period_end' in stripeSub && stripeSub.current_period_end
            ? new Date((stripeSub.current_period_end as number) * 1000).toISOString()
            : null;

        const { error } = await supabaseAdmin
          .from('subscriptions')
          .update({
            status: stripeSub.status,
            current_period_start: currentPeriodStart,
            current_period_end: currentPeriodEnd,
            cancel_at_period_end: stripeSub.cancel_at_period_end
          })
          .eq('stripe_subscription_id', stripeSubscriptionId);

        if (error) {
          console.error('Error updating subscription status:', error);
        }

        if (event.type === 'customer.subscription.deleted') {
          const { data: subData } = await supabaseAdmin
            .from('subscriptions')
            .select('user_id')
            .eq('stripe_subscription_id', stripeSubscriptionId)
            .single();

          if (subData?.user_id) {
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
        const account = event.data.object as unknown as Stripe.Account;
        const stripeAccountId = account.id;

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
        const paymentIntent = event.data.object as unknown as Stripe.PaymentIntent;
        const jobId = paymentIntent.metadata?.jobId;
        const userId = paymentIntent.metadata?.userId;
        const purpose = paymentIntent.metadata?.purpose;
        const tenantId = paymentIntent.metadata?.tenantId;

        if (purpose === 'wallet_topup' && userId) {
          const amount = paymentIntent.amount / 100;

          const { error: walletEnsureError } = await supabaseAdmin
            .from('wallets')
            .upsert(
              {
                user_id: userId,
                updated_at: new Date().toISOString()
              },
              { onConflict: 'user_id' }
            );

          if (walletEnsureError) {
            console.error('Error ensuring wallet exists for top-up:', walletEnsureError);
            break;
          }

          const { error: updateError } = await supabaseAdmin.rpc('increment_wallet_balance', {
            p_user_id: userId,
            p_amount: amount
          });

          if (updateError) {
            console.error('Error incrementing wallet balance:', updateError);
          } else {
            const { error: transError } = await supabaseAdmin
              .from('wallet_transactions')
              .insert({
                user_id: userId,
                amount,
                type: 'topup',
                description: 'Wallet top-up via Stripe',
                stripe_payment_intent_id: paymentIntent.id,
                metadata: {
                  stripe_payment_intent_id: paymentIntent.id,
                  currency: paymentIntent.currency
                }
              });

            if (transError) {
              if (transError.code === '23505') {
                console.log(`Duplicate top-up detected for PaymentIntent ${paymentIntent.id}, skipping.`);
              } else {
                console.error('Error logging wallet transaction:', transError);
              }
            } else {
              await EventService.logEvent(
                'wallet_topped_up',
                {
                  userId,
                  amount,
                  paymentIntentId: paymentIntent.id
                },
                tenantId,
                userId
              );
            }
          }
        } else if (jobId) {
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

          const { data: jobData } = await supabaseAdmin
            .from('jobs')
            .select('driver_id, driver_payout')
            .eq('id', jobId)
            .single();

          if (jobData?.driver_id && jobData?.driver_payout) {
            await supabaseAdmin.from('driver_earnings').upsert(
              {
                driver_id: jobData.driver_id,
                job_id: jobId,
                amount: jobData.driver_payout,
                status: 'paid'
              },
              { onConflict: 'job_id' }
            );
          }

          await EventService.logEvent(
            'payment_completed',
            {
              jobId,
              paymentIntentId: paymentIntent.id,
              amount: paymentIntent.amount / 100
            },
            tenantId
          );
        }
        break;
      }

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    return res.json({ received: true });
  } catch (error: any) {
    console.error('Error handling subscription webhook:', error);
    return res.status(500).json({ error: error.message });
  }
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

    return res.json({ success: true, plan });
  } catch (error: any) {
    console.error('Error switching plan:', error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
