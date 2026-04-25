import { stripe } from './stripe.service';
import { supabaseAdmin } from './supabase.service';


export class ReconciliationService {
  /**
   * Reconcile recent Stripe PaymentIntents with local DB
   */
  static async reconcilePayments(limit = 100) {
    console.log('[ReconciliationService] Starting reconciliation...');
    const results = {
      processed: 0,
      repaired: 0,
      errors: 0,
      discrepancies: [] as any[]
    };

    try {
      // 1. Fetch recent PaymentIntents from Stripe
      const paymentIntents = await stripe.paymentIntents.list({
        limit,
        created: {
          gt: Math.floor(Date.now() / 1000) - (24 * 60 * 60) // Last 24 hours
        }
      });

      for (const pi of paymentIntents.data) {
        results.processed++;
        const { jobId, userId, type } = pi.metadata;

        if (pi.status === 'succeeded') {
          if (type === 'wallet_topup' || pi.metadata.purpose === 'wallet_topup') {
            // Check wallet transaction
            const { data: tx } = await supabaseAdmin
              .from('wallet_transactions')
              .select('id')
              .eq('payment_intent_id', pi.id)
              .single();

            if (!tx) {
              console.warn(`[ReconciliationService] Missing wallet transaction for PI ${pi.id}. Repairing...`);
              const { data: processed, error } = await supabaseAdmin.rpc('finalize_wallet_topup', {
                p_user_id: userId,
                p_amount: pi.amount / 100,
                p_payment_intent_id: pi.id,
                p_description: 'Wallet top-up (Reconciliation)'
              });

              if (error) {
                results.errors++;
                results.discrepancies.push({ id: pi.id, error: error.message });
              } else if (processed) {
                results.repaired++;
              }
            }
          } else if (jobId) {
            // Check job payment status
            const { data: job } = await supabaseAdmin
              .from('jobs')
              .select('id, payment_status, status')
              .eq('id', jobId)
              .single();

            if (job && job.payment_status !== 'paid') {
              console.warn(`[ReconciliationService] Job ${jobId} payment status mismatch. PI ${pi.id} succeeded but job is ${job.payment_status}. Repairing...`);
              const { error } = await supabaseAdmin
                .from('jobs')
                .update({ payment_status: 'paid' })
                .eq('id', jobId);

              if (error) {
                results.errors++;
                results.discrepancies.push({ id: pi.id, error: error.message });
              } else {
                results.repaired++;
              }
            }
          }
        }
      }
    } catch (error: any) {
      console.error('[ReconciliationService] Error during reconciliation:', error);
      results.errors++;
    }

    console.log('[ReconciliationService] Reconciliation finished:', results);
    return results;
  }
}
