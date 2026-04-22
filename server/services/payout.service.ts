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
            // ✅ 1. Fetch only required fields (performance + safety)
            const { data: earnings, error: fetchError } = await supabaseAdmin
                .from('driver_earnings')
                .select('id, driver_id, net_amount, status')
                .eq('status', 'payable');

            if (fetchError) throw fetchError;

            if (!earnings || earnings.length === 0) {
                console.log('[PayoutService] No payable earnings found.');
                return results;
            }

            // ✅ 2. Group earnings by driver
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

            // ✅ 3. Process each driver independently
            for (const driverId of Object.keys(driverGroups)) {
                const group = driverGroups[driverId];

                try {
                    // 🔒 Skip zero/invalid payouts
                    if (!group.amount || group.amount <= 0) {
                        continue;
                    }

                    // ✅ 3.1 Check driver payout readiness (Stripe Connect optional)
                    const { data: driverProfile } = await supabaseAdmin
                        .from('profiles')
                        .select('id, stripe_account_id, account_status')
                        .eq('id', driverId)
                        .maybeSingle();

                    if (!driverProfile || driverProfile.account_status !== 'active') {
                        throw new Error('Driver not eligible for payout');
                    }

                    // ✅ 3.2 Idempotency check (avoid duplicate batches)
                    const { data: existingBatch } = await supabaseAdmin
                        .from('payout_batches')
                        .select('id')
                        .contains('metadata', { driver_id: driverId })
                        .eq('status', 'processing')
                        .maybeSingle();

                    if (existingBatch) {
                        console.warn(`[PayoutService] Skipping driver ${driverId}, batch already exists`);
                        continue;
                    }

                    // ✅ 3.3 Create payout batch
                    const { data: batch, error: batchError } = await supabaseAdmin
                        .from('payout_batches')
                        .insert({
                            total_amount: group.amount,
                            driver_count: 1,
                            status: 'processing',
                            metadata: {
                                driver_id: driverId,
                                earning_ids: group.ids
                            }
                        })
                        .select()
                        .single();

                    if (batchError) throw batchError;

                    // ✅ 3.4 Stripe transfer (only if connected)
                    let transferId: string | null = null;

                    if (driverProfile.stripe_account_id) {
                        try {
                            const transfer = await stripe.transfers.create({
                                amount: Math.round(group.amount * 100),
                                currency: 'gbp',
                                destination: driverProfile.stripe_account_id,
                                metadata: {
                                    batchId: batch.id,
                                    driverId
                                }
                            });

                            transferId = transfer.id;
                        } catch (stripeError: any) {
                            console.error('[PayoutService] Stripe transfer failed:', stripeError);
                            throw new Error('Stripe transfer failed');
                        }
                    }

                    // ✅ 3.5 Finalize via atomic RPC
                    const { error: rpcError } = await supabaseAdmin.rpc('process_payout_batch', {
                        p_batch_id: batch.id,
                        p_driver_ids: [driverId]
                    });

                    if (rpcError) throw rpcError;

                    // ✅ 3.6 Update batch with transfer info
                    if (transferId) {
                        await supabaseAdmin
                            .from('payout_batches')
                            .update({
                                status: 'paid',
                                metadata: {
                                    driver_id: driverId,
                                    transfer_id: transferId
                                }
                            })
                            .eq('id', batch.id);
                    }

                    results.batchesCreated++;
                    results.totalAmount += group.amount;
                    results.driversPaid++;

                    // ✅ 3.7 Audit log
                    await AuditService.log({
                        action: 'payout_processed',
                        entityType: 'payout_batch',
                        entityId: batch.id,
                        metadata: {
                            driverId,
                            amount: group.amount,
                            transferId
                        }
                    });

                } catch (err: any) {
                    console.error(`[PayoutService] Error for driver ${driverId}:`, err);

                    results.errors.push(`Driver ${driverId}: ${err.message}`);

                    await AuditService.log({
                        action: 'payout_failed',
                        entityType: 'driver',
                        entityId: driverId,
                        metadata: {
                            error: err.message
                        }
                    });
                }
            }

        } catch (error: any) {
            console.error('[PayoutService] Global payout error:', error);
            results.errors.push(`Global: ${error.message}`);
        }

        return results;
    }
}