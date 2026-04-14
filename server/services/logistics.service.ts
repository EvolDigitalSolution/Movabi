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
      .select('*, driver:profiles(*)')
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
    // 1. Fetch job details
    const { data: job, error: jobError } = await supabaseAdmin
      .from('jobs')
      .select('*, service_type:service_types(*), driver:profiles(*)')
      .eq('id', jobId)
      .single();

    if (jobError || !job) throw new Error('Job not found');
    if (job.status === 'completed') return job;

    // 2. Calculate payout
    const breakdown = this.calculatePayout(
      job.price,
      job.driver?.pricing_plan || 'starter',
      job.driver?.commission_rate || 15.00
    );

    // 3. Update job status and payout info atomically
    const { data: updatedJob, error: updateError } = await supabaseAdmin
      .from('jobs')
      .update({
        status: 'completed',
        driver_payout: breakdown.driver_payout,
        platform_fee: breakdown.platform_fee,
        completed_at: new Date().toISOString()
      })
      .eq('id', jobId)
      .neq('status', 'completed') // Prevent duplicate completion
      .select()
      .single();

    if (updateError) throw updateError;

    // 4. Record driver earning
    if (job.driver_id) {
      await supabaseAdmin
        .from('driver_earnings')
        .upsert({
          driver_id: job.driver_id,
          job_id: jobId,
          amount: breakdown.driver_payout,
          gross_amount: breakdown.total_price,
          platform_fee: breakdown.platform_fee,
          net_amount: breakdown.driver_payout,
          status: 'payable', // Ready for payout
          metadata: breakdown
        }, { onConflict: 'job_id' });

      // 5. Update reliability stats
      await this.updateDriverReliability(job.driver_id);
    }

    // 6. Audit Log
    await AuditService.logBooking(job.customer_id, 'job_completed', jobId, { breakdown });

    return updatedJob;
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
