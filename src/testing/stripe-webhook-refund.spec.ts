import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';

const JOB = { id: 'job-1', payment_intent_id: 'pi_1', customer_id: 'cust-1', tenant_id: 't-1', currency_code: 'GBP' };
const FB = { customer_charge_minor: 10000, external_due_minor: 4000 };

let tables: Record<string, any> = {};
let currentEvent: any = null;
let rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let rpcAnswers: Record<string, any> = {};

vi.mock('@supabase/supabase-js', () => ({
    createClient: () => ({
        from: (table: string) => {
            const chain: any = {};
            const row = table === 'jobs' ? JOB : table === 'job_funding_breakdown' ? FB : table === 'job_payment_bindings' ? (tables.binding ?? { merchant_account_ref: 'stripe-platform' }) : null;
            chain.eq = () => chain; chain.select = () => chain;
            chain.insert = () => Promise.resolve({ error: null });
            chain.update = () => ({ eq: () => ({ eq: () => ({ in: () => ({ select: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) });
            chain.maybeSingle = async () => ({ data: row, error: null });
            chain.single = chain.maybeSingle;
            return chain;
        },
        rpc: async (name: string, args: Record<string, unknown>) => {
            rpcCalls.push({ name, args });
            return { data: rpcAnswers[name] ?? null, error: null };
        }
    })
}));
vi.mock('stripe', () => ({
    default: class {
        webhooks = { constructEvent: () => currentEvent };
        constructor(..._a: any[]) {}
    }
}));
vi.mock('../../server/services/issuing.service', () => ({ IssuingService: {} }));
vi.mock('../../server/services/payment-authority.service', () => ({
    PaymentAuthorityService: { resolve: async () => ({ serviceFareMajor: 80, itemBudgetMajor: 0, totalAuthorisationMajor: 100 }) }
}));

import router from '../../server/routes/stripe-webhook.routes';

function refundEvent(refund: any): any {
    return {
        id: 'evt_1', type: 'charge.refund.updated',
        data: { object: { payment_intent: 'pi_1', refunds: { data: [refund] } } }
    };
}

async function fire(body: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
        const app = express();
        app.use(express.raw({ type: '*/*' }));
        app.use(router);
        const srv = app.listen(0, () => {
            const port = (srv.address() as any).port;
            fetch(`http://localhost:${port}/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig' },
                body: JSON.stringify(body)
            }).then(async (r) => { srv.close(); resolve({ status: r.status, body: await r.json().catch(() => ({})) }); });
        });
    });
}

describe('webhook charge.refund.updated — confirmed-only allocation', () => {
    beforeEach(() => { rpcCalls = []; tables = {}; rpcAnswers = { apply_job_refund: { service: 5000, external: 2000, credit: 1000 } }; });

    it('succeeded refund applies allocation with provider ref + amount', async () => {
        currentEvent = refundEvent({ id: 're_1', status: 'succeeded', amount: 2000, currency: 'gbp' });
        const r = await fire(currentEvent);
        console.log('WEBHOOK 500 BODY:', JSON.stringify(r.body));
        expect(r.status).toBe(200);
        const alloc = rpcCalls.find(c => c.name === 'apply_job_refund');
        expect(alloc?.args.p_ref).toBe('re_1');
        expect(alloc?.args.p_external_minor).toBe(2000);
        expect(alloc?.args.p_service_minor).toBe(5000);
    });

    it('pending refund restores nothing', async () => {
        currentEvent = refundEvent({ id: 're_2', status: 'pending', amount: 2000, currency: 'gbp' });
        await fire(currentEvent);
        expect(rpcCalls.find(c => c.name === 'apply_job_refund')).toBeFalsy();
    });

    it('failed refund restores nothing', async () => {
        currentEvent = refundEvent({ id: 're_3', status: 'failed', amount: 2000, currency: 'gbp' });
        await fire(currentEvent);
        expect(rpcCalls.find(c => c.name === 'apply_job_refund')).toBeFalsy();
    });

    it('currency mismatch is skipped for review, not allocated', async () => {
        currentEvent = refundEvent({ id: 're_4', status: 'succeeded', amount: 2000, currency: 'usd' });
        await fire(currentEvent);
        expect(rpcCalls.find(c => c.name === 'apply_job_refund')).toBeFalsy();
    });

    it('duplicate event re-fires the same provider ref — RPC dedupes', async () => {
        currentEvent = refundEvent({ id: 're_1', status: 'succeeded', amount: 2000, currency: 'gbp' });
        await fire(currentEvent);
        await fire(currentEvent);
        const allocs = rpcCalls.filter(c => c.name === 'apply_job_refund');
        expect(allocs.every(c => c.args.p_ref === 're_1')).toBe(true);
    });

    it('refund.updated (object form) routes through the shared handler', async () => {
        currentEvent = { id: 'evt_2', type: 'refund.updated',
            data: { object: { id: 're_9', status: 'succeeded', amount: 1500, currency: 'gbp', payment_intent: 'pi_1' } } };
        const r = await fire(currentEvent);
        expect(r.status).toBe(200);
        const alloc = rpcCalls.find(c => c.name === 'apply_job_refund');
        expect(alloc?.args.p_ref).toBe('re_9');
        expect(alloc?.args.p_external_minor).toBe(1500);
    });

    it('account binding mismatch skips the allocation for review', async () => {
        tables.binding = { merchant_account_ref: 'acct_1' };
        currentEvent = { id: 'evt_acc', type: 'charge.refund.updated', account: 'acct_OTHER',
            data: { object: { payment_intent: 'pi_1', refunds: { data: [{ id: 're_acc', status: 'succeeded', amount: 2000, currency: 'gbp' }] } } } };
        await fire(currentEvent);
        expect(rpcCalls.find(c => c.name === 'apply_job_refund')).toBeFalsy();
    });

    it('Connect-bound PI with absent event.account is skipped, not bypassed', async () => {
        tables.binding = { merchant_account_ref: 'acct_1' };
        currentEvent = { id: 'evt_abs', type: 'charge.refund.updated',
            data: { object: { payment_intent: 'pi_1', refunds: { data: [{ id: 're_abs', status: 'succeeded', amount: 2000, currency: 'gbp' }] } } } };
        await fire(currentEvent);
        expect(rpcCalls.find(c => c.name === 'apply_job_refund')).toBeFalsy();
    });

    it('platform-bound PI may omit event.account', async () => {
        // Swap the binding to a platform ref for this test via table override is
        // not supported by the simple mock — assert the Connect case is covered
        // by the absent-account test above; this verifies absence+platform path
        // using a binding-free job (no binding row -> platform semantics).
        tables.binding = { merchant_account_ref: 'stripe-platform' };
        currentEvent = refundEvent({ id: 're_plat', status: 'succeeded', amount: 2000, currency: 'gbp' });
        await fire(currentEvent);
        expect(rpcCalls.find(c => c.name === 'apply_job_refund')?.args.p_ref).toBe('re_plat');
    });

    it('matching account binding allocates normally', async () => {
        tables.binding = { merchant_account_ref: 'acct_1' };
        currentEvent = { id: 'evt_acc2', type: 'charge.refund.updated', account: 'acct_1',
            data: { object: { payment_intent: 'pi_1', refunds: { data: [{ id: 're_acc2', status: 'succeeded', amount: 2000, currency: 'gbp' }] } } } };
        await fire(currentEvent);
        expect(rpcCalls.find(c => c.name === 'apply_job_refund')?.args.p_ref).toBe('re_acc2');
    });

    it('cross-event duplication: same refund in charge.refund.updated + refund.updated stays one ref', async () => {
        currentEvent = refundEvent({ id: 're_7', status: 'succeeded', amount: 2000, currency: 'gbp' });
        await fire(currentEvent);
        currentEvent = { id: 'evt_3', type: 'refund.updated',
            data: { object: { id: 're_7', status: 'succeeded', amount: 2000, currency: 'gbp', payment_intent: 'pi_1' } } };
        await fire(currentEvent);
        const allocs = rpcCalls.filter(c => c.name === 'apply_job_refund');
        expect(allocs.every(c => c.args.p_ref === 're_7')).toBe(true);
    });
});
