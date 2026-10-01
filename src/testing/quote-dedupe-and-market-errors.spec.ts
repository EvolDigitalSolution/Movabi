import { describe, expect, it } from 'vitest';
import { buildQuoteSignature, QUOTE_COORDINATE_PRECISION, QUOTE_MEASURE_PRECISION } from '../../src/app/shared/utils/quote-signature';
import {
  MARKET_FAILURE_COPY,
  MARKET_FAILURE_GENERIC,
  MarketAvailabilityFailure,
  describeMarketFailure,
  isMarketFailureCode,
  marketFailureMessage
} from '../../src/app/shared/utils/market-failure';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/** The exact production payload under investigation. */
const RIDE = {
  lat: 53.552789, lng: -2.428451,
  dropoffLat: 53.581885, dropoffLng: -2.408665,
  serviceSlug: 'ride', distanceKm: 5.18, durationMinutes: 10.46,
  countryCode: 'GB', currencyCode: 'GBP', vehicleClass: 'standard',
  passengerCount: 3, packageSize: null, errandMode: null, moveDetails: null
};
const sig = (over: Record<string, unknown> = {}) => buildQuoteSignature({ ...RIDE, ...over } as any);

describe('quote signature — one authoritative dedupe key', () => {
  it('is deterministic for the same pricing inputs', () => {
    expect(sig()).toBe(sig());
    expect(buildQuoteSignature(RIDE as any)).toBe(buildQuoteSignature({ ...RIDE } as any));
  });

  it('same pricing inputs => one effective request (identical signature)', () => {
    const a = sig();
    const b = sig();
    expect(a === b).toBe(true);
  });

  it('insignificant floating-point drift does NOT produce a new quote', () => {
    // Sub-5dp coordinate noise and sub-2dp measure noise are normalised away.
    expect(sig({ lat: 53.5527891, lng: -2.42845104 })).toBe(sig());
    expect(sig({ distanceKm: 5.180001, durationMinutes: 10.460002 })).toBe(sig());
  });

  it('changed pickup produces a new quote (coordinates participate in the key)', () => {
    expect(sig({ lat: 53.5601 })).not.toBe(sig());
    expect(sig({ lng: -2.4301 })).not.toBe(sig());
  });

  it('changed dropoff produces a new quote', () => {
    expect(sig({ dropoffLat: 53.6 })).not.toBe(sig());
    expect(sig({ dropoffLng: -2.5 })).not.toBe(sig());
    // Clearing the dropoff is also a material change.
    expect(sig({ dropoffLat: null, dropoffLng: null })).not.toBe(sig());
  });

  it('changed service, vehicle class and passenger count each produce a new quote', () => {
    expect(sig({ serviceSlug: 'delivery' })).not.toBe(sig());
    expect(sig({ vehicleClass: 'xl' })).not.toBe(sig());
    expect(sig({ passengerCount: 4 })).not.toBe(sig());
  });

  it('materially changed distance/duration produce a new quote', () => {
    expect(sig({ distanceKm: 5.19 })).not.toBe(sig());
    expect(sig({ durationMinutes: 10.47 })).not.toBe(sig());
    expect(sig({ distanceKm: 12.4 })).not.toBe(sig());
  });

  it('errand / van-moving pricing inputs participate', () => {
    expect(sig({ errandMode: 'items', itemCount: 3 })).not.toBe(sig({ errandMode: 'items', itemCount: 4 }));
    expect(sig({ errandMode: 'budget', budget: 25 })).not.toBe(sig({ errandMode: 'budget', budget: 30 }));
    expect(sig({ serviceSlug: 'van-moving', moveDetails: { size: 'small', helperCount: 1 } }))
      .not.toBe(sig({ serviceSlug: 'van-moving', moveDetails: { size: 'small', helperCount: 2 } }));
    expect(sig({ serviceSlug: 'van-moving', moveDetails: { size: 'small', stairsInvolved: true } }))
      .not.toBe(sig({ serviceSlug: 'van-moving', moveDetails: { size: 'small', stairsInvolved: false } }));
  });

  it('currency/country changes are pricing-relevant', () => {
    expect(sig({ currencyCode: 'EUR' })).not.toBe(sig());
    expect(sig({ countryCode: 'IE' })).not.toBe(sig());
  });

  it('tolerates null/undefined/missing input without throwing', () => {
    expect(() => buildQuoteSignature(null)).not.toThrow();
    expect(() => buildQuoteSignature(undefined)).not.toThrow();
    expect(buildQuoteSignature({})).toBe(buildQuoteSignature(null));
  });

  it('uses the audited precision constants', () => {
    expect(QUOTE_COORDINATE_PRECISION).toBe(5);
    expect(QUOTE_MEASURE_PRECISION).toBe(2);
  });

  it('the pricing service key is the shared signature (coordinates included)', () => {
    const service = read('src/app/core/services/pricing/global-ai-pricing-quote.service.ts');
    expect(service).toContain('buildQuoteSignature(request)');
    // The old key omitted coordinates -- it must not come back.
    expect(service).not.toContain('request.distanceKm, request.durationMinutes, request.passengerCount ?? null');
  });

  it('the page guards on the same signature and covers every trigger', () => {
    const page = read('src/app/apps/mobile/features/customer/booking-request/booking-request.page.ts');
    expect(page).toContain('const signature = buildQuoteSignature(quoteRequest);');
    expect(page).toContain('if (signature === this.quoteInFlightSignature) return;');
    expect(page).toContain('this.lastQuotedSignature = signature;');
    // All seven triggers funnel through recalculateFare, so one guard covers them.
    expect((page.match(/void this\.recalculateFare\(\);/g) || []).length).toBeGreaterThanOrEqual(5);
  });
});

describe('market failure copy — error honesty', () => {
  it('maps every authoritative market code to a truthful customer message', () => {
    for (const code of Object.keys(MARKET_FAILURE_COPY)) {
      expect(isMarketFailureCode(code)).toBe(true);
      const message = marketFailureMessage(code);
      expect(message).toBe(MARKET_FAILURE_COPY[code as keyof typeof MARKET_FAILURE_COPY]);
      expect(message).not.toBe('Unable to calculate the fare right now. Please try again.');
      expect(message.length).toBeGreaterThan(10);
    }
  });

  it('distinguishes the market states from one another', () => {
    // "coming soon" and "not configured" legitimately share the same customer copy, but the
    // states a customer can act on differently must be distinct.
    const distinct = new Set(Object.values(MARKET_FAILURE_COPY));
    expect(distinct.size).toBeGreaterThanOrEqual(4);
    expect(marketFailureMessage('MARKET_LOCATION_UNRESOLVED')).not.toBe(marketFailureMessage('MARKET_PAUSED'));
    expect(marketFailureMessage('MARKET_COMING_SOON')).not.toBe(marketFailureMessage('MARKET_CAPABILITY_DISABLED'));
    expect(marketFailureMessage('MARKET_LOCATION_UNRESOLVED')).not.toBe(marketFailureMessage('MARKET_CAPABILITY_DISABLED'));
    expect(MARKET_FAILURE_COPY.MARKET_COMING_SOON).toBe(MARKET_FAILURE_COPY.MARKET_NOT_CONFIGURED);
  });

  it('unknown codes still fall back safely', () => {
    expect(marketFailureMessage('SOMETHING_NEW')).toBe(MARKET_FAILURE_GENERIC);
    expect(marketFailureMessage(null)).toBe(MARKET_FAILURE_GENERIC);
    expect(marketFailureMessage(undefined)).toBe(MARKET_FAILURE_GENERIC);
  });

  it('never exposes stack traces, SQL or internals', () => {
    const leaks = [
      'at Object.<anonymous> (/app/dist/server.js:1:2)',
      'postgrest error: relation "profiles" does not exist',
      'column profiles.secret does not exist',
      'supabaseAdmin.from("x")',
      'TypeError: undefined is not a function'
    ];
    for (const leak of leaks) {
      const message = marketFailureMessage('UNKNOWN_CODE', leak);
      expect(message).toBe(MARKET_FAILURE_GENERIC);
      expect(message).not.toContain('at Object');
      expect(message).not.toContain('relation');
      expect(message).not.toContain('supabase');
    }
  });

  it('does not manufacture success — every code yields a failure message', () => {
    for (const code of Object.keys(MARKET_FAILURE_COPY)) {
      expect(marketFailureMessage(code).toLowerCase()).not.toMatch(/success|confirmed|booked|complete/);
    }
  });

  it('describeMarketFailure surfaces the code from a thrown failure', () => {
    const failure = new MarketAvailabilityFailure('MARKET_PAUSED', MARKET_FAILURE_COPY.MARKET_PAUSED);
    expect(describeMarketFailure(failure)).toEqual({ code: 'MARKET_PAUSED', message: MARKET_FAILURE_COPY.MARKET_PAUSED });
  });

  it('describeMarketFailure reads a raw HttpErrorResponse-style body and keeps the code', () => {
    const httpError = { status: 422, error: { code: 'MARKET_LOCATION_UNRESOLVED', error: 'Choose a service location so we can check availability.' } };
    const described = describeMarketFailure(httpError);
    expect(described?.code).toBe('MARKET_LOCATION_UNRESOLVED');
    expect(described?.message).toBe(MARKET_FAILURE_COPY.MARKET_LOCATION_UNRESOLVED);
  });

  it('describeMarketFailure returns null for a genuine non-market failure', () => {
    expect(describeMarketFailure(new Error('Network down'))).toBeNull();
    expect(describeMarketFailure({ status: 500, error: { error: 'Unable to calculate global AI price' } })).toBeNull();
    expect(describeMarketFailure(null)).toBeNull();
  });

  it('the client market service throws the code-carrying failure, not a bare Error', () => {
    const service = read('src/app/core/services/market-availability.service.ts');
    expect(service).toContain('throw new MarketAvailabilityFailure(status.code,marketFailureMessage(status.code,status.message||status.title));');
    expect(service).not.toContain('throw new Error(status.message||status.title');
  });

  it('the page preserves the market reason but keeps a generic fallback', () => {
    const page = read('src/app/apps/mobile/features/customer/booking-request/booking-request.page.ts');
    expect(page).toContain('const marketFailure = describeMarketFailure(error);');
    expect(page).toContain("marketFailure?.message || 'Unable to calculate the fare right now. Please try again.'");
    expect(page).toContain("console.warn('[BookingRequest] market rejected the fare quote', { code: marketFailure.code });");
    // A failed quote must leave no usable quote reference behind.
    expect(page).toContain('this.lastQuoteReference = null;');
    expect(page).toContain('this.lastQuotedSignature = null;');
  });
});
