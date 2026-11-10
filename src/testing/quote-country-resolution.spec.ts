import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { MarketAvailabilityService } from '../../server/services/market-availability.service';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');
const route = read('server/routes/global-ai-pricing.routes.ts');
const marketService = read('server/services/market-availability.service.ts');
const paymentRoute = read('server/routes/payment.routes.ts');

/** The production Manchester/GB pickup from the failing quote request. */
const MANCHESTER = { lat: 53.552789, lng: -2.428451 };
/** A coordinate clearly outside the GB service bounds (New York). */
const NEW_YORK = { lat: 40.7128, lng: -74.006 };

const resolve = (cityCountry: unknown, coords = MANCHESTER) =>
  MarketAvailabilityService.resolveServiceCountryCode(cityCountry, coords.lat, coords.lng);

describe('quote country resolution — malformed city country cannot suppress the GB fallback', () => {
  it('1. Manchester + city.country="United Kingdom" resolves to GB (the production defect)', () => {
    // This is the exact failing case: truthy but not ISO alpha-2.
    expect(MarketAvailabilityService.normalizeCountry('United Kingdom')).toBeNull();
    expect(resolve('United Kingdom')).toBe('GB');
  });

  it('2. Manchester + city.country_code="GB" resolves to GB', () => {
    expect(resolve('GB')).toBe('GB');
    expect(resolve('gb')).toBe('GB');
    expect(resolve(' gb ')).toBe('GB');
  });

  it('3. Manchester + missing city country falls back to the GB bounds', () => {
    expect(resolve(undefined)).toBe('GB');
    expect(resolve(null)).toBe('GB');
    expect(resolve('')).toBe('GB');
  });

  it('4. malformed / non-ISO city country cannot suppress the GB fallback', () => {
    for (const malformed of ['United Kingdom', 'England', 'Great Britain', 'GBR', '1', '--', 'null', '{}']) {
      expect(resolve(malformed), malformed).toBe('GB');
    }
  });

  it('4b. FINDING: "UK" passes the alpha-2 shape test but is not a real ISO code', () => {
    // normalizeCountry() accepts any /^[A-Z]{2}$/, so 'UK' survives and outranks the GB
    // fallback -> resolveMarket('UK') finds no row -> MARKET_NOT_CONFIGURED (403), not 422.
    // Distinct from the malformed-value defect fixed here; reported as a follow-up only.
    expect(MarketAvailabilityService.normalizeCountry('UK')).toBe('UK');
    expect(resolve('UK')).toBe('UK');
    expect(resolve('UK')).not.toBe('GB');
  });

  it('5. a VALID non-GB ISO country from the city is preserved, not overwritten by GB', () => {
    // Coordinates deliberately inside the GB bounds to prove the city value wins.
    expect(resolve('IE', MANCHESTER)).toBe('IE');
    expect(resolve('NG', MANCHESTER)).toBe('NG');
    expect(resolve('us', MANCHESTER)).toBe('US');
  });

  it('6. outside GB + invalid/missing city country stays unresolved', () => {
    expect(resolve(undefined, NEW_YORK)).toBeNull();
    expect(resolve('United Kingdom', NEW_YORK)).toBeNull();
    // ...which is what produces MARKET_LOCATION_UNRESOLVED downstream.
    expect(MarketAvailabilityService.normalizeCountry(resolve(undefined, NEW_YORK))).toBeNull();
    // A valid city country still resolves there.
    expect(resolve('US', NEW_YORK)).toBe('US');
  });

  it('bounds are exactly the GB service bounds and reject non-finite input', () => {
    expect(MarketAvailabilityService.GB_SERVICE_BOUNDS)
      .toEqual({ minLat: 49.8, maxLat: 60.9, minLng: -8.7, maxLng: 2.1 });
    expect(MarketAvailabilityService.isWithinGbServiceBounds(49.8, -8.7)).toBe(true);
    expect(MarketAvailabilityService.isWithinGbServiceBounds(60.9, 2.1)).toBe(true);
    expect(MarketAvailabilityService.isWithinGbServiceBounds(49.79, -2)).toBe(false);
    expect(MarketAvailabilityService.isWithinGbServiceBounds(61, -2)).toBe(false);
    expect(MarketAvailabilityService.isWithinGbServiceBounds(NaN, -2)).toBe(false);
    expect(MarketAvailabilityService.isWithinGbServiceBounds(53, Infinity)).toBe(false);
  });

  it('7. client req.body.countryCode cannot authorize the market', () => {
    // The resolver takes no client-country input at all, so a client value cannot reach it.
    expect(MarketAvailabilityService.resolveServiceCountryCode.length).toBe(3);
    // And the route passes only the city value + coordinates.
    expect(route).toContain('MarketAvailabilityService.resolveServiceCountryCode(');
    expect(route).toContain('(city as any)?.country_code || (city as any)?.country,');
    expect(route).not.toContain('req.body.countryCode');
    // The old raw-precedence expression must be gone.
    expect(route).not.toContain("(isWithinGbServiceBounds(lat, lng) ? 'GB' : null)");
    expect(route).not.toContain('const isWithinGbServiceBounds =');
    // An out-of-GB coordinate with a spoofed GB body country still cannot fabricate GB.
    expect(resolve(undefined, NEW_YORK)).toBeNull();
  });

  it('8. market capability controls remain authoritative after country resolution', () => {
    const resolveIdx = route.indexOf('resolveServiceCountryCode');
    const gateIdx = route.indexOf('MarketAvailabilityService.requireCapability');
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(resolveIdx);   // gate runs AFTER resolution, on the result
    expect(route).toContain("capability: 'quote'");
    // The 422/403 mapping is untouched.
    expect(marketService).toContain("const status=result.code==='MARKET_LOCATION_UNRESOLVED'?422:403;");
    expect(marketService).toContain("if (!countryCode) return this.unavailable(null,marketCity,zoneId,'MARKET_LOCATION_UNRESOLVED');");
  });

  it('the resolver uses the existing normalizeCountry authority (not a new regex)', () => {
    const fn = marketService.slice(
      marketService.indexOf('static resolveServiceCountryCode'),
      marketService.indexOf('static async resolveMarket')
    );
    expect(fn).toContain('this.normalizeCountry(cityCountry)');
    expect(fn).toContain('return this.isWithinGbServiceBounds(lat,lng)?\'GB\':null;');
    expect(fn).not.toMatch(/\/\^\[A-Z\]\{2\}\$\//);   // no duplicated ISO regex
  });
});

describe('payment route — same defect class, reported not patched', () => {
  it('records the raw city.country precedence shape (unpatched, out of scope)', () => {
    // Same truthy-invalid-value hazard, but it feeds pricingInput.countryCode rather than a
    // capability gate, and it ends with || 'GB' so it cannot yield null. Reported only.
    expect(paymentRoute).toContain("countryCode: countryCode || (city as any)?.country_code || (city as any)?.country || 'GB',");
  });

  it('the payment route does not gate a market capability on that expression', () => {
    // The capability gate is driven by persisted job/metadata country, not by pricingInput.
    expect(paymentRoute).toContain('MarketAvailabilityService.requireCapability({ countryCode: job.country_code || locationMetadata.country_code');
    expect(paymentRoute).toContain("countryCode: countryCode || (city as any)?.country_code || (city as any)?.country || 'GB',");
  });
});
