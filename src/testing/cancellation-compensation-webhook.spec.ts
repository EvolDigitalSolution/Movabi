import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

const RECEIVABLE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

let webhookEvent: any = null;
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let receivableLookup: Record<string, unknown> | null = null;
let settleResult: Record<string, unknown> | null = null;
let settleError: any = null;
let eventsUpserted: string[] = [];

vi.mock('stripe', () => {
    const FakeStripe = class { webhooks = { constructEvent: () => webhookEvent }; };
    return { default: FakeStripe, Stripe: FakeStripe };
});

vi.mock('@supabase/supabase-js', () => ({
    createClient: () => ({
        from: (table: string) => {
            if (table === 'stripe_events') return {
                upsert: async (row: Record<string, unknown>) => { eventsUpserted.push(String(row.id)); return { error: null }; }
            };
            if (table === 'customer_receivables') return {
                select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: receivableLookup, error: null }) }) })
            };
            return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }), insert: async () => ({ error: null }) };
        },
        rpc: async (fn: string, args: Record<string, unknown>) => {
            rpcCalls.push({ fn, args });
            if (fn === 'settle_cancellation_compensation') return { data: settleResult, error: settleError };
            return { data: null, error: null };
        }
    })
}));

vi.mock('../../server/services/issuing.service', () => ({
    IssuingService: { handleAuthorizationRequest: async () => ({}), syncAuthorization: async () => {}, syncTransaction: async () => {} }
}));
vi.mock('../../server/services/payment-authority.service', () => ({
    PaymentAuthorityService: { resolve: async () => ({ currency: 'gbp', totalAuthorisationMajor: 0 }), minorUnits: () => 0 }
}));

import router from '../../server/routes/stripe-webhook.routes';

async function post(payload: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
        const app = express();
        app.use(express.raw({ type: 'application/json' }));
        app.use(router);
        const srv = app.listen(0, () => {
            const port = (srv.address() as any).port;
            fetch(`http://localhost:${port}/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig' },
                body: JSON.stringify(payload)
            }).then(async (r) => { srv.close(); resolve({ status: r.status, body: await r.json().catch(() => ({})) }); });
        });
    });
}

describe('cancellation compensation webhook integration (real router)', () => {
    beforeEach(() => {
        process.env.STRIPE_WEBHOOK_SECRET = 'wh_test';
        rpcCalls.length = 0;
        receivableLookup = null;
        settleResult = { status: 'settled', driver_compensation_minor: 400, platform_share_minor: 100 };
        settleError = null;
        eventsUpserted.length = 0;
        webhookEvent = {
            id: 'evt_debt_1', type: 'payment_intent.succeeded',
            data: { object: { id: 'pi_debt_1', amount: 500, currency: 'gbp', metadata: { purpose: 'debt_repayment', receivable_id: RECEIVABLE_ID, customer_id: 'u1' } } }
        };
    });

    it('confirmed fee collection calls settle_cancellation_compensation with the verified amount', async () => {
        const res = await post(webhookEvent);
        expect(res.status).toBe(200);
        const settle = rpcCalls.find(c => c.fn === 'settle_cancellation_compensation');
        expect(settle).toBeDefined();
        expect(settle!.args.p_receivable).toBe(RECEIVABLE_ID);
        expect(settle!.args.p_collected_minor).toBe(500);
        expect(settle!.args.p_payment_reference).toBe('pi_debt_1');
        expect(settle!.args.p_provider).toBe('stripe');
        expect(String(settle!.args.p_merchant_account_ref || '')).toBeTruthy();
        expect(settle!.args.p_environment).toBe('test'); // test/live environment bound
    });

    it('a duplicate delivery still calls the idempotent settle and stays acknowledged', async () => {
        await post(webhookEvent);
        await post(webhookEvent); // re-delivery converges via the RPC, not a webhook pre-gate
        expect(rpcCalls.filter(c => c.fn === 'settle_cancellation_compensation').length).toBe(2);
    });

    it('a settlement failure is not acknowledged (500) so Stripe re-delivers', async () => {
        settleError = { message: 'transient db error' };
        const res = await post(webhookEvent);
        expect(res.status).toBe(500);
        expect(eventsUpserted).toHaveLength(0); // event not marked processed -> retried
    });

    it('a review_required settlement is acknowledged without crashing', async () => {
        settleResult = { status: 'review_required', driver_compensation_minor: 0, platform_share_minor: 0 };
        const res = await post(webhookEvent);
        expect(res.status).toBe(200);
        expect(rpcCalls.find(c => c.fn === 'settle_cancellation_compensation')).toBeDefined();
    });

    it('a confirmed refund resolves the receivable and reverses compensation', async () => {
        receivableLookup = { id: RECEIVABLE_ID, payment_reference: 'pi_debt_1' };
        webhookEvent = {
            id: 'evt_refund_1', type: 'refund.created',
            data: { object: { id: 're_1', amount: 200, status: 'succeeded', payment_intent: 'pi_debt_1' } }
        };
        const res = await post(webhookEvent);
        expect(res.status).toBe(200);
        const rev = rpcCalls.find(c => c.fn === 'reverse_cancellation_compensation');
        expect(rev).toBeDefined();
        expect(rev!.args.p_receivable).toBe(RECEIVABLE_ID);
        expect(rev!.args.p_refund_minor).toBe(200);
        expect(rev!.args.p_refund_reference).toBe('re_1');
        expect(rev!.args.p_environment).toBe('test');
    });

    it('a pending/failed refund does not reverse compensation', async () => {
        receivableLookup = { id: RECEIVABLE_ID, payment_reference: 'pi_debt_1' };
        webhookEvent = {
            id: 'evt_refund_2', type: 'refund.updated',
            data: { object: { id: 're_2', amount: 200, status: 'failed', payment_intent: 'pi_debt_1' } }
        };
        const res = await post(webhookEvent);
        expect(res.status).toBe(200);
        expect(rpcCalls.find(c => c.fn === 'reverse_cancellation_compensation')).toBeUndefined();
    });

    it('a refund for a non-debt payment intent is ignored', async () => {
        receivableLookup = null; // no receivable bound to this PI
        webhookEvent = {
            id: 'evt_refund_3', type: 'refund.created',
            data: { object: { id: 're_3', amount: 200, status: 'succeeded', payment_intent: 'pi_job_1' } }
        };
        const res = await post(webhookEvent);
        expect(res.status).toBe(200);
        expect(rpcCalls.find(c => c.fn === 'reverse_cancellation_compensation')).toBeUndefined();
    });
});
