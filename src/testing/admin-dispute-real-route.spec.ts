import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const refundsCalls: Array<Record<string, unknown>> = [];
const refundsListCalls: number[] = [];
let rpcResponder: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown };
let stripeCreateResponder: () => Promise<Record<string, unknown>>;
let stripeListResponder: () => Promise<Record<string, unknown>>;
let jobRow: Record<string, unknown> | null = null;
let jobUpdateShouldFail = false;

vi.mock('../../server/services/supabase.service', () => ({
  supabaseAdmin: {
    auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }) },
    from: (table: string) => ({
      select: () => table === 'profiles'
        ? { eq: () => ({ maybeSingle: async () => ({ data: { role: 'admin' }, error: null }) }) }
        : { eq: () => ({ single: async () => ({ data: jobRow, error: null }) }) },
      update: (values: Record<string, unknown>) => ({ eq: async () => jobUpdateShouldFail ? { error: { message: 'db_write_failed' } } : { error: null } })
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResponder(fn, args);
    }
  }
}));
vi.mock('../../server/services/stripe.service', () => ({
  stripe: {
    refunds: {
      create: async (params: Record<string, unknown>, opts: Record<string, unknown>) => { refundsCalls.push({ ...params, ...opts }); return stripeCreateResponder(); },
      list: async () => { refundsListCalls.push(1); return stripeListResponder(); }
    },
    paymentIntents: { retrieve: async () => ({ status: 'succeeded' }) }
  }
}));
vi.mock('../../server/services/audit.service', () => ({ AuditService: { logAdminAction: async () => {} } }));

import router from '../../server/routes/admin.routes';

const JOB = { id: 'b1', payment_intent_id: 'pi_1', payment_status: 'requires_refund', status: 'cancelled', total_price: 50, price: 50, metadata: {} };

function call(bookingId: string, amount?: number): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    const srv = app.listen(0, () => {
      const port = (srv.address() as any).port;
      fetch(`http://localhost:${port}/dispute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({ bookingId, amount, reason: 't', adminId: 'a1' })
      }).then(async (r) => { srv.close(); resolve({ status: r.status, body: await r.json() }); });
    });
  });
}

describe('real /dispute route', () => {
  beforeEach(() => {
    rpcCalls.length = 0; refundsCalls.length = 0; refundsListCalls.length = 0; jobUpdateShouldFail = false; jobRow = { ...JOB };
    rpcResponder = (fn) => fn === 'reserve_refund_operation' ? { data: { id: 'op-1' }, error: null } : { data: {}, error: null };
    stripeCreateResponder = async () => ({ id: 're_1', status: 'succeeded' });
    stripeListResponder = async () => ({ data: [] });
  });

  it('duplicate request 409s — no second Stripe call', async () => {
    const r1 = await call('b1', 50);
    expect(r1.status).toBe(200);
    expect(refundsCalls).toHaveLength(1);
    rpcResponder = (fn) => fn === 'reserve_refund_operation' ? { data: null, error: null } : { data: {}, error: null };
    const r2 = await call('b1', 50);
    expect(r2.status).toBe(409);
    expect(refundsCalls).toHaveLength(1);
  });

  it('provider success + DB write failure → 500 LOCAL_STATE_WRITE_FAILED, op stays executed', async () => {
    jobUpdateShouldFail = true;
    const r = await call('b1', 50);
    expect(r.status).toBe(500);
    expect(r.body.code).toBe('LOCAL_STATE_WRITE_FAILED');
    expect(rpcCalls.map((c) => c.fn)).toEqual(['reserve_refund_operation', 'mark_refund_operation']);
    expect(rpcCalls[1].args.p_status).toBe('executed');
  });

  it('unknown timeout → reservation preserved, no release', async () => {
    stripeCreateResponder = async () => { throw { type: 'StripeAPIError', statusCode: 500, message: 'timeout' }; };
    const r = await call('b1', 50);
    expect(r.status).toBe(500);
    expect(rpcCalls.map((c) => c.fn)).toEqual(['reserve_refund_operation', 'mark_refund_operation']);
    expect(rpcCalls[1].args.p_status).toBe('unknown');
  });
});
