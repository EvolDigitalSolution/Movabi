import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

const DEBT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CUSTOMER = 'cccccccc-0000-0000-0000-000000000001';

let debt: Record<string, unknown> | null = null;
let allocatedRef: Record<string, unknown> | null = null;
let updateWritten = false;
let stripeIntent: Record<string, unknown> | Error | null = null;
let auditLogged: Record<string, unknown>[] = [];

vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: {
        auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }) },
        from: (table: string) => {
            if (table === 'profiles') return {
                select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: 'admin' }, error: null }) }) })
            };
            if (table === 'customer_receivables') return {
                select: () => {
                    const single = { maybeSingle: async () => ({ data: debt, error: null }) };
                    const chain: any = {
                        maybeSingle: single.maybeSingle,
                        eq: () => chain,
                        neq: () => ({ maybeSingle: async () => ({ data: allocatedRef, error: null }) })
                    };
                    return chain;
                },
                update: () => ({ eq: () => ({ in: () => ({ select: () => ({ maybeSingle: async () => { updateWritten = true; return { data: { id: DEBT_ID, customer_id: CUSTOMER, amount_minor: 500 }, error: null }; } }) }) }) })
            };
            return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
        },
        rpc: async () => ({ data: null, error: null })
    }
}));
vi.mock('../../server/services/stripe.service', () => ({
    stripe: {
        paymentIntents: {
            retrieve: async () => {
                if (stripeIntent instanceof Error) throw stripeIntent;
                return stripeIntent;
            }
        }
    }
}));
vi.mock('../../server/services/audit.service', () => ({
    AuditService: { logAdminAction: async (_a: string, action: string, _t: string, _e: string, meta: Record<string, unknown>) => { auditLogged.push({ action, meta }); } }
}));
vi.mock('express-rate-limit', () => {
    const passthrough = () => (_r: any, _s: any, n: any) => n();
    return { rateLimit: passthrough, default: passthrough };
});

import router from '../../server/routes/admin.routes';

async function call(path: string, body: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
        const app = express();
        app.use(express.json());
        app.use(router);
        const srv = app.listen(0, () => {
            const port = (srv.address() as any).port;
            fetch(`http://localhost:${port}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
                body: JSON.stringify(body)
            }).then(async (r) => { srv.close(); resolve({ status: r.status, body: await r.json().catch(() => ({})) }); });
        });
    });
}

describe('POST /receivables/:id/resolve — paid requires provider-verified payment', () => {
    beforeEach(() => {
        debt = { id: DEBT_ID, customer_id: CUSTOMER, tenant_id: 't', currency_code: 'GBP', amount_minor: 500, status: 'open' };
        allocatedRef = null; updateWritten = false; stripeIntent = null; auditLogged = [];
    });

    it('rejects a fabricated reference the provider does not know', async () => {
        stripeIntent = new Error('No such payment_intent');
        const r = await call(`/receivables/${DEBT_ID}/resolve`, { status: 'paid', paymentReference: 'pi_fake', paymentProvider: 'stripe', merchantAccountRef: 'acct_1' });
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('REFERENCE_NOT_FOUND');
        expect(updateWritten).toBe(false);
    });

    it('rejects an intent that did not succeed', async () => {
        stripeIntent = { id: 'pi_x', status: 'requires_capture', amount: 500, amount_received: 500, currency: 'gbp', metadata: { customer_id: CUSTOMER } };
        const r = await call(`/receivables/${DEBT_ID}/resolve`, { status: 'paid', paymentReference: 'pi_x', paymentProvider: 'stripe', merchantAccountRef: 'acct_1' });
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('REFERENCE_MISMATCH');
        expect(updateWritten).toBe(false);
    });

    it('rejects an amount mismatch', async () => {
        stripeIntent = { id: 'pi_x', status: 'succeeded', amount: 499, amount_received: 499, currency: 'gbp', metadata: { customer_id: CUSTOMER } };
        const r = await call(`/receivables/${DEBT_ID}/resolve`, { status: 'paid', paymentReference: 'pi_x', paymentProvider: 'stripe', merchantAccountRef: 'acct_1' });
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('REFERENCE_MISMATCH');
    });

    it('rejects a currency mismatch', async () => {
        stripeIntent = { id: 'pi_x', status: 'succeeded', amount: 500, amount_received: 500, currency: 'usd', metadata: { customer_id: CUSTOMER } };
        const r = await call(`/receivables/${DEBT_ID}/resolve`, { status: 'paid', paymentReference: 'pi_x', paymentProvider: 'stripe', merchantAccountRef: 'acct_1' });
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('REFERENCE_MISMATCH');
    });

    it('rejects a payment owned by a different customer', async () => {
        stripeIntent = { id: 'pi_x', status: 'succeeded', amount: 500, amount_received: 500, currency: 'gbp', metadata: { customer_id: 'other-customer' } };
        const r = await call(`/receivables/${DEBT_ID}/resolve`, { status: 'paid', paymentReference: 'pi_x', paymentProvider: 'stripe', merchantAccountRef: 'acct_1' });
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('REFERENCE_MISMATCH');
    });

    it('rejects a reference already allocated to another receivable', async () => {
        stripeIntent = { id: 'pi_x', status: 'succeeded', amount: 500, amount_received: 500, currency: 'gbp', metadata: { customer_id: CUSTOMER } };
        allocatedRef = { id: 'other-receivable' };
        const r = await call(`/receivables/${DEBT_ID}/resolve`, { status: 'paid', paymentReference: 'pi_x', paymentProvider: 'stripe', merchantAccountRef: 'acct_1' });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('REFERENCE_REUSED');
        expect(updateWritten).toBe(false);
    });

    it('marks paid + audits when the provider payment fully verifies', async () => {
        stripeIntent = { id: 'pi_ok', status: 'succeeded', amount: 500, amount_received: 500, currency: 'gbp', metadata: { customer_id: CUSTOMER } };
        const r = await call(`/receivables/${DEBT_ID}/resolve`, { status: 'paid', paymentReference: 'pi_ok', paymentProvider: 'stripe', merchantAccountRef: 'acct_1' });
        expect(r.status).toBe(200);
        expect(updateWritten).toBe(true);
        expect(auditLogged[0]?.action).toBe('receivable_paid');
        expect(auditLogged[0]?.meta?.paymentReference).toBe('pi_ok');
    });

    it('waive is distinct — no payment reference required and none stored', async () => {
        const r = await call(`/receivables/${DEBT_ID}/resolve`, { status: 'waived', reason: 'Goodwill' });
        expect(r.status).toBe(200);
        expect(auditLogged[0]?.action).toBe('receivable_waived');
    });

    it('rejects paid without provider+merchant binding', async () => {
        const r = await call(`/receivables/${DEBT_ID}/resolve`, { status: 'paid', paymentReference: 'pi_x' });
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('BINDING_INCOMPLETE');
        expect(updateWritten).toBe(false);
    });

    it('rejects a payment reference supplied for a non-paid action', async () => {
        const r = await call(`/receivables/${DEBT_ID}/resolve`, { status: 'waived', paymentReference: 'pi_x' });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('REFERENCE_ON_NON_PAYMENT');
        expect(updateWritten).toBe(false);
    });
});
