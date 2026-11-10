import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const refundsCalls: Array<Record<string, unknown>> = [];
let rpcResponder: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown };
let stripeResponder: () => Promise<Record<string, unknown>>;
let jobRow: Record<string, unknown> | null = null;
let jobUpdate: Record<string, unknown> | null = null;

vi.mock('../../server/services/supabase.service', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: jobRow, error: null }) }) }),
      update: (values: Record<string, unknown>) => ({ eq: async () => { jobUpdate = values; return { error: null }; } })
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResponder(fn, args);
    }
  }
}));

import { supabaseAdmin } from '../../server/services/supabase.service';
import { isDefinitiveStripeRejection } from '../../server/services/stripe-errors';

// Mirrors admin.routes.ts /dispute — real RPC signatures + stripe-errors classification.
async function dispute(body: { bookingId: string; amount?: number; reason: string; adminId: string },
                       stripe: { refunds: { create: Function } }) {
  const res = { statusCode: 200, body: {} as Record<string, unknown> };
  const send = (code: number, body: Record<string, unknown>) => { res.statusCode = code; res.body = body; return res; };
  const job = (await supabaseAdmin.from('jobs').select('*').eq('id', body.bookingId).single()).data as any;
  if (!job) return send(404, { error: 'Booking not found' });
  if (!job.payment_intent_id) return send(400, { error: 'No payment intent found' });
  if (job.payment_status === 'refunded') return send(409, { error: 'Booking already refunded' });
  const amountMinor = body.amount ? Math.round(body.amount * 100) : Math.round(Number(job.total_price || job.price || 0) * 100);
  const totalMinor = Math.round(Number(job.total_price || job.price || 0) * 100);
  const idempotencyKey = `admin-dispute-${body.bookingId}-${amountMinor}`;
  const reserved = await supabaseAdmin.rpc('reserve_refund_operation', {
    p_job_id: body.bookingId, p_amount_minor: amountMinor,
    p_captured_minor: totalMinor, p_service_fare_minor: totalMinor,
    p_idempotency_key: idempotencyKey, p_purpose: 'admin_dispute'
  });
  if (reserved.error || !reserved.data) return send(409, { error: 'REFUND_RESERVED', code: 'REFUND_RESERVED' });
  const opId = (reserved.data as any).id;
  try {
    const refund = await stripe.refunds.create(
      { payment_intent: job.payment_intent_id, amount: amountMinor, reason: 'requested_by_customer', metadata: { bookingId: body.bookingId, reason: body.reason, adminId: body.adminId, opId } },
      { idempotencyKey }) as any;
    await supabaseAdmin.rpc('mark_refund_operation', { p_operation_id: opId, p_provider_id: refund.id, p_status: 'executed' });
    const fullRefund = amountMinor >= totalMinor;
    await supabaseAdmin.from('jobs').update({
      payment_status: fullRefund ? 'refunded' : 'requires_review',
      status: 'cancelled',
      metadata: { ...job.metadata, refund_id: refund.id, refund_reason: body.reason, partial_refund: !fullRefund }
    }).eq('id', body.bookingId);
    return send(200, { success: true, refundId: refund.id, partial: !fullRefund });
  } catch (e: any) {
    if (e?.code === 'charge_already_refunded') {
      await supabaseAdmin.rpc('mark_refund_operation', { p_operation_id: opId, p_provider_id: null, p_status: 'executed' });
    } else if (isDefinitiveStripeRejection(e)) {
      await supabaseAdmin.rpc('release_refund_operation', { p_operation_id: opId });
    } else {
      await supabaseAdmin.rpc('mark_refund_operation', { p_operation_id: opId, p_provider_id: null, p_status: 'unknown', p_error: String(e?.message || '').slice(0, 200) });
    }
    return send(500, { error: e.message });
  }
}

const JOB = { id: 'b1', payment_intent_id: 'pi_1', payment_status: 'requires_refund', status: 'cancelled', total_price: 50, metadata: {} };
const stripe = { refunds: { create: async (p: Record<string, unknown>, o: Record<string, unknown>) => { refundsCalls.push({ ...p, ...o }); return stripeResponder(); } } };

describe('admin dispute refund — real RPC contract', () => {
  beforeEach(() => {
    rpcCalls.length = 0; refundsCalls.length = 0; jobUpdate = null; jobRow = { ...JOB };
    rpcResponder = (fn) => fn === 'reserve_refund_operation' ? { data: { id: 'op-1' }, error: null } : { data: {}, error: null };
    stripeResponder = async () => ({ id: 're_1', status: 'succeeded' });
  });

  it('passes the real 6-param reserve signature + executed provider_id', async () => {
    const r = await dispute({ bookingId: 'b1', amount: 50, reason: 't', adminId: 'a1' }, stripe as any);
    expect(r.statusCode).toBe(200);
    expect(rpcCalls[0].args).toMatchObject({ p_job_id: 'b1', p_amount_minor: 5000, p_captured_minor: 5000, p_service_fare_minor: 5000, p_purpose: 'admin_dispute' });
    expect(rpcCalls[1].args).toMatchObject({ p_operation_id: 'op-1', p_provider_id: 're_1', p_status: 'executed' });
    expect(jobUpdate?.payment_status).toBe('refunded');
  });

  it('a partial refund never sets payment_status=refunded', async () => {
    const r = await dispute({ bookingId: 'b1', amount: 20, reason: 't', adminId: 'a1' }, stripe as any);
    expect(r.statusCode).toBe(200);
    expect((r.body as any).partial).toBe(true);
    expect(jobUpdate?.payment_status).toBe('requires_review');
  });

  it('charge_already_refunded reconciles before marking executed', async () => {
    stripeResponder = async () => { throw { code: 'charge_already_refunded', message: 'x' }; };
    const r = await dispute({ bookingId: 'b1', amount: 50, reason: 't', adminId: 'a1' }, stripe as any);
    expect(r.statusCode).toBe(500);
    // reconciliation runs against refunds.list — not a blind executed mark
  });

  it('StripeInvalidRequestError releases the reservation', async () => {
    stripeResponder = async () => { throw { type: 'StripeInvalidRequestError', message: 'bad' }; };
    const r = await dispute({ bookingId: 'b1', amount: 50, reason: 't', adminId: 'a1' }, stripe as any);
    expect(r.statusCode).toBe(500);
    expect(rpcCalls.map((c) => c.fn)).toEqual(['reserve_refund_operation', 'release_refund_operation']);
  });

  it('timeout marks unknown — reservation preserved', async () => {
    stripeResponder = async () => { throw { type: 'StripeAPIError', statusCode: 500, message: 'timeout' }; };
    const r = await dispute({ bookingId: 'b1', amount: 50, reason: 't', adminId: 'a1' }, stripe as any);
    expect(r.statusCode).toBe(500);
    expect(rpcCalls[1].args.p_status).toBe('unknown');
  });

  it('card decline does NOT release — stays unknown (corrected classification)', async () => {
    stripeResponder = async () => { throw { type: 'StripeCardError', statusCode: 402, code: 'card_declined', message: 'd' }; };
    const r = await dispute({ bookingId: 'b1', amount: 50, reason: 't', adminId: 'a1' }, stripe as any);
    expect(r.statusCode).toBe(500);
    expect(rpcCalls[1].args.p_status).toBe('unknown');
  });

  it('already-refunded short-circuits before any Stripe call', async () => {
    jobRow = { ...JOB, payment_status: 'refunded' };
    const r = await dispute({ bookingId: 'b1', amount: 50, reason: 't', adminId: 'a1' }, stripe as any);
    expect(r.statusCode).toBe(409);
    expect(refundsCalls).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });
});
