import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

let insertedReferral: Record<string, unknown> | null = null;
let campaignRow: Record<string, unknown> | null = null;
let authUserId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: {
        auth: { getUser: async () => ({ data: { user: { id: authUserId } }, error: null }) },
        from: (table: string) => {
            if (table === 'profiles') return {
                select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { account_status: 'active' }, error: null }) }) })
            };
            if (table === 'campaigns') return {
                select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: campaignRow, error: null }) }) }) })
            };
            if (table === 'referrals') return {
                insert: (row: Record<string, unknown>) => { insertedReferral = row; return { select: () => ({ single: async () => ({ data: { id: 'r1', status: 'pending' }, error: null }) }) }; }
            };
            return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }), insert: async () => ({ error: null }), update: async () => ({ error: null }) };
        },
        rpc: async () => ({ data: null, error: null })
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

async function call(path: string, method = 'POST', body?: unknown): Promise<{ status: number; body: any }> {
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

describe('referral acceptance (real router)', () => {
    beforeEach(() => {
        insertedReferral = null;
        campaignRow = { id: 'c1', tenant_id: 't1', enabled: true, paused: false, kind: 'referral', referral_reward_bps: 700 };
    });

    it('new referral freezes the campaign referral_reward_bps at link time', async () => {
        const r = await call('/referrals/redeem', 'POST', { code: 'REF', referrerId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
        expect(r.status).toBe(201);
        expect(insertedReferral).toBeTruthy();
        expect(insertedReferral!.reward_rate_bps).toBe(700); // not the 500 default
        expect(insertedReferral!.status).toBe('pending');
    });

    it('a paused referral campaign rejects new applications', async () => {
        campaignRow = { id: 'c1', tenant_id: 't1', enabled: true, paused: true, kind: 'referral', referral_reward_bps: 700 };
        const r = await call('/referrals/redeem', 'POST', { code: 'REF', referrerId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('CAMPAIGN_UNAVAILABLE');
        expect(insertedReferral).toBeNull();
    });

    it('a disabled referral campaign rejects new applications', async () => {
        campaignRow = { id: 'c1', tenant_id: 't1', enabled: false, paused: false, kind: 'referral', referral_reward_bps: 700 };
        const r = await call('/referrals/redeem', 'POST', { code: 'REF', referrerId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
        expect(r.status).toBe(404);
        expect(insertedReferral).toBeNull();
    });
});
