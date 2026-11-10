import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../server/services/supabase.service', () => {
    const data = { events: [] as any[], cancels: [] as any[], assigned: [] as any[] };
    const chain = (pick: (isCancel: boolean) => any[]) => {
        const c: any = {
            select: () => c,
            eq: (field: string, value: any) => {
                if (field === 'status' && value === 'cancelled') c._isCancel = true;
                return c;
            },
            gte: () => c,
            lte: () => c,
            _isCancel: false,
            then: (resolve: any) => Promise.resolve({ data: pick(c._isCancel), error: null }).then(resolve),
        };
        return c;
    };
    return {
        __data: data,
        supabaseAdmin: {
            from: (table: string) =>
                table === 'driver_offer_events'
                    ? chain(() => data.events)
                    : table === 'jobs'
                        ? chain((isCancel: boolean) => (isCancel ? data.cancels : data.assigned))
                        : chain(() => []),
        },
    };
});

import { reportDriverOfferMetrics } from '../../server/services/driver-offer-metrics.service';
const { __data } = await import('../../server/services/supabase.service') as any;

describe('reportDriverOfferMetrics', () => {
    beforeEach(() => { __data.events = []; __data.cancels = []; __data.assigned = []; });

    it('returns insufficient-data nulls below thresholds — never invents rates', async () => {
        const m = await reportDriverOfferMetrics('d1', 30);
        expect(m.acceptanceRate).toBeNull();
        expect(m.cancellationRate).toBeNull();
        expect(m.insufficientData).toEqual({ offers: true, cancellations: true });
    });

    it('denominator is authenticated acknowledgement only — delivery_attempted alone never counts', async () => {
        __data.events = [
            // 5 attempted but UNACKNOWLEDGED offers with 3 accepts → still insufficient
            ...Array.from({ length: 5 }, (_, i) => ({ event: 'created', job_id: `j${i}`, driver_id: 'd1' })),
            ...Array.from({ length: 5 }, (_, i) => ({ event: 'delivery_attempted', job_id: `j${i}`, driver_id: 'd1' })),
            ...Array.from({ length: 3 }, (_, i) => ({ event: 'accepted', job_id: `j${i}`, driver_id: 'd1' })),
        ];
        const m = await reportDriverOfferMetrics('d1', 30);
        expect(m.deliveredAttempts).toBe(5);
        expect(m.acknowledgedOffers).toBe(0);
        expect(m.acceptanceRate).toBeNull();
        expect(m.insufficientData.offers).toBe(true);
    });

    it('acceptance rate only over acknowledged offers; accepted implies ack via atomic close', async () => {
        __data.events = [
            ...Array.from({ length: 5 }, (_, i) => ({ event: 'created', job_id: `j${i}`, driver_id: 'd1' })),
            // accepted rows get an acknowledged row from close_driver_offer;
            // two declined offers acknowledged directly
            ...Array.from({ length: 5 }, (_, i) => ({ event: 'acknowledged', job_id: `j${i}`, driver_id: 'd1' })),
            ...Array.from({ length: 3 }, (_, i) => ({ event: 'accepted', job_id: `j${i}`, driver_id: 'd1' })),
            ...Array.from({ length: 2 }, (_, i) => ({ event: 'declined', job_id: `j${i + 3}`, driver_id: 'd1' })),
        ];
        const m = await reportDriverOfferMetrics('d1', 30);
        expect(m.acknowledgedOffers).toBe(5);
        expect(m.acceptanceRate).toBeCloseTo(0.6);
    });

    it('counts only driver-attributable cancellations via canonical metadata reason', async () => {
        __data.assigned = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }];
        __data.cancels = [
            { id: 'c1', metadata: { cancellation_reason: 'Driver cancelled' }, driver_id: 'd1' },
            { id: 'c2', metadata: { cancellation_reason: 'Customer changed plans' }, driver_id: 'd1' }, // excluded
            { id: 'c3', metadata: {}, driver_id: 'd1' }, // no reason → excluded
        ];
        const m = await reportDriverOfferMetrics('d1', 30);
        expect(m.driverCancellations).toBe(1);
        expect(m.cancellationRate).toBeCloseTo(1 / 3);
    });
});
