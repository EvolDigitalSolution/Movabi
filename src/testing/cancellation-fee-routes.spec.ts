import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

// Real booking router; mocked Supabase and Stripe. The fee RULES are proven on real PostgreSQL
// (bash scripts/cancellation-fee/run-realdb-tests.sh) and through real routes in the upgraded-clone
// rehearsal. This spec covers what needs a provider: how the route acts on the FROZEN quote for card
// bookings (capture amount/currency exponent/idempotency, receivable when nothing can be captured),
// and the preview contract.

const CUSTOMER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DRIVER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let jobRow: Record<string, any> = {};
let quoteRpc: { data: unknown; error: unknown } = { data: null, error: null };
let pi: Record<string, any> = {};
let caller = CUSTOMER;
const rpcCalls: Array<{ fn: string; args: Record<string, any> }> = [];
const stripeCalls: Array<{ op: string; args: any[] }> = [];

// Any query chain resolves to the job row (single/maybeSingle/await).
const chain = (): any => new Proxy({}, {
    get(_t, prop) {
        if (prop === 'then') return (res: any) => Promise.resolve({ data: jobRow, error: null }).then(res);
        if (prop === 'single' || prop === 'maybeSingle') return async () => ({ data: jobRow, error: null });
        return () => chain();
    }
});

vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: {
        auth: { getUser: async () => ({ data: { user: { id: caller } }, error: null }) },
        from: (table: string) => table === 'profiles'
            ? new Proxy({}, { get: (_t, p) => p === 'then' ? (r: any) => Promise.resolve({ data: { account_status: 'active', role: 'customer' }, error: null }).then(r)
                : (p === 'single' || p === 'maybeSingle') ? async () => ({ data: { account_status: 'active', role: 'customer' }, error: null }) : () => chain() })
            : chain(),
        rpc: async (fn: string, args: Record<string, any>) => {
            rpcCalls.push({ fn, args });
            if (fn === 'cancel_job_with_actor') return { data: true, error: null };
            if (fn === 'cancellation_fee_quote') return quoteRpc;
            return { data: null, error: null };
        }
    },
    getSupabaseAdmin: () => null
}));
vi.mock('../../server/services/stripe.service', () => ({
    stripe: {
        paymentIntents: {
            retrieve: async (...args: any[]) => { stripeCalls.push({ op: 'retrieve', args }); return pi; },
            capture: async (...args: any[]) => { stripeCalls.push({ op: 'capture', args }); return { ...pi, status: 'succeeded' }; },
            cancel: async (...args: any[]) => { stripeCalls.push({ op: 'cancel', args }); return { ...pi, status: 'canceled' }; }
        }
    }
}));
vi.mock('stripe', () => { const S = class { paymentIntents = {}; webhooks = {}; }; return { default: S, Stripe: S }; });
vi.mock('../../server/services/fraud.service', () => ({ FraudService: { trackCancellation: async () => {} } }));
vi.mock('../../server/services/dispatch.service', () => ({ DispatchService: {} }));
vi.mock('../../server/services/notification.service', () => ({ NotificationService: { notifyJobStatusUpdate: async () => {} } }));
vi.mock('../../server/services/logistics.service', () => ({ LogisticsService: { isValidBookingTransition: (_c: string, n: string) => n === 'cancelled' } }));
vi.mock('express-rate-limit', () => { const f = () => (_q: any, _s: any, n: any) => n(); return { default: f, rateLimit: f }; });

import router, { normaliseCancellationFeeQuote } from '../../server/routes/booking.routes';

async function call(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
        const app = express(); app.use(express.json()); app.use(router);
        const srv = app.listen(0, () => {
            const port = (srv.address() as any).port;
            fetch(`http://localhost:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' }, body: body === undefined ? undefined : JSON.stringify(body) })
                .then(async (r) => { srv.close(); resolve({ status: r.status, body: await r.json().catch(() => ({})) }); });
        });
    });
}
const quote = (over: Record<string, unknown> = {}) => ({ due: true, reasonCode: 'due', feeMinor: 400, currency: 'GBP', exponent: 2, policyVersion: 3,
    graceSeconds: 300, graceUntil: '2026-11-12T10:05:00Z', driverAssigned: true, ...over });
const cardJob = (frozen: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) => ({
    id: JOB, tenant_id: 't', customer_id: CUSTOMER, driver_id: DRIVER, accepted_driver_id: DRIVER, status: 'assigned',
    payment_method: 'card', payment_status: 'authorized', payment_intent_id: 'pi_card', currency_code: 'GBP', country_code: 'GB',
    metadata: frozen ? { cancellation_fee_quote: frozen } : {}, ...over });
const receivableCall = () => rpcCalls.find(c => c.fn === 'record_customer_receivable');

describe('cancellation fee on the real booking router', () => {
    beforeEach(() => { rpcCalls.length = 0; stripeCalls.length = 0; caller = CUSTOMER; quoteRpc = { data: null, error: null }; });

    it('card: captures exactly the frozen fee (GBP 400), with an idempotency key, never re-quoting', async () => {
        jobRow = cardJob(quote());
        pi = { id: 'pi_card', status: 'requires_capture', amount_capturable: 1200, currency: 'gbp' };
        const r = await call('/cancel', 'POST', { jobId: JOB, reason: 'changed plans' });
        expect(r.status).toBe(200);
        expect(rpcCalls.find(c => c.fn === 'cancel_job_with_actor')?.args).toMatchObject({ p_actor: CUSTOMER, p_actor_role: 'customer' });
        expect(rpcCalls.some(c => c.fn === 'cancellation_fee_quote' || c.fn === 'active_cancellation_policy'), 'the route uses the frozen quote only').toBe(false);
        const capture = stripeCalls.find(c => c.op === 'capture');
        expect(capture?.args[1]).toEqual({ amount_to_capture: 400 });
        expect(capture?.args[2]).toEqual({ idempotencyKey: `vaydu-cancel-fee:${JOB}` });
        expect(receivableCall(), 'captured fees are not also recorded as debt').toBeUndefined();
    });

    it('card: JPY (0 decimals) captures 500, not 50000', async () => {
        jobRow = cardJob(quote({ feeMinor: 500, currency: 'JPY', exponent: 0 }), { currency_code: 'JPY', country_code: 'JP' });
        pi = { id: 'pi_card', status: 'requires_capture', amount_capturable: 1200, currency: 'jpy' };
        await call('/cancel', 'POST', { jobId: JOB, reason: 'x' });
        expect(stripeCalls.find(c => c.op === 'capture')?.args[1]).toEqual({ amount_to_capture: 500 });
    });

    it('card: never captures more than was authorised', async () => {
        jobRow = cardJob(quote({ feeMinor: 900 }));
        pi = { id: 'pi_card', status: 'requires_capture', amount_capturable: 600, currency: 'gbp' };
        await call('/cancel', 'POST', { jobId: JOB, reason: 'x' });
        expect(stripeCalls.find(c => c.op === 'capture')?.args[1]).toEqual({ amount_to_capture: 600 });
    });

    it('card: a quote that is not due releases the authorisation and takes nothing', async () => {
        jobRow = cardJob(quote({ due: false, reasonCode: 'within_grace', feeMinor: 0 }));
        pi = { id: 'pi_card', status: 'requires_capture', amount_capturable: 1200, currency: 'gbp' };
        await call('/cancel', 'POST', { jobId: JOB, reason: 'x' });
        expect(stripeCalls.some(c => c.op === 'capture')).toBe(false);
        expect(stripeCalls.some(c => c.op === 'cancel')).toBe(true);
        expect(receivableCall()).toBeUndefined();
    });

    it('card: a missing or malformed frozen quote charges nothing (fail closed)', async () => {
        for (const frozen of [undefined, { due: true, feeMinor: 'lots', currency: 'GBP', exponent: 2 }, { due: true, feeMinor: 400, currency: 'GBP', exponent: 9 }]) {
            stripeCalls.length = 0; rpcCalls.length = 0;
            jobRow = cardJob(frozen as any);
            pi = { id: 'pi_card', status: 'requires_capture', amount_capturable: 1200, currency: 'gbp' };
            await call('/cancel', 'POST', { jobId: JOB, reason: 'x' });
            expect(stripeCalls.some(c => c.op === 'capture'), JSON.stringify(frozen)).toBe(false);
            expect(receivableCall(), JSON.stringify(frozen)).toBeUndefined();
        }
    });

    it('card: nothing capturable (authorisation never completed) -> the due fee becomes a receivable', async () => {
        jobRow = cardJob(quote());
        pi = { id: 'pi_card', status: 'requires_payment_method', amount_capturable: 0, currency: 'gbp' };
        await call('/cancel', 'POST', { jobId: JOB, reason: 'x' });
        expect(stripeCalls.some(c => c.op === 'capture')).toBe(false);
        expect(receivableCall()?.args).toMatchObject({ p_customer: CUSTOMER, p_job: JOB, p_currency: 'GBP', p_amount: 400, p_reason: 'cancellation_fee', p_policy_version: 3 });
    });

    it('no PaymentIntent (e.g. wallet/other): the due fee becomes a receivable with the frozen version', async () => {
        jobRow = cardJob(quote({ feeMinor: 250 }), { payment_method: 'wallet', payment_intent_id: null, payment_status: 'wallet_funded' });
        await call('/cancel', 'POST', { jobId: JOB, reason: 'x' });
        expect(receivableCall()?.args).toMatchObject({ p_amount: 250, p_policy_version: 3, p_currency: 'GBP' });
    });

    it('the assigned driver cancelling is recorded as the driver (the DB freezes not_customer)', async () => {
        caller = DRIVER;
        jobRow = cardJob(quote({ due: false, reasonCode: 'not_customer', feeMinor: 0 }));
        pi = { id: 'pi_card', status: 'requires_capture', amount_capturable: 1200, currency: 'gbp' };
        await call('/cancel', 'POST', { jobId: JOB, reason: 'x' });
        expect(rpcCalls.find(c => c.fn === 'cancel_job_with_actor')?.args).toMatchObject({ p_actor: DRIVER, p_actor_role: 'driver' });
        expect(stripeCalls.some(c => c.op === 'capture')).toBe(false);
    });

    it('preview: asks the database for the caller role and returns its quote', async () => {
        jobRow = cardJob(undefined);
        quoteRpc = { data: quote(), error: null };
        const r = await call(`/${JOB}/cancel-preview`);
        expect(r.status).toBe(200);
        expect(rpcCalls.find(c => c.fn === 'cancellation_fee_quote')?.args).toEqual({ p_job: JOB, p_actor_role: 'customer' });
        expect(r.body).toMatchObject({ due: true, feeMinor: 400, currency: 'GBP', exponent: 2, policyVersion: 3, source: 'policy' });
        caller = DRIVER; rpcCalls.length = 0;
        await call(`/${JOB}/cancel-preview`);
        expect(rpcCalls.find(c => c.fn === 'cancellation_fee_quote')?.args.p_actor_role).toBe('driver');
    });

    it('preview: a non-participant gets 404; a quote failure is 500, never "free"', async () => {
        jobRow = cardJob(undefined);
        caller = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        expect((await call(`/${JOB}/cancel-preview`)).status).toBe(404);
        caller = CUSTOMER;
        quoteRpc = { data: null, error: { message: 'function does not exist' } };
        const r = await call(`/${JOB}/cancel-preview`);
        expect(r.status).toBe(500);
        expect(r.body.code).toBe('FEE_QUOTE_UNAVAILABLE');
    });

    it('normaliseCancellationFeeQuote: due only with a valid positive fee and a known exponent', () => {
        expect(normaliseCancellationFeeQuote(quote()).due).toBe(true);
        expect(normaliseCancellationFeeQuote(quote({ exponent: null })).due).toBe(false);
        expect(normaliseCancellationFeeQuote(quote({ feeMinor: -1 })).feeMinor).toBe(0);
        expect(normaliseCancellationFeeQuote(null)).toMatchObject({ due: false, reasonCode: 'quote_unavailable', feeMinor: 0 });
    });
});
