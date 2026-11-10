import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../server/services/supabase.service', () => ({
  supabaseAdmin: { from: vi.fn() }
}));

import { reportUnresolvedPaymentOps } from '../../server/services/payment-operations-report.service';
import { supabaseAdmin } from '../../server/services/supabase.service';

const NOW = new Date('2026-11-01T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString();

function mockJobs(rows: Array<Record<string, unknown>>) {
  const chain = { select: vi.fn().mockReturnThis(), not: vi.fn().mockResolvedValue({ data: rows, error: null }) };
  (supabaseAdmin.from as any).mockReturnValue(chain);
}

describe('reportUnresolvedPaymentOps', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports requires_refund and requires_review jobs', async () => {
    mockJobs([
      { id: 'j1', payment_status: 'requires_refund', status: 'cancelled', payment_intent_id: 'pi_1', created_at: minutesAgo(120) },
      { id: 'j2', payment_status: 'requires_review', status: 'completed', payment_intent_id: 'pi_2', created_at: minutesAgo(30) },
      { id: 'j3', payment_status: 'paid', status: 'completed', payment_intent_id: 'pi_3', created_at: minutesAgo(500) }
    ]);
    const r = await reportUnresolvedPaymentOps(NOW);
    expect(r.unresolved).toHaveLength(2);
    expect(r.counts).toEqual({ payment_status_requires_refund: 1, payment_status_requires_review: 1 });
    expect(r.unresolved[0].ageMinutes).toBe(120);
  });

  it('flags stale authorized and unresolved states past the threshold', async () => {
    mockJobs([
      { id: 'j4', payment_status: 'authorized', status: 'pending', payment_intent_id: 'pi_4', created_at: minutesAgo(90) },
      { id: 'j5', payment_status: 'pending', status: 'active', payment_intent_id: 'pi_5', created_at: minutesAgo(200) },
      { id: 'j6', payment_status: 'authorized', status: 'pending', payment_intent_id: 'pi_6', created_at: minutesAgo(30) }
    ]);
    const r = await reportUnresolvedPaymentOps(NOW);
    expect(r.unresolved.map((u) => u.jobId).sort()).toEqual(['j4', 'j5']);
    expect(r.unresolved.find((u) => u.jobId === 'j4')?.reason).toBe('authorized_stale');
    expect(r.unresolved.find((u) => u.jobId === 'j5')?.reason).toBe('unresolved_pending');
  });

  it('returns an empty report when nothing is unresolved', async () => {
    mockJobs([
      { id: 'j7', payment_status: 'paid', status: 'completed', payment_intent_id: 'pi_7', created_at: minutesAgo(10) },
      { id: 'j8', payment_status: 'refunded', status: 'cancelled', payment_intent_id: 'pi_8', created_at: minutesAgo(100) }
    ]);
    const r = await reportUnresolvedPaymentOps(NOW);
    expect(r.unresolved).toHaveLength(0);
    expect(r.counts).toEqual({});
  });
});
