import { supabaseAdmin } from './supabase.service';
import { MarketplaceConfigService } from './marketplace-config.service';

type JobCleanupCandidate = {
  id: string;
  status: string | null;
  payment_status: string | null;
  payment_intent_id: string | null;
  driver_id: string | null;
  accepted_driver_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  expires_at: string | null;
};

type SessionCleanupCandidate = {
  id: string;
  job_id: string | null;
  status: string | null;
  updated_at: string | null;
  expires_at: string | null;
};

class MarketplaceCleanupService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private readonly paidStatuses = new Set([
    'paid',
    'authorized',
    'requires_capture',
    'succeeded',
    'wallet_funded',
    'captured',
    'capture_pending'
  ]);

  private readonly protectedStatuses = new Set([
    'accepted',
    'assigned',
    'arrived',
    'heading_to_pickup',
    'driver_en_route',
    'driver_arrived',
    'picked_up',
    'in_progress',
    'arrived_at_store',
    'shopping_in_progress',
    'collected',
    'en_route_to_customer',
    'delivered',
    'completed',
    'settled',
    'cancelled',
    'requires_review',
    'disputed'
  ]);

  start(): void {
    if (this.timer) return;
    this.scheduleNext(1);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(minutes: number): void {
    const safeMinutes = Math.max(1, Number(minutes) || 10);
    this.timer = setTimeout(async () => {
      this.timer = null;
      const nextMinutes = await this.runCleanup();
      this.scheduleNext(nextMinutes);
    }, safeMinutes * 60 * 1000);
  }

  async runCleanup(): Promise<number> {
    if (this.running) return 10;
    this.running = true;

    try {
      const rules = await MarketplaceConfigService.getMarketplaceDraftRules();
      const intervalMinutes = Math.max(1, Number(rules.cleanupIntervalMinutes) || 10);

      if (!rules.enabled) {
        return intervalMinutes;
      }

      const now = new Date();
      const pendingFareCutoff = this.minutesAgo(now, rules.pendingFareTtlMinutes);
      const fareAgreedCutoff = this.minutesAgo(now, rules.fareAgreedUnpaidTtlMinutes);
      const idleCutoff = this.minutesAgo(now, rules.negotiationIdleTtlMinutes);

      const [pendingFareIds, fareAgreedIds, staleSessionIds] = await Promise.all([
        this.findExpiredPendingFareJobs(now, pendingFareCutoff),
        this.findExpiredFareAgreedJobs(now, fareAgreedCutoff),
        this.findExpiredNegotiationJobs(now, idleCutoff)
      ]);

      await this.softExpireJobs(pendingFareIds, 'pending_fare_expired');
      await this.softExpireJobs(fareAgreedIds, 'fare_agreed_unpaid_expired');
      await this.softExpireJobs(staleSessionIds, 'negotiation_idle_expired');

      const total = pendingFareIds.length + fareAgreedIds.length + staleSessionIds.length;
      if (total > 0) {
        console.log('[MarketplaceCleanup] expired stale marketplace drafts', {
          pendingFare: pendingFareIds.length,
          fareAgreed: fareAgreedIds.length,
          staleNegotiations: staleSessionIds.length
        });
      }

      if (rules.deleteExpiredDrafts) {
        console.warn('[MarketplaceCleanup] deleteExpiredDrafts is configured but hard deletion is disabled for audit safety.');
      }

      return intervalMinutes;
    } catch (error: any) {
      console.warn('[MarketplaceCleanup] cleanup failed', error?.message || error);
      return 10;
    } finally {
      this.running = false;
    }
  }

  private minutesAgo(now: Date, minutes: number | undefined): Date {
    const safeMinutes = Math.max(1, Number(minutes) || 30);
    return new Date(now.getTime() - safeMinutes * 60 * 1000);
  }

  private async findExpiredPendingFareJobs(now: Date, cutoff: Date): Promise<string[]> {
    const { data, error } = await supabaseAdmin
      .from('jobs')
      .select('id, status, payment_status, payment_intent_id, driver_id, accepted_driver_id, created_at, updated_at, expires_at')
      .eq('status', 'pending_fare_confirmation')
      .is('expired_at', null);

    if (error) {
      console.warn('[MarketplaceCleanup] pending fare lookup failed', error.message);
      return [];
    }

    const candidates = ((data || []) as JobCleanupCandidate[])
      .filter(job => this.isSafeUnpaidDraft(job))
      .filter(job => this.isExpiredBy(job, now, cutoff));

    return this.excludeJobsWithActiveSessions(candidates.map(job => job.id), now);
  }

  private async findExpiredFareAgreedJobs(now: Date, cutoff: Date): Promise<string[]> {
    const { data, error } = await supabaseAdmin
      .from('jobs')
      .select('id, status, payment_status, payment_intent_id, driver_id, accepted_driver_id, created_at, updated_at, expires_at')
      .eq('status', 'fare_agreed')
      .is('expired_at', null);

    if (error) {
      console.warn('[MarketplaceCleanup] fare agreed lookup failed', error.message);
      return [];
    }

    return ((data || []) as JobCleanupCandidate[])
      .filter(job => this.isSafeUnpaidDraft(job))
      .filter(job => this.isExpiredBy(job, now, cutoff))
      .map(job => job.id);
  }

  private async findExpiredNegotiationJobs(now: Date, cutoff: Date): Promise<string[]> {
    const { data, error } = await supabaseAdmin
      .from('marketplace_negotiation_sessions')
      .select('id, job_id, status, updated_at, expires_at')
      .in('status', ['open', 'released', 'driver_claimed', 'negotiating'])
      .not('job_id', 'is', null);

    if (error) {
      console.warn('[MarketplaceCleanup] negotiation session lookup failed', error.message);
      return [];
    }

    const staleSessions = ((data || []) as SessionCleanupCandidate[])
      .filter(session => this.isDateExpired(session.expires_at, now) || this.isDateBefore(session.updated_at, cutoff));

    const sessionIds = staleSessions.map(session => session.id);
    if (sessionIds.length > 0) {
      const { error: updateError } = await supabaseAdmin
        .from('marketplace_negotiation_sessions')
        .update({ status: 'expired', updated_at: now.toISOString() })
        .in('id', sessionIds);

      if (updateError) {
        console.warn('[MarketplaceCleanup] stale session update failed', updateError.message);
      }
    }

    const jobIds = Array.from(new Set(staleSessions.map(session => session.job_id).filter(Boolean))) as string[];
    if (jobIds.length === 0) return [];

    const { data: jobs, error: jobsError } = await supabaseAdmin
      .from('jobs')
      .select('id, status, payment_status, payment_intent_id, driver_id, accepted_driver_id, created_at, updated_at, expires_at')
      .in('id', jobIds);

    if (jobsError) {
      console.warn('[MarketplaceCleanup] stale negotiation job lookup failed', jobsError.message);
      return [];
    }

    return ((jobs || []) as JobCleanupCandidate[])
      .filter(job => ['pending_fare_confirmation', 'negotiating', 'fare_agreed'].includes(String(job.status || '').toLowerCase()))
      .filter(job => this.isSafeUnpaidDraft(job))
      .map(job => job.id);
  }

  private async excludeJobsWithActiveSessions(jobIds: string[], now: Date): Promise<string[]> {
    if (jobIds.length === 0) return [];

    const { data, error } = await supabaseAdmin
      .from('marketplace_negotiation_sessions')
      .select('job_id')
      .in('job_id', jobIds)
      .in('status', ['open', 'driver_claimed', 'negotiating', 'fare_agreed', 'payment_pending'])
      .gt('expires_at', now.toISOString());

    if (error) {
      console.warn('[MarketplaceCleanup] active session lookup failed', error.message);
      return jobIds;
    }

    const activeJobIds = new Set((data || []).map((row: any) => String(row.job_id)));
    return jobIds.filter(id => !activeJobIds.has(id));
  }

  private async softExpireJobs(jobIds: string[], reason: string): Promise<void> {
    if (jobIds.length === 0) return;

    const now = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from('jobs')
      .update({
        status: 'expired',
        is_draft: true,
        expired_at: now,
        expiry_reason: reason,
        updated_at: now
      })
      .in('id', jobIds);

    if (error) {
      console.warn(`[MarketplaceCleanup] failed to expire ${reason}`, error.message);
    }
  }

  private isSafeUnpaidDraft(job: JobCleanupCandidate): boolean {
    const status = String(job.status || '').toLowerCase();
    const paymentStatus = String(job.payment_status || '').toLowerCase();
    return !this.protectedStatuses.has(status)
      && !this.paidStatuses.has(paymentStatus)
      && !String(job.payment_intent_id || '').trim()
      && !String(job.driver_id || '').trim()
      && !String(job.accepted_driver_id || '').trim();
  }

  private isExpiredBy(job: JobCleanupCandidate, now: Date, cutoff: Date): boolean {
    return this.isDateExpired(job.expires_at, now)
      || this.isDateBefore(job.updated_at || job.created_at, cutoff)
      || this.isDateBefore(job.created_at, cutoff);
  }

  private isDateExpired(value: string | null, now: Date): boolean {
    if (!value) return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date <= now;
  }

  private isDateBefore(value: string | null, cutoff: Date): boolean {
    if (!value) return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date <= cutoff;
  }
}

export const marketplaceCleanupService = new MarketplaceCleanupService();
