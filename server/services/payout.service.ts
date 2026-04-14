import { stripe } from './stripe.service';
import { supabaseAdmin } from './supabase.service';
import { AuditService } from './audit.service';

export class PayoutService {
  /**
   * Process all payable earnings into payouts
   */
  static async processDriverPayouts() {
    console.log('[PayoutService] Starting payout processing...');
    const results = {
      batchesCreated: 0,
      totalAmount: 0,
      driversPaid: 0,
      errors: [] as string[]
    };

    try {
      // 1. Fetch all payable earnings
      const { data: earnings, error: fetchError } = await supabaseAdmin
        .from('driver_earnings')
        .select('*')
        .eq('status', 'payable');

      if (fetchError) throw fetchError;
      if (!earnings || earnings.length === 0) {
        console.log('[PayoutService] No payable earnings found.');
        return results;
      }

      // 2. Group by driver
      const driverGroups = earnings.reduce((acc: any, curr: any) => {
        if (!acc[curr.driver_id]) {
          acc[curr.driver_id] = {
            amount: 0,
            ids: []
          };
        }
        acc[curr.driver_id].amount += Number(curr.net_amount);
        acc[curr.driver_id].ids.push(curr.id);
        return acc;
      }, {});

      // 3. Process each driver
      for (const driverId in driverGroups) {
        const group = driverGroups[driverId];
        
        try {
          // Create a payout batch record
          const { data: batch, error: batchError } = await supabaseAdmin
            .from('payout_batches')
            .insert({
              total_amount: group.amount,
              driver_count: 1,
              status: 'processing',
              metadata: { driver_id: driverId, earning_ids: group.ids }
            })
            .select()
            .single();

          if (batchError) throw batchError;

          // Placeholder for Stripe Connect Transfer
          // In a real enterprise app, we'd call stripe.transfers.create here
          // const transfer = await stripe.transfers.create({
          //   amount: Math.round(group.amount * 100),
          //   currency: 'gbp',
          //   destination: driverStripeAccountId,
          //   metadata: { batchId: batch.id }
          // });

          // 4. Finalize batch and earnings atomically via RPC
          const { error: rpcError } = await supabaseAdmin.rpc('process_payout_batch', {
            p_batch_id: batch.id,
            p_driver_ids: [driverId]
          });

          if (rpcError) throw rpcError;

          results.batchesCreated++;
          results.totalAmount += group.amount;
          results.driversPaid++;

          await AuditService.log({
            action: 'payout_processed',
            entityType: 'payout_batch',
            entityId: batch.id,
            metadata: { driverId, amount: group.amount }
          });

        } catch (err: any) {
          console.error(`[PayoutService] Error processing payout for driver ${driverId}:`, err);
          results.errors.push(`Driver ${driverId}: ${err.message}`);
        }
      }

    } catch (error: any) {
      console.error('[PayoutService] Global payout error:', error);
      results.errors.push(`Global: ${error.message}`);
    }

    return results;
  }
}
