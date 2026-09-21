import { stripe } from './stripe.service';
import { supabaseAdmin } from './supabase.service';
import { AuditService } from './audit.service';
import { calculatePayoutBreakdown } from './payout-calculator';
import { IssuingService } from './issuing.service';
import { MarketplaceConfigService } from './marketplace-config.service';

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
    const { data, error } = await supabaseAdmin
      .from('driver_earnings')
      .select('job_id')
      .eq('job_id', jobId)
      .maybeSingle();

    if (error) {
      // Fail closed on an unreadable marker: never re-run money movement when we
      // cannot prove the completion tail did not already run.
      console.error('[LogisticsService.hasDriverEarnings] earnings lookup failed:', error);
      throw new Error('Could not verify whether this request was already settled.');
    }

    return !!data;
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

    const completionMetadata = this.assertCompletionPin(job, completionPin);

    const requestedTotalPrice = Number(job.total_price ?? job.price ?? job.estimated_price ?? 0);

    if (!Number.isFinite(requestedTotalPrice) || requestedTotalPrice <= 0) {
      throw new Error('Invalid job amount');
    }

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

    const effectiveCommissionRate = await MarketplaceConfigService.getEffectiveCommissionPercent(
      String(job.service_slug || '').toLowerCase() || null,
      String(job.city_zone || '') || null,
      String(driverProfile?.tier || job.driver_tier_at_assignment || '') || null,
      String(job.tenant_id || '') || null
    );

    const storedCommission =
      (job.fare_breakdown as Record<string, unknown> | null)?.commissionPercent ??
      job.commission_rate_used ??
      effectiveCommissionRate;

    const commissionRate = plan === 'pro' ? 0 : Number(storedCommission ?? 0);
    const safeCommissionRate = Number.isFinite(commissionRate)
      ? commissionRate
      : 0;

    let finalPaymentStatus = String(job.payment_status || 'pending').toLowerCase();
    const isWalletPayment = finalPaymentStatus === 'wallet_funded' || String(job.payment_method || '').toLowerCase() === 'wallet';
    const totalPrice = isWalletPayment
      ? await this.resolveWalletSettlementAmount(job, requestedTotalPrice)
      : requestedTotalPrice;

    const platformFee = this.roundMoney(totalPrice * (safeCommissionRate / 100));
    const driverPayout = this.roundMoney(Math.max(0, Math.min(totalPrice, totalPrice - platformFee)));

    const payoutAmountInPence = Math.round(driverPayout * 100);

    if (payoutAmountInPence <= 0) {
      throw new Error('Invalid driver payout amount');
    }

    if (finalPaymentStatus === 'paid') {
      console.log('[LogisticsService.completeJob] Payment already paid, skipping capture:', job.id);
    } else if (isWalletPayment) {
      await this.settleWalletJobReservation(job, totalPrice);
      finalPaymentStatus = 'paid';
    } else if (finalPaymentStatus === 'authorized') {
      if (!job.payment_intent_id) {
        throw new Error('Payment is authorized but payment_intent_id is missing');
      }

      try {
        const captured = await stripe.paymentIntents.capture(
          job.payment_intent_id,
          {} as any,
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

    let stripeTransferId = job.stripe_transfer_id || null;

    if (!stripeTransferId) {
      try {
        const transfer = await stripe.transfers.create(
          {
            amount: payoutAmountInPence,
            currency: String(job.currency_code || 'gbp').toLowerCase(),
            destination: stripeAccountId,
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
        throw new Error(transferError?.message || 'Failed to transfer driver payout');
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

    const { data: updatedJob, error: updateError } = await supabaseAdmin
      .from('jobs')
      .update({
        // Keep the ORIGINAL completed status/timestamp when resuming a partially
        // completed job rather than rewriting when it actually finished.
        status: wasAlreadyCompleted ? String(job.status) : 'completed',
        payment_status: 'paid',
        driver_id: driverId,
        price: totalPrice,
        total_price: totalPrice,
        driver_payout: driverPayout,
        platform_fee: platformFee,
        stripe_transfer_id: stripeTransferId,
        stripe_transfer_status: 'paid',
        transferred_at: job.transferred_at || now,
        updated_at: now,
        ...(wasAlreadyCompleted ? {} : { completed_at: job.completed_at || now }),
        metadata: completedMetadata
      })
      .eq('id', job.id)
      .select('*')
      .single();

    if (updateError) {
      console.error('[LogisticsService.completeJob] update failed:', updateError);
      throw new Error(updateError.message || 'Failed to complete job');
    }

    const { error: earningError } = await supabaseAdmin
      .from('driver_earnings')
      .upsert(
        {
          driver_id: driverId,
          job_id: job.id,
          amount: driverPayout,
          platform_fee: platformFee,
          gross_amount: totalPrice,
          status: 'paid',
          currency_code: job.currency_code || 'GBP',
          country_code: job.country_code || 'GB',
          stripe_transfer_id: stripeTransferId,
          created_at: job.created_at || now
        },
        { onConflict: 'job_id' }
      );

    if (earningError) {
      console.error('[LogisticsService.completeJob] earning upsert failed:', earningError);
      throw new Error(earningError.message || 'Failed to sync driver earnings');
    }

    await AuditService.logBooking(job.customer_id, 'job_completed', job.id, {
      total_price: totalPrice,
      reserved_price: requestedTotalPrice,
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

  private static assertCompletionPin(job: any, submittedPin?: string | null): Record<string, any> {
    const metadata = this.getMetadata(job);
    const expectedPin = this.getCompletionPin(metadata);

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
      const { data: jobs } = await supabaseAdmin
        .from('jobs')
        .select('status, cancellation_reason')
        .eq('driver_id', driverId);

      if (!jobs || jobs.length === 0) return;

      const total = jobs.length;
      const completed = jobs.filter(j => j.status === 'completed').length;
      const cancelledByDriver = jobs.filter(j => j.status === 'cancelled' && j.cancellation_reason?.toLowerCase().includes('driver')).length;
      
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
