import { describe, it, expect, vi, beforeEach } from 'vitest';

// The counts themselves are computed in SQL (driver_offer_metrics_v2) and verified against recorded
// events on real PostgreSQL: bash scripts/driver-metrics/run-realdb-tests.sh. This spec covers the
// service's mapping, thresholds and fail-closed handling.
vi.mock('../../server/services/supabase.service', () => {
    const state = { result: { data: null as any, error: null as any }, calls: [] as any[] };
    return {
        __state: state,
        supabaseAdmin: {
            rpc: async (fn: string, args: any) => { state.calls.push({ fn, args }); return state.result; },
            from: () => { throw new Error('metrics must not read tables directly (row limits)'); },
        },
    };
});

import { reportDriverOfferMetrics } from '../../server/services/driver-offer-metrics.service';
const { __state } = await import('../../server/services/supabase.service') as any;

const counts = (over: Record<string, number> = {}) => ({
    acknowledgedOffers: 0, deliveredAttempts: 0, acceptedOffers: 0, declinedOffers: 0, expiredOffers: 0,
    acceptedBookings: 0, driverCancelledBookings: 0, driverHandoffs: 0, unattributedCancellations: 0,
    customerCancellations: 0, adminCancellations: 0, otherDriverCancellations: 0, customerNoShows: 0, ...over,
});

describe('reportDriverOfferMetrics (policy D9: driver-initiated only)', () => {
    beforeEach(() => { __state.calls = []; __state.result = { data: counts(), error: null }; });

    it('asks the database for this driver over the period', async () => {
        const before = Date.now();
        await reportDriverOfferMetrics('d1', 30);
        expect(__state.calls).toHaveLength(1);
        expect(__state.calls[0].fn).toBe('driver_offer_metrics_v2');
        expect(__state.calls[0].args.p_driver).toBe('d1');
        const since = Date.parse(__state.calls[0].args.p_since);
        expect(Math.abs(since - (before - 30 * 86400_000))).toBeLessThan(5_000);
    });

    it('returns insufficient-data nulls below thresholds — never invents rates', async () => {
        __state.result.data = counts({ acknowledgedOffers: 4, acceptedOffers: 4, acceptedBookings: 2, driverCancelledBookings: 1 });
        const m = await reportDriverOfferMetrics('d1', 30);
        expect(m.acceptanceRate).toBeNull();
        expect(m.cancellationRate).toBeNull();
        expect(m.insufficientData).toEqual({ offers: true, cancellations: true });
    });

    it('acceptance rate = accepted / acknowledged offers', async () => {
        __state.result.data = counts({ acknowledgedOffers: 5, acceptedOffers: 3, declinedOffers: 2, deliveredAttempts: 9 });
        const m = await reportDriverOfferMetrics('d1', 30);
        expect(m.acceptanceRate).toBeCloseTo(0.6);
        expect(m.deliveredAttempts).toBe(9);
    });

    it('cancellation rate = (driver-cancelled bookings + handoffs) / accepted assignments; exclusions and unattributed never count', async () => {
        __state.result.data = counts({ acceptedBookings: 12, driverCancelledBookings: 1, driverHandoffs: 1, unattributedCancellations: 2,
            customerCancellations: 3, adminCancellations: 1, otherDriverCancellations: 1, customerNoShows: 1 });
        const m = await reportDriverOfferMetrics('d1', 30);
        expect(m.driverCancellations).toBe(2);
        expect(m.driverCancelledBookings).toBe(1);
        expect(m.driverHandoffs).toBe(1);
        expect(m.unattributedCancellations).toBe(2);
        expect(m.excludedCancellations).toEqual({ customer: 3, admin: 1, otherDriver: 1, customerNoShow: 1 });
        expect(m.cancellationRate).toBeCloseTo(2 / 12);
    });

    it('fails closed if the classes exceed the accepted assignments (identity/window mismatch)', async () => {
        __state.result.data = counts({ acceptedBookings: 2, driverCancelledBookings: 2, customerCancellations: 1 });
        await expect(reportDriverOfferMetrics('d1', 30)).rejects.toThrow('exceed accepted assignments');
    });

    it('fails closed on a database error or a malformed count', async () => {
        __state.result = { data: null, error: new Error('rpc failed') };
        await expect(reportDriverOfferMetrics('d1', 30)).rejects.toThrow('rpc failed');
        __state.result = { data: counts({ acceptedBookings: -1 }), error: null };
        await expect(reportDriverOfferMetrics('d1', 30)).rejects.toThrow('invalid count');
        __state.result = { data: { ...counts(), acceptedOffers: 'x' }, error: null };
        await expect(reportDriverOfferMetrics('d1', 30)).rejects.toThrow('invalid count');
    });
});
