import { stripe } from './stripe.service';
import { supabaseAdmin } from './supabase.service';
import { AuditService } from './audit.service';
import { calculatePayoutBreakdown } from './payout-calculator';
import { IssuingService } from './issuing.service';
import { PaymentAuthorityService } from './payment-authority.service';
import { FareSplitService, HistoricalFareReconciliationRequired, FareSplitSnapshot } from './fare-split.service';
import { PayoutEligibilityService } from './payout-eligibility.service';

export class LogisticsService {
  private static readonly EARTH_RADIUS_KM = 6371;

  /**
   * Calculate distance between two points using Haversine formula
   */
  static calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return this.EARTH_RADIUS_KM * c;
  }

  private static toRad(value: number): number {
    return (value * Math.PI) / 180;
  }

  /**
   * Calculate price based on distance
   */
  static calculatePrice(distanceKm: number): number {
    const baseFee = 20;
    const ratePerKm = 2.5;
    const price = baseFee + (distanceKm * ratePerKm);
    return Math.round(price * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Calculate payout breakdown for a job
   */
  static calculatePayout(
    totalPrice: number,
    pricingPlan: 'starter' | 'pro',
    commissionRate: number,
    serviceFeePercent: number = 0
  ) {
    return calculatePayoutBreakdown(totalPrice, pricingPlan, commissionRate, serviceFeePercent);
  }

  /**
   * Find nearest drivers within a tenant
   */
  static async findNearestDrivers(lat: number, lon: number, tenantId: string, limit = 5) {
    // Fetch drivers with recent location (last 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const { data: locations, error } = await supabaseAdmin
      .from('driver_locations')
      .select('*')
      .eq('tenant_id', tenantId)
      .gt('updated_at', fiveMinutesAgo);

    if (error) throw error;

    const candidates = locations.map(loc => {
      const distance = this.calculateDistance(lat, lon, loc.lat, loc.lng);
      return {
        ...loc,
        distance
      };
    });

    // Sort by distance and return top N
    return candidates
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  /**
   * Durable completion evidence: the per-job earnings row. driver_earnings has
   * UNIQUE(job_id), so a row here means the monetary tail already ran for this job.
   */
  private static async hasDriverEarnings(jobId: string): Promise<boolean> {
    // C2: only a SETTLED earnings row proves the money tail already ran. A
    // trigger-created 'pending' row (e.g. from an admin status write) must NOT
    // short-circuit the real completion, or capture/transfer would be skipped.
    const { data, error } = await supabaseAdmin
      .from('driver_earnings')
      .select('job_id')
      .eq('job_id', jobId)
      .eq('status', 'paid')
      .maybeSingle();

    if (error) {
      // Fail closed on an unreadable marker: never re-run money movement when we
      // cannot prove the completion tail did not already run.
      console.error('[LogisticsService.hasDriverEarnings] earnings lookup failed:', error);
      throw new Error('Could not verify whether this request was already settled.');
    }

    return !!data;
  }

  /** Resolve the frozen fare split; never recompute from live configuration. */
  private static resolveFareSplit(job: any): FareSplitSnapshot {
    try {
      return FareSplitService.fromSnapshot(job.fare_breakdown, job.currency_code);
    } catch (error) {
      if (error instanceof HistoricalFareReconciliationRequired) throw error;
      throw new HistoricalFareReconciliationRequired('Fare split snapshot is missing or malformed.');
    }
  }

  /**
   * Atomically acquire the settlement claim: transition `settlement_status` from a
   * claimable state to 'claimed' and persist the immutable settlement identity in
   * the SAME update. Exactly one writer wins (the WHERE admits one transition).
   * `stripe_transfer_id` is never used as a claim token here.
   */
  private static readonly SETTLEMENT_LEASE_MS = 120_000;

  private static async claimSettlement(
    jobId: string,
    immutable: { amountMinor: number; currency: string; destination: string }
  ): Promise<boolean> {
    const { data, error } = await supabaseAdmin.rpc('claim_job_settlement', {
      p_job_id: jobId,
      p_amount_minor: immutable.amountMinor,
      p_currency: immutable.currency,
      p_destination: immutable.destination,
      p_lease_seconds: Math.round(this.SETTLEMENT_LEASE_MS / 1000)
    });

    if (error) throw error;
    return Boolean(data);
  }

  /** Read the current settlement state (status + genuine transfer id). */
  private static async readSettlementState(jobId: string): Promise<{ status: string; transferId: string | null } | null> {
    const { data, error } = await supabaseAdmin
      .from('jobs')
      .select('settlement_status, stripe_transfer_id')
      .eq('id', jobId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      status: String((data as any).settlement_status || 'pending').toLowerCase(),
      transferId: (data as any).stripe_transfer_id || null
    };
  }

  /**
   * Persist a settlement state transition. `transferId: null` clears the claim
   * (definitive failure); an omitted transferId leaves stripe_transfer_id alone.
   */
  private static async markSettlement(
    jobId: string,
    opts: { status: string; transferId?: string | null; error?: string; errorType?: string; metadata?: Record<string, any> }
  ): Promise<void> {
    await supabaseAdmin
      .from('jobs')
      .update({
        settlement_status: opts.status,
        stripe_transfer_status: opts.status,
        ...(opts.transferId === null ? { stripe_transfer_id: null } : {}),
        ...(opts.error
          ? {
            metadata: {
              ...(opts.metadata || {}),
              stripe_transfer_error: opts.error,
              stripe_transfer_error_type: opts.errorType || ''
            }
          }
          : {}),
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId);
  }

  /**
   * Reconcile an ambiguous/stale settlement against Stripe by transfer_group and
   * destination. Never infers "no transfer" from a missing local id — it asks
   * Stripe. Returns the real transfer id, or null (which keeps the job blocked).
   */
  private static async reconcileTransfer(jobId: string, destination: string): Promise<string | null> {
    try {
      const transfers = await stripe.transfers.list({ transfer_group: `job_${jobId}`, destination, limit: 5 });
      const first = (transfers?.data || [])[0];
      return first ? String(first.id) : null;
    } catch (error) {
      console.error('[LogisticsService.reconcileTransfer] Stripe lookup failed:', error);
      return null;
    }
  }

  /**
   * Validate booking status transition
   */
  static isValidBookingTransition(current: string, next: string): boolean {
    const transitions: Record<string, string[]> = {
      'requested': ['pending_fare_confirmation', 'negotiating', 'fare_agreed', 'accepted', 'searching', 'cancelled'],
      'pending_fare_confirmation': ['negotiating', 'fare_agreed', 'cancelled'],
      'negotiating': ['fare_agreed', 'cancelled'],
      'fare_agreed': ['searching', 'cancelled'],
      'searching': ['assigned', 'accepted', 'no_driver_found', 'cancelled'],
      'assigned': ['in_progress', 'cancelled'],
      'in_progress': ['completed'],
      'completed': [],
      'cancelled': [],
      'no_driver_found': ['searching', 'cancelled']
    };

    return transitions[current]?.includes(next) || false;
  }

  /**
   * Validate payment status transition
   */
  static isValidPaymentTransition(current: string, next: string): boolean {
    const transitions: Record<string, string[]> = {
      'pending': ['authorized', 'failed'],
      'authorized': ['captured', 'cancelled'],
      'captured': ['refunded'],
      'refunded': [],
      'failed': ['pending']
    };

    return transitions[current]?.includes(next) || false;
  }

  /**
   * Complete a job and finalize payout
   */
  static async completeJob(jobId: string, completionPin?: string | null, expectedDriverId?: string | null) {
    const rawJobId = String(jobId || '').trim();

    if (!rawJobId) {
      throw new Error('jobId required');
    }

    let jobQuery = supabaseAdmin.from('jobs').select('*');

    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawJobId)) {
      jobQuery = jobQuery.eq('id', rawJobId);
    } else {
      jobQuery = jobQuery.ilike('id', `${rawJobId}%`);
    }

    const { data: job, error: jobError } = await jobQuery.maybeSingle();

    if (jobError || !job) {
      console.error('[LogisticsService.completeJob] job lookup failed:', { rawJobId, error: jobError });
      throw new Error('Job not found');
    }

    const driverId = job.driver_id || job.accepted_driver_id;

    if (!driverId) {
      throw new Error('Cannot complete job without an assigned driver');
    }

    // Ownership guard. Runs before PIN validation, Stripe capture, transfer,
    // earnings sync or any other side effect. The authenticated caller must be
    // the driver assigned to this job.
    if (!expectedDriverId || String(expectedDriverId) !== String(driverId)) {
      throw new Error('Only the assigned driver can complete this request');
    }

    // Completion readiness. Ownership alone does not stop the SAME driver from
    // calling complete again (a resend, an impatient second tap, or a retry after a
    // partial failure). Decide from PERSISTED state what still needs to run instead
    // of blindly re-running money movement or blindly refusing.
    const wasAlreadyCompleted = String(job.status || '').toLowerCase() === 'completed';

    // Fully-complete evidence: the job is marked completed AND its earnings row
    // exists. driver_earnings has UNIQUE(job_id), so that row is the durable marker
    // that the whole money tail (capture/settlement, transfer, status write,
    // earnings) finished. Only then is a repeat call a safe no-op.
    if (wasAlreadyCompleted && await this.hasDriverEarnings(job.id)) {
      console.log('[LogisticsService.completeJob] Job already fully completed, returning without side effects:', job.id);
      return job;
    }

    // Otherwise resume. Every step below is individually skipped when its own
    // durable marker is already present, so a retry finishes only the missing work
    // and a repeat can never capture, transfer, settle or earn twice.
    if (wasAlreadyCompleted) {
      console.warn('[LogisticsService.completeJob] Resuming completion of a partially completed job:', job.id);
    }

    const completionMetadata = await this.assertCompletionPin(job, completionPin);

    const { data: driverProfile } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', driverId)
      .maybeSingle();

    const stripeAccountId =
      driverProfile?.stripe_account_id ||
      driverProfile?.stripe_connect_account_id ||
      driverProfile?.stripe_connected_account_id ||
      driverProfile?.stripe_connect_id;

    if (!stripeAccountId) {
      throw new Error('Driver Stripe Connect account is missing');
    }

    const plan = String(driverProfile?.pricing_plan || 'starter').toLowerCase();

    // One authoritative fare split, frozen at quote/agreement time. Never
    // recompute from live config; a missing/ambiguous snapshot fails closed for
    // explicit reconciliation instead of inventing a new entitlement.
    const split = this.resolveFareSplit(job);
    const totalPrice = split.customerCharge;
    const platformFee = split.platformFeeAmount;
    const driverPayout = split.driverEntitlement;
    const safeCommissionRate = split.commissionPercent;

    // UK-only payout scope: verify the actual Stripe account country/capabilities
    // before any money movement. Fails closed on unsupported/unknown eligibility.
    await PayoutEligibilityService.assertEligible(driverId, stripeAccountId);

    const settlementCurrency = String(split.currency || job.currency_code || 'gbp').toUpperCase();
    const payoutAmountInPence = FareSplitService.toMinor(driverPayout, settlementCurrency);

    if (payoutAmountInPence <= 0) {
      throw new Error('Invalid driver payout amount');
    }

    // Resolve the current settlement state. `stripe_transfer_id` is only ever a
    // genuine Stripe transfer id (never a claim token), so its presence means a
    // transfer already happened and we are resuming.
    let stripeTransferId: string | null = job.stripe_transfer_id || null;

    if (!stripeTransferId) {
      // Atomically acquire the claim + persist the immutable settlement identity.
      const claimed = await this.claimSettlement(job.id, {
        amountMinor: payoutAmountInPence,
        currency: settlementCurrency,
        destination: stripeAccountId
      });

      if (!claimed) {
        const state = await this.readSettlementState(job.id);
        // Reconcile against Stripe by transfer_group before deciding there is no
        // transfer. Never infer "no transfer" from a missing local id.
        if (state && (state.status === 'unknown' || state.status === 'claimed')) {
          const reconciledId = await this.reconcileTransfer(job.id, stripeAccountId);
          if (reconciledId) {
            stripeTransferId = reconciledId;
          } else {
            // No transfer found. A transfer_group lookup returning nothing cannot
            // prove the original (now-expired) claim will never succeed, so we
            // must NOT re-transfer. A stale 'claimed' is demoted to 'unknown'
            // (blocked) for reconciliation; it never auto-becomes claimable.
            if (state.status === 'claimed') {
              await this.markSettlement(job.id, { status: 'unknown' });
            }
            console.warn('[LogisticsService.completeJob] settlement blocked and unreconciled, skipping:', job.id, state.status);
            return job;
          }
        } else {
          console.warn('[LogisticsService.completeJob] settlement not claimable, skipping:', job.id, state?.status);
          return job;
        }
      }
    }

    let finalPaymentStatus = String(job.payment_status || 'pending').toLowerCase();
    const isWalletPayment = finalPaymentStatus === 'wallet_funded' || String(job.payment_method || '').toLowerCase() === 'wallet';

    if (finalPaymentStatus === 'paid') {
      console.log('[LogisticsService.completeJob] Payment already paid, skipping capture:', job.id);
    } else if (isWalletPayment) {
      await this.settleWalletJobReservation(job, totalPrice);
      finalPaymentStatus = 'paid';
    } else if (finalPaymentStatus === 'authorized') {
      if (!job.payment_intent_id) {
        throw new Error('Payment is authorized but payment_intent_id is missing');
      }

      // Release closure: card errands capture only service fare + actually-spent
      // purchase budget, converging with the wallet path (which refunds unused
      // budget). Unused purchasing budget is never captured as driver earnings.
      let captureAmountInPence: number | undefined;
      if (String(job.service_slug || '').toLowerCase() === 'errand') {
        const payable = await PaymentAuthorityService.resolve(job);
        const serviceFare = Number(payable.serviceFareMajor || totalPrice || 0);
        const budget = Math.max(0, Number(payable.totalAuthorisationMajor || 0) - serviceFare);
        const { data: details } = await supabaseAdmin
          .from('errand_details')
          .select('actual_spending')
          .eq('job_id', job.id)
          .maybeSingle();
        const actualSpending = this.roundMoney(Number(details?.actual_spending || 0));
        captureAmountInPence = Math.round((serviceFare + Math.min(budget, actualSpending)) * 100);
      }

      try {
        const captured = await stripe.paymentIntents.capture(
          job.payment_intent_id,
          captureAmountInPence ? { amount_to_capture: captureAmountInPence } : ({} as any),
          { idempotencyKey: `capture-job-${job.id}` }
        );

        if (captured.status !== 'succeeded') {
          throw new Error(`Stripe capture returned status: ${captured.status}`);
        }

        finalPaymentStatus = 'paid';
      } catch (captureError: any) {
        const message = String(captureError?.message || '');

        if (message.toLowerCase().includes('already been captured')) {
          finalPaymentStatus = 'paid';
        } else {
          console.error('[LogisticsService.completeJob] Stripe capture failed:', captureError);
          throw new Error(message || 'Failed to capture customer payment');
        }
      }
    } else {
      throw new Error(`Payment has not been authorized. Current status: ${finalPaymentStatus}`);
    }

    if (!stripeTransferId) {
      try {
        const transfer = await stripe.transfers.create(
          {
            amount: payoutAmountInPence,
            currency: settlementCurrency.toLowerCase(),
            destination: stripeAccountId,
            transfer_group: `job_${job.id}`,
            description: `Movabi driver payout for job ${job.id}`,
            metadata: {
              job_id: String(job.id),
              driver_id: String(driverId),
              total_price: String(totalPrice),
              driver_payout: String(driverPayout),
              platform_fee: String(platformFee),
              plan
            }
          },
          {
            idempotencyKey: `transfer-job-${job.id}`
          }
        );

        stripeTransferId = transfer.id;
      } catch (transferError: any) {
        console.error('[LogisticsService.completeJob] Stripe transfer failed:', transferError);
        const message = String(transferError?.message || 'Failed to transfer driver payout');
        const statusCode = Number(transferError?.statusCode || 0);
        // A 4xx is a definitive Stripe rejection: the transfer did NOT happen.
        // A connection error, timeout, or 5xx is AMBIGUOUS: Stripe may have
        // completed the transfer even though the response never reached us. We do
        // NOT assume "no transfer" from a missing local id; ambiguous outcomes
        // become 'unknown' and block further transfers until reconciled.
        const markerStatus = (statusCode >= 400 && statusCode < 500) ? 'failed' : 'unknown';
        try {
          await this.markSettlement(job.id, {
            status: markerStatus,
            // Definitive failure releases the claim (re-claimable); ambiguous keeps
            // stripe_transfer_id untouched (still null) but status 'unknown' blocks.
            transferId: markerStatus === 'failed' ? null : undefined,
            error: message,
            errorType: String(transferError?.type || ''),
            metadata: job.metadata
          });
        } catch (markError) {
          // Best-effort bookkeeping: never mask the economically important Stripe
          // error with a marker-persistence failure.
          console.error('[LogisticsService.completeJob] failed to persist transfer failure marker:', markError);
        }
        throw transferError instanceof Error ? transferError : new Error(message);
      }
    } else {
      console.log('[LogisticsService.completeJob] Transfer already exists, skipping transfer:', stripeTransferId);
    }

    const now = new Date().toISOString();
    const completedMetadata = this.getCompletionPin(completionMetadata)
      ? {
        ...completionMetadata,
        completion_pin_required: true,
        completion_pin_verified_at: now
      }
      : completionMetadata;

    // Atomically record transfer success + earnings in ONE database transaction
    // (record_job_settlement). This is the single write path; atomicity is real.
    const { data: settledRows, error: settleError } = await supabaseAdmin.rpc('record_job_settlement', {
      p_job_id: job.id,
      p_driver_id: driverId,
      p_total_price: totalPrice,
      p_driver_payout: driverPayout,
      p_platform_fee: platformFee,
      p_commission_fee: split.driverCommissionAmount,
      p_commission_rate: safeCommissionRate,
      p_stripe_transfer_id: stripeTransferId,
      p_currency_code: job.currency_code || 'GBP',
      p_country_code: job.country_code || 'GB',
      p_was_already_completed: wasAlreadyCompleted
    });

    if (settleError) {
      console.error('[LogisticsService.completeJob] settlement recording failed:', settleError);
      throw new Error(settleError.message || 'Failed to record settlement');
    }

    const updatedJob = Array.isArray(settledRows) ? settledRows[0] : settledRows;

    // Completion-pin evidence is not money-critical; write it idempotently.
    await supabaseAdmin
      .from('jobs')
      .update({ metadata: completedMetadata, updated_at: now })
      .eq('id', job.id);

    await AuditService.logBooking(job.customer_id, 'job_completed', job.id, {
      total_price: totalPrice,
      reserved_price: totalPrice,
      driver_payout: driverPayout,
      platform_fee: platformFee,
      stripe_transfer_id: stripeTransferId,
      pricing_plan_used: plan,
      commission_rate_used: safeCommissionRate
    });

    if (String(job.service_slug || '').toLowerCase() === 'errand' && driverId) {
      try {
        await IssuingService.freezeDriverCard(driverId, `Errand ${job.id} completed`);
        await supabaseAdmin
          .from('job_issuing_spend_controls')
          .update({
            status: 'completed',
            deactivated_at: now,
            updated_at: now
          })
          .eq('job_id', job.id);
      } catch (error) {
        console.error('[LogisticsService.completeJob] issuing card deactivation failed:', error);
      }
    }

    return updatedJob;
  }

  private static async assertCompletionPin(job: any, submittedPin?: string | null): Promise<Record<string, any>> {
    const metadata = this.getMetadata(job);

    // Release closure: the completion secret lives in job_completion_secrets
    // (customer-only RLS), not in jobs.metadata (which the driver's jobs.*
    // SELECT returns wholesale). Fall back to metadata ONLY for in-flight jobs
    // created before the secret store existed.
    let expectedPin = '';
    const { data: secretRow } = await supabaseAdmin
      .from('job_completion_secrets')
      .select('completion_pin')
      .eq('job_id', job.id)
      .maybeSingle();
    if (secretRow?.completion_pin) {
      expectedPin = this.normalizeCompletionPin(secretRow.completion_pin);
    } else {
      expectedPin = this.getCompletionPin(metadata);
    }

    if (!expectedPin) {
      return metadata;
    }

    const providedPin = this.normalizeCompletionPin(submittedPin);

    if (!providedPin) {
      throw new Error('Customer PIN is required to complete this request.');
    }

    if (providedPin !== expectedPin) {
      throw new Error('The customer PIN is incorrect. Ask the customer for the current 4-digit PIN and try again.');
    }

    return metadata;
  }

  private static getMetadata(job: any): Record<string, any> {
    const raw = job?.metadata || {};

    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    return raw && typeof raw === 'object' ? raw : {};
  }

  private static getCompletionPin(metadata: Record<string, any>): string {
    return this.normalizeCompletionPin(
      metadata.completion_pin ||
      metadata.service_completion_pin ||
      metadata.delivery_pin
    );
  }

  private static normalizeCompletionPin(value: unknown): string {
    return String(value ?? '').replace(/\D/g, '').slice(0, 8);
  }

  /**
   * Read-only estimate of the amount that will settle from the wallet reservation.
   * Used only to size the driver payout / platform fee before settlement. The
   * authoritative amount is re-derived from DB state inside
   * settle_job_wallet_reservation, which performs the actual mutation.
   */
  private static async resolveWalletSettlementAmount(job: any, fallbackAmount: number): Promise<number> {
    if (String(job.service_slug || '').toLowerCase() !== 'errand') {
      return this.roundMoney(fallbackAmount);
    }

    const [{ data: details }, { data: funding }] = await Promise.all([
      supabaseAdmin
        .from('errand_details')
        .select('actual_spending')
        .eq('job_id', job.id)
        .maybeSingle(),
      supabaseAdmin
        .from('errand_funding')
        .select('amount_reserved')
        .eq('job_id', job.id)
        .maybeSingle()
    ]);

    const actualSpending = this.roundMoney(Number(details?.actual_spending || 0));
    const reservedAmount = this.roundMoney(Number(funding?.amount_reserved || fallbackAmount));

    if (actualSpending <= 0) {
      return this.roundMoney(fallbackAmount);
    }

    return this.roundMoney(Math.min(reservedAmount, actualSpending));
  }

  /**
   * Settle the customer's wallet reservation for this job.
   *
   * The whole operation (balance mutation, ledger rows and the settlement marker)
   * runs inside ONE Postgres transaction in settle_job_wallet_reservation, so it can
   * never leave a debited wallet without durable settlement evidence. A repeat call
   * returns 'already_settled' without changing balances. This deliberately replaces
   * the previous sequence of independent PostgREST calls.
   */
  private static async settleWalletJobReservation(job: any, amount: number): Promise<void> {
    const { data, error } = await supabaseAdmin.rpc('settle_job_wallet_reservation', {
      p_job_id: job.id,
      p_amount: amount
    });

    if (error) {
      console.error('[LogisticsService.settleWalletJobReservation] atomic settlement failed:', error);
      throw new Error(error.message || 'Failed to settle wallet reservation');
    }

    const result = (data || {}) as Record<string, unknown>;
    const status = String(result['status'] || '');

    if (status === 'settled') {
      console.log('[LogisticsService.settleWalletJobReservation] settled', {
        jobId: job.id,
        amountSettled: result['amount_settled'],
        amountReleased: result['amount_released']
      });
      return;
    }

    if (status === 'already_settled') {
      console.warn('[LogisticsService.settleWalletJobReservation] already settled, not debiting again:', job.id);
      return;
    }

    // No wallet reservation to settle. Completion must not mark the job as paid.
    throw new Error(String(result['reason'] || 'Customer wallet reservation could not be found'));
  }

  private static roundMoney(value: number): number {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  /**
   * Update driver reliability stats
   */
  static async updateDriverReliability(driverId: string) {
    try {
      // Cancellation reason lives in jobs.metadata (written by cancel_job_safely
      // as metadata.cancellation_reason), NOT in a cancellation_reason column.
      // Selecting a nonexistent column made PostgREST reject the query, so the
      // reliability stats silently never updated.
      const { data: jobs, error: jobsError } = await supabaseAdmin
        .from('jobs')
        .select('status, metadata')
        .eq('driver_id', driverId);

      if (jobsError) {
        console.error('[LogisticsService] Error fetching jobs for reliability:', jobsError);
        return;
      }
      if (!jobs || jobs.length === 0) return;

      const total = jobs.length;
      const completed = jobs.filter(j => j.status === 'completed').length;
      const cancelledByDriver = jobs.filter(j =>
        j.status === 'cancelled' &&
        String((j.metadata as any)?.cancellation_reason ?? '').toLowerCase().includes('driver')
      ).length;

      const completionRate = (completed / total) * 100;
      const cancellationRate = (cancelledByDriver / total) * 100;

      await supabaseAdmin
        .from('profiles')
        .update({
          completion_rate: Math.round(completionRate),
          cancellation_rate: Math.round(cancellationRate)
        })
        .eq('id', driverId);
    } catch (err) {
      console.error('[LogisticsService] Error updating driver reliability:', err);
    }
  }

  /**
   * Fetch driver profile details
   */
  static async findDriverProfile(driverId: string) {
    return await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', driverId)
      .single();
  }
}
