import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

/**
 * 7a (2026-11-14): /campaigns/apply converted nothing: protected_fare_snapshot.driverBase is MAJOR units
 * (12.50 GBP) but was sent to apply_campaign_discount as p_fare_minor (12), so every minimum-fare check
 * failed and discounts were 100x too small. It now converts with the currency exponent and refuses a
 * campaign used outside its own tenant, market or currency.
 */
const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
let quote: Record<string, unknown> | null = null;
let campaign: Record<string, unknown> | null = null;
let profileTenant = 't1';
let rpcArgs: any = null;

vi.mock('../../server/services/supabase.service', () => ({
    supabaseAdmin: {
        auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
        from: (table: string) => {
            const one = (data: unknown) => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }), maybeSingle: async () => ({ data, error: null }) }) });
            if (table === 'quote_market_adjustments') return { select: () => one(quote) };
            if (table === 'campaigns') return { select: () => one(campaign) };
            if (table === 'profiles') return { select: () => one({ account_status: 'active', tenant_id: profileTenant }) };
            return { select: () => one(null) };
        },
        rpc: async (fn: string, args: any) => { if (fn === 'apply_campaign_discount') { rpcArgs = args; return { data: { discount_minor: Math.min(500, Math.floor(args.p_fare_minor * 5 / 100)) }, error: null }; } return { data: null, error: null }; }
    }
}));
vi.mock('../../server/services/stripe.service', () => ({ stripe: { paymentIntents: {}, webhooks: { constructEvent: () => ({}) } } }));
vi.mock('express-rate-limit', () => { const p = () => (_r: any, _s: any, n: any) => n(); return { rateLimit: p, default: p }; });
vi.mock('../../server/services/fraud.service', () => ({ FraudService: { trackCancellation: async () => {} } }));
vi.mock('../../server/services/dispatch.service', () => ({ DispatchService: {} }));
vi.mock('../../server/services/notification.service', () => ({ NotificationService: {} }));
vi.mock('../../server/services/logistics.service', () => ({ LogisticsService: { isValidBookingTransition: () => false } }));

import router from '../../server/routes/booking.routes';

async function apply(): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
        const app = express(); app.use(express.json()); app.use(router);
        const srv = app.listen(0, () => {
            fetch(`http://localhost:${(srv.address() as any).port}/campaigns/apply`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
                body: JSON.stringify({ code: 'FIRST5', quoteReference: 'q1' })
            }).then(async (r) => { srv.close(); resolve({ status: r.status, body: await r.json().catch(() => ({})) }); });
        });
    });
}

describe('first-booking promotion: minor units and market isolation', () => {
    beforeEach(() => {
        rpcArgs = null; profileTenant = 't1';
        quote = { quote_reference: 'q1', customer_id: USER, country_code: 'GB', currency: 'GBP', protected_fare_snapshot: { driverBase: 12.5, currency: 'GBP' } };
        campaign = { id: 'c1', tenant_id: 't1', enabled: true, kind: 'customer_discount', market_code: 'GB', currency_code: 'GBP' };
    });

    it('a 12.50 GBP quote is sent as 1250 minor units (5% = 62)', async () => {
        const r = await apply();
        expect(r.status).toBe(200);
        expect(rpcArgs.p_fare_minor).toBe(1250);
        expect(r.body.discountMinor).toBe(62);
    });
    it('zero-decimal currency: 1500 JPY stays 1500', async () => {
        quote = { ...quote, country_code: 'JP', currency: 'JPY', protected_fare_snapshot: { driverBase: 1500 } };
        campaign = { ...campaign, market_code: 'JP', currency_code: 'JPY' };
        expect((await apply()).status).toBe(200);
        expect(rpcArgs.p_fare_minor).toBe(1500);
    });
    it('a GB campaign is refused on an NG quote (market isolation)', async () => {
        quote = { ...quote, country_code: 'NG', currency: 'NGN' };
        const r = await apply();
        expect(r.status).toBe(404);
        expect(rpcArgs).toBeNull();
    });
    it('a campaign of another tenant is refused', async () => {
        profileTenant = 't2';
        expect((await apply()).status).toBe(404);
        expect(rpcArgs).toBeNull();
    });
    it('a quote without a currency is refused (no guessing)', async () => {
        quote = { ...quote, currency: null, protected_fare_snapshot: { driverBase: 12.5 } };
        expect((await apply()).status).toBe(404);
        expect(rpcArgs).toBeNull();
    });
});
