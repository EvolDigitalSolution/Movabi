import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

const JOB = {
    id: 'job-1', status: 'completed', payment_intent_id: 'pi_1', payment_status: 'paid', refund_id: null,
    total_refunded_minor: 0, stripe_transfer_id: null, stripe_transfer_status: null,
    driver_payout: 0, currency_code: 'GBP', metadata: {},
    fare_breakdown: { customerCharge: 100 }
};
const FB = { customer_charge_minor: 10000, external_due_minor: 4000 };

let role = 'admin';
let userId = 'admin-1';
let rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let rpcAnswers: Record<string, any> = {};
let stripeRefundCalls = 0;
let stripeRefundResponse: any = { id: 're_1', amount: 2000, status: 'succeeded' };

vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: {
        auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
        from: (table: string) => {
            if (table === 'profiles') return {
                select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role }, error: null }) }) })
            };
            const chain: any = {};
            const row = table === 'jobs' ? JOB : table === 'job_funding_breakdown' ? FB : null;
            chain.eq = () => chain; chain.in = () => chain; chain.select = () => chain;
            chain.update = () => ({ eq: () => Promise.resolve({ error: null }) });
            chain.maybeSingle = async () => ({ data: row, error: null });
            chain.single = chain.maybeSingle;
            return chain;
        },
        rpc: async (name: string, args: Record<string, unknown>) => {
            rpcCalls.push({ name, args });
            return { data: rpcAnswers[name] ?? null, error: null };
        }
    }
}));
vi.mock('../../server/services/stripe.service', () => ({
    stripe: {
        paymentIntents: { retrieve: async () => ({ status: 'succeeded', amount_received: 4000 }) },
        refunds: {
            create: async () => { stripeRefundCalls++; return stripeRefundResponse; },
            list: async () => ({ data: [] })
        }
    }
}));
vi.mock('../../server/services/stripe-errors', () => ({ isDefinitiveStripeRejection: () => false }));
vi.mock('../../server/services/fare-split.service', () => ({
    FareSplitService: { toMinor: (v: number, _c: string) => Math.round(v * 100), fromMinor: (v: number, _c: string) => v / 100 }
}));
vi.mock('../../server/services/payment-authority.service', () => ({
    PaymentAuthorityService: { resolve: async () => ({ serviceFareMajor: 80, itemBudgetMajor: 0, totalAuthorisationMajor: 100 }) }
}));
vi.mock('express-rate-limit', () => {
    const passthrough = () => (_r: any, _s: any, n: any) => n();
    return { rateLimit: passthrough, default: passthrough };
});

import router from '../../server/routes/payment.routes';

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
        const app = express();
        app.use(express.json());
        app.use((req: any, _r: any, n: any) => { req.user = { id: userId }; n(); });
        app.use(router);
        const srv = app.listen(0, () => {
            const port = (srv.address() as any).port;
            fetch(`http://localhost:${port}${path}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
                body: JSON.stringify(body)
            }).then(async (r) => { srv.close(); resolve({ status: r.status, body: await r.json().catch(() => ({})) }); });
        });
    });
}

describe('/refund — confirmed allocation wiring', () => {
    beforeEach(() => {
        rpcCalls = []; stripeRefundCalls = 0;
        stripeRefundResponse = { id: 're_1', amount: 2000, status: 'succeeded' };
        rpcAnswers = {
            reserve_refund_operation: [{ id: 'op-1', status: 'reserved', service_component_minor: 2000 }],
            mark_refund_operation: null,
            apply_job_refund: { service: 2000, external: 2000, credit: 1000, discrepancy: 0 }
        };
    });

    it('confirmed succeeded refund applies allocation with provider ref + amount', async () => {
        const r = await post('/refund', { jobId: 'job-1' });
        expect(r.status).toBe(200);
        const alloc = rpcCalls.find(c => c.name === 'apply_job_refund');
        expect(alloc).toBeTruthy();
        expect(alloc!.args.p_ref).toBe('re_1');
        expect(alloc!.args.p_external_minor).toBe(2000);
        // service value scaled: 2000 external * 10000 charge / 4000 due = 5000
        expect(alloc!.args.p_service_minor).toBe(5000);
    });

    it('pending provider refund does NOT restore value', async () => {
        stripeRefundResponse = { id: 're_2', amount: 2000, status: 'pending' };
        const r = await post('/refund', { jobId: 'job-1' });
        expect(r.status).toBe(200);
        expect(rpcCalls.find(c => c.name === 'apply_job_refund')).toBeFalsy();
    });

    it('executed-op replay applies allocation against the same provider ref', async () => {
        rpcAnswers.reserve_refund_operation = [{ id: 'op-1', status: 'executed', provider_id: 're_1', service_component_minor: 2000 }];
        const r = await post('/refund', { jobId: 'job-1' });
        expect(r.status).toBe(200);
        const alloc = rpcCalls.find(c => c.name === 'apply_job_refund');
        expect(alloc?.args.p_ref).toBe('re_1');
        expect(stripeRefundCalls).toBe(0); // no duplicate Stripe refund on replay
    });

    it('credit-only refund on completed fully-funded job: no Stripe call', async () => {
        (JOB as any).payment_intent_id = null;
        (JOB as any).status = 'completed';
        (FB as any).external_due_minor = 0;
        rpcAnswers.apply_job_refund = { service: 5000, external: 0, credit: 2500 };
        const r = await post('/refund', { jobId: 'job-1', amount: 50 });
        expect(r.status).toBe(200);
        expect(r.body.creditOnly).toBe(true);
        expect(stripeRefundCalls).toBe(0);
        const alloc = rpcCalls.find(c => c.name === 'apply_job_refund');
        expect(alloc?.args.p_external_minor).toBe(0);
        (JOB as any).payment_intent_id = 'pi_1';
        (FB as any).external_due_minor = 4000;
    });
});
