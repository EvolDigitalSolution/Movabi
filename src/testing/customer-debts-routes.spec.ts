import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DEBT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let receivables: Record<string, unknown>[] = [];
let debtRow: Record<string, unknown> | null = null;
let updateResult: Record<string, unknown> | null = null;
let openDebtMinor = 0;
let policy: Record<string, unknown> | null = null;
let jobRow: Record<string, unknown> | null = null;
let createdIntent: { params: Record<string, unknown>; opts: Record<string, unknown> } | null = null;

const chain = (result: () => unknown): any => ({
    select: () => ({
        eq: () => ({
            in: () => ({ order: async () => result() }),
            eq: () => ({
                eq: () => ({ select: () => ({ maybeSingle: async () => result() }) }),
                maybeSingle: async () => result()
            }),
            maybeSingle: async () => result()
        }),
        maybeSingle: async () => result()
    }),
    update: () => ({
        eq: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: updateResult, error: null }) }) }) }) })
    }),
    insert: () => ({ select: () => ({ single: async () => result() }) })
});

vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: {
        auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
        from: (table: string) => {
            if (table === 'profiles') return chain(() => ({ data: { account_status: 'active' }, error: null }));
            if (table === 'customer_receivables') return {
                select: () => ({
                    eq: () => ({
                        in: () => ({ order: async () => ({ data: receivables, error: null }) }),
                        eq: () => ({
                            eq: () => ({ maybeSingle: async () => ({ data: debtRow, error: null }) }),
                            maybeSingle: async () => ({ data: debtRow, error: null })
                        }),
                        maybeSingle: async () => ({ data: debtRow, error: null })
                    })
                }),
                update: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: updateResult, error: null }) }) }) }) }) })
            };
            if (table === 'jobs') return chain(() => ({ data: jobRow, error: null }));
            return chain(() => ({ data: null, error: null }));
        },
        rpc: async (fn: string, args: Record<string, unknown>) => {
            rpcCalls.push({ fn, args });
            if (fn === 'customer_open_debt_minor') return { data: openDebtMinor, error: null };
            if (fn === 'active_cancellation_policy') return { data: policy, error: null };
            return { data: null, error: null };
        }
    }
}));
let webhookEvent: Record<string, unknown> | null = null;
let receivablePaid: Record<string, unknown> | null = null;
let webhookRpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

vi.mock('stripe', () => {
    const constructEvent = () => webhookEvent;
    const FakeStripe = class { webhooks = { constructEvent }; paymentIntents = {}; };
    return { default: FakeStripe, Stripe: FakeStripe };
});
vi.mock('../../server/services/stripe.service', () => ({
    stripe: {
        paymentIntents: {
            create: async (params: Record<string, unknown>, opts: Record<string, unknown>) => {
                createdIntent = { params, opts };
                return { id: 'pi_debt_1', client_secret: 'cs_debt_1' };
            },
            retrieve: async () => ({ status: 'requires_capture' }),
            capture: async () => ({}),
            cancel: async () => ({})
        },
        webhooks: { constructEvent: () => webhookEvent }
    }
}));
// The webhook route instantiates its own client; stub createClient to drive
// stripe_events dedup + customer_receivables settlement.
vi.mock('@supabase/supabase-js', () => ({
    createClient: () => ({
        from: (table: string) => {
            if (table === 'stripe_events') return {
                select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
                insert: async () => ({ error: null }),
                upsert: async () => ({ error: null })
            };
            if (table === 'customer_receivables') return {
                update: (values: Record<string, unknown>) => {
                    receivablePaid = values;
                    return { eq: () => ({ in: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: DEBT_ID }, error: null }) }) }) }) };
                },
                select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) })
            };
            return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }), insert: async () => ({ error: null }), upsert: async () => ({ error: null }) };
        },
        rpc: async (fn: string, args: Record<string, unknown>) => {
            webhookRpcCalls.push({ fn, args });
            return { data: { status: 'settled' }, error: null };
        }
    })
}));
vi.mock('express-rate-limit', () => {
    const passthrough = () => (_r: any, _s: any, n: any) => n();
    return { rateLimit: passthrough, default: passthrough };
});
vi.mock('../../server/services/fraud.service', () => ({ FraudService: { trackCancellation: async () => {} } }));
vi.mock('../../server/services/dispatch.service', () => ({ DispatchService: {} }));
vi.mock('../../server/services/notification.service', () => ({ NotificationService: {} }));
vi.mock('../../server/services/logistics.service', () => ({ LogisticsService: { isValidBookingTransition: () => false } }));

import router from '../../server/routes/booking.routes';
import webhookRouter from '../../server/routes/stripe-webhook.routes';

async function call(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
        const app = express();
        app.use(express.json());
        app.use(router);
        const srv = app.listen(0, () => {
            const port = (srv.address() as any).port;
            fetch(`http://localhost:${port}${path}`, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
                body: body === undefined ? undefined : JSON.stringify(body)
            }).then(async (r) => { srv.close(); resolve({ status: r.status, body: await r.json().catch(() => ({})) }); });
        });
    });
}

describe('customer debts routes (real router)', () => {
    beforeEach(() => {
        rpcCalls.length = 0;
        receivables = []; debtRow = null; updateResult = null;
        openDebtMinor = 0; policy = null; jobRow = null; createdIntent = null;
    });

    it('GET /debts lists only the caller open+disputed receivables with a total', async () => {
        receivables = [{ id: DEBT_ID, amount_minor: 500, currency_code: 'GBP', reason: 'cancellation_fee', status: 'open' }];
        openDebtMinor = 500;
        const r = await call('/debts');
        expect(r.status).toBe(200);
        expect(r.body.debts).toHaveLength(1);
        expect(r.body.totalMinor).toBe(500);
        expect(rpcCalls.find(c => c.fn === 'customer_open_debt_minor')?.args.p_customer).toBe(USER);
    });

    it('POST /debts/:id/dispute rejects a short reason', async () => {
        const r = await call(`/debts/${DEBT_ID}/dispute`, 'POST', { reason: 'no' });
        expect(r.status).toBe(422);
    });

    it('POST /debts/:id/dispute records the dispute on the caller own open debt', async () => {
        updateResult = { id: DEBT_ID, status: 'disputed' };
        const r = await call(`/debts/${DEBT_ID}/dispute`, 'POST', { reason: 'I arrived and the driver never showed up' });
        expect(r.status).toBe(200);
        expect(r.body.dispute.status).toBe('disputed');
    });

    it('POST /debts/:id/repay creates a debt_repayment intent with a stable idempotency key', async () => {
        debtRow = { id: DEBT_ID, tenant_id: 't', customer_id: USER, currency_code: 'GBP', amount_minor: 500, reason: 'cancellation_fee', status: 'open' };
        const r = await call(`/debts/${DEBT_ID}/repay`, 'POST');
        expect(r.status).toBe(200);
        expect(r.body.clientSecret).toBe('cs_debt_1');
        expect(createdIntent?.params.amount).toBe(500);
        expect(createdIntent?.params.metadata?.purpose).toBe('debt_repayment');
        expect(createdIntent?.opts.idempotencyKey).toBe(`debt-repay:${DEBT_ID}`);
    });

    it('POST /debts/:id/repay rejects a debt that is not open for the caller', async () => {
        debtRow = null;
        const r = await call(`/debts/${DEBT_ID}/repay`, 'POST');
        expect(r.status).toBe(409);
        expect(createdIntent).toBeNull();
    });

    it('GET /:jobId/cancel-preview returns the job fee before policy fee', async () => {
        jobRow = { id: 'j1', customer_id: USER, driver_id: 'd1', tenant_id: 't', country_code: 'GB', currency_code: 'GBP', cancellation_fee: 5, price: 20, total_price: 20 };
        policy = { enabled: true, fee_minor: 750, grace_seconds: 300, version: 2 };
        const r = await call('/j1/cancel-preview');
        expect(r.status).toBe(200);
        expect(r.body.feeMinor).toBe(500);
        expect(r.body.source).toBe('booking');
        expect(r.body.policyVersion).toBe(2);
    });

    it('GET /:jobId/cancel-preview falls back to the enabled policy fee', async () => {
        jobRow = { id: 'j2', customer_id: USER, driver_id: null, tenant_id: 't', country_code: 'GB', currency_code: 'GBP', cancellation_fee: 0 };
        policy = { enabled: true, fee_minor: 750, fee_cap_minor: 600, grace_seconds: 300, version: 2 };
        const r = await call('/j2/cancel-preview');
        expect(r.body.feeMinor).toBe(600);
        expect(r.body.source).toBe('policy');
    });

    it('POST /create returns 409 OUTSTANDING_DEBT when open debt meets the enabled threshold', async () => {
        policy = { enabled: true, debt_threshold_minor: 1000, fee_minor: 0 };
        openDebtMinor = 1000;
        const r = await call('/create', 'POST', { booking: { tenant_id: 't', country_code: 'GB' } });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('OUTSTANDING_DEBT');
        expect(r.body.debtMinor).toBe(1000);
    });

    it('POST /create does not gate when no enabled policy sets a threshold', async () => {
        policy = null;
        openDebtMinor = 5000;
        const r = await call('/create', 'POST', { booking: { tenant_id: 't', country_code: 'GB' } });
        // The gate must not fire — a downstream check may still 409 for an
        // unrelated reason (e.g. missing quote), so assert on the code.
        expect(r.body.code).not.toBe('OUTSTANDING_DEBT');
    });
});

describe('debt_repayment webhook → restored eligibility', () => {
    beforeEach(() => {
        process.env.STRIPE_WEBHOOK_SECRET = 'wh_test';
        webhookEvent = {
            id: 'evt_debt_1', type: 'payment_intent.succeeded',
            data: { object: { id: 'pi_debt_1', amount: 500, currency: 'gbp', metadata: { purpose: 'debt_repayment', receivable_id: DEBT_ID, customer_id: USER } } }
        };
        receivablePaid = null;
        webhookRpcCalls.length = 0;
    });

    it('a verified succeeded intent settles compensation for the receivable', async () => {
        const res = await new Promise<{ status: number; body: any }>((resolve) => {
            const app = express();
            app.use(express.raw({ type: 'application/json' }));
            app.use(webhookRouter);
            const srv = app.listen(0, () => {
                const port = (srv.address() as any).port;
                fetch(`http://localhost:${port}/`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig' },
                    body: '{}'
                }).then(async (r) => { srv.close(); resolve({ status: r.status, body: await r.json().catch(() => ({})) }); });
            });
        });
        expect(res.status).toBe(200);
        const settle = webhookRpcCalls.find(c => c.fn === 'settle_cancellation_compensation');
        expect(settle).toBeDefined();
        expect(settle!.args.p_receivable).toBe(DEBT_ID);
        expect(settle!.args.p_collected_minor).toBe(500);
        expect(settle!.args.p_payment_reference).toBe('pi_debt_1');
    });

    it('booking eligibility is restored: the gate no longer blocks once debt is cleared', async () => {
        // After payment, customer_open_debt_minor drops below the threshold.
        policy = { enabled: true, debt_threshold_minor: 1000 };
        openDebtMinor = 0;
        const r = await call('/create', 'POST', { booking: { tenant_id: 't', country_code: 'GB' } });
        expect(r.body.code).not.toBe('OUTSTANDING_DEBT');
    });
});
