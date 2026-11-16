import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
const state = vi.hoisted(() => ({ country: 'GB', profile: { tenant_id: 'native-gb', role: 'customer', registration_country_code: '', country_code: 'GB' },
    owner: '', getUser: vi.fn(), quote: vi.fn() }));
vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: { auth: { getUser: state.getUser }, from: (table: string) => {
    const q: any = { select: () => q, eq: (key: string, id: string) => { if (table === 'profiles' && key === 'id') state.owner = id; return q; },
        order: () => q, limit: () => q, maybeSingle: async () => ({ data: table === 'profiles' ? state.profile : { value: { markets: { GB: { enabled: true } } } }, error: null }) }; return q;
} } }));
vi.mock('../../server/services/city.service', () => ({ CityService: { findCityForLocation: async () => ({ name: 'Test', country_code: state.country }) } }));
vi.mock('../../server/services/dispatch.service', () => ({ dispatchService: { getAreaStats: async () => ({ demand: 10, supply: 1 }) } }));
vi.mock('../../server/services/global-ai-pricing.service', () => ({ GlobalAiPricingService: { resolveQuote: state.quote } }));
vi.mock('../../server/services/map-quote-context', () => ({ mapQuoteContext: async () => null }));
vi.mock('../../server/services/market-availability.service', () => ({ MarketAvailabilityError: class extends Error {}, MarketAvailabilityService: {
    resolveServiceCountryCode: () => state.country, requireCapability: async () => ({ countryCode: state.country, currency: state.country === 'GB' ? 'GBP' : 'NGN', marketCity: 'Test' }) } }));
vi.mock('../../server/services/no-show.service', () => ({ NoShowService: { getEnabledConfig: async () => ({ noShowEnabled: false }) } }));
import router from '../../server/routes/global-ai-pricing.routes';
beforeEach(() => {
    vi.clearAllMocks(); state.country = 'GB'; state.owner = '';
    state.profile = { tenant_id: 'native-gb', role: 'customer', registration_country_code: '', country_code: 'GB' };
    state.getUser.mockResolvedValue({ data: { user: { id: 'signed-customer' } }, error: null });
    state.quote.mockResolvedValue({ legacyPricing: { totalPrice: 10, currencyCode: 'GBP', source: 'pricing_config', fareBreakdown: {} },
        quote: { market: { countryCode: state.country, currency: 'GBP' }, price: { totalMinor: 1000 } } });
});
async function post(body: any, token?: string, authority = false) {
    const previous = process.env.VAYDU_MAP_QUOTE_AUTHORITY_V23;
    process.env.VAYDU_MAP_QUOTE_AUTHORITY_V23 = authority ? 'true' : 'false';
    const app = express(); app.use(express.json()); app.use(router);
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise<void>(resolve => server.once('listening', resolve));
        const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/quote`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ lat: 53.55, lng: -2.42, distanceKm: 5.18, durationMinutes: 10.46, serviceSlug: 'ride', ...body }) });
        return { status: r.status, body: await r.json() };
    } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        if (previous === undefined) delete process.env.VAYDU_MAP_QUOTE_AUTHORITY_V23; else process.env.VAYDU_MAP_QUOTE_AUTHORITY_V23 = previous;
    }
}
describe('actual booking quote handler wires the signed-in GB tenant', () => {
    it('the real client shape has no tenantId; the native profile tenant reaches the quote engine', async () => {
        expect((await post({}, 'valid')).status).toBe(200);
        expect(state.quote).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'native-gb', countryCode: 'GB' }));
        expect(state.owner).toBe('signed-customer');
    });
    it('client tenant and authenticatedUserId cannot replace the server-verified identity', async () => {
        expect((await post({ tenantId: 'victim', authenticatedUserId: 'victim' }, 'valid')).status).toBe(200);
        expect(state.quote).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'native-gb' })); expect(state.owner).toBe('signed-customer');
    });
    it('map-authority authentication remains required and is reused without a second auth call', async () => {
        expect((await post({}, undefined, true)).status).toBe(401);
        expect((await post({}, 'valid', true)).status).toBe(200); expect(state.getUser).toHaveBeenCalledTimes(1);
    });
    it('foreign country keeps the existing input tenant and no new profile lookup', async () => {
        state.country = 'NG';
        expect((await post({ tenantId: 'ng-legacy' }, 'valid')).status).toBe(200);
        expect(state.quote).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'ng-legacy', countryCode: 'NG' }));
        expect(state.getUser).not.toHaveBeenCalled(); expect(state.owner).toBe('');
    });
});
