/**
 * MOBILE UX PATCH 1 - user-facing wording.
 *
 * Proves the three guarantees of this batch:
 *   1. raw technical/JS/network error text is NEVER shown to a user;
 *   2. unknown job statuses fall back to neutral copy, never raw snake_case;
 *   3. service SLUGS are unchanged while their DISPLAY names are canonical.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { SESSION_EXPIRED_MESSAGE, userFacingError } from '../app/shared/utils/http-failure';
import { serviceDisplayName } from '../app/shared/utils/service-display';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');
const TRACKING = read('src/app/apps/mobile/features/customer/booking-tracking/booking-tracking.page.ts');
const ACTIVITY = read('src/app/apps/mobile/features/customer/activity/activity.page.ts');
const DASH = read('src/app/apps/mobile/features/driver/dashboard/dashboard.page.ts');
const NEG = read('src/app/apps/mobile/features/driver/hybrid-negotiation/hybrid-negotiation.page.ts');
const ONB = read('src/app/apps/mobile/features/driver/onboarding/onboarding.page.ts');

describe('userFacingError - unknown/technical errors', () => {
  const FALLBACK = 'Unable to accept fare.';

  it('never returns raw JavaScript/network/platform text', () => {
    expect(userFacingError(new TypeError('Failed to fetch'), FALLBACK)).toBe(FALLBACK);
    expect(userFacingError(new Error('Network request failed'), FALLBACK)).toBe(FALLBACK);
    expect(userFacingError(new Error('Load failed'), FALLBACK)).toBe(FALLBACK);
    expect(userFacingError(new Error('Cannot read properties of undefined'), FALLBACK)).toBe(FALLBACK);
    expect(userFacingError(new Error('x is not a function'), FALLBACK)).toBe(FALLBACK);
    expect(userFacingError(new Error('Unexpected token < in JSON'), FALLBACK)).toBe(FALLBACK);
  });

  it('never returns SQL/PostgREST/stack detail', () => {
    expect(userFacingError(new Error('relation "jobs" does not exist'), FALLBACK)).toBe(FALLBACK);
    expect(userFacingError(new Error('column jobs.foo does not exist'), FALLBACK)).toBe(FALLBACK);
    expect(userFacingError(new Error('at Object.next (/app/main.js:1:2)'), FALLBACK)).toBe(FALLBACK);
    expect(userFacingError(new Error('postgrest error 400'), FALLBACK)).toBe(FALLBACK);
  });

  it('never returns empty/undefined-ish text', () => {
    expect(userFacingError(new Error(''), FALLBACK)).toBe(FALLBACK);
    expect(userFacingError(null, FALLBACK)).toBe(FALLBACK);
    expect(userFacingError(undefined, FALLBACK)).toBe(FALLBACK);
    expect(userFacingError({}, FALLBACK)).toBe(FALLBACK);
    expect(userFacingError('plain string', FALLBACK)).toBe(FALLBACK);
  });
});

describe('userFacingError - known errors', () => {
  it('maps an expired/missing session to the intentional copy', () => {
    expect(userFacingError({ status: 401 }, 'Fallback')).toBe(SESSION_EXPIRED_MESSAGE);
    expect(userFacingError({ error: { code: 'AUTHENTICATION_REQUIRED' } }, 'Fallback')).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it('preserves a curated domain message we raised ourselves', () => {
    const curated = 'Another driver has already taken this negotiation.';
    expect(userFacingError(new Error(curated), 'Fallback')).toBe(curated);
  });

  it('preserves a curated server-authored message', () => {
    const curated = 'This request is no longer available for negotiation.';
    expect(userFacingError({ error: { error: curated, code: 'JOB_NOT_NEGOTIABLE' } }, 'Fallback')).toBe(curated);
  });
});

describe('job status display', () => {
  it('booking tracking never de-underscores an unknown status', () => {
    expect(TRACKING).not.toContain("status.replace(/_/g, ' ')");
    expect(TRACKING).toContain("?? 'Updating…'");
  });

  it('activity never de-underscores an unknown status', () => {
    expect(ACTIVITY).not.toMatch(/replace\(\/_\/g,\s*' '\)\s*\.replace/);
    expect(ACTIVITY).toContain("return 'Updating…';");
  });

  it('internal job status values are unchanged (display map keys only)', () => {
    for (const key of ['pending_fare_confirmation', 'en_route_to_customer', 'requires_review', 'no_driver_found']) {
      expect(TRACKING).toContain(`${key}:`);
    }
    // the enum still drives the errand branch (no value renamed)
    expect(TRACKING).toContain('ServiceTypeEnum.ERRAND');
  });
});

describe('service display names', () => {
  it('maps the four canonical slugs to existing Movabi terminology', () => {
    expect(serviceDisplayName('ride')).toBe('Ride');
    expect(serviceDisplayName('errand')).toBe('Shop');
    expect(serviceDisplayName('delivery')).toBe('Deliver');
    expect(serviceDisplayName('van-moving')).toBe('Move');
  });

  it('normalises the underscore variant but keeps the same slug identity', () => {
    expect(serviceDisplayName('van_moving')).toBe('Move');
    expect(serviceDisplayName(' ERRAND ')).toBe('Shop');
  });

  it('unknown/absent service falls back to Request (never a raw slug)', () => {
    expect(serviceDisplayName('something-new')).toBe('Request');
    expect(serviceDisplayName('')).toBe('Request');
    expect(serviceDisplayName(null)).toBe('Request');
    expect(serviceDisplayName(undefined)).toBe('Request');
  });

  it('the canonical slug values themselves are unchanged', () => {
    const source = read('src/app/shared/utils/service-display.ts');
    for (const slug of ['ride', 'errand', 'delivery', 'van-moving']) {
      expect(source).toContain(slug);
    }
  });

  it('booking tracking renders the display name, not the raw slug', () => {
    expect(TRACKING).toContain('{{ serviceLabel() }}');
    expect(TRACKING).not.toContain("{{ booking()?.service_slug || 'Request' }}");
    expect(TRACKING).toContain("return serviceDisplayName(this.booking()?.service_slug);");
  });
});

describe('safe error display adoption + navigation invariance', () => {
  it('the three named screens no longer pass a raw error.message to the user', () => {
    for (const src of [DASH, NEG, ONB]) {
      expect(src).toContain('userFacingError');
      expect(src).not.toMatch(/showToast\(\s*(error|e|err)\??\.message/);
      expect(src).not.toMatch(/showToast\(\s*(error|e|err) instanceof Error\s*\?\s*\1\.message/);
      expect(src).not.toMatch(/=\s*(error|e|err) instanceof Error\s*\?\s*\1\.message\s*:/);
    }
  });

  it('routes and navigation are unchanged by the wording edits', () => {
    expect(ONB).toContain("this.router.navigate(['/driver'],{replaceUrl:true})");
    expect(DASH).toContain("['/driver/job-details', jobId]");
    expect(DASH).toContain("['/driver/hybrid-negotiation', jobId]");
  });

  it('the terse job-details CTA now uses the standard View Details wording', () => {
    const jd = read('src/app/apps/mobile/features/driver/job-details/job-details.page.ts');
    expect(jd).toContain("return 'View Details';");
    expect(jd).not.toContain("return 'Review request details';");
  });
});
