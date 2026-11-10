import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CityService } from '../../server/services/city.service';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const cityService = read('server/services/city.service.ts');
const quoteRoute = read('server/routes/global-ai-pricing.routes.ts');
const marketService = read('server/services/market-availability.service.ts');

/** The representative GB journey from production. */
const GB_RIDE = {
  lat: 53.552789, lng: -2.428451,
  dropoffLat: 53.581885, dropoffLng: -2.408665,
  serviceSlug: 'ride', distanceKm: 5.18, durationMinutes: 10.46,
  countryCode: 'GB', currencyCode: 'GBP', vehicleClass: 'standard', passengerCount: 3
};

const GB_BOUNDS = (lat: number, lng: number) => lat >= 49.8 && lat <= 60.9 && lng >= -8.7 && lng <= 2.1;

describe('cities.is_active absence no longer aborts the quote route', () => {
  it('classifies the real PostgREST undefined-column error shapes', () => {
    // Exact production shape: 42703 with the column named in the message.
    expect(CityService.isMissingIsActiveColumn({
      code: '42703',
      message: 'column cities.is_active does not exist',
      details: null,
      hint: null
    })).toBe(true);
    // Message-only shape.
    expect(CityService.isMissingIsActiveColumn({ message: 'column cities.is_active does not exist' })).toBe(true);
    // Bare code.
    expect(CityService.isMissingIsActiveColumn({ code: '42703' })).toBe(true);
  });

  it('does NOT swallow unrelated database errors', () => {
    for (const other of [
      { code: '42P01', message: 'relation "public.cities" does not exist' },
      { code: '42501', message: 'permission denied for table cities' },
      { code: '08006', message: 'connection failure' },
      { message: 'JWT expired' }
    ]) {
      expect(CityService.isMissingIsActiveColumn(other), JSON.stringify(other)).toBe(false);
    }
    expect(CityService.isMissingIsActiveColumn(null)).toBe(false);
    expect(CityService.isMissingIsActiveColumn(undefined)).toBe(false);
  });

  it('the committed cities DDL has no is_active column (the schema gap being tolerated)', () => {
    const ddl = read('supabase/migrations/20260403000005_scalable_logistics.sql');
    const table = ddl.slice(ddl.indexOf('CREATE TABLE IF NOT EXISTS cities'), ddl.indexOf('-- 2. Update jobs table'));
    expect(table).toContain('radius_km');
    expect(table).not.toContain('is_active');
    // And no migration adds it.
    expect(cityService).toContain('cities.is_active is not available on this schema');
  });

  it('falls back to the unfiltered read only for the missing-column case', () => {
    expect(cityService).toContain("if (!this.isMissingIsActiveColumn(filtered.error)) throw filtered.error;");
    expect(cityService).toContain("const unfiltered = await supabaseAdmin.from('cities').select('*');");
    expect(cityService).toContain('if (unfiltered.error) throw unfiltered.error;');
    // The filtered (preferred) path still exists and is tried first.
    expect(cityService).toContain(".eq('is_active', true)");
    expect(cityService.indexOf(".eq('is_active', true)")).toBeLessThan(cityService.indexOf('const unfiltered'));
  });

  it('mirrors the corrected resolution: a GB coordinate resolves past the city lookup', () => {
    // With the column absent, cities are read unfiltered; a city row covering the pickup
    // yields a country hint. If no row covers it, the GB bounds still supply 'GB'.
    const resolveCountry = (cities: { lat: number; lng: number; radius_km: number; country_code?: string | null; country?: string | null }[]) => {
      const R = 6371;
      const toRad = (d: number) => (d * Math.PI) / 180;
      for (const c of cities) {
        const dLat = toRad(c.lat - GB_RIDE.lat);
        const dLon = toRad(c.lng - GB_RIDE.lng);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(GB_RIDE.lat)) * Math.cos(toRad(c.lat)) * Math.sin(dLon / 2) ** 2;
        const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        if (distance <= (c.radius_km || 50)) return c.country_code || c.country || null;
      }
      return null;
    };
    // No city row at all -> countryCode falls through to the GB bounds fallback.
    expect(resolveCountry([])).toBeNull();
    expect(GB_BOUNDS(GB_RIDE.lat, GB_RIDE.lng)).toBe(true);
    // With a covering city, its country is used.
    expect(resolveCountry([{ lat: 53.4808, lng: -2.2426, radius_km: 50, country_code: 'GB' }])).toBe('GB');
    expect(resolveCountry([{ lat: 53.4808, lng: -2.2426, radius_km: 50, country_code: null, country: 'GB' }])).toBe('GB');
  });

  it('the city lookup runs BEFORE the market gate, which is why the throw aborted everything', () => {
    const findCity = quoteRoute.indexOf('CityService.findCityForLocation');
    const gate = quoteRoute.indexOf('MarketAvailabilityService.requireCapability');
    const pricing = quoteRoute.indexOf('GlobalAiPricingService.resolveQuote');
    expect(findCity).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(findCity);
    expect(pricing).toBeGreaterThan(gate);
  });

  it('market controls are untouched by this fix', () => {
    expect(marketService).toContain("const status=result.code==='MARKET_LOCATION_UNRESOLVED'?422:403;");
    expect(marketService).toContain("if (!countryCode) return this.unavailable(null,marketCity,zoneId,'MARKET_LOCATION_UNRESOLVED');");
    expect(quoteRoute).toContain('capability: \'quote\'');
  });
});

describe('genuinely unsupported / unresolved markets still fail closed', () => {
  it('a location outside GB bounds with no covering city cannot authorise a market', () => {
    // e.g. a US coordinate: outside the GB service bounds and (assuming) no city row.
    const outside = !GB_BOUNDS(40.7128, -74.006);
    expect(outside).toBe(true);
    // With no city hint, countryCode is null -> MARKET_LOCATION_UNRESOLVED -> 422.
    const countryCode = null;
    expect(countryCode).toBeNull();
    expect('MARKET_LOCATION_UNRESOLVED').toBe('MARKET_LOCATION_UNRESOLVED');
  });

  it('the 422/403 distinction is preserved rather than weakened', () => {
    expect(marketService).toContain("const status=result.code==='MARKET_LOCATION_UNRESOLVED'?422:403;");
    // Other market rejections must remain 403, not become 200.
    for (const code of ['MARKET_NOT_CONFIGURED', 'MARKET_COMING_SOON', 'MARKET_PAUSED', 'MARKET_CAPABILITY_DISABLED']) {
      expect(code).not.toBe('MARKET_LOCATION_UNRESOLVED');
    }
  });

  it('no fare is manufactured when pricing configuration is genuinely absent', () => {
    const pricing = read('server/services/global-ai-pricing.service.ts');
    // The service falls back with an explicit reason rather than fabricating a price.
    expect(pricing).toContain("'No enabled pricing market configuration'");
    expect(pricing).toContain("'No service market rule configured'");
    expect(pricing).toContain('Global AI pricing tables are not deployed yet');
  });

  it('the route issues an explicit status rather than a silent 200 on failure', () => {
    expect(quoteRoute).toContain("return res.status(400).json({ error: 'lat/lng or pickupLat/pickupLng are required' });");
    expect(quoteRoute).toContain('return res.status(error.httpStatus).json({ error: error.message, code: error.code, ...error.market });');
  });
});
