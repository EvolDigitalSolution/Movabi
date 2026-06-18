import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { IssuingService } from '../services/issuing.service';

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2022-11-15',
});

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

router.post('/', async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature) {
    return res.status(400).send('Missing stripe-signature');
  }

  if (!webhookSecret) {
    console.error('[Stripe webhook] Missing STRIPE_WEBHOOK_SECRET');
    return res.status(500).send('Missing webhook secret');
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err: any) {
    console.error('[Stripe webhook] Signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    console.log('[Stripe webhook] Received:', event.type);

    switch (event.type) {
      case 'issuing_authorization.request': {
        const authorization = event.data.object as Stripe.Issuing.Authorization;
        const decision = await IssuingService.handleAuthorizationRequest(authorization);

        return res
          .status(200)
          .set('Stripe-Version', '2023-10-16')
          .json(decision);
      }

      case 'issuing_authorization.created':
      case 'issuing_authorization.updated': {
        const authorization = event.data.object as Stripe.Issuing.Authorization;
        await IssuingService.syncAuthorization(authorization);
        break;
      }

      case 'issuing_transaction.created':
      case 'issuing_transaction.updated': {
        const transaction = event.data.object as Stripe.Issuing.Transaction;
        await IssuingService.syncTransaction(transaction);
        break;
      }

      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;

        const driverId = session.metadata?.driverId;
        const planName = session.metadata?.planName || session.metadata?.plan || 'starter';

        if (driverId) {
          await supabase.from('subscriptions').upsert(
            {
              driver_id: driverId,
              stripe_customer_id: String(session.customer || ''),
              stripe_subscription_id: String(session.subscription || ''),
              plan_name: planName,
              status: 'active',
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'driver_id' }
          );
        }

        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as any;
        const subscriptionId = String(invoice.subscription || '');

        if (subscriptionId) {
          await supabase
            .from('subscriptions')
            .update({
              status: 'active',
              updated_at: new Date().toISOString(),
            })
            .eq('stripe_subscription_id', subscriptionId);
        }

        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as any;
        const subscriptionId = String(invoice.subscription || '');

        if (subscriptionId) {
          await supabase
            .from('subscriptions')
            .update({
              status: 'past_due',
              updated_at: new Date().toISOString(),
            })
            .eq('stripe_subscription_id', subscriptionId);
        }

        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;

        await supabase
          .from('subscriptions')
          .update({
            status: 'cancelled',
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', subscription.id);

        break;
      }

      default:
        console.log('[Stripe webhook] Unhandled:', event.type);
    }

    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error('[Stripe webhook] Handler error:', err.message);

    return res.status(200).json({
      received: true,
      warning: 'Webhook received but sync failed',
    });
  }
});

export default router;
