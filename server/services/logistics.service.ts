import { stripe } from './stripe.service';
import { supabaseAdmin } from './supabase.service';
import { AuditService } from './audit.service';

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
  static calculatePayout(totalPrice: number, pricingPlan: 'starter' | 'pro', commissionRate: number = 15.00) {
    // SOURCE OF TRUTH: 10% platform fee from customer
    const serviceFee = Math.round(totalPrice * 0.10 * 100) / 100; 
    const baseFare = totalPrice - serviceFee;
    
    let commissionFee = 0;
    let driverPayout = 0;

    if (pricingPlan === 'pro') {
      // Pro Plan: 0% commission from driver
      commissionFee = 0;
      driverPayout = baseFare;
    } else {
      // Starter Plan: Pay as you earn (commission applies to base fare)
      commissionFee = Math.round(baseFare * (commissionRate / 100) * 100) / 100;
      driverPayout = baseFare - commissionFee;
    }

    const platformFee = Math.round((serviceFee + commissionFee) * 100) / 100;

    return {
      total_price: totalPrice,
      base_fare: baseFare,
      service_fee: serviceFee,
      commission_fee: commissionFee,
      commission_rate_used: commissionRate,
      platform_fee: platformFee,
      driver_payout: driverPayout,
      pricing_plan_used: pricingPlan
    };
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
   * Validate booking status transition
   */
  static isValidBookingTransition(current: string, next: string): boolean {
    const transitions: Record<string, string[]> = {
      'requested': ['searching', 'cancelled'],
      'searching': ['assigned', 'no_driver_found', 'cancelled'],
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
  static async completeJob(jobId: string) {
    const rawJobId = String(jobId || '').trim();

    if (!rawJobId) {
      throw new Error('jobId required');
    }

    let jobQuery = supabaseAdmin
      .from('jobs')
      .select('*');

    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawJobId)) {
      jobQuery = jobQuery.eq('id', rawJobId);
    } else {
      jobQuery = jobQuery.ilike('id', `${rawJobId}%`);
    }

    const { data: job, error: jobError } = await jobQuery.maybeSingle();

    if (jobError || !job) {
      console.error('[LogisticsService.completeJob] job lookup failed:', {
        rawJobId,
        error: jobError
      });
      throw new Error('Job not found');
    }

    const driverId = job.driver_id || job.accepted_driver_id;

    if (!driverId) {
      throw new Error('Cannot complete job without an assigned driver');
    }

    const totalPrice = Number(
      job.total_price ??
      job.price ??
      job.estimated_price ??
      0
    );

    if (!Number.isFinite(totalPrice) || totalPrice <= 0) {
      throw new Error('Invalid job amount');
    }

    const { data: driverProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, pricing_plan, commission_rate')
      .eq('id', driverId)
      .maybeSingle();

    const plan = String(driverProfile?.pricing_plan || 'starter').toLowerCase();
    const commissionRate = plan === 'pro'
      ? 0
      : Number(driverProfile?.commission_rate ?? 15);

    const safeCommissionRate = Number.isFinite(commissionRate) ? commissionRate : 15;
    const platformFee = this.roundMoney(totalPrice * (safeCommissionRate / 100));
    const driverPayout = this.roundMoney(Math.max(0, Math.min(totalPrice, totalPrice - platformFee)));

    let finalPaymentStatus = String(job.payment_status || 'pending').toLowerCase();

    /**
     * Idempotent rule:
     * - If already paid, do not capture again.
     * - If authorized, capture once.
     * - If anything else, block completion.
     */
    if (finalPaymentStatus === 'paid') {
      console.log('[LogisticsService.completeJob] Payment already paid, skipping capture:', job.id);
    } else if (finalPaymentStatus === 'authorized') {
      if (!job.payment_intent_id) {
        throw new Error('Payment is authorized but payment_intent_id is missing');
      }

      try {
        const captured = await stripe.paymentIntents.capture(
          job.payment_intent_id,
          {
            idempotencyKey: `capture-job-${job.id}`
          } as any
        );

        if (captured.status !== 'succeeded') {
          throw new Error(`Stripe capture returned status: ${captured.status}`);
        }

        finalPaymentStatus = 'paid';
      } catch (captureError: any) {
        const message = String(captureError?.message || '');

        /**
         * Stripe may say the PaymentIntent was already captured/succeeded.
         * Treat that as idempotent success only if Stripe confirms succeeded.
         */
        if (message.toLowerCase().includes('has already been captured')) {
          finalPaymentStatus = 'paid';
        } else {
          console.error('[LogisticsService.completeJob] Stripe capture failed:', captureError);
          throw new Error(message || 'Failed to capture customer payment');
        }
      }
    } else {
      throw new Error(`Payment has not been authorized. Current status: ${finalPaymentStatus}`);
    }

    const now = new Date().toISOString();

    const { data: updatedJob, error: updateError } = await supabaseAdmin
      .from('jobs')
      .update({
        status: 'completed',
        payment_status: 'paid',
        driver_id: driverId,
        driver_payout: driverPayout,
        platform_fee: platformFee,
        completed_at: job.completed_at || now,
        updated_at: now
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
          status: 'paid',
          currency_code: job.currency_code || 'GBP',
          country_code: job.country_code || 'GB',
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
      driver_payout: driverPayout,
      platform_fee: platformFee,
      pricing_plan_used: plan,
      commission_rate_used: safeCommissionRate
    });

    return updatedJob;
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
