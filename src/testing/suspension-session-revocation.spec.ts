import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

// Token -> user identity, and each user's live account_status. The middleware
// re-reads account_status on every call, so flipping it revokes the same token.
const tokenToUser: Record<string, string> = { 'tok-a': 'user-a', 'tok-b': 'user-b' };
const accountStatus: Record<string, string> = { 'user-a': 'active', 'user-b': 'active' };

vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: {
        auth: {
            getUser: async (token: string) => {
                const id = tokenToUser[token];
                return id ? { data: { user: { id } }, error: null } : { data: null, error: { message: 'invalid token' } };
            }
        },
        from: (table: string) => {
            if (table === 'profiles') return {
                select: () => ({ eq: (_col: string, val: string) => ({ maybeSingle: async () => ({ data: { account_status: accountStatus[String(val)] ?? 'active' }, error: null }) }) })
            };
            if (table === 'customer_receivables') return {
                select: () => ({ eq: () => ({ in: () => ({ order: async () => ({ data: [], error: null }) }) }) })
            };
            return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
        },
        rpc: async () => ({ data: 0, error: null })
    }
}));
vi.mock('../../server/services/stripe.service', () => ({ stripe: { paymentIntents: { create: async () => ({ id: 'pi_1', client_secret: 'cs_1' }), retrieve: async () => ({ status: 'requires_capture' }), capture: async () => ({}), cancel: async () => ({}) }, webhooks: { constructEvent: () => ({}) } } }));
vi.mock('express-rate-limit', () => {
    const passthrough = () => (_r: any, _s: any, n: any) => n();
    return { rateLimit: passthrough, default: passthrough };
});
vi.mock('../../server/services/fraud.service', () => ({ FraudService: { trackCancellation: async () => {} } }));
vi.mock('../../server/services/dispatch.service', () => ({ DispatchService: {} }));
vi.mock('../../server/services/notification.service', () => ({ NotificationService: {} }));
vi.mock('../../server/services/logistics.service', () => ({ LogisticsService: { isValidBookingTransition: () => false } }));

import router from '../../server/routes/booking.routes';

async function get(path: string, token: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
        const app = express();
        app.use(express.json());
        app.use(router);
        const srv = app.listen(0, () => {
            const port = (srv.address() as any).port;
            fetch(`http://localhost:${port}${path}`, { headers: { Authorization: `Bearer ${token}` } })
                .then(async (r) => { srv.close(); resolve({ status: r.status, body: await r.json().catch(() => ({})) }); });
        });
    });
}

describe('suspension / session revocation through a protected HTTP path', () => {
    beforeEach(() => { accountStatus['user-a'] = 'active'; accountStatus['user-b'] = 'active'; });

    it('access succeeds before suspension', async () => {
        const r = await get('/debts', 'tok-a');
        expect(r.status).toBe(200);
        expect(r.body.debts).toEqual([]);
    });

    it('the same issued token is denied after suspension', async () => {
        accountStatus['user-a'] = 'suspended';
        const r = await get('/debts', 'tok-a'); // same Bearer token
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('a different active user is unaffected by the suspension', async () => {
        accountStatus['user-a'] = 'suspended';
        const r = await get('/debts', 'tok-b');
        expect(r.status).toBe(200);
        expect(r.body.debts).toEqual([]);
    });

    it('an invalid token is rejected regardless', async () => {
        const r = await get('/debts', 'unknown-token');
        expect(r.status).toBe(401);
    });
});
