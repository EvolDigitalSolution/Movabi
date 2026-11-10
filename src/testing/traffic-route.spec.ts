import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

// Mutable traffic provider state + jobs state.
const trafficState = vi.hoisted(() => ({ congestionRatio: 1.0 as number | null, throwProvider: false }));
const jobState = vi.hoisted(() => ({ id: 'job-1', customer_id: 'user-a', driver_id: null, pickup_lat: 0, pickup_lng: 0, dropoff_lat: 0.01, dropoff_lng: 0.01, agreed_fare: 12.5, price: 12.5 }));
const writes = vi.hoisted(() => ({ jobs: 0 }));

vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: {
        auth: { getUser: async () => ({ data: { user: { id: 'user-a' } }, error: null }) },
        from: (table: string) => {
            if (table === 'jobs') return {
                select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: jobState, error: null }) }) }),
                update: () => { writes.jobs += 1; return { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }; },
                insert: () => { writes.jobs += 1; return { select: () => ({ single: async () => ({ data: null, error: null }) }) }; }
            };
            return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
        }
    }
}));
vi.mock('../../server/services/maps-v23', () => ({
    mapsV23: { route: async () => { if (trafficState.throwProvider) throw new Error('tomtom unavailable'); return { congestionRatio: trafficState.congestionRatio }; } }
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

async function getTraffic(times = 1): Promise<Array<{ status: number; body: any }>> {
    const results: Array<{ status: number; body: any }> = [];
    for (let i = 0; i < times; i++) {
        results.push(await new Promise((resolve) => {
            const app = express();
            app.use(express.json());
            app.use(router);
            const srv = app.listen(0, () => {
                const port = (srv.address() as any).port;
                fetch(`http://localhost:${port}/job-1/traffic`, { headers: { Authorization: 'Bearer tok' } })
                    .then(async (r) => { srv.close(); resolve({ status: r.status, body: await r.json().catch(() => ({})) }); });
            });
        }));
    }
    return results;
}

describe('traffic route (real router)', () => {
    beforeEach(() => {
        trafficState.congestionRatio = 1.0;
        trafficState.throwProvider = false;
        writes.jobs = 0;
        jobState.agreed_fare = 12.5;
        jobState.price = 12.5;
    });

    it('returns a green level with an observation timestamp', async () => {
        const [r] = await getTraffic(1);
        expect(r.status).toBe(200);
        expect(r.body.level).toBe('green');
        expect(r.body.ratio).toBe(1.0);
        expect(typeof r.body.observedAt).toBe('string');
        expect(Math.abs(Date.now() - Date.parse(r.body.observedAt))).toBeLessThan(5000);
    });

    it('classifies amber and red thresholds', async () => {
        trafficState.congestionRatio = 1.2;
        expect((await getTraffic(1))[0].body.level).toBe('amber');
        trafficState.congestionRatio = 1.5;
        expect((await getTraffic(1))[0].body.level).toBe('red');
    });

    it('returns an explicit unavailable state when congestion data is absent', async () => {
        trafficState.congestionRatio = null;
        const [r] = await getTraffic(1);
        expect(r.status).toBe(200);
        expect(r.body.level).toBe('unavailable');
        expect(r.body.ratio).toBeNull();
        expect(r.body.text).toContain('temporarily unavailable');
        expect(typeof r.body.observedAt).toBe('string');
    });

    it('returns an explicit unavailable state when the provider fails', async () => {
        trafficState.throwProvider = true;
        const [r] = await getTraffic(1);
        expect(r.status).toBe(200);
        expect(r.body.level).toBe('unavailable');
        expect(r.body.ratio).toBeNull();
        expect(r.body.text).toContain('temporarily unavailable');
    });

    it('repeated traffic refreshes do not alter the frozen accepted fare', async () => {
        const before = jobState.agreed_fare;
        const results = await getTraffic(3);
        expect(results.every(r => r.status === 200)).toBe(true);
        expect(jobState.agreed_fare).toBe(before);       // fare untouched
        expect(jobState.price).toBe(12.5);
        expect(writes.jobs).toBe(0);                     // no write, no duplicate delay charge
        expect(results[0].body.delayCharge).toBeUndefined();
    });
});
