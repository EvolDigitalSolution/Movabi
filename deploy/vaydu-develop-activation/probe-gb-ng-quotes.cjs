// Run inside the EXISTING develop API container. Uses its installed services and live DB config.
// No bookings, provider calls, captures or payments. The quote engine may write normal quote audits.
require('/app/node_modules/ts-node').register({ project: '/app/server/tsconfig.json', transpileOnly: true });
const assert = require('node:assert/strict');
const { supabaseAdmin: db } = require('/app/server/services/supabase.service');
const { MarketplaceConfigService: config } = require('/app/server/services/marketplace-config.service');
const { PricingService: pricing } = require('/app/server/services/pricing.service');
const marketOf = p => String(p.registration_country_code?.trim() || p.country_code?.trim() || '').toUpperCase();
(async () => {
  const at = process.env.PROBE_AT;
  assert(at && Number.isFinite(Date.parse(at)), 'PROBE_AT must be fixed across before/after probes');
  const profiles = await db.from('profiles').select('id,role,tenant_id,registration_country_code,country_code').in('role', ['customer', 'driver']);
  if (profiles.error) throw new Error('Profile inventory failed');
  const gb = profiles.data.filter(p => p.tenant_id && marketOf(p) === 'GB');
  assert(gb.some(p => p.role === 'customer'), 'No recognised GB customer');
  assert(gb.some(p => p.role === 'driver'), 'No recognised GB driver');
  const tenants = [...new Set(gb.map(p => p.tenant_id))].sort();
  const rows = await db.from('pricing_config').select('*').eq('is_active', true);
  if (rows.error) throw new Error('Pricing inventory failed');
  const ng = rows.data.filter(r => String(r.country_code || '').trim().toUpperCase() === 'NG')
    .sort((a, b) => a.id.localeCompare(b.id));
  assert(ng.length > 0, 'No explicitly scoped active NG pricing rows');
  const cases = ['delivery', 'errand', 'ride', 'van-moving'].map(service => ({ country: 'GB', currency: 'GBP', service, city: '', zone: '' }));
  for (const row of ng) cases.push({ country: 'NG', currency: row.currency_code, service: row.service_type,
    city: row.market_city || '', zone: row.zone_id || '' });
  const output = [];
  for (const tenant of tenants) for (const c of cases) {
    const effective = await config.getEffectivePricingConfig(c.service, { countryCode: c.country, currencyCode: c.currency, city: c.city }, c.zone);
    assert.equal(effective.source, 'pricing_config', `Missing ${c.country}/${c.service} pricing`);
    if (c.country === 'GB' && c.service === 'ride') assert.equal(effective.minimumFare, 3.35, 'Existing ride minimum must remain GBP 3.35');
    for (const [distance, duration] of [[0, 0], [5, 10]]) {
      const quote = await pricing.resolvePrice({ serviceSlug: c.service, countryCode: c.country, currencyCode: c.currency,
        lat: c.country === 'GB' ? 51.5074 : 6.5244, lng: c.country === 'GB' ? -0.1278 : 3.3792,
        distanceKm: distance, durationMinutes: duration, requestedAt: at, tenantId: tenant,
        city: c.city ? { name: c.city } : null, cityZone: c.zone || null, zoneId: c.zone || null,
        demand: 0, supply: 1, weatherMultiplier: 1, trafficMultiplier: 1, budget: 0 });
      assert.equal(quote.source, 'pricing_config');
      assert.equal(quote.countryCode, c.country);
      assert.equal(quote.currencyCode, c.currency);
      assert.equal(quote.fareBreakdown.reconciliationValid, true);
      // Effective config includes ID, all rates and updated_at-derived version. Quote contains the
      // actual payable amount/split and adjustments, so equality is stronger than checking a floor.
      output.push({ tenant, ...c, distance, duration, effective, quote });
    }
  }
  console.log('PROFILE_MARKETS_OK ' + JSON.stringify({ customers: gb.filter(p => p.role === 'customer').length,
    drivers: gb.filter(p => p.role === 'driver').length, tenants: tenants.length }));
  console.log('QUOTE_PROBE_JSON=' + JSON.stringify(output));
})().catch(e => { console.error('QUOTE_PROBE_FAILED: ' + e.message); process.exitCode = 1; });
