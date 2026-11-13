import { describe, expect, it, vi } from 'vitest';
vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: {} }));
vi.mock('../../server/services/stripe.service', () => ({ stripe: {} }));
import { evaluateMarketReadiness, FAILED, MarketReadinessInput, reportMarketReadiness } from '../../server/services/market-readiness.service';

/** Area 8: collection, payout and cash-ride readiness are separate states (2026-11-13). */
const gbRows = [
  { country_code: 'GB', market_city: 'London', zone_id: null, supported_currency: 'GBP', enabled: true, payment_enabled: true, booking_enabled: true, driver_online_enabled: true },
  { country_code: 'GB', market_city: null, zone_id: null, supported_currency: 'GBP', enabled: true, payment_enabled: true, booking_enabled: true, driver_online_enabled: true },
];
const ngRows = [{ country_code: 'NG', market_city: null, zone_id: null, supported_currency: 'NGN', enabled: true, payment_enabled: true, booking_enabled: true, driver_online_enabled: true }];
const base = (over: Partial<MarketReadinessInput> = {}): MarketReadinessInput => ({
  tenantId: 't1', market: 'GB', service: 'ride', marketRows: gbRows, pricingCount: 1, drivers: { total: 3, eligible: 2 },
  cardRoute: null, payoutRow: null, cashMarketEnabled: false, ...over,
});
const devEnv = { VAYDU_DRIVER_TOPUP_API: 'true' }; // develop today: no routing, no cash flag, no payout sandbox

describe('market readiness: separate capability states', () => {
  it('GB on develop today: collection and payout ready (Stripe), cash ride blocked by its own gates', () => {
    const r = evaluateMarketReadiness(base(), devEnv);
    expect(r.collection).toEqual({ state: 'ready', provider: 'stripe', reasons: [] });
    expect(r.payout).toEqual({ state: 'ready', provider: 'stripe', reasons: [] });
    expect(r.cash_ride).toEqual({ state: 'blocked', provider: null, reasons: ['cash_ride_flag_off', 'cash_market_not_enabled'] });
    expect(r.ready).toMatchObject({ quote: true, booking: true, collection: true, payout: true, cash_ride: false });
    expect(r.blocked_reasons).toEqual(['cash_ride:cash_ride_flag_off', 'cash_ride:cash_market_not_enabled']);
    expect(r.market_rows).toBe(2);
    expect(r.currency_code).toBe('GBP');
  });

  it('enabling cash in one market never makes collection or payout ready elsewhere (NG stays blocked)', () => {
    const env = { ...devEnv, VAYDU_CASH_RIDE_BOOKING: 'true' };
    const gb = evaluateMarketReadiness(base({ cashMarketEnabled: true }), env);
    expect(gb.cash_ride.state).toBe('ready');
    const ng = evaluateMarketReadiness(base({ market: 'NG', marketRows: ngRows, cashMarketEnabled: false, payoutRow: { provider: 'flutterwave', enabled: false } }), env);
    expect(ng.collection).toEqual({ state: 'blocked', provider: null, reasons: ['legacy_checkout_gb_gbp_only'] });
    expect(ng.payout).toEqual({ state: 'blocked', provider: 'flutterwave', reasons: ['payout_market_disabled', 'payout_runtime_disabled'] });
    expect(ng.cash_ride).toEqual({ state: 'blocked', provider: null, reasons: ['cash_market_not_enabled'] });
  });

  it('cash is rides only (courier cash off everywhere)', () => {
    const r = evaluateMarketReadiness(base({ service: 'delivery', cashMarketEnabled: true }), { VAYDU_CASH_RIDE_BOOKING: 'true' });
    expect(r.cash_ride).toEqual({ state: 'blocked', provider: null, reasons: ['cash_rides_only'] });
  });

  it('database routing on: collection follows the card route row, each missing approval is named', () => {
    const env = { VAYDU_DATABASE_PAYMENT_ROUTING_V23: 'true' };
    expect(evaluateMarketReadiness(base({ cardRoute: null }), env).collection.reasons).toEqual(['no_card_route']);
    expect(evaluateMarketReadiness(base({ cardRoute: { provider: 'stripe', enabled: false, merchant_approved: false, adapter_ready: true, capabilities: ['authorise'] } }), env).collection)
      .toEqual({ state: 'blocked', provider: 'stripe', reasons: ['card_route_disabled', 'merchant_not_approved', 'route_cannot_collect'] });
    expect(evaluateMarketReadiness(base({ cardRoute: { provider: 'stripe', enabled: true, merchant_approved: true, adapter_ready: true, capabilities: ['authorise', 'capture'] } }), env).collection)
      .toEqual({ state: 'ready', provider: 'stripe', reasons: [] });
  });

  it('a market with payments switched off is not collection-ready even on the legacy GB path', () => {
    const rows = gbRows.map((r) => ({ ...r, payment_enabled: false }));
    expect(evaluateMarketReadiness(base({ marketRows: rows }), devEnv).collection.reasons).toEqual(['market_payment_disabled']);
  });

  it('a non-Stripe payout market needs both the enabled row and the sandbox runtime', () => {
    const ng = (payoutRow: any, env: any) => evaluateMarketReadiness(base({ market: 'NG', marketRows: ngRows, payoutRow }), env).payout;
    expect(ng(null, {}).reasons).toEqual(['no_payout_market']);
    expect(ng({ provider: 'flutterwave', enabled: true }, {}).reasons).toEqual(['payout_runtime_disabled']);
    expect(ng({ provider: 'flutterwave', enabled: true }, { VAYDU_DRIVER_PAYOUT_SANDBOX: 'true' }).state).toBe('ready');
  });

  it('failed reads are unknown, never ready', () => {
    const r = evaluateMarketReadiness(base({ market: 'NG', marketRows: ngRows, payoutRow: FAILED, cashMarketEnabled: FAILED, drivers: FAILED, pricingCount: FAILED }), { VAYDU_CASH_RIDE_BOOKING: 'true' });
    expect(r.payout).toEqual({ state: 'unknown', provider: null, reasons: ['payout_market_read_failed'] });
    expect(r.cash_ride).toEqual({ state: 'unknown', provider: null, reasons: ['cash_market_read_failed'] });
    expect(r.blocked_reasons).toEqual(expect.arrayContaining(['pricing_read_failed', 'drivers_read_failed']));
    expect(r.ready.quote).toBe(false);
    const routed = evaluateMarketReadiness(base({ cardRoute: FAILED }), { VAYDU_GLOBAL_PAYMENT_ROUTING_V23: 'true' });
    expect(routed.collection.state).toBe('unknown');
    const noMarket = evaluateMarketReadiness(base({ marketRows: FAILED }), devEnv);
    expect([noMarket.collection.state, noMarket.payout.state, noMarket.cash_ride.state]).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('an unknown market is blocked in every capability', () => {
    const r = evaluateMarketReadiness(base({ market: 'KE', marketRows: [] }), devEnv);
    expect(r.blocked_reasons).toContain('no_market_row');
    expect([r.collection.state, r.payout.state, r.cash_ride.state]).toEqual(['blocked', 'blocked', 'blocked']);
  });
});

describe('market readiness loader', () => {
  /** Minimal PostgREST-shaped fake that records filters, to prove tenant scoping and failure handling. */
  function fakeDb(tables: Record<string, { data?: any; count?: number; error?: any }>, rpc: { data?: any; error?: any }) {
    const calls: Array<{ table: string; filters: Array<[string, string, any]> }> = [];
    const builder = (table: string) => {
      const filters: Array<[string, string, any]> = []; calls.push({ table, filters });
      const q: any = {
        select: () => q, order: () => q, limit: () => q,
        eq: (c: string, v: any) => (filters.push(['eq', c, v]), q),
        not: (c: string, op: string, v: any) => (filters.push(['not', c, v]), q),
        then: (ok: any, ko: any) => Promise.resolve(tables[table] ?? { data: [], count: 0 }).then(ok, ko),
      };
      return q;
    };
    return { calls, db: { from: builder, rpc: () => Promise.resolve(rpc) } };
  }

  it('scopes driver counts to the tenant and the market', async () => {
    const { db, calls } = fakeDb({ market_availability: { data: gbRows }, market_pricing_strategies: { count: 1 }, profiles: { count: 2 } }, { data: false });
    const r = await reportMarketReadiness('tenant-a', 'gb', 'ride', db, devEnv);
    const profileCalls = calls.filter((c) => c.table === 'profiles');
    expect(profileCalls).toHaveLength(2);
    for (const c of profileCalls) expect(c.filters).toEqual(expect.arrayContaining([['eq', 'tenant_id', 'tenant-a'], ['eq', 'registration_country_code', 'GB'], ['eq', 'role', 'driver']]));
    expect(r.drivers).toEqual({ total: 2, eligible: 2 });
    expect(r.collection.state).toBe('ready');
  });

  it('a database error is reported as unknown, not as "not configured"', async () => {
    const { db } = fakeDb({ market_availability: { data: ngRows }, market_pricing_strategies: { count: 1 }, profiles: { count: 1 }, driver_payout_markets: { error: { message: 'boom' } } }, { error: { message: 'boom' } });
    const r = await reportMarketReadiness('t', 'NG', 'ride', db, { VAYDU_CASH_RIDE_BOOKING: 'true' });
    expect(r.payout.state).toBe('unknown');
    expect(r.cash_ride.state).toBe('unknown');
  });
});
