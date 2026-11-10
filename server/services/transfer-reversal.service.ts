import { stripe } from './stripe.service';
import { FareSplitService } from './fare-split.service';

/**
 * Transfer reversal — the counterpart to a customer refund.
 *
 * A customer refund returns money to the customer; a transfer reversal returns
 * the driver's entitlement back to the platform so a refunded job does not
 * leave the platform out of pocket. Reversals are idempotent via a deterministic
 * key (Stripe's short-window safeguard) and durable via `jobs.stripe_transfer_status`.
 */

export interface ReversalResult {
  id: string;
  amountMinor: number;
}

export class TransferReversalService {
  /**
   * Reverse a per-job driver transfer. Supports full or partial amounts. A
   * deterministic idempotency key prevents double reversal inside Stripe's
   * window; callers must also guard on `jobs.stripe_transfer_status`.
   */
  static async reverseDriverTransfer(params: {
    transferId: string;
    amountMajor: number;
    currency: string;
    jobId: string;
    partialIndex?: number;
  }): Promise<ReversalResult> {
    const amountMinor = FareSplitService.toMinor(params.amountMajor, params.currency);
    if (amountMinor <= 0) {
      throw new Error('Reversal amount must be positive.');
    }

    const key = params.partialIndex === undefined
      ? `reversal-job-${params.jobId}`
      : `reversal-job-${params.jobId}-${params.partialIndex}`;

    const reversal = await stripe.transfers.createReversal(
      params.transferId,
      { amount: amountMinor },
      { idempotencyKey: key }
    );

    return { id: reversal.id, amountMinor };
  }
}
