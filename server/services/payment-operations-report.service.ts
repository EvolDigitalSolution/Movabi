/**
 * Read-only payment operations report. Lists unresolved/aged payment
 * operations for operator review. Never mutates financial state, never
 * issues refunds and never retries charges.
 */
import { supabaseAdmin } from './supabase.service';

export interface AgedPaymentOp {
  readonly jobId: string;
  readonly paymentStatus: string;
  readonly jobStatus: string;
  readonly paymentIntentId: string | null;
  readonly ageMinutes: number;
  readonly reason: string;
}

export interface PaymentOpsReport {
  readonly scannedAt: string;
  readonly unresolved: AgedPaymentOp[];
  readonly counts: Record<string, number>;
}

const UNRESOLVED_STATUSES = new Set(['requires_refund', 'requires_review']);
const AGED_MINUTES = 60;

export async function reportUnresolvedPaymentOps(now: Date = new Date()): Promise<PaymentOpsReport> {
  const { data: jobs, error } = await supabaseAdmin
    .from('jobs')
    .select('id, payment_status, status, payment_intent_id, created_at')
    .not('payment_intent_id', 'is', null);
  if (error) throw error;
  const unresolved: AgedPaymentOp[] = [];
  const counts: Record<string, number> = {};
  for (const job of jobs || []) {
    const ageMinutes = Math.floor((now.getTime() - Date.parse(job.created_at)) / 60000);
    let reason: string | null = null;
    if (UNRESOLVED_STATUSES.has(String(job.payment_status))) {
      reason = `payment_status_${job.payment_status}`;
    } else if (String(job.payment_status) === 'authorized' && ageMinutes > AGED_MINUTES) {
      reason = 'authorized_stale';
    } else if (!['paid', 'refunded', 'cancelled'].includes(String(job.payment_status)) && ageMinutes > AGED_MINUTES) {
      reason = `unresolved_${job.payment_status}`;
    }
    if (!reason) continue;
    unresolved.push({
      jobId: job.id,
      paymentStatus: job.payment_status,
      jobStatus: job.status,
      paymentIntentId: job.payment_intent_id || null,
      ageMinutes,
      reason
    });
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return { scannedAt: now.toISOString(), unresolved, counts };
}
