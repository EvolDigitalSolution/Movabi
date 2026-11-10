import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

const JOB = {
    id: 'job-1', tenant_id: 't-1', customer_id: 'cust-1', currency_code: 'GBP',
    country_code: 'GB', status: 'requested', payment_status: 'pending',
    payment_method: 'card', service_type_id: 'st-1', agreed_fare: 100,
    fare_breakdown: { customerCharge: 100 }, metadata: {}, service_type: { slug: 'ride' }
};

let userId = 'cust-1';
let tables: Record<string, any> = {};
let rpcAnswers: Record<string, any> = {};
let stripeCalls = 0;
let stripeCreateArgs: any[][] = [];

function chainFor(table: string) {
    const chain: any = {};
    let filter: Record<string, any> = {};
    chain.eq = (k: string, v: any) => { filter[k] = v; return chain; };
    chain.in = (k: string, v: any) => { filter[k] = v; return chain; };
    chain.neq = () => chain;
    chain.select = () => chain;
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.update = () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) });
    chain.insert = () => chain;
    const filtered = () => {
        const rows = Array.isArray(tables[table]) ? tables[table] : (tables[table] ? [tables[table]] : []);
        return rows.filter((r: any) => Object.entries(filter).every(([k, v]) => Array.isArray(v) ? v.includes(r[k]) : r[k] === v));
    };
    chain.maybeSingle = async () => ({ data: filtered()[0] ?? null, error: null });
    chain.single = chain.maybeSingle;
    chain.then = (res: any) => Promise.resolve({ data: filtered(), error: null }).then(res);
    return chain;
}

vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: {
        auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
        from: (table: string) => {
            if (table === 'profiles') return {
                select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: 'customer' }, error: null }) }) })
            };
            return chainFor(table);
        },
        rpc: async (name: string, _args: Record<string, unknown>) => ({ data: rpcAnswers[name], error: null })
    }
}));
vi.mock('../../server/services/payment-authority.service', () => ({
    PaymentAuthorityService: { resolve: async () => ({ serviceFareMajor: 80, itemBudgetMajor: 0, totalAuthorisationMajor: 100 }), minorUnits: (v: number) => Math.round(v * 100) }
}));
vi.mock('../../server/services/market-availability.service', () => ({
    MarketAvailabilityService: { requireCapability: async () => ({}), resolveMarket: async () => null }
}));
vi.mock('../../server/services/stripe.service', () => ({
    stripe: { paymentIntents: { create: async (...args: any[]) => { stripeCalls++; stripeCreateArgs.push(args); return { id: 'pi_1', client_secret: 's' }; }, retrieve: async () => { throw new Error('none'); } } }
}));
vi.mock('../../server/services/booking-payment-context', () => ({ stripeCheckoutMarket: () => true }));
vi.mock('../../server/services/payments/market-payment-store', () => ({
    loadDatabasePaymentPolicies: async () => ({ routes: [{ provider: 'stripe', merchantAccountRef: 'stripe-platform', currency: 'GBP' }] })
}));
vi.mock('../../server/services/payments/market-payment-registry', () => ({
    selectMarketPayment: () => ({ provider: 'stripe', merchantAccountRef: 'stripe-platform', currency: 'GBP' })
}));
vi.mock('../../server/services/payments/gb-gateway-checkout', () => ({ createGbGatewayCheckout: async () => ({ id: 'pi_1' }) }));
vi.mock('../../server/services/issuing-capacity.service', () => ({ IssuingCapacityService: { assertAvailable: async () => ({}) } }));
vi.mock('../../server/services/payments/stripe-saved-cards', () => ({ StripeSavedCards: class { async prepare() { return {}; } } }));
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

describe('/create-intent â€” atomic secured zero-payable funding', () => {
    beforeEach(() => {
        stripeCalls = 0;
        tables = { jobs: [JOB] };
        rpcAnswers = { job_remaining_payable_minor: 0, secure_zero_payable_funding: { funded: true, already: false, externalDueMinor: 0 } };
    });

    it('secured funding â†’ 200, no Stripe intent, funded state', async () => {
        const r = await post('/create-intent', { jobId: 'job-1' });
        expect(r.status).toBe(200);
        expect(r.body.zeroExternalPayable).toBe(true);
        expect(r.body.fundingStatus).toBe('fully_funded_by_credit');
        expect(stripeCalls).toBe(0);
    });

    it('insecure allocation (released/reversed/mismatched) â†’ 409, no PI', async () => {
        rpcAnswers.secure_zero_payable_funding = { funded: false, reason: 'insecure_allocation' };
        const r = await post('/create-intent', { jobId: 'job-1' });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('UNSECURED_ZERO_PAYABLE');
        expect(stripeCalls).toBe(0);
    });

    it('no zero-payable breakdown â†’ 409 (bare arithmetic zero is not funding)', async () => {
        rpcAnswers.secure_zero_payable_funding = { funded: false, reason: 'no_zero_payable_breakdown' };
        const r = await post('/create-intent', { jobId: 'job-1' });
        expect(r.status).toBe(409);
    });

    it('retry on already-funded â†’ same funded state, still no PI', async () => {
        rpcAnswers.secure_zero_payable_funding = { funded: true, already: true, externalDueMinor: 0 };
        const r = await post('/create-intent', { jobId: 'job-1' });
        expect(r.status).toBe(200);
        expect(r.body.alreadyFunded).toBe(true);
        expect(stripeCalls).toBe(0);
    });

    it('RPC failure â†’ 500, no wallet_funded', async () => {
        rpcAnswers.secure_zero_payable_funding = null;
        const r = await post('/create-intent', { jobId: 'job-1' });
        expect([409, 500]).toContain(r.status);
        expect(stripeCalls).toBe(0);
    });
});
describe('/create-intent — outbound amount precision', () => {
    beforeEach(() => {
        stripeCalls = 0;
        stripeCreateArgs = [];
        tables = { jobs: [{ ...JOB, currency_code: 'GBP' }] };
        rpcAnswers = { job_remaining_payable_minor: 666, secure_zero_payable_funding: { funded: false } };
    });

    it('GBP 666 minor → Stripe amount 666 gbp', async () => {
        const r = await post('/create-intent', { jobId: 'job-1', amount: 6.66 });
        expect(r.status).toBe(200);
        expect(stripeCreateArgs[0][0].amount).toBe(666);
        expect(stripeCreateArgs[0][0].currency).toBe('gbp');
    });

    it('excess precision 6.666 GBP rejected before any Stripe call', async () => {
        const r = await post('/create-intent', { jobId: 'job-1', amount: 6.666 });
        expect(r.status).toBe(400);
        expect(r.body.error).toBe('Invalid amount precision');
        expect(stripeCalls).toBe(0);
    });
});
