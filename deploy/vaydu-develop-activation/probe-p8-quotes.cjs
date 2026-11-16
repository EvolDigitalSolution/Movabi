// Inside the installed develop API: no calculator/resolver stubs. Quotes can write normal audits.
require('/app/node_modules/ts-node').register({ project: '/app/server/tsconfig.json', transpileOnly: true });
const assert = require('node:assert/strict');
const { supabaseAdmin: db } = require('/app/server/services/supabase.service');
const { MarketplaceConfigService: config } = require('/app/server/services/marketplace-config.service');
const { PricingService: pricing } = require('/app/server/services/pricing.service');
const { GlobalAiPricingService: ai } = require('/app/server/services/global-ai-pricing.service');
const { resolveMarketPricingStrategy, getMarketPricingSettings } = require('/app/server/services/market-pricing.service');
const marketOf = p => String(p.registration_country_code?.trim() || p.country_code?.trim() || '').toUpperCase();
async function read(table, columns = '*') {
  const r = await db.from(table).select(columns);
  if (r.error) throw new Error('Inventory failed: ' + table);
  return r.data;
}
(async () => {
  const phase = process.env.P8_PHASE;
  const at = process.env.P8_AT;
  assert(['before', 'after'].includes(phase) && at && Number.isFinite(Date.parse(at)), 'P8_PHASE/P8_AT required');
  const [profiles, rows, strategies, aiMarkets, intelligence] = await Promise.all([
    read('profiles', 'id,role,tenant_id,registration_country_code,country_code'), read('pricing_config'),
    read('market_pricing_strategies'), read('pricing_markets'), getMarketPricingSettings()]);
  const gb = profiles.filter(p => p.tenant_id && ['customer', 'driver'].includes(p.role) && marketOf(p) === 'GB');
  assert(gb.some(p => p.role === 'customer') && gb.some(p => p.role === 'driver'), 'GB customer and driver must be recognised');
  assert.equal(intelligence.shadowMode, true, 'Market intelligence must stay in shadow mode');
  assert(aiMarkets.filter(m => m.country_code === 'GB').every(m => m.shadow_mode_enabled), 'GB AI must remain shadowed');
  const tenants = [...new Set(gb.map(p => p.tenant_id))].sort();
  if (phase === 'after') {
    const { resolveGbQuoteTenant } = require('/app/server/services/gb-quote-tenant');
    for (const p of gb) assert.equal(await resolveGbQuoteTenant({ countryCode: 'GB', authenticatedUserId: p.id }, db), p.tenant_id,
      'installed GB session/profile binding must use the same activated native tenant');
    console.log('P8_GB_SESSION_TENANT_BINDING_OK');
  }
  const cases = ['ride', 'errand', 'delivery', 'van-moving'].map(service => ({ country: 'GB', currency: 'GBP', service, city: null, zone: null, vehicle: null }));
  for (const s of strategies.filter(s => s.country_code === 'GB')) cases.push({ country: 'GB', currency: s.currency, service: s.service_type,
    city: s.market_city, zone: s.zone_id, vehicle: s.vehicle_class });
  for (const row of rows.filter(r => r.is_active && r.country_code && r.country_code !== 'GB')) cases.push({ country: row.country_code,
    currency: row.currency_code, service: row.service_type, city: row.market_city, zone: row.zone_id, vehicle: null });
  const unique = [...new Map(cases.map(c => [JSON.stringify(c), c])).values()];
  assert(unique.some(c => c.country === 'NG'), 'Explicit NG quote cases required');
  const output = [];
  for (const c of unique) for (const tenant of (c.country === 'GB' ? tenants : [...new Set([null, ...tenants,
    ...profiles.filter(p => p.tenant_id && ['customer', 'driver'].includes(p.role) && marketOf(p) === c.country).map(p => p.tenant_id)])].sort())) {
    const dyn = await config.getEffectiveDynamicPricingConfig(c.service, { countryCode: c.country, currencyCode: c.currency }, c.zone, tenant);
    const selected = await resolveMarketPricingStrategy({ countryCode: c.country, currency: c.currency, serviceType: c.service,
      marketCity: c.city, zoneId: c.zone, vehicleClass: c.vehicle, distanceKm: 5, durationMinutes: 10,
      baseServiceFare: 0, platformFeePercent: 0, driverCommissionPercent: 0 });
    if (phase === 'after' && c.country === 'GB') {
      assert.equal(dyn.enabled, true); assert.equal(dyn.demandSupplyEnabled, true);
      assert.equal(dyn.maxMultiplier, 1.5); assert.equal(dyn.trafficEnabled, false);
      for (const k of ['trafficMultiplier', 'weatherMultiplier', 'demandMultiplier', 'fuelMultiplier', 'supplyScarcityMultiplier',
        'rainMultiplier', 'floodMultiplier', 'peakMultiplier', 'publicHolidayMultiplier', 'eventMultiplier', 'nearbyDriverDiscount', 'nightMultiplier']) assert.equal(dyn[k], 1, k);
      assert.equal(dyn.airportSurcharge, 0);
      if (selected) { assert.equal(selected.maximumSurgeMultiplier, 1.5); assert.equal(selected.normalDemandMultiplier, 1); assert.equal(selected.busyMultiplier, null); }
    }
    const demandCases = c.country === 'GB' ? [[0, 10], [0.2, 1], [50, 1], [50, 0]] : [[0, 10], [50, 1]];
    for (const [demand, supply] of demandCases) {
      let ordinary;
      for (const stress of [1, 9]) {
        const input = { serviceSlug: c.service, countryCode: c.country, currencyCode: c.currency,
          lat: c.country === 'GB' ? 51.5074 : 6.5244, lng: c.country === 'GB' ? -0.1278 : 3.3792,
          distanceKm: 5, durationMinutes: 10, requestedAt: at, tenantId: tenant,
          city: c.city ? { name: c.city } : null, cityName: c.city, cityZone: c.zone, zoneId: c.zone, pricingZoneId: c.zone,
          vehicleClass: c.vehicle, demand, supply, trafficMultiplier: stress, liveTraffic: stress, weatherMultiplier: stress, budget: 0 };
        let resolved;
        try { resolved = await ai.resolveQuote(input); }
        catch (e) {
          if (c.country === 'GB') throw e;
          // Existing unavailable foreign quotes must remain unavailable identically; never
          // invent a currency/payment configuration just to make this GB correction pass.
          output.push({ tenant, ...c, demand, supply, stress, error: e.code || null, message: e.message });
          continue;
        }
        const { legacyPricing: p, quote } = resolved;
        assert.equal(p.currencyCode, c.currency); assert.equal(p.fareBreakdown.reconciliationValid, true);
        if (phase === 'after' && c.country === 'GB') {
          const expected = pricing.getSurgeMultiplier(demand, supply, dyn);
          assert.equal(p.surgeMultiplier, expected, 'fixed strategy must not bypass demand/supply');
          assert(p.dynamicPricingMultiplier >= 1 && p.dynamicPricingMultiplier <= 1.5, 'P8 1.5 ceiling');
          assert(p.fareBreakdown.serviceFareBeforePlatformFee <= p.fareBreakdown.preAdjustmentFare * 1.5 + 0.011, 'service fare cap incl penny rounding');
          assert.equal(quote.ai.shadowMode, true);
          assert.equal(quote.price.totalMinor, Math.round(p.totalPrice * 100), 'AI shadow cannot replace payable canonical fare');
          if (ordinary) {
            assert.equal(p.totalPrice, ordinary.totalPrice, 'traffic/weather cannot increase the payable fare');
            assert.equal(p.driverPayout, ordinary.driverPayout);
            assert.equal(quote.price.totalMinor, ordinary.totalMinor);
          }
        }
        ordinary = { totalPrice: p.totalPrice, driverPayout: p.driverPayout, totalMinor: quote.price.totalMinor };
        output.push({ tenant, ...c, demand, supply, stress, selectedStrategy: selected?.id || null,
          source: p.source, currency: p.currencyCode, base: p.basePrice, total: p.totalPrice, payout: p.driverPayout,
          commission: p.commissionFee, platformFee: p.platformFee, surge: p.surgeMultiplier, dynamic: p.dynamicPricingMultiplier,
          components: { base: p.fareBreakdown.baseFare, distance: p.fareBreakdown.distanceCost, duration: p.fareBreakdown.durationCost,
            service: p.fareBreakdown.serviceFee, traffic: p.fareBreakdown.extras.trafficMultiplier, weather: p.fareBreakdown.extras.weatherMultiplier },
          aiPayable: quote.price.totalMinor });
      }
    }
  }
  console.log('P8_QUOTE_JSON=' + JSON.stringify(output));
  console.log(phase === 'after' ? 'P8_ACTUAL_QUOTES_OK: demand/supply capped at 1.5; traffic/weather cannot increase fares; GB AI shadow retained' : 'P8_BASELINE_QUOTES_CAPTURED');
})().catch(e => { console.error('P8_QUOTE_FAILED: ' + e.message); process.exitCode = 1; });
