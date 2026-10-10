import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { IssuingService } from '../services/issuing.service';
import { PaymentAuthorityService } from '../services/payment-authority.service';

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2022-11-15',
});

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

/**
 * C2: bind a Stripe PaymentIntent event to its job using the STORED intent id and
 * the authoritative amount/currency, not just a client-visible metadata.jobId.
 * Returns the job id only when the event is genuine for that job; null otherwise.
 */
async function verifyJobPaymentIntent(event: Stripe.Event): Promise<string | null> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  if (paymentIntent.metadata?.purpose === 'shopping_budget_reauthorization') return null;
  const jobId = paymentIntent.metadata?.jobId;
  if (!jobId) return null;

  const { data: job } = await supabase
    .from('jobs')
    .select('*, service_type:service_types(*)')
    .eq('id', jobId)
    .maybeSingle();
  if (!job) return null;
  if (job.payment_intent_id !== paymentIntent.id) return null;

  const payable = await PaymentAuthorityService.resolve(job);
  if (String(paymentIntent.currency || '').toLowerCase() !== payable.currency) return null;
  if (paymentIntent.amount !== PaymentAuthorityService.minorUnits(payable.totalAuthorisationMajor)) return null;

  return String(jobId);
}

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
        const decision = await IssuingService.handleAuthorizationRequest(authorization).catch(error => {
          console.error('[Issuing] authorization declined after processing error',error.message);
          return {approved:false};
        });

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

      case 'payment_intent.amount_capturable_updated': {
        // C2A.1: under manual capture this is the AUTHORIZATION signal. The event
        // is verified against the stored intent + authoritative amount/currency,
        // then advances only an unpaid, unowned job. Idempotent and guarded.
        const jobId = await verifyJobPaymentIntent(event);
        const authorizedIntent = event.data.object as Stripe.PaymentIntent;
        if (jobId) {
          const { data: alreadyProcessed } = await supabase
            .from('stripe_events')
            .select('id')
            .eq('id', event.id)
            .maybeSingle();
          if (!alreadyProcessed) {
            await supabase.from('stripe_events').insert({
              id: event.id,
              type: event.type,
              status: 'processed',
              created_at: new Date().toISOString(),
              processed_at: new Date().toISOString()
            });
            // ATOMIC FINALIZATION AUTHORITY (migration 360). The old guard
            // (payment_status='pending' AND driver_id IS NULL) was SATISFIED by a
            // released/expired agreement — expiry clears driver_id — so a delayed
            // event resurrected it. The RPC re-verifies the agreement under lock.
            const { data: finalizeResult } = await supabase.rpc('finalize_job_payment', {
              p_job_id: jobId,
              p_payment_status: 'authorized',
              p_job_status: 'searching',
              p_require_unowned: true,
              p_dispatch_started_at: new Date().toISOString(),
              p_driver_search_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
              p_dispatch_attempts: 1,
              p_intent_amount_minor: authorizedIntent.amount,
              p_currency: authorizedIntent.currency
            });

            if (finalizeResult !== 'finalized') {
              console.warn('[StripeWebhook] authorization NOT activated (agreement lost):', {
                jobId, finalizeResult
              });
            }
          }
        }
        break;
      }

      case 'payment_intent.succeeded': {
        // C2: Stripe is authoritative for payment success. This handler was
        // previously shadowed by a duplicate mount; merged here so a job only
        // becomes searchable after a verified Stripe event, and only once.
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const jobId = await verifyJobPaymentIntent(event);
        if (jobId) {
          const { data: alreadyProcessed } = await supabase
            .from('stripe_events')
            .select('id')
            .eq('id', event.id)
            .maybeSingle();
          if (!alreadyProcessed) {
            await supabase.from('stripe_events').insert({
              id: event.id,
              type: event.type,
              status: 'processed',
              created_at: new Date().toISOString(),
              processed_at: new Date().toISOString()
            });

            // ATOMIC FINALIZATION AUTHORITY (migration 360). A delayed success must
            // NOT resurrect a released/cancelled/expired agreement.
            const { data: finalizeResult } = await supabase.rpc('finalize_job_payment', {
              p_job_id: jobId,
              p_payment_status: 'paid',
              p_job_status: 'searching',
              p_require_unowned: true,
              p_dispatch_started_at: new Date().toISOString(),
              p_driver_search_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
              p_dispatch_attempts: 1,
              p_intent_amount_minor: paymentIntent.amount,
              p_currency: paymentIntent.currency
            });

            if (finalizeResult !== 'finalized') {
              console.warn('[StripeWebhook] payment NOT activated (agreement lost):', {
                jobId, finalizeResult
              });
            }

            if (finalizeResult === 'finalized') {
              await supabase.from('booking_status_history').insert({
                job_id: jobId,
                status: 'searching',
                notes: 'Payment confirmed via Stripe webhook'
              });
              await supabase.from('job_events').insert({
                job_id: jobId,
                event_type: 'payment_succeeded',
                actor_role: 'system',
                notes: 'Payment confirmed via Stripe webhook',
                metadata: { paymentIntentId: paymentIntent.id, amount: paymentIntent.amount / 100, currency: paymentIntent.currency }
              });
            }
          }
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        if (paymentIntent.metadata?.purpose === 'shopping_budget_reauthorization') return null;
  const jobId = paymentIntent.metadata?.jobId;
        if (jobId) {
          await supabase.from('stripe_events').upsert({
            id: event.id,
            type: event.type,
            status: 'processed',
            created_at: new Date().toISOString(),
            processed_at: new Date().toISOString()
          });
          await supabase.from('job_events').insert({
            job_id: jobId,
            event_type: 'payment_failed',
            actor_role: 'system',
            notes: `Payment failed: ${paymentIntent.last_payment_error?.message ?? ''}`,
            metadata: { paymentIntentId: paymentIntent.id }
          });
        }
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
