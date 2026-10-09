import { stripe } from './stripe.service';
import { supabaseAdmin } from './supabase.service';
import { PayoutEligibilityService } from './payout-eligibility.service';
interface QueueRow { job_id: string; driver_id: string; destination: string; amount_minor: number; currency: string; status: string; attempt: number; token: string; attempted_at: string; }
export class JobPayoutService {
  private static running = false;
  static start() {
    const timer = setInterval(() => { void this.tick(); }, 60000);
    timer.unref();
    void this.tick();
  }
  static async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const { data, error } = await supabaseAdmin.from('job_payout_queue').select('job_id').in('status', ['pending','processing','reconcile']).lte('retry_at', new Date().toISOString()).order('retry_at').limit(20);
      if (error) throw error;
      for (const row of data || []) {
        try { await this.process(row.job_id); } catch (error) { console.error('[JobPayout] retry failed', row.job_id, error); }
      }
    } catch (error) { console.error('[JobPayout] worker unavailable', error); }
    finally { this.running = false; }
  }
  static async process(jobId: string) {
    const claim = await supabaseAdmin.rpc('claim_queued_job_payout', { p_job_id: jobId });
    if (claim.error) throw claim.error;
    const q = claim.data?.[0] as QueueRow | undefined;
    if (!q) return;
    const update = async (status: string, code: string) => {
      const result = await supabaseAdmin.from('job_payout_queue').update({ status, last_error: code, lease_until: null,
        retry_at: new Date(Date.now()+300000).toISOString(), updated_at: new Date().toISOString() }).eq('job_id', q.job_id).eq('token', q.token).in('status',['processing','reconcile']).select('job_id');
      if (result.error || !result.data?.length) throw new Error('Payout retry marker was not persisted');
    };
    const finish = async (id: string) => {
      const result = await supabaseAdmin.rpc('finish_queued_job_payout', { p_job_id: q.job_id, p_token: q.token, p_transfer_id: id });
      if (result.error || result.data !== true) throw new Error('Payout requires local reconciliation');
    };
    // Always reconcile first, including crashes after Stripe succeeded but before the DB commit.
    let transfers;
    try { transfers = await stripe.transfers.list({ transfer_group: `job_${q.job_id}`, limit: 100 }); }
    catch { await update('reconcile','transfer_lookup_unavailable'); return; }
    const matching = transfers.data.filter(t => String(typeof t.destination === 'string' ? t.destination : t.destination?.id) === q.destination && t.amount === Number(q.amount_minor) && t.currency === q.currency && !t.reversed);
    if (transfers.has_more || transfers.data.length > 1 || (transfers.data.length && matching.length !== 1)) { await update('blocked','transfer_identity_requires_review'); return; }
    if (matching.length === 1) { await finish(matching[0].id); return; }
    if (q.status === 'reconcile' && Date.now()-Date.parse(q.attempted_at) > 20*3600000) { await update('blocked','idempotency_window_requires_review'); return; }
    // Eligibility/balance checks run before requesting a transfer. An ambiguous attempt
    // retains its key even when these checks temporarily prevent submission.
    try { await PayoutEligibilityService.assertEligible(q.driver_id, q.destination); }
    catch { await update(q.status === 'reconcile' ? 'reconcile' : 'pending','destination_not_ready'); return; }
    let balance;
    try { balance = await stripe.balance.retrieve(); }
    catch { await update(q.status === 'reconcile' ? 'reconcile' : 'pending','balance_lookup_unavailable'); return; }
    const available = balance.available.filter(b => b.currency === q.currency).reduce((n,b) => n+b.amount,0);
    if (available < Number(q.amount_minor)) { await update(q.status === 'reconcile' ? 'reconcile' : 'pending','balance_insufficient'); return; }
    let transfer;
    try {
      transfer = await stripe.transfers.create({ amount: Number(q.amount_minor), currency: q.currency, destination: q.destination,
        transfer_group: `job_${q.job_id}`, metadata: { job_id: q.job_id, driver_id: q.driver_id, payout_policy: 'outbox-v1' } },
        { idempotencyKey: `job-payout-v2-${q.job_id}-${q.attempt}` });
    } catch (error: unknown) {
      const e = error as { statusCode?: number; code?: string };
      // Only an explicit insufficient-balance rejection is retried with a new key.
      const definitive = e.statusCode === 400 && e.code === 'balance_insufficient';
      await update(definitive ? 'pending' : 'reconcile', e.code || 'transfer_outcome_unknown');
      return;
    }
    await finish(transfer.id);
  }
}
