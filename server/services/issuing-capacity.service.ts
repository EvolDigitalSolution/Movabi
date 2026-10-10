import { stripe } from './stripe.service';
import { supabaseAdmin } from './supabase.service';
import { FareSplitService } from './fare-split.service';

const terminalStatuses = new Set(['completed', 'settled', 'cancelled', 'canceled', 'expired', 'failed', 'no_driver_found']);

export class IssuingCapacityError extends Error {
  readonly code = 'SHOPPING_CAPACITY_UNAVAILABLE';
}

// Preliminary capacity check only. Activation still reserves funds atomically.
export class IssuingCapacityService {
  static async assertAvailable(budget: number, currency: string, jobId?: string): Promise<void> {
    if (budget === 0) return;
    if (!Number.isFinite(budget) || budget < 0) throw new IssuingCapacityError('Invalid shopping budget.');
    if (process.env.STRIPE_ISSUING_ENABLED !== 'true') {
      throw new IssuingCapacityError('Shopping funding is temporarily unavailable. Choose a task without a purchase budget or try later.');
    }
    try {
      const code = currency.toUpperCase();
      const balance = await stripe.balance.retrieve();
      const available = balance.issuing?.available.find(entry => entry.currency === code.toLowerCase())?.amount || 0;
      let reserved = 0;
      const pageSize = 500;
      for (let start = 0; ; start += pageSize) {
        const { data, error } = await supabaseAdmin.from('job_issuing_reserves')
          .select('job_id,amount_remaining,jobs!inner(status)')
          .eq('currency', code.toLowerCase()).order('job_id').range(start, start + pageSize - 1);
        if (error || !data) throw new Error('Reserve capacity could not be read');
        for (const row of data) {
          const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
          if (row.job_id === jobId || terminalStatuses.has(String(job?.status))) continue;
          const amount = Number(row.amount_remaining);
          if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid reserve balance');
          reserved += FareSplitService.toMinor(amount, code);
        }
        if (data.length < pageSize) break;
      }
      if (FareSplitService.toMinor(budget, code) > Math.max(0, available - reserved)) {
        throw new IssuingCapacityError('This shopping budget exceeds current funding capacity. Reduce the purchase budget or try again later.');
      }
    } catch (error) {
      if (error instanceof IssuingCapacityError) throw error;
      console.error('[IssuingCapacity] capacity verification failed');
      throw new IssuingCapacityError('Shopping funding could not be verified. Please try again later.');
    }
  }
}
