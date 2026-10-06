import { stripe } from './stripe.service';
import { supabaseAdmin } from './supabase.service';
import { FareSplitService } from './fare-split.service';
import { isDefinitiveStripeRejection } from './stripe-errors';

/**
 * Ride customer no-show — FINAL policy (default-off, UK/GBP ride pickup only).
 *
 *   grace = 5 minutes after server-verified arrival.
 *   feeMinor = min(500, floor(agreedRideFareMinor / 2))   (LOWER of £5 or 50%)
 *   driverShareMinor  = round(feeMinor * 80 / 100)
 *   platformShareMinor = feeMinor - driverShareMinor
 *
 * The disclosed split is persisted with the booking (in fare_breakdown) and is
 * immutable; later configuration changes never alter an existing booking's
 * terms. Bookings without the disclosure are never charged.
 *
 * Database RPCs perform DB operations only; Stripe calls run here on the server.
 */

export const NO_SHOW_POLICY_VERSION = 'ride-no-show-v1';
export const NO_SHOW_GRACE_MINUTES = 5;
export const NO_SHOW_FEE_CAP_MINOR = 500;        // £5
export const NO_SHOW_FEE_PERCENT = 50;           // 50% of agreed fare
export const NO_SHOW_DRIVER_SHARE_PERCENT = 80;  // 80% of the fee

/** Conservative location-rule defaults (no dedicated verified-proximity rule exists). */
export const NO_SHOW_ARRIVAL_MAX_DISTANCE_M = 200;   // pickup proximity
export const NO_SHOW_ARRIVAL_MAX_LOCATION_AGE_MS = 5 * 60_000; // location freshness

export interface NoShowSplit {
  policyVersion: string;
  feeMinor: number;
  driverShareMinor: number;
  platformShareMinor: number;
  currency: string;
}

export class NoShowService {
  static readonly POLICY_VERSION = NO_SHOW_POLICY_VERSION;
  static readonly GRACE_MINUTES = NO_SHOW_GRACE_MINUTES;
  static readonly FEE_CAP_MINOR = NO_SHOW_FEE_CAP_MINOR;
  static readonly DRIVER_SHARE_PERCENT = NO_SHOW_DRIVER_SHARE_PERCENT;

  /**
   * The disclosed no-show split. feeMinor = LOWER of £5 or 50% of the agreed
   * ride fare; driver/platform split 80/20. Never includes an errand purchase
   * budget. No ordinary commission or extra platform fee on top.
   */
  static computeNoShowSplit(agreedRideFareMinor: number, currency = 'GBP'): NoShowSplit {
    const fareMinor = Math.max(0, Math.round(Number(agreedRideFareMinor) || 0));
    const feeMinor = Math.min(NO_SHOW_FEE_CAP_MINOR, Math.floor(fareMinor / 2));
    const driverShareMinor = Math.round((feeMinor * NO_SHOW_DRIVER_SHARE_PERCENT) / 100);
    const platformShareMinor = feeMinor - driverShareMinor;
    return {
      policyVersion: NO_SHOW_POLICY_VERSION,
      feeMinor,
      driverShareMinor,
      platformShareMinor,
      currency: String(currency || 'GBP').toUpperCase()
    };
  }

  /** Feature flag — default OFF (safe-zero). */
  static isEnabled(config: { noShowEnabled?: boolean } | null | undefined): boolean {
    return Boolean(config?.noShowEnabled);
  }

  /**
   * Read the no-show feature flag from the existing marketplace_settings config
   * (`no_show` key, `{ enabled: true }`). Defaults OFF when absent/unset, so the
   * feature is never enabled in production without an explicit config change.
   */
  static async getEnabledConfig(): Promise<{ noShowEnabled: boolean }> {
    try {
      const { data } = await supabaseAdmin
        .from('marketplace_settings')
        .select('value')
        .eq('key', 'no_show')
        .is('tenant_id', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const raw = (data as any)?.value;
      if (raw && typeof raw === 'object' && (raw as any).enabled === true) {
        return { noShowEnabled: true };
      }
    } catch (error) {
      console.warn('[NoShowService] getEnabledConfig read failed (default off):', error);
    }
    return { noShowEnabled: false };
  }

  /** UK/GBP only for the initial scope. */
  static isSupported(country: string | null | undefined, currency: string | null | undefined): boolean {
    return String(country || '').trim().toUpperCase() === 'GB'
      && String(currency || '').trim().toUpperCase() === 'GBP';
  }

  /** Immutable grace deadline from a verified arrival timestamp. */
  static graceUntil(arrivedAtIso: string): string {
    return new Date(new Date(arrivedAtIso).getTime() + NO_SHOW_GRACE_MINUTES * 60_000).toISOString();
  }

  /** Read the disclosed split from a booking's frozen fare_breakdown. */
  static splitFromBreakdown(breakdown: unknown): NoShowSplit | null {
    const b = (breakdown && typeof breakdown === 'object') ? breakdown as Record<string, unknown> : {};
    if (b['noShowPolicyVersion'] !== NO_SHOW_POLICY_VERSION) return null;
    const num = (k: string) => { const v = Number(b[k]); return Number.isFinite(v) ? v : 0; };
    return {
      policyVersion: String(b['noShowPolicyVersion']),
      feeMinor: num('noShowFeeMinor'),
      driverShareMinor: num('noShowDriverShareMinor'),
      platformShareMinor: num('noShowPlatformShareMinor'),
      currency: String(b['currency'] || 'GBP').toUpperCase()
    };
  }

  /**
   * Server-authoritative arrival. The caller must already have validated
   * ownership, ride-pickup state and location proximity/freshness. This is the
   * atomic, idempotent write (repeated arrival never resets the timer).
   */
  static async recordArrival(jobId: string, driverId: string): Promise<Record<string, any> | null> {
    const { data, error } = await supabaseAdmin.rpc('mark_job_arrived', {
      p_job_id: jobId,
      p_driver_id: driverId,
      p_grace_minutes: NO_SHOW_GRACE_MINUTES
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  /**
   * Finalise a no-show: terminal transition (RPC) followed by server-side money
   * movement. Returns the job with financial status. Idempotent: a repeated call
   * does not move money twice.
   */
  static async finalizeNoShow(
    jobId: string,
    driverId: string,
    reason: string,
    contactAttempted: boolean
  ): Promise<Record<string, any>> {
    // 1. Terminal transition (DB only). RPC returns null when not eligible.
    const { data: finalized, error: rpcError } = await supabaseAdmin.rpc('finalize_job_no_show', {
      p_job_id: jobId,
      p_driver_id: driverId,
      p_reason: reason || 'Customer no-show',
      p_contact_attempted: contactAttempted
    });
    if (rpcError) throw rpcError;
    const job = (Array.isArray(finalized) ? finalized[0] : finalized) as Record<string, any>;
    if (!job) throw new Error('No-show is not eligible for this booking.');

    // Already settled → idempotent no-op.
    if (job.no_show_status && job.no_show_status !== 'pending') return job;

    const split = this.splitFromBreakdown(job.fare_breakdown);
    if (!split) throw new Error('Booking has no no-show disclosure.');

    // 2. Money movement (server-side Stripe).
    await this.executeNoShowMoney(job, split);

    return job;
  }

  private static async executeNoShowMoney(job: Record<string, any>, split: NoShowSplit): Promise<void> {
    const jobId = String(job.id);
    const currency = String(job.currency_code || 'gbp').toLowerCase();
    const paymentMethod = String(job.payment_method || '').toLowerCase();

    if (paymentMethod === 'wallet' || String(job.payment_status || '').toLowerCase() === 'wallet_funded') {
      await this.finalizeWalletNoShow(jobId, split);
    } else if (job.payment_intent_id) {
      await this.finalizeCardNoShow(job, split, currency);
    }

    // Driver compensation via the single hardened settlement authority
    // (claim -> transfer -> record), not a distinct transfer path alone.
    if (split.driverShareMinor > 0) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('stripe_account_id')
        .eq('id', job.driver_id)
        .maybeSingle();
      const stripeAccountId = (profile as any)?.stripe_account_id || (job as any).stripe_account_id;
      if (stripeAccountId) {
        await this.payDriverCompensation(job, split, String(stripeAccountId));
      }
    }
  }

  private static async finalizeCardNoShow(
    job: Record<string, any>,
    split: NoShowSplit,
    currency: string
  ): Promise<void> {
    const jobId = String(job.id);
    const paymentIntentId = String(job.payment_intent_id);
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    const capturedMinor = Number(pi.amount_received || 0);

    if (pi.status === 'requires_capture') {
      // Capture only the fee; then cancel to release the unused authorisation.
      await stripe.paymentIntents.capture(
        paymentIntentId,
        { amount_to_capture: split.feeMinor },
        { idempotencyKey: `no-show-capture-${jobId}` }
      );
      await stripe.paymentIntents.cancel(paymentIntentId, { idempotencyKey: `no-show-release-${jobId}` }).catch(() => undefined);
    } else if (pi.status === 'succeeded' && capturedMinor > split.feeMinor) {
      // Refund the remainder to the original source, accounting for prior refunds.
      const remainderMinor = capturedMinor - split.feeMinor - Number(job.total_refunded_minor || 0);
      if (remainderMinor > 0) {
        const { data: reserved } = await supabaseAdmin.rpc('reserve_job_refund', {
          p_job_id: jobId, p_amount_minor: remainderMinor, p_captured_minor: capturedMinor
        });
        if (reserved) {
          try {
            await stripe.refunds.create(
              { payment_intent: paymentIntentId, amount: remainderMinor },
              { idempotencyKey: `no-show-refund-${jobId}-${remainderMinor}` }
            );
            await supabaseAdmin.from('jobs').update({ no_show_status: 'fee_charged' }).eq('id', jobId);
          } catch (e) {
            await supabaseAdmin.rpc('release_job_refund', { p_job_id: jobId, p_amount_minor: remainderMinor });
            throw e;
          }
        }
      }
    }
  }

  private static async finalizeWalletNoShow(jobId: string, split: NoShowSplit): Promise<void> {
    // Reuse the existing atomic wallet ledger convention: settle_job_wallet_reservation
    // settles ONLY the fee and releases the remainder back to the wallet in one
    // transaction, and is idempotent ('already_settled' — never debits twice).
    const feeMajor = FareSplitService.fromMinor(split.feeMinor, split.currency);
    const { data, error } = await supabaseAdmin.rpc('settle_job_wallet_reservation', {
      p_job_id: jobId,
      p_amount: feeMajor
    });
    if (error) throw error;
    const result = (data || {}) as Record<string, unknown>;
    const status = String(result['status'] || '');
    if (status === 'settled' || status === 'already_settled') {
      await supabaseAdmin
        .from('jobs')
        .update({ no_show_status: 'fee_charged' })
        .eq('id', jobId);
      return;
    }
    throw new Error(String(result['reason'] || 'Wallet no-show settlement failed'));
  }

  private static async payDriverCompensation(job: Record<string, any>, split: NoShowSplit, stripeAccountId: string): Promise<void> {
    const jobId = String(job.id);

    // 1. Atomic claim via the hardened settlement authority (single-writer).
    const { data: claimed, error: claimError } = await supabaseAdmin.rpc('claim_job_settlement', {
      p_job_id: jobId,
      p_amount_minor: split.driverShareMinor,
      p_currency: split.currency,
      p_destination: stripeAccountId,
      p_lease_seconds: 120
    });
    if (claimError) throw claimError;
    if (!claimed) return; // already claimed/settled — idempotent

    // 2. Stripe transfer (server-side), with a distinct transfer_group.
    let transferId: string;
    try {
      const transfer = await stripe.transfers.create(
        {
          amount: split.driverShareMinor,
          currency: split.currency.toLowerCase(),
          destination: stripeAccountId,
          transfer_group: `no_show_${jobId}`,
          description: `No-show compensation for job ${jobId}`,
          metadata: { job_id: jobId, driver_id: String(job.driver_id), purpose: 'no_show_compensation' }
        },
        { idempotencyKey: `no-show-transfer-${jobId}` }
      );
      transferId = transfer.id;
    } catch (transferError: any) {
      // Documented definitive rejection vs uncertain: mirror the settlement state.
      const status = isDefinitiveStripeRejection(transferError) ? 'failed' : 'unknown';
      await supabaseAdmin
        .from('jobs')
        .update({ settlement_status: status, stripe_transfer_status: status, updated_at: new Date().toISOString() })
        .eq('id', jobId);
      throw transferError;
    }

    // 3. Atomic record (jobs + earnings) with the no-show purpose, preserving
    //    the terminal 'cancelled' status. This is the same durable write path as
    //    ordinary settlement, with a distinct purpose.
    const { error: recordError } = await supabaseAdmin.rpc('record_no_show_settlement', {
      p_job_id: jobId,
      p_driver_id: job.driver_id,
      p_amount_minor: split.driverShareMinor,
      p_platform_share_minor: split.platformShareMinor,
      p_fee_minor: split.feeMinor,
      p_currency: split.currency,
      p_stripe_transfer_id: transferId
    });
    if (recordError) throw recordError;

    await supabaseAdmin
      .from('jobs')
      .update({ no_show_status: 'compensation_paid' })
      .eq('id', jobId);
  }
}
