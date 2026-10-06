/**
 * /refund route — executable tests with Stripe + Supabase mocks.
 * Exercises the actual refundHandler (not source text).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => {
  const stripe = {
    paymentIntents: { retrieve: vi.fn(), capture: vi.fn(), cancel: vi.fn() },
    refunds: { create: vi.fn(), list: vi.fn() },
    transfers: { createReversal: vi.fn() }
  };
  const state = {
    profile: { role: 'admin' },
    job: null as any,
    op: null as any,
    markError: null as any,
    reversalMarkError: null as any,
    rpcCalls: [] as Array<{ fn: string; args: any }>
  };
  const thenable = (data: any, error: any = null) => Promise.resolve({ data, error });
  const supabaseAdmin = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => thenable(table === 'profiles' ? state.profile : state.job)
        })
      }),
      update: () => ({ eq: () => thenable({}, null) })
    }),
    rpc: (fn: string, args: any) => {
      state.rpcCalls.push({ fn, args });
      switch (fn) {
        case 'reserve_refund_operation': return thenable(state.op);
        case 'reserve_reversal_operation': return thenable({ id: 'rev-1', status: 'reserved' });
        case 'mark_refund_operation': return state.markError ? thenable(null, state.markError) : thenable(true);
        case 'mark_reversal_operation': return state.reversalMarkError ? thenable(null, state.reversalMarkError) : thenable(true);
        default: return thenable(true);
      }
    }
  };
  return { stripe, supabaseAdmin, state };
});

vi.mock('../../server/services/stripe.service', () => ({ stripe: M.stripe }));
vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: M.supabaseAdmin }));

import { refundHandler } from '../../server/routes/payment.routes';

const ADMIN = '00000000-0000-0000-0000-0000000000aa';
const JOB_ID = '11111111-2222-3333-4444-555555555555';

function baseJob(overrides: Record<string, any> = {}) {
  return {
    id: JOB_ID, payment_intent_id: 'pi_1', payment_status: 'paid',
    driver_payout: 90, currency_code: 'gbp', stripe_transfer_id: null,
    stripe_transfer_status: null, total_refunded_minor: 0, total_reversed_minor: 0,
    fare_breakdown: { customerCharge: 100, platformFeeAmount: 0 },
    ...overrides
  };
}

function makeRes(): any {
  const res: any = {};
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (data: any) => { res.body = data; return res; };
  return res;
}

async function run(body: any) {
  const res = makeRes();
  await refundHandler({ user: { id: ADMIN }, body } as any, res as any);
  return res;
}

const reserveKey = () => M.state.rpcCalls.find(c => c.fn === 'reserve_refund_operation')?.args?.p_idempotency_key;

beforeEach(() => {
  vi.clearAllMocks();
  M.state.job = baseJob();
  M.state.op = { id: 'op-1', status: 'reserved', service_component_minor: 800, budget_component_minor: 0, provider_id: null };
  M.state.markError = null;
  M.state.reversalMarkError = null;
  M.state.rpcCalls = [];
  M.stripe.paymentIntents.retrieve.mockResolvedValue({ status: 'succeeded', amount_received: 1000 });
  M.stripe.refunds.create.mockResolvedValue({ id: 're_1' });
  M.stripe.refunds.list.mockResolvedValue({ data: [] });
  M.stripe.transfers.createReversal.mockResolvedValue({ id: 'trr_1' });
});

describe('/refund route', () => {
  it('successful refund calls Stripe once and marks the operation executed', async () => {
    const res = await run({ jobId: JOB_ID });

    expect(M.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(M.state.rpcCalls.some(c => c.fn === 'mark_refund_operation' && c.args.p_status === 'executed')).toBe(true);
    expect(res.body.success).toBe(true);
  });

  it('an already-EXECUTED operation returns its recorded result with NO further Stripe call', async () => {
    M.state.op = { id: 'op-1', status: 'executed', provider_id: 're_done', service_component_minor: 800, budget_component_minor: 0 };
    const res = await run({ jobId: JOB_ID, idempotencyKey: 'op-x' });

    expect(M.stripe.refunds.create).not.toHaveBeenCalled();
    expect(res.body.refundId).toBe('re_done');
  });

  it('an UNKNOWN operation reconciles via provider list and never blindly re-issues', async () => {
    M.state.op = { id: 'op-1', status: 'unknown', provider_id: null, service_component_minor: 800, budget_component_minor: 0 };
    M.stripe.refunds.list.mockResolvedValue({ data: [{ id: 're_found', amount: 1000 }] });
    const res = await run({ jobId: JOB_ID, idempotencyKey: 'op-x' });

    expect(M.stripe.refunds.list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 100 });
    expect(M.stripe.refunds.create).not.toHaveBeenCalled();
    expect(res.body.refundId).toBe('re_found');
  });

  it('an UNKNOWN operation with no provider match stays pending (blocked)', async () => {
    M.state.op = { id: 'op-1', status: 'unknown', provider_id: null, service_component_minor: 800, budget_component_minor: 0 };
    M.stripe.refunds.list.mockResolvedValue({ data: [] });
    const res = await run({ jobId: JOB_ID, idempotencyKey: 'op-x' });

    expect(M.stripe.refunds.create).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.body.status).toBe('unknown');
  });

  it('a documented terminal rejection releases the reservation (not all 4xx)', async () => {
    M.stripe.refunds.create.mockRejectedValue(Object.assign(new Error('refund_exceeds_amount'), { type: 'StripeInvalidRequestError', code: 'refund_exceeds_amount' }));
    const res = await run({ jobId: JOB_ID });

    expect(res.statusCode).toBe(500);
    expect(M.state.rpcCalls.some(c => c.fn === 'mark_refund_operation' && c.args.p_status === 'failed')).toBe(true);
    expect(M.state.rpcCalls.some(c => c.fn === 'release_refund_operation')).toBe(true);
  });

  it('a connection error (not definitive) retains the reservation as unknown', async () => {
    M.stripe.refunds.create.mockRejectedValue(Object.assign(new Error('Connection reset'), { type: 'StripeConnectionError' }));
    const res = await run({ jobId: JOB_ID });

    expect(res.statusCode).toBe(500);
    expect(M.state.rpcCalls.some(c => c.fn === 'mark_refund_operation' && c.args.p_status === 'unknown')).toBe(true);
    expect(M.state.rpcCalls.some(c => c.fn === 'release_refund_operation')).toBe(false);
  });

  it('provider success followed by DB-record failure reconciles via the same idempotency key', async () => {
    M.state.markError = { message: 'db down' };
    const res1 = makeRes();
    await refundHandler({ user: { id: ADMIN }, body: { jobId: JOB_ID, idempotencyKey: 'op-x' } } as any, res1 as any);
    expect(res1.statusCode).toBe(500);
    expect(M.stripe.refunds.create).toHaveBeenCalledTimes(1);

    // DB recovered: the SAME idempotency key re-issues safely (Stripe dedups) and marks executed.
    M.state.markError = null;
    M.state.rpcCalls = [];
    const res2 = makeRes();
    await refundHandler({ user: { id: ADMIN }, body: { jobId: JOB_ID, idempotencyKey: 'op-x' } } as any, res2 as any);

    expect(M.stripe.refunds.create).toHaveBeenCalledTimes(2);
    expect(M.stripe.refunds.create.mock.calls[0][1].idempotencyKey).toBe(M.stripe.refunds.create.mock.calls[1][1].idempotencyKey);
    expect(res2.body.success).toBe(true);
    expect(M.state.rpcCalls.some(c => c.fn === 'mark_refund_operation' && c.args.p_status === 'executed')).toBe(true);
  });

  it('reversal success followed by DB failure is surfaced and reconciles on retry', async () => {
    M.state.job = baseJob({ stripe_transfer_id: 'tr_1', stripe_transfer_status: 'succeeded', driver_payout: 90 });
    M.state.op = { id: 'op-1', status: 'reserved', service_component_minor: 1000, budget_component_minor: 0, provider_id: null };
    M.state.reversalMarkError = { message: 'db down' };

    const res1 = makeRes();
    await refundHandler({ user: { id: ADMIN }, body: { jobId: JOB_ID, idempotencyKey: 'op-x' } } as any, res1 as any);
    expect(M.stripe.transfers.createReversal).toHaveBeenCalledTimes(1);
    expect(res1.body.reversalWarning).toBeTruthy();

    // DB recovered: the reversal op is idempotent on its key; retry completes.
    M.state.reversalMarkError = null;
    M.state.rpcCalls = [];
    const res2 = makeRes();
    await refundHandler({ user: { id: ADMIN }, body: { jobId: JOB_ID, idempotencyKey: 'op-x' } } as any, res2 as any);

    expect(M.stripe.transfers.createReversal).toHaveBeenCalledTimes(2);
    expect(M.state.rpcCalls.some(c => c.fn === 'mark_reversal_operation' && c.args.p_status === 'executed')).toBe(true);
  });

  it('a supplied idempotency key is reused as the stable request identity', async () => {
    await run({ jobId: JOB_ID, idempotencyKey: 'my-stable-key' });

    expect(reserveKey()).toBe('my-stable-key');
    expect(M.stripe.refunds.create.mock.calls[0][1].idempotencyKey).toBe('my-stable-key');
  });

  it('distinct partial refunds of the SAME amount use DIFFERENT keys (no dedup)', async () => {
    await run({ jobId: JOB_ID, amount: 5 });
    const k1 = reserveKey();
    M.state.rpcCalls = [];
    await run({ jobId: JOB_ID, amount: 5 });
    const k2 = reserveKey();

    expect(k1).toBeTruthy();
    expect(k2).toBeTruthy();
    expect(k1).not.toBe(k2);
  });
});
