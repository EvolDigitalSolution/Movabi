import { Router, Request, Response } from 'express';
import { stripe, verifyWebhookSignature } from '../services/stripe.service';
import { supabaseAdmin } from '../services/supabase.service';
import { EmailService } from '../services/email.service';

const router = Router();

/**
 * Stripe Webhook Handler
 * Mount at /api/webhook/stripe
 * Requires raw body parsing
 */
router.post('/stripe', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  let event;

  try {
    // req.body must be the raw buffer here
    event = verifyWebhookSignature(req.body, sig);
  } catch (err: any) {
    console.error(`[Stripe Webhook] Signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 1. Idempotency Check
  const { data: existingEvent } = await supabaseAdmin
    .from('stripe_events')
    .select('*')
    .eq('id', event.id)
    .single();

  if (existingEvent && existingEvent.status === 'processed') {
    console.log(`[Stripe Webhook] Event ${event.id} already processed. Skipping.`);
    return res.json({ received: true, duplicate: true });
  }

  // 2. Insert/Update Event Tracking
  await supabaseAdmin.from('stripe_events').upsert({
    id: event.id,
    type: event.type,
    status: 'pending',
    created_at: new Date().toISOString()
  });

  console.log(`[Stripe Webhook] Received event: ${event.type} [${event.id}]`);

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object as any;
        const { jobId, type, purpose, userId, tenantId } = paymentIntent.metadata;
        const walletType = type || purpose;

        if (walletType === 'wallet_topup') {
          console.log(`[Stripe Webhook] Processing wallet top-up for user ${userId}, amount ${paymentIntent.amount / 100}`);
          
          // Use atomic RPC
          const { data: processed, error: rpcError } = await supabaseAdmin.rpc('finalize_wallet_topup', {
            p_user_id: userId,
            p_amount: paymentIntent.amount / 100,
            p_payment_intent_id: paymentIntent.id,
            p_description: 'Wallet top-up (Webhook)'
          });

          if (rpcError) {
            throw rpcError;
          }

          if (processed) {
            // Send receipt
            const { data: profile } = await supabaseAdmin
              .from('profiles')
              .select('email')
              .eq('id', userId)
              .single();

            if (profile?.email) {
              await EmailService.sendReceipt(profile.email, {
                amount: paymentIntent.amount / 100,
                currency: paymentIntent.currency.toUpperCase(),
                transactionId: paymentIntent.id,
                description: 'Wallet Top-up',
                date: new Date()
              });
            }
          }
        } else if (jobId) {
          console.log(`[Stripe Webhook] Processing job payment for job ${jobId}`);
          
          // Atomic update for job status
          const { data: job, error: jobError } = await supabaseAdmin
            .from('jobs')
            .update({
              payment_status: 'paid',
              status: 'searching'
            })
            .eq('id', jobId)
            .eq('payment_status', 'pending') // Guard
            .select()
            .single();

          if (jobError) {
            console.error('[Stripe Webhook] Error updating job:', jobError);
            // Don't fail the whole webhook if it was already updated
          } else if (job) {
            // Log status history
            await supabaseAdmin.from('booking_status_history').insert({
              job_id: jobId,
              status: 'searching',
              notes: 'Payment confirmed via Stripe webhook'
            });

            // Log job event
            await supabaseAdmin.from('job_events').insert({
              job_id: jobId,
              event_type: 'payment_succeeded',
              actor_role: 'system',
              notes: 'Payment confirmed via Stripe webhook',
              metadata: { 
                paymentIntentId: paymentIntent.id,
                amount: paymentIntent.amount / 100,
                currency: paymentIntent.currency
              }
            });
          }
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object as any;
        const { jobId } = paymentIntent.metadata;
        console.warn(`[Stripe Webhook] Payment failed for intent ${paymentIntent.id}. Reason: ${paymentIntent.last_payment_error?.message}`);
        
        if (jobId) {
          await supabaseAdmin.from('job_events').insert({
            job_id: jobId,
            event_type: 'payment_failed',
            actor_role: 'system',
            notes: `Payment failed: ${paymentIntent.last_payment_error?.message}`,
            metadata: { paymentIntentId: paymentIntent.id }
          });
        }
        break;
      }

      default:
        console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
    }

    // 3. Mark Event as Processed
    await supabaseAdmin.from('stripe_events').update({
      status: 'processed',
      processed_at: new Date().toISOString()
    }).eq('id', event.id);

    res.json({ received: true });
  } catch (error: any) {
    console.error('[Stripe Webhook] Internal Error:', error);
    
    // Mark Event as Failed
    await supabaseAdmin.from('stripe_events').update({
      status: 'failed',
      error_message: error.message
    }).eq('id', event.id);

    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
