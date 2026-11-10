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

// Shared confirmed-refund allocation: used by charge.refund.updated,
// refund.created and refund.updated. Only 'succeeded' refunds allocate —
// pending/failed restore nothing. Currency must match the job; a mismatch
// is skipped for review. provider_ref=refund.id is unique so duplicate and
// out-of-order events converge to one allocation.
async function applyConfirmedRefund(paymentIntentId: string, rf: any, eventAccount?: string) {
  if (!paymentIntentId || String(rf?.status || '') !== 'succeeded') return;
  const { data: job } = await supabase
    .from('jobs')
    .select('id,payment_intent_id,customer_id,tenant_id,currency_code')
    .eq('payment_intent_id', paymentIntentId)
    .maybeSingle();
  if (!job) return;
  // Merchant/Connect binding: when a canonical payment binding exists for
  // this PI, event.account must match its merchant_account_ref. Absence is
  // not a bypass — a binding to a Connect account ('acct_*') demands the
  // account field; only platform-bound PIs may omit it.
  const { data: binding } = await supabase
    .from('job_payment_bindings')
    .select('merchant_account_ref,provider')
    .eq('payment_reference', paymentIntentId)
    .maybeSingle();
  if (binding?.merchant_account_ref) {
    const expected = String(binding.merchant_account_ref);
    const platformBound = expected === 'stripe-platform' || expected === 'platform';
    if (eventAccount) {
      if (expected !== String(eventAccount)) {
        console.warn('[StripeWebhook] refund account mismatch — skipped for review:', {
          jobId: job.id, refund: rf.id, eventAccount, expected
        });
        return;
      }
    } else if (!platformBound) {
      console.warn('[StripeWebhook] refund event missing account for Connect-bound PI — skipped for review:', {
        jobId: job.id, refund: rf.id, expected
      });
      return;
    }
  }
  if (String(rf?.currency || '').toLowerCase() !== String(job.currency_code || '').toLowerCase()) {
    console.warn('[StripeWebhook] refund currency mismatch — skipped for review:', {
      jobId: job.id, refund: rf.id, currency: rf.currency, expected: job.currency_code
    });
    return;
  }
  const { data: fb } = await supabase
    .from('job_funding_breakdown')
    .select('customer_charge_minor,external_due_minor')
    .eq('job_id', job.id)
    .maybeSingle();
  if (!fb) return;
  const due = Number(fb.external_due_minor || 0);
  const confirmed = Number(rf.amount || 0);
  const serviceMinor = due > 0
    ? Math.min(Math.round(confirmed * Number(fb.customer_charge_minor) / due), Number(fb.customer_charge_minor))
    : confirmed;
  const { error: allocErr } = await supabase.rpc('apply_job_refund', {
    p_job: job.id, p_service_minor: serviceMinor,
    p_external_minor: confirmed, p_ref: String(rf.id)
  });
  if (allocErr) console.error('[StripeWebhook] refund allocation failed:', allocErr.message);
}

/**
 * Confirmed debt-repayment refund -> linked compensation reversal. The
 * collection recorded customer_receivables.payment_reference = payment_intent
 * id, so the receivable is resolved from the refund's payment_intent. Only
 * 'succeeded' refunds reverse; the RPC is cumulative/bounded so duplicate and
 * partial refunds cannot over- or double-adjust compensation.
 */
async function applyConfirmedReceivableRefund(paymentIntentId: string, rf: any, eventAccount?: string, livemode?: boolean) {
  if (!paymentIntentId || String(rf?.status || '') !== 'succeeded') return;
  const { data: receivable } = await supabase
    .from('customer_receivables')
    .select('id,payment_reference')
    .eq('payment_reference', paymentIntentId)
    .maybeSingle();
  if (!receivable) return; // not a debt-repayment receivable
  const { error } = await supabase.rpc('reverse_cancellation_compensation', {
    p_receivable: receivable.id,
    p_refund_minor: Number(rf.amount || 0),
    p_refund_reference: String(rf.id),
    p_provider: 'stripe',
    p_merchant_account_ref: String(eventAccount || 'stripe-platform'),
    p_environment: livemode ? 'live' : 'test'
  });
  if (error) console.error('[StripeWebhook] debt_repayment compensation reversal failed:', error.message);
}

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
        // Debt repayment: verified succeeded intent marks the receivable paid.
        // Idempotent via stripe_events dedup below + status transition guard.
        if (paymentIntent.metadata?.purpose === 'debt_repayment') {
          const receivableId = String(paymentIntent.metadata.receivable_id || '');
          if (!receivableId) return res.status(400).json({ error: 'debt_repayment intent missing receivable_id' });
          // Confirmed eligible fee collection -> compensation settlement. The
          // RPC is the single idempotent authority (deduped on provider + merchant
          // + environment + reference), so a re-delivery converges. A failed
          // settlement returns 500 so Stripe re-delivers — the event is never
          // acknowledged while compensation could still be missing.
          const { data: settlement, error: settleErr } = await supabase.rpc('settle_cancellation_compensation', {
            p_receivable: receivableId,
            p_collected_minor: paymentIntent.amount, // Stripe-verified collected amount
            p_payment_reference: paymentIntent.id,
            p_provider: 'stripe',
            p_merchant_account_ref: String((event as any).account || 'stripe-platform'),
            p_environment: (event as any).livemode ? 'live' : 'test'
          });
          if (settleErr) {
            console.error('[Webhook] debt_repayment compensation settlement failed:', settleErr.message);
            return res.status(500).json({ received: false, error: 'compensation settlement failed; retry' });
          }
          // Observability only — settlement already idempotently recorded above.
          const { error: upsertErr } = await supabase.from('stripe_events').upsert(
            { id: event.id, type: event.type, status: 'processed', created_at: new Date().toISOString(), processed_at: new Date().toISOString() },
            { onConflict: 'id' }
          );
          if (upsertErr) console.warn('[Webhook] stripe_events observability write failed:', upsertErr.message);
          if (settlement?.status === 'review_required') {
            console.warn('[Webhook] debt_repayment compensation routed to review (no frozen policy version):', receivableId);
          }
          return res.json({ received: true });
        }
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

      // Async refund confirmation: only SUCCEEDED refunds allocate;
      // provider_ref (refund.id) is unique so duplicate/out-of-order events
      // cannot double-allocate. Pending/failed restore nothing.
      case 'charge.refund.updated': {
        const charge = event.data.object as any;
        const refunds = Array.isArray(charge?.refunds?.data) ? charge.refunds.data : [];
        for (const rf of refunds) {
          await applyConfirmedRefund(String(charge?.payment_intent || ''), rf, (event as any).account);
          await applyConfirmedReceivableRefund(String(charge?.payment_intent || ''), rf, (event as any).account, (event as any).livemode);
        }
        break;
      }

      // refund.created / refund.updated carry the refund object directly.
      case 'refund.created':
      case 'refund.updated': {
        const rf = event.data.object as any;
        await applyConfirmedRefund(String(rf?.payment_intent || ''), rf, (event as any).account);
        await applyConfirmedReceivableRefund(String(rf?.payment_intent || ''), rf, (event as any).account, (event as any).livemode);
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
