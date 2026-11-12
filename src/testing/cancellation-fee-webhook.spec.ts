import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

// Webhook backstop for a cancellation fee captured from a cancelled booking's own authorisation (6b).
// Real webhook router; mocked Stripe event and database. The settlement rules themselves run on real
// PostgreSQL in the upgraded-clone rehearsal.

const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
let webhookEvent: any = null;
let jobRow: Record<string, any> | null = null;
let rpcCalls: Array<{ fn: string; args: Record<string, any> }> = [];
let settleResult: any = { status: 'settled' };
let settleError: any = null;

vi.mock('stripe', () => { const S = class { webhooks = { constructEvent: () => webhookEvent }; }; return { default: S, Stripe: S }; });
const anyChain = (row: () => any): any => new Proxy({}, { get: (_t, p) =>
    p === 'then' ? (r: any) => Promise.resolve({ data: row(), error: null }).then(r)
    : (p === 'maybeSingle' || p === 'single') ? async () => ({ data: row(), error: null })
    : (p === 'insert' || p === 'upsert') ? async () => ({ error: null })
    : () => anyChain(row) });
vi.mock('@supabase/supabase-js', () => ({
    createClient: () => ({
        from: (table: string) => anyChain(() => table === 'jobs' ? jobRow : null),
        rpc: async (fn: string, args: Record<string, any>) => {
            rpcCalls.push({ fn, args });
            if (fn === 'record_customer_receivable') return { data: { id: 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr' }, error: null };
            if (fn === 'settle_cancellation_compensation') return { data: settleResult, error: settleError };
            return { data: null, error: null };
        }
    })
}));
vi.mock('../../server/services/issuing.service', () => ({ IssuingService: { handleAuthorizationRequest: async () => ({}), syncAuthorization: async () => {}, syncTransaction: async () => {} } }));
vi.mock('../../server/services/payment-authority.service', () => ({ PaymentAuthorityService: { resolve: async () => ({ currency: 'gbp', totalAuthorisationMajor: 0 }), minorUnits: () => -1 } }));

import router from '../../server/routes/stripe-webhook.routes';

async function post(payload: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
        const app = express(); app.use(express.raw({ type: 'application/json' })); app.use(router);
        const srv = app.listen(0, () => {
            fetch(`http://localhost:${(srv.address() as any).port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig' }, body: JSON.stringify(payload) })
                .then(async (r) => { srv.close(); resolve({ status: r.status, body: await r.json().catch(() => ({})) }); });
        });
    });
}
const frozen = { due: true, reasonCode: 'due', feeMinor: 400, currency: 'GBP', exponent: 2, policyVersion: 3 };
const succeeded = (over: Record<string, any> = {}) => ({ id: 'evt_fee_1', type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_booking', status: 'succeeded', currency: 'gbp', amount: 1200, amount_received: 400, livemode: false, metadata: { jobId: JOB }, ...over } } });
const settleCall = () => rpcCalls.find(c => c.fn === 'settle_cancellation_compensation');

describe('cancellation fee webhook backstop (real router)', () => {
    beforeEach(() => {
        process.env.STRIPE_WEBHOOK_SECRET = 'wh_test';
        rpcCalls = []; settleResult = { status: 'settled' }; settleError = null;
        jobRow = { id: JOB, tenant_id: 't', customer_id: 'u1', status: 'cancelled', payment_intent_id: 'pi_booking', metadata: { cancellation_fee_quote: frozen } };
    });

    it('settles the captured fee with the same identity the route uses (provider, platform merchant, test env, PI id)', async () => {
        webhookEvent = succeeded();
        const res = await post(webhookEvent);
        expect(res.status).toBe(200);
        expect(rpcCalls.find(c => c.fn === 'record_customer_receivable')?.args).toMatchObject({ p_job: JOB, p_amount: 400, p_reason: 'cancellation_fee', p_policy_version: 3, p_currency: 'GBP' });
        expect(settleCall()?.args).toEqual({ p_receivable: 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr', p_collected_minor: 400, p_payment_reference: 'pi_booking',
            p_provider: 'stripe', p_merchant_account_ref: 'stripe-platform', p_environment: 'test' });
        expect(rpcCalls.some(c => c.fn === 'finalize_job_payment'), 'a cancelled booking is never re-activated').toBe(false);
    });

    it('a replay converges (already_settled) and is acknowledged', async () => {
        settleResult = { status: 'already_settled' };
        webhookEvent = succeeded();
        expect((await post(webhookEvent)).status).toBe(200);
    });

    it('a storage failure answers 500 so Stripe re-delivers', async () => {
        settleError = { message: 'connection reset' };
        webhookEvent = succeeded();
        const res = await post(webhookEvent);
        expect(res.status).toBe(500);
        expect(res.body.error).toContain('cancellation fee settlement failed');
    });

    it('more than the frozen fee (charged before cancelling) is not booked as a fee and is not retried', async () => {
        webhookEvent = succeeded({ amount_received: 1200 });
        const res = await post(webhookEvent);
        expect(res.status).toBe(200);
        expect(settleCall()).toBeUndefined();
        expect(rpcCalls.some(c => c.fn === 'record_customer_receivable')).toBe(false);
    });

    it('an active (not cancelled) booking takes the normal path, never the fee path', async () => {
        jobRow = { ...jobRow!, status: 'searching' };
        webhookEvent = succeeded({ amount_received: 1200 });
        expect((await post(webhookEvent)).status).toBe(200);
        expect(settleCall()).toBeUndefined();
    });

    it('no fee due in the frozen quote: nothing booked', async () => {
        jobRow = { ...jobRow!, metadata: { cancellation_fee_quote: { ...frozen, due: false, reasonCode: 'within_grace', feeMinor: 0 } } };
        webhookEvent = succeeded();
        expect((await post(webhookEvent)).status).toBe(200);
        expect(settleCall()).toBeUndefined();
    });
});
