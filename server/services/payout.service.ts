/**
 * Payout batch service.
 *
 * DISABLED: per-job settlement (LogisticsService.completeJob) is the single
 * settlement path. The legacy batch runner has been REMOVED entirely so there is
 * no reachable alternative payment path that could double-pay an entitlement the
 * per-job transfer already settled.
 */
export class PayoutService {
    static async processDriverPayouts() {
        console.warn('[PayoutService] batch payout is disabled; use per-job settlement.');
        return {
            disabled: true,
            batchesCreated: 0,
            totalAmount: 0,
            driversPaid: 0,
            errors: ['Batch payout is disabled. Use per-job settlement.']
        };
    }
}
