import {driverMatchesJobMarket} from './driver-market-scope';
import { supabaseAdmin } from './supabase.service';
import { PricingService } from './pricing.service';
import { FareSplitService } from './fare-split.service';

export class DriverEarningsPreviewService {
  static async preview(driverId: string, jobId: string, proposed?: number) {
    const profile = await supabaseAdmin.from('profiles').select('*').eq('id', driverId).maybeSingle();
    if (profile.error) throw profile.error;
    if (!profile.data || profile.data.role !== 'driver') throw new Error('Driver access required');
    const response = await supabaseAdmin.from('jobs').select('*').eq('id', jobId).maybeSingle();
    if (response.error) throw response.error;
    const job = response.data;
    if (!job || !driverMatchesJobMarket(profile.data,job)) throw new Error('Request unavailable');
    if (job.driver_id && job.driver_id !== driverId) throw new Error('Request unavailable');
    if (!job.driver_id) {
      const status = String(job.status);
      if (!['requested','searching','pending_fare_confirmation','open','negotiating'].includes(status)) throw new Error('Request unavailable');
      if (['open','negotiating'].includes(status)) {
        // Match discovery without broadening access to unrelated open jobs.
        const opportunity = await supabaseAdmin.from('marketplace_negotiation_sessions')
          .select('id').eq('job_id', jobId).in('status', ['open','released'])
          .is('active_driver_id', null).gt('expires_at', new Date().toISOString()).limit(1).maybeSingle();
        if (opportunity.error) throw opportunity.error;
        if (!opportunity.data) throw new Error('Request unavailable');
      }
    }
    let candidate = job;
    if (proposed !== undefined) {
      if (!(job.negotiation_mode_enabled || job.bid_mode_enabled || job.status === 'pending_fare_confirmation') || !Number.isFinite(proposed) || proposed <= 0) throw new Error('Invalid proposed fare');
      candidate = { ...job, ...PricingService.applyAgreedFare(job, proposed, { previewOnly: true }) };
    }
    const breakdown = candidate.fare_breakdown;
    const split = FareSplitService.fromSnapshot(breakdown, candidate.currency_code);
    let commission = split.driverCommissionAmount;
    let net = split.driverEntitlement;
    const policy = breakdown?.driverCommissionPolicy;
    if (policy?.version === 'subscription-commission-v1' && (!job.driver_id || policy.frozen !== true)) {
      let query = supabaseAdmin.from('subscriptions').select('stripe_subscription_id,current_period_end')
        .eq('user_id', driverId).eq('status','active').not('stripe_subscription_id','is',null);
      query = profile.data.tenant_id ? query.eq('tenant_id',profile.data.tenant_id) : query.is('tenant_id',null);
      const subscriptions = await query;
      if (subscriptions.error) throw subscriptions.error;
      const active = (subscriptions.data || []).some((s: any) => !s.current_period_end || Date.parse(s.current_period_end) > Date.now());
      const standard = Number(policy.standardCommissionAmount);
      if (!Number.isFinite(standard) || standard < 0 || standard >= split.driverBase) throw new Error('Commission terms unavailable');
      commission = active ? 0 : standard;
      net = split.driverBase - commission;
    }
    if (split.driverBase <= 0 || ![split.driverBase, commission, net].every(n => Number.isFinite(n) && n >= 0) || Math.abs(split.driverBase - commission - net) > 0.000001) throw new Error('Earnings require reconciliation');
    let suggestedCustomerFare: number | undefined;
    if (candidate.previewBelowProtectedMinimum === true) {
      const quoted = Number(job.fare_breakdown?.customerCharge ?? job.total_price ?? job.price);
      if (Number.isFinite(quoted) && quoted > 0) {
        try {
          PricingService.applyAgreedFare(job, quoted); // actual agreement checks, no preview exception
          suggestedCustomerFare = quoted;
        } catch { /* Never invent a valid amount if the original quote no longer validates. */ }
      }
    }
    return { suggestedCustomerFare, offerAllowed: candidate.previewBelowProtectedMinimum !== true, gross: split.driverBase, deductions: commission, net, currency: split.currency, estimated: !job.driver_id || proposed !== undefined };
  }
}
