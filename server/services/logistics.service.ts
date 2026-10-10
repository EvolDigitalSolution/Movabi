import { stripe } from './stripe.service';
import { supabaseAdmin } from './supabase.service';
import { AuditService } from './audit.service';
import { calculatePayoutBreakdown } from './payout-calculator';
import { IssuingService } from './issuing.service';
import { PaymentAuthorityService } from './payment-authority.service';
import { FareSplitService, HistoricalFareReconciliationRequired, FareSplitSnapshot } from './fare-split.service';

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

    const { data: existingQueue, error: existingQueueError } = await supabaseAdmin.from('job_payout_queue').select('job_id').eq('job_id', job.id).maybeSingle();
    if (existingQueueError) throw new Error('Completion payout queue is unavailable');
    if (existingQueue) {
      if (job.status !== 'completed') throw new Error('Queued completion requires reconciliation');
      return job;
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

    const settlementCurrency = String(split.currency || job.currency_code || 'gbp').toUpperCase();
    const payoutAmountInPence = FareSplitService.toMinor(driverPayout, settlementCurrency);
    if (payoutAmountInPence <= 0) throw new Error('Invalid driver payout amount');
    if (!['in_progress', 'en_route_to_customer', 'arrived_at_customer', 'on_trip', 'completed'].includes(String(job.status))) {
      throw new Error('Request is not ready for completion');
    }
    if (job.stripe_transfer_id || ['claimed','unknown','transferred','reversed'].includes(String(job.settlement_status))) {
      throw new Error('Existing transfer requires reconciliation before completion');
    }
    let finalPaymentStatus = String(job.payment_status || 'pending').toLowerCase();
    const isWalletPayment = finalPaymentStatus === 'wallet_funded' || String(job.payment_method || '').toLowerCase() === 'wallet';

    if (finalPaymentStatus === 'paid') {
      console.log('[LogisticsService.completeJob] Payment already paid, skipping capture:', job.id);
    } else if (isWalletPayment) {
      // Wallet settlement and completion commit together in the outbox RPC.
      finalPaymentStatus = 'paid';
    } else if (finalPaymentStatus === 'authorized') {
      if (!job.payment_intent_id) {
        throw new Error('Payment is authorized but payment_intent_id is missing');
      }

      // Release closure: card errands capture only service fare + actually-spent
      // purchase budget, converging with the wallet path (which refunds unused
      // budget). Unused purchasing budget is never captured as driver earnings.
      let captureAmountInPence: number | undefined;
      if (PaymentAuthorityService.isErrand(job)) {
        const payable = await PaymentAuthorityService.resolve(job);
        const serviceFare = Number(payable.serviceFareMajor || totalPrice || 0);
        const budget = Math.max(0, Number(payable.totalAuthorisationMajor || 0) - serviceFare);
        const { data: details, error: detailsError } = await supabaseAdmin
          .from('errand_details')
          .select('actual_spending')
          .eq('job_id', job.id)
          .maybeSingle();
        if (detailsError) throw new Error('Shopping spend could not be verified');
        const actualSpending = this.roundMoney(Number(details?.actual_spending || 0));
        if (!Number.isFinite(actualSpending) || actualSpending < 0 || actualSpending > budget) throw new Error('Shopping spend requires budget approval before completion');
        const [{data:control,error:controlError},{data:authorizations,error:authorizationError},{data:transactions,error:transactionError}]=await Promise.all([
          supabaseAdmin.from('job_issuing_spend_controls').select('amount_captured').eq('job_id',job.id).maybeSingle(),
          supabaseAdmin.from('job_issuing_authorizations').select('amount,status,approved').eq('job_id',job.id),
          supabaseAdmin.from('job_issuing_transactions').select('amount,status').eq('job_id',job.id)
        ]);
        if(controlError || authorizationError || transactionError) throw new Error('Shopping card spend could not be reconciled');
        if(control) {
          const committed=(authorizations || []).filter(row=>row.approved && !['reversed','expired'].includes(String(row.status)))
            .reduce((sum,row)=>sum+Number(row.amount),0);
          const refunds=(transactions || []).filter(row=>row.status==='refund').reduce((sum,row)=>sum+Number(row.amount),0);
          const verifiedSpend=this.roundMoney(Math.max(Number(control.amount_captured || 0),committed-refunds,0));
          if(actualSpending!==verifiedSpend) throw new Error('Receipt spending does not match shopping card purchases; reconciliation is required');
        }

        const funding = await supabaseAdmin.from('errand_funding').select('over_budget_status').eq('job_id',job.id).maybeSingle();
        if (funding.error || funding.data?.over_budget_status === 'requested') throw new Error('Shopping budget approval must finish before completion');
        captureAmountInPence = Math.round((serviceFare + actualSpending) * 100);
      }

      const intent = await stripe.paymentIntents.retrieve(job.payment_intent_id);
      const expectedCapture = captureAmountInPence ?? Math.round(totalPrice * 100);
      if (intent.currency.toUpperCase() !== settlementCurrency) throw new Error('Payment currency requires reconciliation');
      if (intent.status === 'succeeded') {
        if (intent.amount_received !== expectedCapture) throw new Error('Captured amount requires reconciliation');
      } else {
        if (intent.status !== 'requires_capture') throw new Error('Customer payment is not ready for capture');
        const captured = await stripe.paymentIntents.capture(job.payment_intent_id,
          { amount_to_capture: expectedCapture }, { idempotencyKey: `capture-job-${job.id}` });
        if (captured.status !== 'succeeded') throw new Error('Customer payment capture is pending');
      }
      finalPaymentStatus = 'paid';
    } else {
      throw new Error(`Payment has not been authorized. Current status: ${finalPaymentStatus}`);
    }

    const now = new Date().toISOString();
    const completedMetadata = { ...completionMetadata, completion_pin_verified_at: now };
    const { data: settledRows, error: settleError } = await supabaseAdmin.rpc('complete_job_with_pending_payout', {
      p_job_id: job.id, p_driver_id: driverId, p_metadata: completedMetadata,
      p_terms: { total: totalPrice, payout: driverPayout, platformFee,
        commission: split.driverCommissionAmount, commissionRate: safeCommissionRate,
        amountMinor: payoutAmountInPence, currency: settlementCurrency,
        destination: stripeAccountId, country: job.country_code || 'GB' }
    });
    if (settleError) throw new Error(settleError.message || 'Failed to record completion');
    const updatedJob = Array.isArray(settledRows) ? settledRows[0] : settledRows;
    if (!updatedJob) throw new Error('Completion was not recorded');
    await AuditService.logBooking(job.customer_id, 'job_completed', job.id, {
      total_price: totalPrice,
      reserved_price: totalPrice,
      driver_payout: driverPayout,
      platform_fee: platformFee,
      stripe_transfer_id: null,
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
    const { data: secretRow, error: secretError } = await supabaseAdmin
      .from('job_completion_secrets')
      .select('completion_pin')
      .eq('job_id', job.id)
      .maybeSingle();
    if (secretError) throw new Error('Customer PIN could not be verified. Please retry.');
    if (secretRow?.completion_pin) {
      expectedPin = this.normalizeCompletionPin(secretRow.completion_pin);
    } else {
      expectedPin = this.getCompletionPin(metadata);
    }

    if (!expectedPin) {
      if (metadata.completion_pin_required) throw new Error('Customer PIN is unavailable; please contact support.');
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
